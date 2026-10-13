import type { AccountSigner } from "../protocol/nostr-event-signer"
import type { ConduitAppId } from "../protocol/nip89"
import {
  fetchProfileContext,
  getProfileLightningAddress,
  publishProfileContext,
} from "../protocol/profiles"
import {
  getAccountSparkRecovery,
  runAccountWalletSetup,
} from "./account-spark-recovery"
import { assertWalletSignerCurrent } from "./signer-spark-recovery"
import { getSparkWalletManager } from "./spark-sdk"
import {
  createAddressRequestWorkflow,
  type AddressRequestWorkflow,
  type AddressRequestView,
} from "./address-request-workflow"
import type { SparkRecoveryDiscovery } from "./spark-recovery-service"

const paused = new WeakSet<AccountSigner>()
const checked = new WeakMap<AccountSigner, Set<string>>()
export function accountAddressRequests(
  signer: AccountSigner,
  appId: ConduitAppId
): AddressRequestWorkflow {
  const service = getAccountSparkRecovery(signer)
  const current = () => assertWalletSignerCurrent(signer)
  const manager = () => {
    current()
    const value = getSparkWalletManager()
    if (!value) throw new Error("Open this wallet to continue.")
    return value
  }
  const viewOf = (
    discovery: SparkRecoveryDiscovery,
    walletId: string
  ): AddressRequestView | undefined => {
    if (
      discovery.state === "conflict" ||
      discovery.state === "unresolved" ||
      discovery.invalidCount ||
      discovery.unresolvedObserved
    )
      throw new Error(
        "Wallet sync needs attention before changing this request."
      )
    if (!discovery.registry && discovery.coverage !== "complete")
      throw new Error("Saved requests are unavailable. Retry wallet sync.")
    const registry = discovery.registry
    if (
      !registry?.activeWalletIds.includes(walletId) ||
      registry.removedWalletIds.includes(walletId)
    )
      return undefined
    const record = registry.addressNameRequests?.[walletId]
    return record
      ? {
          record,
          publication: discovery.registryMembershipReady
            ? "confirmed"
            : "local",
        }
      : undefined
  }
  const makeWorkflow = (priority: "foreground" | "background") =>
    createAddressRequestWorkflow({
      owner: signer.pubkey,
      assertCurrent: current,
      async load(walletId) {
        return viewOf(
          await service.discover(false, "mainnet", { priority }),
          walletId
        )
      },
      async save(walletId, record) {
        let discovery = await service.discover(false, "mainnet", {
          priority,
        })
        if (discovery.registryEventId && !discovery.registryMembershipReady) {
          const result = await service.deliver(discovery.registryEventId, {
            priority,
          })
          if (!result.ready) {
            const existing = viewOf(discovery, walletId)
            if (
              existing &&
              JSON.stringify(existing.record) === JSON.stringify(record)
            )
              return existing
            throw new Error(
              "Wallet progress is saved locally. Finish syncing it before continuing."
            )
          }
        }
        const eventId = await service.prepareRegistry(
          "mainnet",
          {
            type: "address_request",
            walletId,
            record,
          },
          undefined,
          { priority }
        )
        await service.deliver(eventId, { priority })
        discovery = await service.discover(false, "mainnet", {
          priority,
        })
        const view = viewOf(discovery, walletId)
        if (!view) throw new Error("Saved request could not be restored.")
        return view
      },
      signWallet: (walletId, input) =>
        manager().signAddressNameRequest(walletId, input),
      signAccount: (draft) => signer.signEvent(draft, { priority }),
      fetch: (...args) => fetch(...args),
      address: (walletId, register, name) =>
        manager().getLightningAddress(walletId, register, name, "conduit.cash"),
      async publishProfile(address) {
        const options = {
          accountPubkey: signer.pubkey,
          authenticatedPubkey: signer.pubkey,
          shouldContinue: () => {
            current()
            return true
          },
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "profile_edit" as const,
        }
        const before = await fetchProfileContext(signer.pubkey, options)
        current()
        if (
          before.frontier?.validity === "valid" &&
          before.freshness === "observed" &&
          getProfileLightningAddress(JSON.parse(before.frontier.rawContent)) ===
            address
        )
          return before.frontier.eventId
        const published = await publishProfileContext(
          { lud16: address },
          appId,
          {
            ...options,
            expectedLightningAddress: getProfileLightningAddress(
              before.profile
            ),
          }
        )
        const after = await fetchProfileContext(signer.pubkey, options)
        current()
        if (
          after.freshness !== "observed" ||
          after.frontier?.validity !== "valid" ||
          after.frontier.eventId !== published.frontier?.eventId ||
          getProfileLightningAddress(JSON.parse(after.frontier.rawContent)) !==
            address
        )
          throw new Error(
            "Address activated. Profile publication still needs confirmation."
          )
        return after.frontier.eventId
      },
    })
  const workflow = makeWorkflow("foreground")
  const background = makeWorkflow("background")
  return {
    load: (walletId) =>
      runAccountWalletSetup(signer, async () => {
        const view = await background.load(walletId)
        if (!view || !["pending", "received"].includes(view.record.phase))
          return view
        let attempts = checked.get(signer)
        if (!attempts) {
          attempts = new Set()
          checked.set(signer, attempts)
        }
        const key = walletId + ":" + view.record.payload
        // At most three automatic checks per signer session, one per saved request.
        if (paused.has(signer) || attempts.has(key) || attempts.size >= 3)
          return view
        attempts.add(key)
        try {
          return await background.check(walletId)
        } catch {
          paused.add(signer)
          return view
        }
      }),
    submit: (walletId, input) =>
      runAccountWalletSetup(signer, () => workflow.submit(walletId, input)),
    check: (walletId) =>
      runAccountWalletSetup(signer, () => workflow.check(walletId)),
    activate: (walletId) =>
      runAccountWalletSetup(signer, () => workflow.activate(walletId)),
  }
}

/** Called after normal account registry restoration, without changing wallet availability. */
export async function restoreAddressRequests(
  signer: AccountSigner,
  discovery: SparkRecoveryDiscovery,
  appId: ConduitAppId
): Promise<void> {
  const ids = Object.entries(discovery.registry?.addressNameRequests ?? {})
    .filter(([, record]) => ["pending", "received"].includes(record.phase))
    .map(([id]) => id)
    .slice(0, 3)
  for (const walletId of ids)
    await accountAddressRequests(signer, appId).load(walletId)
}
