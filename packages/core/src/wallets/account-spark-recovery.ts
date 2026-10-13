import { DexieWalletNameStore } from "./wallet-name-store"
import { WalletNameService } from "./wallet-name-service"
import type { WalletNameNetwork } from "./wallet-name-contract"
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
  accountRegistryReadiness,
  SparkRecoveryService,
  type SparkRecoveryDiscovery,
  type SparkRecoveryCandidate,
  type SparkRecoveryTransport,
} from "./spark-recovery-service"
import { DexieSparkRecoveryStore } from "./spark-recovery-store"
import { createSparkRecoveryReader } from "./spark-recovery-read"
import { isSparkWalletRegistryDTag } from "./spark-recovery-address"
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
import type { WalletDescriptor, WalletRegistry } from "./index"

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
    transport: createAccountWalletTransport(signer),
  })
  services.set(signer, service)
  return service
}

function createAccountWalletTransport(
  signer: AccountSigner
): SparkRecoveryTransport {
  return {
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
  }
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
    discovery.registryMembershipReady === true &&
    discovery.coverage === "complete" &&
    !discovery.invalidCount &&
    !discovery.unresolvedObserved &&
    discovery.state !== "conflict" &&
    discovery.state !== "unresolved"
  )
}

/** Publish one bounded legacy membership snapshot before automatic restore. */
export async function bootstrapLegacyAccountWalletRegistry(input: {
  signer: AccountSigner
  discovery: SparkRecoveryDiscovery
  network: SparkRecoveryBundle["network"]
  service: SparkRecoveryService
  store: Pick<MarketWalletStore, "list">
  journal: Pick<DexieSparkRecoveryStore, "load">
  options?: AccountSignerOperationOptions
}): Promise<{
  discovery: SparkRecoveryDiscovery
  attempted: boolean
  ready: boolean
}> {
  const { signer, discovery, network, service, store, journal, options } = input
  const candidates = discovery.candidates.filter(
    (candidate) => candidate.source === "conduit_v1"
  )
  if (
    discovery.registry ||
    discovery.coverage !== "complete" ||
    discovery.state !== "recoverable" ||
    discovery.invalidCount ||
    discovery.unresolvedObserved ||
    discovery.candidates.some(
      (candidate) => candidate.source === "addy" && !candidate.resolved
    ) ||
    !candidates.length ||
    candidates.some(
      (candidate) => !candidate.walletId || candidate.network !== network
    )
  )
    return { discovery, attempted: false, ready: false }
  const state = await journal.load(signer.pubkey)
  if (
    state.registryExcludedWalletIds?.length ||
    state.records.some((record) =>
      record.event.tags.some(
        (tag) => tag[0] === "d" && isSparkWalletRegistryDTag(tag[1])
      )
    )
  )
    return { discovery, attempted: false, ready: false }
  const knownIds = new Set(candidates.map((candidate) => candidate.walletId))
  const localWallets = await store.list()
  for (const walletId of state.removedWalletIds ?? []) {
    if (knownIds.has(walletId)) continue
    const wallet = localWallets.find((candidate) => candidate.id === walletId)
    if (!wallet || wallet.network === network)
      return { discovery, attempted: false, ready: false }
  }
  // Restore validates the signed envelope and the native Spark identity,
  // including the account number and network, without registering a wallet.
  for (const candidate of candidates) {
    assertWalletSignerCurrent(signer)
    const envelope = await service.restore(candidate, undefined, options)
    if (
      !("walletId" in envelope) ||
      envelope.walletId !== candidate.walletId ||
      envelope.network !== network
    )
      return { discovery, attempted: false, ready: false }
  }
  assertWalletSignerCurrent(signer)
  const eventId = await service.prepareRegistry(network, { type: "bootstrap" })
  if (!(await service.deliver(eventId, options)).ready)
    return { discovery, attempted: true, ready: false }
  const current = await service.discover(false, network, options)
  return {
    discovery: current,
    attempted: true,
    ready: isCompleteAccountRegistryDiscovery(current),
  }
}

/** Apply explicit signed removals without hiding a local add awaiting publication. */
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
  // A local signed snapshot can precede relay delivery. Only confirmed
  // removals may hide a registered wallet; older confirmations remain sticky.
  const removed = new Set(discovery.confirmedRemovedWalletIds ?? [])
  if (!removed.size && !discovery.registryMembershipReady) return
  const scoped: string[] = []
  const excluded: string[] = []
  for (const wallet of await store.list()) {
    if (wallet.providerId !== "spark" || wallet.network !== network) continue
    const recovery = await store.getSparkRecovery(wallet.id)
    if (recovery?.type !== "signer" || recovery.ownerPubkey !== signer.pubkey)
      continue
    scoped.push(wallet.id)
    if (removed.has(wallet.id)) excluded.push(wallet.id)
  }
  assertWalletSignerCurrent(signer)
  await journal.setRegistryExcluded(signer.pubkey, scoped, excluded)
  for (const walletId of removed) {
    assertWalletSignerCurrent(signer)
    await journal.setDeviceRemoved(signer.pubkey, walletId, true)
  }
}

/** Local signer credentials remain usable after a completed sync attempt, even
 * while relay backup redundancy is pending. Visibility applies known removals. */
export async function listAutomaticSignerSparkWallets(input: {
  signer: AccountSigner
  network: SparkRecoveryBundle["network"]
  recoverySync: "idle" | "checking" | "ready" | "pending" | "blocked"
  store: Pick<MarketWalletStore, "listVisible" | "getSparkRecovery">
  deliberatelyLockedIds?: ReadonlySet<string>
}): Promise<WalletDescriptor[]> {
  const { signer, network, recoverySync, store, deliberatelyLockedIds } = input
  if (recoverySync === "idle" || recoverySync === "checking") return []
  assertWalletSignerCurrent(signer)
  const visible = await store.listVisible(signer.pubkey)
  const candidates: WalletDescriptor[] = []
  for (const wallet of visible) {
    if (
      wallet.providerId !== "spark" ||
      wallet.network !== network ||
      deliberatelyLockedIds?.has(wallet.id)
    )
      continue
    const recovery = await store.getSparkRecovery(wallet.id)
    assertWalletSignerCurrent(signer)
    if (recovery?.type === "signer" && recovery.ownerPubkey === signer.pubkey)
      candidates.push(wallet)
  }
  return candidates
}

/** Seed an empty device from the explicit main choice, preserving local choices. */
export async function applyAccountWalletRegistryDefaults(input: {
  signer: AccountSigner
  discovery: SparkRecoveryDiscovery
  network: SparkRecoveryBundle["network"]
  store: MarketWalletStore
  registry: WalletRegistry
}): Promise<void> {
  const { signer, discovery, network, store, registry } = input
  const mainWalletId = discovery.mainChoiceWalletId
  if (
    !isCompleteAccountRegistryDiscovery(discovery) ||
    discovery.state !== "recoverable" ||
    !mainWalletId
  )
    return
  const visible = await store.listVisible(signer.pubkey)
  await store.transaction(async () => {
    for (const { walletId, intent } of [
      {
        walletId: mainWalletId,
        intent: "pay_invoice" as const,
      },
      {
        walletId: mainWalletId,
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
      if (current) continue
      assertWalletSignerCurrent(signer)
      await registry.setDefault(target.id, intent)
    }
    assertWalletSignerCurrent(signer)
  })
}

interface AccountWalletNameSyncInput {
  signer: AccountSigner
  network: WalletNameNetwork
  store: Pick<
    MarketWalletStore,
    "listVisible" | "getSparkRecovery" | "rename" | "transaction"
  >
  names?: DexieWalletNameStore
  service?: WalletNameService
  options?: AccountSignerOperationOptions
  seedExisting?: boolean
}

/** Recovery writes may advance membership. Never reuse their pre-write snapshot. */
export async function synchronizeAccountWalletNamesAfterRecovery(
  input: AccountWalletNameSyncInput & {
    recoveryService?: Pick<SparkRecoveryService, "discover">
  }
): Promise<{ discovery: SparkRecoveryDiscovery; ready: boolean }> {
  assertWalletSignerCurrent(input.signer)
  const recovery =
    input.recoveryService ?? getAccountSparkRecovery(input.signer)
  const discovery = await recovery.discover(false, input.network, input.options)
  assertWalletSignerCurrent(input.signer)
  const ready = await synchronizeAccountWalletNames({ ...input, discovery })
  return { discovery, ready }
}

/** Optional name synchronization cannot invalidate otherwise usable wallet recovery. */
export async function synchronizeAccountWalletNames(
  input: AccountWalletNameSyncInput & { discovery: SparkRecoveryDiscovery }
): Promise<boolean> {
  const { signer, discovery, network, store, options = {} } = input
  const names = input.names ?? new DexieWalletNameStore()
  if (!isCompleteAccountRegistryDiscovery(discovery)) return false
  const service =
    input.service ??
    new WalletNameService({
      signer,
      store: names,
      transport: createAccountWalletTransport(signer),
    })
  try {
    let result = await service.sync(network, discovery, options)
    assertWalletSignerCurrent(signer)
    if (input.seedExisting && result.ready) {
      const active = new Set(discovery.registry?.activeWalletIds)
      const missing = (await store.listVisible(signer.pubkey)).filter(
        (wallet) =>
          wallet.providerId === "spark" &&
          wallet.network === network &&
          active.has(wallet.id) &&
          !result.names[wallet.id]
      )
      const eligible = await Promise.all(
        missing.map(async (wallet) => {
          const recovery = await store.getSparkRecovery(wallet.id)
          return recovery?.type === "signer" &&
            recovery.ownerPubkey === signer.pubkey
            ? wallet
            : undefined
        })
      )
      assertWalletSignerCurrent(signer)
      await names.update(signer.pubkey, network, (current) => {
        const pending = { ...current.pending }
        for (const wallet of eligible)
          if (wallet && !pending[wallet.id])
            pending[wallet.id] = {
              name: wallet.label,
              token: crypto.randomUUID(),
            }
        return { ...current, pending }
      })
      result = await service.sync(network, discovery, options)
    }
    if (!result.ready) return false
    await store.transaction(async () => {
      const pending = (await names.load(signer.pubkey, network)).pending
      for (const wallet of await store.listVisible(signer.pubkey)) {
        const name = result.names[wallet.id]
        if (
          !name ||
          pending[wallet.id] ||
          name === wallet.label ||
          wallet.providerId !== "spark" ||
          wallet.network !== network
        )
          continue
        const recovery = await store.getSparkRecovery(wallet.id)
        if (
          recovery?.type !== "signer" ||
          recovery.ownerPubkey !== signer.pubkey
        )
          continue
        assertWalletSignerCurrent(signer)
        await store.rename(wallet.id, name)
      }
      assertWalletSignerCurrent(signer)
    })
    return true
  } catch {
    assertWalletSignerCurrent(signer)
    return false
  }
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
  const backup = await service.deliver(candidate.eventId, options)
  const primary = await service.deliver(pointer, options)
  // Account membership can advance only after every planned relay confirms
  // both encrypted recovery references. Backup durability remains a separate
  // two-operator (or explicit export) readiness decision.
  const delivered = (await store.load(signer.pubkey)).records
  if (
    ![candidate.eventId, pointer].every((eventId) => {
      const record = delivered.find((item) => item.event.id === eventId)
      return record && accountRegistryReadiness(record).ready
    })
  )
    return false
  const latest = await service.discover(false, bundle.network, options)
  if (
    latest.coverage === "complete" &&
    latest.state === "recoverable" &&
    !latest.invalidCount &&
    latest.registry?.activeWalletIds.includes(walletId)
  )
    return latest.registryEventId
      ? (await service.deliver(latest.registryEventId, options)).ready &&
          backup.ready &&
          primary.ready
      : false
  const registryEventId = await service.prepareRegistry(bundle.network, {
    type: "add",
    walletId,
  })
  const ready =
    (await service.deliver(registryEventId, options)).ready &&
    backup.ready &&
    primary.ready
  if (ready)
    await synchronizeAccountWalletNames({
      signer,
      discovery: await service.discover(false, bundle.network, options),
      network: bundle.network,
      store: getMarketWalletStore(),
      options,
      seedExisting: true,
    })
  return ready
}
