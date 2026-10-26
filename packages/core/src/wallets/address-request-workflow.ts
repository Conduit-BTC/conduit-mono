import type {
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "../protocol/nostr-event-signer"
import type { BreezAddressState } from "./breez-lightning-address"
import {
  ADDRESS_REQUEST_ORIGIN,
  ADDRESS_REQUEST_PATH,
  addressNameRequestPayload,
  addressRequestHash,
  decodeAddressNameRequestResponse,
  type AddressNameRequest,
  type AddressNameRequestStatus,
  type SignedAddressNameRequest,
} from "./address-name-request"
import {
  requestEvidence,
  type AddressRequestRecord,
} from "./address-request-record"

export interface AddressRequestView {
  record: AddressRequestRecord
  publication: "confirmed" | "local"
  status?: AddressNameRequestStatus
  /** Session evidence only; never persisted or used as approval/ownership authority. */
  activation?: {
    step: "approval" | "registration" | "public_lookup" | "profile"
    reason?: string
    retryAt?: number
    exhausted?: boolean
    address?: Extract<BreezAddressState, { status: "registered" }>
  }
}
export interface AddressActivationOptions {
  signal?: AbortSignal
  onProgress?(view: AddressRequestView): void
}
export interface AddressRequestWorkflowDependencies {
  owner: string
  assertCurrent(): void
  /** Authorize before timestamping; the returned cheap fence runs after signing. */
  authorize?(
    walletId: string,
    record?: AddressRequestRecord
  ): Promise<void | (() => Promise<void>)>
  load(walletId: string): Promise<AddressRequestView | undefined>
  /** Must retain encrypted exact bytes locally before attempting relay publication. */
  save(
    walletId: string,
    record: AddressRequestRecord
  ): Promise<AddressRequestView>
  signWallet(
    walletId: string,
    input: Omit<AddressNameRequest, "sparkIdentity">
  ): Promise<SignedAddressNameRequest>
  signAccount(draft: UnsignedNostrEvent): Promise<SignedNostrEvent>
  fetch: typeof fetch
  address(
    walletId: string,
    register: boolean | "retry",
    name: string,
    beforeRegister?: () => Promise<void | (() => Promise<void>)>,
    signal?: AbortSignal
  ): Promise<BreezAddressState>
  publishProfile(address: string, assertCurrent?: () => void): Promise<string>
  now?(): number
  wait?(milliseconds: number, signal?: AbortSignal): Promise<void>
}
export interface AddressRequestWorkflow {
  /** Enabled by default; an explicit false disables new writes in an emergency. */
  writesEnabled?: boolean
  load(walletId: string): Promise<AddressRequestView | undefined>
  submit(
    walletId: string,
    input: { desiredName: string; token: string; requestId?: string }
  ): Promise<AddressRequestView>
  check(walletId: string): Promise<AddressRequestView | undefined>
  activate(
    walletId: string,
    options?: AddressActivationOptions
  ): Promise<AddressRequestView>
}

function waitForRecheck(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Activation cancelled."))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
/** No provider/network write precedes retained intent. Account state never grants approval. */
export function createAddressRequestWorkflow(
  d: AddressRequestWorkflowDependencies
): AddressRequestWorkflow {
  const authorization = async (body: string, path: string) => {
    d.assertCurrent()
    const event = await d.signAccount({
      kind: 27235,
      pubkey: d.owner,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", ADDRESS_REQUEST_ORIGIN + path],
        ["method", "POST"],
        ["payload", addressRequestHash(body)],
      ],
    })
    d.assertCurrent()
    return event
  }
  const send = async (
    walletId: string,
    record: AddressRequestRecord,
    check: boolean,
    token?: string
  ): Promise<AddressNameRequestStatus> => {
    const path = ADDRESS_REQUEST_PATH + (check ? "/status" : "")
    const assertAuthorized = await d.authorize?.(walletId, record)
    const event = await authorization(record.payload, path)
    await assertAuthorized?.()
    d.assertCurrent()
    try {
      const result = await d.fetch(ADDRESS_REQUEST_ORIGIN + path, {
        method: "POST",
        body: record.payload,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
          "X-Address-Request-Proof": btoa(record.accountProof),
          ...(!check && token ? { "X-Turnstile-Token": token } : {}),
        },
        signal: AbortSignal.timeout(20_000),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      const status = await decodeAddressNameRequestResponse(result)
      d.assertCurrent()
      return status
    } catch {
      d.assertCurrent()
      return "pending"
    }
  }
  const save = async (walletId: string, record: AddressRequestRecord) => {
    d.assertCurrent()
    const saved = await d.save(walletId, record)
    d.assertCurrent()
    return saved
  }
  const observe = async (
    walletId: string,
    view: AddressRequestView,
    status: AddressNameRequestStatus
  ) => {
    if (
      ["received", "approved", "declined"].includes(status) &&
      ["pending", "received"].includes(view.record.phase)
    )
      view = await save(walletId, {
        ...view.record,
        phase: status as "received" | "approved" | "declined",
      })
    return { ...view, status }
  }
  const load = async (walletId: string) => {
    d.assertCurrent()
    const view = await d.load(walletId)
    d.assertCurrent()
    return view
  }
  return {
    load,
    async submit(walletId, input) {
      let view = await load(walletId)
      const retained = !!view
      if (!view) {
        const proof = await d.signWallet(walletId, {
          requestId: input.requestId ?? crypto.randomUUID(),
          desiredName: input.desiredName.trim().toLowerCase(),
          note: "",
          network: "mainnet",
          ownerPubkey: d.owner,
          timestamp: Math.floor(Date.now() / 1000),
        })
        const payload = addressNameRequestPayload(proof)
        const accountProof = JSON.stringify(
          await authorization(payload, ADDRESS_REQUEST_PATH)
        )
        view = await save(walletId, { payload, accountProof, phase: "pending" })
      }
      if (!["pending", "received"].includes(view.record.phase)) return view
      // A retained intent may have reached the gateway even if its HTTP reply
      // or local receipt write was lost. Only authenticated absence permits retry.
      if (retained) {
        const status = await send(walletId, view.record, true)
        if (status !== "not_received") return observe(walletId, view, status)
      }
      const status = await send(walletId, view.record, false, input.token)
      return observe(walletId, view, status)
    },
    async check(walletId) {
      const view = await load(walletId)
      if (!view || !["pending", "received"].includes(view.record.phase))
        return view
      return observe(walletId, view, await send(walletId, view.record, true))
    },
    async activate(walletId, options = {}) {
      const current = () => {
        options.signal?.throwIfAborted()
        d.assertCurrent()
      }
      current()
      let view = await load(walletId)
      if (!view) throw new Error("Restore your saved request first.")
      const request = requestEvidence(view.record)
      if (view.record.phase === "complete")
        return view.publication === "confirmed"
          ? view
          : save(walletId, view.record)
      if (view.record.phase === "declined")
        throw new Error("This request was declined.")
      const progress = (
        activation: NonNullable<AddressRequestView["activation"]>
      ) => {
        current()
        view = { ...view!, activation }
        options.onProgress?.(view)
        return view
      }
      progress({ step: "approval" })
      // A user-authored phase is only a resume hint, including registered progress.
      if ((await send(walletId, view.record, true)) !== "approved")
        throw new Error("Gateway approval could not be confirmed.")
      current()
      // The client owns the locked recovery/race check. A retained intent may
      // retry only with an exact checkpoint proving non-submission/rejection.
      // Missing checkpoints and potentially committed attempts stay read-only.
      const register =
        view.record.phase === "registered"
          ? false
          : view.record.phase === "activating"
            ? "retry"
            : true
      progress({ step: "registration" })
      let address = await d.address(
        walletId,
        register,
        request.desiredName,
        async () => {
          current()
          view = await save(walletId, { ...view!.record, phase: "activating" })
          const fence = await d.authorize?.(walletId, view.record)
          await fence?.()
          current()
          progress({ step: "registration" })
          return async () => {
            await fence?.()
            current()
          }
        },
        options.signal
      )
      for (let recheck = 0; ; recheck++) {
        current()
        const owned =
          address.status === "registered" &&
          address.username === request.desiredName &&
          address.address === `${request.desiredName}@conduit.cash`
        if (
          owned &&
          address.status === "registered" &&
          address.publicLookup === "verified"
        )
          break
        const step = owned ? "public_lookup" : "registration"
        const reason =
          address.status === "unavailable"
            ? address.reason
            : owned && address.status === "registered"
              ? (address.publicFailure ?? "provider_unavailable")
              : address.status === "registered"
                ? "identity_mismatch"
                : "registration_pending"
        const retryable = [
          "rate_limited",
          "provider_unavailable",
          "registration_pending",
          "not_found",
        ].includes(reason)
        const now = (d.now ?? Date.now)()
        const retryAt =
          address.status !== "absent" && address.retryAt
            ? address.retryAt
            : now + [20_000, 40_000, 60_000][Math.min(recheck, 2)]!
        const exhausted = !retryable || recheck >= 3 || retryAt - now > 60_000
        const state = progress({
          step,
          reason,
          retryAt: retryable ? retryAt : undefined,
          exhausted,
          ...(owned && address.status === "registered" ? { address } : {}),
        })
        if (exhausted) return state
        await (d.wait ?? waitForRecheck)(
          Math.max(0, retryAt - now),
          options.signal
        )
        current()
        await d.authorize?.(walletId, view.record)
        current()
        // Rechecks are reads only, including when the original response was lost.
        address = await d.address(
          walletId,
          false,
          request.desiredName,
          undefined,
          options.signal
        )
      }
      if (address.status !== "registered")
        throw new Error("Address verification failed.")
      view = await save(walletId, { ...view.record, phase: "registered" })
      progress({ step: "profile", address })
      current()
      await d.authorize?.(walletId, view.record)
      current()
      // If this fails, next action verifies registration and ONLY resumes profile publication.
      const profileEventId = await d.publishProfile(address.address, current)
      current()
      view = await save(walletId, {
        ...view.record,
        phase: "complete",
        profileEventId,
      })
      return progress({ step: "profile", address })
    },
  }
}
