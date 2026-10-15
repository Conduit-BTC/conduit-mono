import type { AccountSigner } from "../protocol/nostr-event-signer"
import type { ConduitAppId } from "../protocol/nip89"
import {
  fetchProfileContext,
  getProfileLightningAddress,
  publishProfileContext,
} from "../protocol/profiles"
import {
  getAccountAddressRequestService,
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
import { requestEvidence } from "./address-request-record"

const paused = new WeakSet<AccountSigner>()
const checked = new WeakMap<AccountSigner, Set<string>>()
export function accountAddressRequests(
  signer: AccountSigner,
  appId: ConduitAppId
): AddressRequestWorkflow {
  const writesEnabled =
    import.meta.env?.VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED !== "false"
  const assertWritesEnabled = () => {
    if (!writesEnabled)
      throw new Error("Name requests are temporarily unavailable.")
  }
  const service = getAccountSparkRecovery(signer)
  const metadata = getAccountAddressRequestService(signer)
  const current = () => assertWalletSignerCurrent(signer)
  const manager = () => {
    current()
    const value = getSparkWalletManager()
    if (!value) throw new Error("Open this wallet to continue.")
    return value
  }
  const viewOf = async (
    discovery: SparkRecoveryDiscovery,
    walletId: string,
    priority: "foreground" | "background"
  ): Promise<AddressRequestView | undefined> => {
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
    const saved = await metadata.load("mainnet", discovery, { priority })
    const record = saved.records[walletId]
    return record
      ? {
          record,
          publication: saved.confirmed ? "confirmed" : "local",
          sync: saved.diagnosis,
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
          walletId,
          priority
        )
      },
      async save(walletId, record) {
        assertWritesEnabled()
        const discovery = await service.discover(false, "mainnet", {
          priority,
        })
        const candidate = discovery.candidates.find(
          (value) =>
            value.walletId === walletId &&
            value.network === "mainnet" &&
            value.source === "conduit_v1"
        )
        if (!candidate)
          throw new Error("Wallet recovery evidence is unavailable.")
        const backup = await service.restore(candidate, undefined, { priority })
        if (
          !("identityPublicKey" in backup) ||
          backup.identityPublicKey !== requestEvidence(record).sparkIdentity
        )
          throw new Error("Wallet identity does not match the signed request.")
        const saved = await metadata.save(
          "mainnet",
          discovery,
          walletId,
          record,
          { priority }
        )
        return {
          record: saved.records[walletId],
          publication: saved.confirmed ? "confirmed" : "local",
          sync: saved.diagnosis,
        }
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
    writesEnabled,
    load: (walletId) =>
      runAccountWalletSetup(signer, async () => {
        const view = await background.load(walletId)
        if (
          !writesEnabled ||
          !view ||
          !["pending", "received"].includes(view.record.phase)
        )
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
    submit: (walletId, input) => {
      assertWritesEnabled()
      return runAccountWalletSetup(signer, () =>
        workflow.submit(walletId, input)
      )
    },
    check: (walletId) =>
      runAccountWalletSetup(signer, () => workflow.check(walletId)),
    activate: (walletId) => {
      assertWritesEnabled()
      return runAccountWalletSetup(signer, () => workflow.activate(walletId))
    },
  }
}

/** Called after normal account registry restoration, without changing wallet availability. */
export async function restoreAddressRequests(
  signer: AccountSigner,
  discovery: SparkRecoveryDiscovery,
  appId: ConduitAppId
): Promise<void> {
  if (!discovery.registry) return
  const saved = await getAccountAddressRequestService(signer).load(
    "mainnet",
    discovery,
    { priority: "background" }
  )
  const ids = Object.entries(saved.records)
    .filter(([, record]) => ["pending", "received"].includes(record.phase))
    .map(([id]) => id)
    .slice(0, 3)
  for (const walletId of ids)
    await accountAddressRequests(signer, appId).load(walletId)
}
