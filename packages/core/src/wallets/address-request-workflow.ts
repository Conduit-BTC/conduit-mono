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
}
export interface AddressRequestWorkflowDependencies {
  owner: string
  assertCurrent(): void
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
    register: boolean,
    name: string
  ): Promise<BreezAddressState>
  publishProfile(address: string): Promise<string>
}
export interface AddressRequestWorkflow {
  /** Rollout gate; readers deploy before any extended registry write. */
  writesEnabled?: boolean
  load(walletId: string): Promise<AddressRequestView | undefined>
  submit(
    walletId: string,
    input: { desiredName: string; token: string; requestId?: string }
  ): Promise<AddressRequestView>
  check(walletId: string): Promise<AddressRequestView | undefined>
  activate(walletId: string): Promise<AddressRequestView>
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
    record: AddressRequestRecord,
    check: boolean,
    token?: string
  ): Promise<AddressNameRequestStatus> => {
    const path = ADDRESS_REQUEST_PATH + (check ? "/status" : "")
    const event = await authorization(record.payload, path)
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
      // Retrying an unsynced intent repairs the exact registry event first.
      if (view.publication !== "confirmed")
        view = await save(walletId, view.record)
      if (view.publication !== "confirmed")
        throw new Error(
          "Request saved on this device. Finish wallet sync before submitting."
        )
      const status = await send(view.record, false, input.token)
      return observe(walletId, view, status)
    },
    async check(walletId) {
      const view = await load(walletId)
      if (!view || !["pending", "received"].includes(view.record.phase))
        return view
      return observe(walletId, view, await send(view.record, true))
    },
    async activate(walletId) {
      let view = await load(walletId)
      if (!view) throw new Error("Restore your saved request first.")
      const request = requestEvidence(view.record)
      if (view.record.phase === "complete")
        return view.publication === "confirmed"
          ? view
          : save(walletId, view.record)
      if (view.record.phase === "declined")
        throw new Error("This request was declined.")
      // A user-authored phase is only a resume hint, including registered progress.
      if ((await send(view.record, true)) !== "approved")
        throw new Error("Gateway approval could not be confirmed.")
      // Verify current provider state before deciding whether registration is needed.
      let address = await d.address(walletId, false, request.desiredName)
      d.assertCurrent()
      if (address.status !== "registered") {
        if (view.record.phase === "registered")
          throw new Error(
            "The activated address could not be verified. Retry its lookup."
          )
        if (address.status !== "absent")
          throw new Error(
            "Address lookup is unavailable. Your existing address is preserved."
          )
        view = await save(walletId, { ...view.record, phase: "activating" })
        if (view.publication !== "confirmed")
          throw new Error(
            "Activation intent is saved on this device. Finish wallet sync to continue."
          )
        address = await d.address(walletId, true, request.desiredName)
        d.assertCurrent()
      }
      if (
        address.status !== "registered" ||
        address.username !== request.desiredName ||
        address.address !== `${request.desiredName}@conduit.cash` ||
        address.publicLookup !== "verified"
      )
        throw new Error(
          "The approved address is not yet verified. Your existing address is preserved."
        )
      view = await save(walletId, { ...view.record, phase: "registered" })
      // If this fails, next action verifies registration and ONLY resumes profile publication.
      const profileEventId = await d.publishProfile(address.address)
      d.assertCurrent()
      return save(walletId, {
        ...view.record,
        phase: "complete",
        profileEventId,
      })
    },
  }
}
