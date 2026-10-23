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
import {
  openSignerSparkRecovery,
  assertWalletSignerCurrent,
} from "./signer-spark-recovery"
import { deriveSparkRecoveryIdentity, getSparkWalletManager } from "./spark-sdk"
import {
  createAddressRequestWorkflow,
  type AddressRequestWorkflow,
} from "./address-request-workflow"
import type { SparkRecoveryDiscovery } from "./spark-recovery-service"
import {
  mergeAddressRequestRecord,
  requestEvidence,
  type AddressRequestRecord,
} from "./address-request-record"
import { getMarketWalletStore } from "./wallet-storage"
import { DexieSparkRecoveryStore } from "./spark-recovery-store"
import { parseSparkWalletRegistrySnapshot } from "./spark-wallet-registry"
import { isSparkWalletRegistryDTag } from "./spark-recovery-address"

const paused = new WeakSet<AccountSigner>()
const checked = new WeakMap<AccountSigner, Set<string>>()
export function accountAddressRequests(
  signer: AccountSigner,
  appId: ConduitAppId,
  dependencies: {
    recovery?: ReturnType<typeof getAccountSparkRecovery>
    metadata?: ReturnType<typeof getAccountAddressRequestService>
    store?: ReturnType<typeof getMarketWalletStore>
    journal?: DexieSparkRecoveryStore
    manager?: Pick<
      NonNullable<ReturnType<typeof getSparkWalletManager>>,
      "getAddressIdentity" | "signAddressNameRequest" | "getLightningAddress"
    >
    fetch?: typeof fetch
  } = {}
): AddressRequestWorkflow {
  const writesEnabled =
    import.meta.env?.VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED !== "false"
  const assertWritesEnabled = () => {
    if (!writesEnabled)
      throw new Error("Name requests are temporarily unavailable.")
  }
  const service = dependencies.recovery ?? getAccountSparkRecovery(signer)
  const metadata =
    dependencies.metadata ?? getAccountAddressRequestService(signer)
  const walletStore = dependencies.store ?? getMarketWalletStore()
  const journalStore = dependencies.journal ?? new DexieSparkRecoveryStore()
  const current = () => assertWalletSignerCurrent(signer)
  const manager = () => {
    current()
    const value = dependencies.manager ?? getSparkWalletManager()
    if (!value) throw new Error("Open this wallet to continue.")
    return value
  }
  const createAuthorization = (priority: "foreground" | "background") => {
    // Decrypted evidence belongs to one action, never a later action or session.
    let verified:
      | {
          walletId: string
          recovery: string
          records: string
          identity: string
          removedWalletIds: string[]
        }
      | undefined
    return async (
      walletId: string,
      record?: AddressRequestRecord,
      refresh = true
    ) => {
      current()
      const store = walletStore
      const [wallets, recovery, journal] = await Promise.all([
        store.list(),
        store.getSparkRecovery(walletId),
        journalStore.load(signer.pubkey),
      ])
      const wallet = wallets.find((wallet) => wallet.id === walletId)
      if (
        !wallet ||
        wallet.providerId !== "spark" ||
        wallet.network !== "mainnet" ||
        recovery?.type !== "signer" ||
        recovery.ownerPubkey !== signer.pubkey ||
        journal.removedWalletIds?.includes(walletId) ||
        journal.registryExcludedWalletIds?.includes(walletId)
      )
        throw new Error(
          "Open an available wallet owned by this Nostr identity."
        )
      const recoveryKey = JSON.stringify(recovery)
      const recordsKey = JSON.stringify(
        journal.records.map(({ event }) => event.id)
      )
      if (
        verified?.walletId !== walletId ||
        verified.recovery !== recoveryKey ||
        verified.records !== recordsKey
      ) {
        // After proof signing, changed evidence must stop delivery, not decrypt again.
        if (!refresh) throw new Error("Wallet authorization changed.")
        verified = undefined
        const mnemonic = await openSignerSparkRecovery(
          recovery,
          {
            walletId,
            providerId: "spark",
            network: wallet.network,
            accountNumber: recovery.accountNumber,
          },
          signer,
          { priority }
        )
        const identity = await deriveSparkRecoveryIdentity({
          mnemonic,
          network: wallet.network,
          accountNumber: recovery.accountNumber,
        })
        // Retained signed evidence remains authoritative even while discovery is partial.
        const removedWalletIds = new Set<string>()
        for (const item of journal.records) {
          if (
            item.event.tags.some(
              (tag) => tag[0] === "d" && isSparkWalletRegistryDTag(tag[1])
            )
          ) {
            const snapshot = parseSparkWalletRegistrySnapshot(
              await signer.decryptNip44(signer.pubkey, item.event.content, {
                priority,
              }),
              item.event
            )
            current()
            if (snapshot.network === "mainnet")
              for (const id of snapshot.removedWalletIds)
                removedWalletIds.add(id)
            if (snapshot.removedWalletIds.includes(walletId))
              throw new Error("This wallet registration was removed.")
          }
          if (
            !item.event.tags.some(
              (tag) =>
                tag[0] === "d" &&
                tag[1] === `conduit:spark:wallet:v1:${walletId}`
            )
          )
            continue
          const backup = await service.restore(
            {
              eventId: item.event.id,
              walletId,
              source: "conduit_v1",
            },
            undefined,
            { priority }
          )
          if (
            !("identityPublicKey" in backup) ||
            backup.identityPublicKey !== identity
          )
            throw new Error("Conflicting recovery exists for this wallet.")
        }
        verified = {
          walletId,
          recovery: recoveryKey,
          records: recordsKey,
          identity,
          removedWalletIds: [...removedWalletIds],
        }
      }
      if (
        (await manager().getAddressIdentity(walletId)) !== verified.identity ||
        (record && requestEvidence(record).sparkIdentity !== verified.identity)
      )
        throw new Error("Wallet identity does not match the signed request.")
      current()
      const [latest, retained] = await Promise.all([
        store.getSparkRecovery(walletId),
        journalStore.load(signer.pubkey),
      ])
      if (
        JSON.stringify(latest) !== recoveryKey ||
        JSON.stringify(retained.records.map(({ event }) => event.id)) !==
          recordsKey ||
        retained.removedWalletIds?.includes(walletId) ||
        retained.registryExcludedWalletIds?.includes(walletId)
      )
        throw new Error("Wallet authorization changed.")
      current()
      return verified.removedWalletIds
    }
  }
  const makeWorkflow = (priority: "foreground" | "background") => {
    const authorize = createAuthorization(priority)
    return createAddressRequestWorkflow({
      owner: signer.pubkey,
      assertCurrent: current,
      authorize: async (walletId, record) => {
        await authorize(walletId, record)
        return async () => {
          await authorize(walletId, record, false)
        }
      },
      async load(walletId) {
        await authorize(walletId)
        const discovery = await service.discover(false, "mainnet", { priority })
        current()
        if (
          discovery.confirmedRemovedWalletIds?.includes(walletId) ||
          discovery.registry?.removedWalletIds.includes(walletId)
        )
          throw new Error("This wallet registration was removed.")
        // Recover remote progress when membership is known. Unrelated absence or
        // incomplete recovery does not veto this positively verified local wallet.
        const saved =
          discovery.registry &&
          discovery.state !== "conflict" &&
          discovery.state !== "unresolved"
            ? await metadata.load("mainnet", discovery, { priority })
            : await metadata.loadLocal("mainnet", { priority })
        const local = await metadata.loadLocal("mainnet", { priority })
        let record =
          saved.records[walletId] && local.records[walletId]
            ? mergeAddressRequestRecord(
                local.records[walletId],
                saved.records[walletId]
              )
            : (local.records[walletId] ?? saved.records[walletId])
        const legacy = discovery.registry?.addressNameRequests?.[walletId]
        if (legacy) record = mergeAddressRequestRecord(record, legacy)
        const removedWalletIds = await authorize(walletId, record)
        if (record)
          await metadata.stage(
            "mainnet",
            walletId,
            record,
            { priority },
            removedWalletIds
          )
        const confirmed =
          saved.confirmed &&
          !!record &&
          JSON.stringify(saved.records[walletId]) === JSON.stringify(record)
        return record
          ? {
              record,
              publication: confirmed ? "confirmed" : "local",
              sync: confirmed
                ? undefined
                : (saved.diagnosis ?? {
                    reason: "request_contents_unconfirmed" as const,
                  }),
            }
          : undefined
      },
      async save(walletId, record) {
        assertWritesEnabled()
        const removedWalletIds = await authorize(walletId, record)
        const saved = await metadata.stage(
          "mainnet",
          walletId,
          record,
          {
            priority,
          },
          removedWalletIds
        )
        return {
          record: saved.records[walletId],
          publication: "local",
          sync: saved.diagnosis,
        }
      },
      async signWallet(walletId, input) {
        await authorize(walletId)
        return manager().signAddressNameRequest(walletId, {
          ...input,
          timestamp: Math.floor(Date.now() / 1000),
        })
      },
      signAccount: (draft) => signer.signEvent(draft, { priority }),
      fetch: (...args) => (dependencies.fetch ?? fetch)(...args),
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
  }
  const synchronize = () => {
    void metadata.syncPending(() =>
      service.discover(false, "mainnet", { priority: "background" })
    )
  }
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await runAccountWalletSetup(signer, operation)
    } finally {
      if (writesEnabled) synchronize()
    }
  }
  return {
    writesEnabled,
    load: (walletId) =>
      run(async () => {
        const background = makeWorkflow("background")
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
      return run(() => makeWorkflow("foreground").submit(walletId, input))
    },
    check: (walletId) => run(() => makeWorkflow("foreground").check(walletId)),
    activate: (walletId) => {
      assertWritesEnabled()
      return run(() => makeWorkflow("foreground").activate(walletId))
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
