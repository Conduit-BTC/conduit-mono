import { getAccountSigner } from "../protocol/session-signer"
import {
  type AccountSigner,
  type AccountSignerOperationOptions,
} from "../protocol/nostr-event-signer"
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
  type MarketWalletStore,
} from "./wallet-storage"
import type { SparkRecoveryBundle } from "./spark-recovery-contract"
import type { WalletRegistry } from "./index"

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

export function isCompleteAccountRegistryDiscovery(
  discovery: SparkRecoveryDiscovery
): boolean {
  return (
    !!discovery.registry &&
    discovery.coverage === "complete" &&
    !discovery.invalidCount &&
    !discovery.unresolvedObserved &&
    discovery.state !== "conflict" &&
    discovery.state !== "unresolved"
  )
}

/** Hide cached signer wallets excluded by a verified account snapshot. */
export async function reconcileAccountWalletRegistryMembership(input: {
  signer: AccountSigner
  discovery: SparkRecoveryDiscovery
  network: SparkRecoveryBundle["network"]
  store: Pick<MarketWalletStore, "list" | "getSparkRecovery">
  journal: Pick<
    DexieSparkRecoveryStore,
    "setDeviceRemoved" | "setRegistryExcluded"
  >
}): Promise<void> {
  const { signer, discovery, network, store, journal } = input
  if (!isCompleteAccountRegistryDiscovery(discovery)) return
  const active = new Set(discovery.registry!.activeWalletIds)
  const scoped: string[] = []
  const excluded: string[] = []
  for (const wallet of await store.list()) {
    if (wallet.providerId !== "spark" || wallet.network !== network) continue
    const recovery = await store.getSparkRecovery(wallet.id)
    if (recovery?.type !== "signer" || recovery.ownerPubkey !== signer.pubkey)
      continue
    scoped.push(wallet.id)
    if (!active.has(wallet.id)) excluded.push(wallet.id)
  }
  assertWalletSignerCurrent(signer)
  await journal.setRegistryExcluded(signer.pubkey, scoped, excluded)
  for (const walletId of discovery.registry!.removedWalletIds) {
    assertWalletSignerCurrent(signer)
    await journal.setDeviceRemoved(signer.pubkey, walletId, true)
  }
}

/** Apply account Spark choices only when a device-owned choice is not active. */
export async function applyAccountWalletRegistryDefaults(input: {
  signer: AccountSigner
  discovery: SparkRecoveryDiscovery
  network: SparkRecoveryBundle["network"]
  store: MarketWalletStore
  registry: WalletRegistry
}): Promise<void> {
  const { signer, discovery, network, store, registry } = input
  if (
    !isCompleteAccountRegistryDiscovery(discovery) ||
    discovery.state !== "recoverable"
  )
    return
  const visible = await store.listVisible(signer.pubkey)
  await store.transaction(async () => {
    for (const { walletId, intent } of [
      {
        walletId: discovery.registry!.payInvoiceWalletId,
        intent: "pay_invoice" as const,
      },
      {
        walletId: discovery.registry!.receiveWalletId,
        intent: "receive" as const,
      },
    ]) {
      if (!walletId) continue
      const target = visible.find(
        (wallet) => wallet.id === walletId && wallet.network === network
      )
      if (!target || target.providerId !== "spark") continue
      const targetRecovery = await store.getSparkRecovery(target.id)
      if (
        targetRecovery?.type !== "signer" ||
        targetRecovery.ownerPubkey !== signer.pubkey
      )
        continue
      const current = visible.find(
        (wallet) =>
          wallet.network === network && wallet.defaultIntents.includes(intent)
      )
      if (current && current.id !== target.id) {
        const recovery =
          current.providerId === "spark"
            ? await store.getSparkRecovery(current.id)
            : null
        if (
          recovery?.type !== "signer" ||
          recovery.ownerPubkey !== signer.pubkey
        )
          continue
      }
      assertWalletSignerCurrent(signer)
      await registry.setDefault(target.id, intent)
    }
    assertWalletSignerCurrent(signer)
  })
}

export async function restoreAccountSparkWallets(
  signer: AccountSigner,
  discovery: SparkRecoveryDiscovery,
  network: SparkRecoveryBundle["network"],
  options: AccountSignerOperationOptions = {}
): Promise<Array<{ walletId: string } & SparkRecoveryBundle>> {
  // Old backups remain discoverable for explicit import, but without the
  // current account registry they cannot prove the wallet was not removed.
  if (!isCompleteAccountRegistryDiscovery(discovery)) return []
  if (!discovery.candidates.length) return []
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
    const bundle = await getAccountSparkRecovery(signer).restore(
      candidate,
      undefined,
      options
    )
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
      signer,
      options
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
  options: AccountSignerOperationOptions & { rootBackupEventId?: string } = {}
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
    const discovery = await service.discover(false, bundle.network, options)
    candidate = await service.prepare(
      bundle,
      walletId,
      options.rootBackupEventId ??
        discovery.lineageRootEventId ??
        discovery.primary?.eventId
    )
  }
  const discovery = await service.discover(false, bundle.network, options)
  let pointer = discovery.primaryPointerEventId
  if (!pointer) pointer = await service.preparePrimary(candidate)
  const backup = await service.deliver(candidate.eventId)
  const primary = await service.deliver(pointer)
  if (!backup.ready || !primary.ready) return false
  const latest = await service.discover(false, bundle.network, options)
  if (
    latest.coverage === "complete" &&
    latest.state === "recoverable" &&
    !latest.invalidCount &&
    latest.registry?.activeWalletIds.includes(walletId)
  )
    return latest.registryEventId
      ? (await service.deliver(latest.registryEventId)).ready
      : false
  const registryEventId = await service.prepareRegistry(bundle.network, {
    type: "add",
    walletId,
  })
  return (await service.deliver(registryEventId)).ready
}
