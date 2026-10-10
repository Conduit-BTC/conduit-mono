import { getAccountSigner } from "../protocol/session-signer"
import { type AccountSigner } from "../protocol/nostr-event-signer"
import { getProtectedReadAuthorization } from "../protocol/protected-read-authorization"
import {
  publishWithPlanner,
  getRelayPublishTargetStatus,
  RelayPublishDiagnosticsError,
} from "../protocol/relay-publish"
import {
  SparkRecoveryService,
  type SparkRecoveryDiscovery,
  type SparkRecoveryCandidate,
} from "./spark-recovery-service"
import { DexieSparkRecoveryStore } from "./spark-recovery-store"
import { createSparkRecoveryReader } from "./spark-recovery-read"
import { deriveSparkRecoveryIdentity } from "./spark-sdk"
import {
  sealSignerSparkRecovery,
  assertWalletSignerCurrent,
} from "./signer-spark-recovery"
import {
  getMarketWalletStore,
  getMarketWalletRegistry,
  registerSparkWalletAtomically,
} from "./wallet-storage"
import type { SparkRecoveryBundle } from "./spark-recovery-contract"

const services = new WeakMap<AccountSigner, SparkRecoveryService>()
export function getAccountSparkRecovery(
  signer: AccountSigner
): SparkRecoveryService {
  let service = services.get(signer)
  if (service) return service
  service = new SparkRecoveryService({
    signer,
    store: new DexieSparkRecoveryStore(),
    deriveIdentity: deriveSparkRecoveryIdentity,
    transport: {
      read: createSparkRecoveryReader(),
      async publish(url, event, shouldContinue) {
        if (!shouldContinue()) return "cancelled"
        if (
          !getProtectedReadAuthorization(signer.pubkey) ||
          getAccountSigner() !== signer
        )
          return "auth_required"
        try {
          const result = await publishWithPlanner(event, {
            intent: "author_event",
            authorPubkey: signer.pubkey,
            authenticatedPubkey: signer.pubkey,
            accountPubkey: signer.pubkey,
            exclusiveRelayUrls: [url],
            relayTargets: [
              {
                url,
                grants: [{ kind: "source_delivery", operation: "write" }],
              },
            ],
            deliveryMode: "critical",
            shouldContinue,
            relayAuthentication: {
              expectedPubkey: signer.pubkey,
              signer,
              sessionScope: signer,
            },
          })
          return getRelayPublishTargetStatus(result, url) === "acked"
            ? "acked"
            : "error"
        } catch (error) {
          if (!shouldContinue()) return "cancelled"
          if (error instanceof RelayPublishDiagnosticsError) {
            const status = getRelayPublishTargetStatus(error.diagnostics, url)
            if (
              status === "rejected" ||
              status === "timed_out" ||
              status === "auth_required" ||
              status === "policy_blocked"
            )
              return status
          }
          return "error"
        }
      },
    },
  })
  services.set(signer, service)
  return service
}

/** Origin-local serialization only; independent origins retain conflicting signed candidates. */
export async function runAccountWalletSetup<T>(
  signer: AccountSigner,
  operation: () => Promise<T>
): Promise<T> {
  assertWalletSignerCurrent(signer)
  return navigator.locks.request(
    `conduit:account-wallet-setup:${signer.pubkey}`,
    async () => {
      assertWalletSignerCurrent(signer)
      return operation()
    }
  )
}

export function assertWalletCreationDiscovery(
  discovery: SparkRecoveryDiscovery,
  resolvedAddyEventIds: readonly string[] = []
): void {
  if (
    discovery.candidates.some(
      (candidate) =>
        candidate.source === "addy" &&
        !candidate.resolved &&
        !resolvedAddyEventIds.includes(candidate.eventId)
    )
  )
    throw new Error(
      "An Addy recovery backup needs its original network and Spark account number. Import that recovery phrase with those details before creating another wallet."
    )
  if (
    discovery.coverage !== "complete" ||
    discovery.invalidCount ||
    discovery.unresolvedObserved ||
    discovery.state === "conflict" ||
    discovery.state === "unresolved"
  ) {
    throw new Error(
      "Wallet recovery is incomplete or conflicting. Retry recovery before creating or importing another wallet."
    )
  }
}

export async function restoreAccountSparkWallets(
  signer: AccountSigner,
  discovery: SparkRecoveryDiscovery,
  network: SparkRecoveryBundle["network"]
): Promise<Array<{ walletId: string } & SparkRecoveryBundle>> {
  assertWalletSignerCurrent(signer)
  const store = getMarketWalletStore()
  const registry = getMarketWalletRegistry()
  const removed = new Set(
    (await new DexieSparkRecoveryStore().load(signer.pubkey))
      .removedWalletIds ?? []
  )
  const restored: Array<{ walletId: string } & SparkRecoveryBundle> = []
  for (const candidate of discovery.candidates) {
    if (
      candidate.source !== "conduit_v1" ||
      !candidate.walletId ||
      removed.has(candidate.walletId)
    )
      continue
    if (
      (await store.listVisible(signer.pubkey)).some(
        (wallet) => wallet.id === candidate.walletId
      )
    )
      continue
    const bundle = await getAccountSparkRecovery(signer).restore(candidate)
    if (!("walletId" in bundle) || bundle.network !== network) continue
    assertWalletSignerCurrent(signer)
    const recovery = await sealSignerSparkRecovery(
      bundle.mnemonic,
      {
        walletId: bundle.walletId,
        providerId: "spark",
        network: bundle.network,
        accountNumber: bundle.accountNumber,
      },
      signer
    )
    const registration = await registerSparkWalletAtomically({
      store,
      recovery,
      findExisting: async () => {
        for (const wallet of await store.listVisible(signer.pubkey)) {
          if (wallet.providerId !== "spark") continue
          const stored = await store.getSparkRecovery(wallet.id)
          if (
            stored?.type === "signer" &&
            stored.identityKey === recovery.identityKey
          )
            return wallet
        }
        return undefined
      },
      shouldContinue: () => getAccountSigner() === signer,
      register: () =>
        registry.add({
          id: bundle.walletId,
          kind: "portable",
          providerId: "spark",
          network: bundle.network,
          label: "Conduit Wallet",
          capabilities: [
            "pay_invoice",
            "receive",
            "balance",
            "history",
            "spark_transfer",
          ],
        }),
    })
    assertWalletSignerCurrent(signer)
    // Receiving recovery never chooses a spending default or changes the profile.
    restored.push({ ...bundle, walletId: registration.id })
  }
  return restored
}

/** Retain exact encrypted backup before delivery; retry never generates another wallet. */
export async function backUpAccountSparkWallet(
  signer: AccountSigner,
  walletId: string,
  bundle: SparkRecoveryBundle,
  lineage?: { rootBackupEventId?: string }
): Promise<boolean> {
  const service = getAccountSparkRecovery(signer)
  const store = new DexieSparkRecoveryStore()
  let candidate: SparkRecoveryCandidate | undefined
  for (const record of (await store.load(signer.pubkey)).records) {
    if (
      record.event.tags.some(
        (tag) =>
          tag[0] === "d" && tag[1] === `conduit:spark:wallet:v1:${walletId}`
      )
    )
      candidate = { walletId, eventId: record.event.id, source: "conduit_v1" }
  }
  if (!candidate) {
    const discovery = await service.discover(false, bundle.network)
    candidate = await service.prepare(
      bundle,
      walletId,
      lineage
        ? lineage.rootBackupEventId
        : (discovery.lineageRootEventId ?? discovery.primary?.eventId)
    )
  }
  const discovery = await service.discover(false, bundle.network)
  let pointer = discovery.primaryPointerEventId
  if (!pointer) pointer = await service.preparePrimary(candidate)
  const backup = await service.deliver(candidate.eventId)
  const primary = await service.deliver(pointer)
  return backup.ready && primary.ready
}
