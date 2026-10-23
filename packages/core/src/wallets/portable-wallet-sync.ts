import { db } from "../db"
import type {
  AccountSigner,
  AccountSignerOperationOptions,
  SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { NostrSignerError } from "../protocol/nostr-event-signer"
import {
  SessionSignerError,
  subscribeToAccountSignerChanges,
} from "../protocol/session-signer"
import { getAccountStorageRelays } from "../protocol/account-storage-relay-policy"
import {
  createAccountWalletTransport,
  type WalletRecordTransport,
} from "./portable-wallet-transport"
import { deriveSparkRecoveryIdentity } from "./spark-sdk"
import {
  assertWalletSignerCurrent,
  sealSignerSparkRecovery,
} from "./signer-spark-recovery"
import { getMarketWalletStore, getMarketWalletRegistry } from "./wallet-storage"
import {
  compareWalletEvents,
  isPortableWalletEvent,
  parsePortableWalletRecord,
  portableWalletId,
  portableWalletRecordSchema,
  PORTABLE_WALLET_KIND,
  PORTABLE_WALLET_PREFIX,
  PORTABLE_WALLET_TAG,
  type PortableWalletRecord,
} from "./portable-wallet-record"
import type { SparkRecoveryBundle } from "./spark-recovery-bundle"
import type { WalletNetwork } from "./index"

export interface SavedPortableWallet {
  event: SignedNostrEvent
  observed: string[]
}
export interface PortableWalletAccount {
  ownerPubkey: string
  wallets: Record<string, SavedPortableWallet>
  pendingNames?: Record<string, string>
}
export interface PortableWalletStore {
  load(owner: string): Promise<PortableWalletAccount>
  save(account: PortableWalletAccount): Promise<void>
}
export class DexiePortableWalletStore implements PortableWalletStore {
  async load(ownerPubkey: string): Promise<PortableWalletAccount> {
    return (
      (await db.portableWalletAccounts.get(ownerPubkey)) ?? {
        ownerPubkey,
        wallets: {},
      }
    )
  }
  async save(account: PortableWalletAccount): Promise<void> {
    await db.portableWalletAccounts.put(account)
  }
}
export type WalletSyncStatus =
  "idle" | "checking" | "ready" | "pending" | "blocked"
export type PortableWalletPatch = Partial<
  Pick<
    PortableWalletRecord,
    | "name"
    | "lightningAddress"
    | "lifecycle"
    | "paySelectedAt"
    | "receiveSelectedAt"
    | "addressRequest"
    | "setupPending"
  >
>
export interface WalletSyncSnapshot {
  status: WalletSyncStatus
  coverage: "complete" | "partial" | "unavailable"
  invalidCount: number
  blockedReason?: "signer" | "storage"
}

/** One coordinator per signer session; only encrypted signed records persist. */
export class PortableWalletSync {
  private consumers = 0
  private stopBackground?: () => void
  /** One timer and foreground listener set shared by all mounted consumers. */
  connect(): () => void {
    this.consumers++
    if (this.consumers === 1) {
      let active = true
      let running = false
      let nextAt = 0
      let delay = 15_000
      const run = async (force = false) => {
        if (
          !active ||
          running ||
          this.snapshot.status === "blocked" ||
          (!force && Date.now() < nextAt)
        )
          return
        running = true
        try {
          await this.sync({ priority: "background" })
          delay =
            this.snapshot.status === "ready"
              ? 30_000
              : Math.min(delay * 2, 300_000)
        } catch {
          /* Shared status records access failure; background never repeats denied consent. */
        } finally {
          running = false
          nextAt = Date.now() + delay + Math.floor(Math.random() * 1000)
        }
      }
      const wake = () => {
        if (document.visibilityState === "visible") void run(true)
      }
      const timer = setInterval(() => {
        void run()
      }, 15_000)
      window.addEventListener("online", wake)
      window.addEventListener("focus", wake)
      document.addEventListener("visibilitychange", wake)
      this.stopBackground = () => {
        active = false
        clearInterval(timer)
        window.removeEventListener("online", wake)
        window.removeEventListener("focus", wake)
        document.removeEventListener("visibilitychange", wake)
      }
      void run(true)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.consumers === 0) {
        this.stopBackground?.()
        this.stopBackground = undefined
      }
    }
  }
  private synchronization?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private decoded = new Map<string, PortableWalletRecord>()
  private listeners = new Set<() => void>()
  snapshot: WalletSyncSnapshot = {
    status: "idle",
    coverage: "unavailable",
    invalidCount: 0,
  }
  constructor(
    private readonly d: {
      signer: AccountSigner
      store: PortableWalletStore
      transport: WalletRecordTransport
      relays: string[]
      deriveIdentity: (bundle: SparkRecoveryBundle) => Promise<string>
      assertCurrent?: () => void
      project?: (
        records: PortableWalletRecord[],
        options: AccountSignerOperationOptions
      ) => Promise<void>
      saveName?: (walletId: string, name: string) => Promise<void>
      now?: () => number
    }
  ) {}
  clear() {
    this.decoded.clear()
    this.stopBackground?.()
  }
  private current() {
    try {
      ;(
        this.d.assertCurrent ?? (() => assertWalletSignerCurrent(this.d.signer))
      )()
    } catch (error) {
      this.clear()
      throw error
    }
  }
  private changed(snapshot: Partial<WalletSyncSnapshot>) {
    this.snapshot = { ...this.snapshot, ...snapshot }
    for (const listener of this.listeners) listener()
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const work = async () => {
      this.current()
      // Coalesce consumers and serialize independent tabs sharing IndexedDB.
      return typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request(
            `conduit:portable-record:${this.d.signer.pubkey}`,
            operation
          )
        : operation()
    }
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async decode(
    event: SignedNostrEvent,
    options: AccountSignerOperationOptions
  ): Promise<PortableWalletRecord> {
    this.current()
    if (!isPortableWalletEvent(event, this.d.signer.pubkey))
      throw new Error("Invalid wallet event.")
    const cached = this.decoded.get(event.id)
    if (cached) return cached
    const plaintext = await this.d.signer.decryptNip44(
      this.d.signer.pubkey,
      event.content,
      options
    )
    this.current()
    const record = parsePortableWalletRecord(plaintext, event)
    if ((await this.d.deriveIdentity(record)) !== record.identityPublicKey)
      throw new Error("Wallet identity does not match its seed.")
    this.current()
    this.decoded.set(event.id, record)
    return record
  }
  async get(
    walletId: string,
    options: AccountSignerOperationOptions = {}
  ): Promise<PortableWalletRecord> {
    this.current()
    const saved = (await this.d.store.load(this.d.signer.pubkey)).wallets[
      walletId
    ]
    if (!saved) throw new Error("Import this wallet's recovery phrase first.")
    return structuredClone(await this.decode(saved.event, options))
  }
  private async project(
    account: PortableWalletAccount,
    options: AccountSignerOperationOptions
  ) {
    const records: PortableWalletRecord[] = []
    for (const saved of Object.values(account.wallets))
      records.push(await this.decode(saved.event, options))
    this.current()
    await this.d.project?.(
      records.map((r) => ({
        ...r,
        name: account.pendingNames?.[r.walletId] ?? r.name,
      })),
      options
    )
    this.current()
  }
  async import(
    bundle: SparkRecoveryBundle,
    name: string,
    options: AccountSignerOperationOptions = {},
    setupPending = false
  ): Promise<PortableWalletRecord> {
    return this.run(async () => {
      const identityPublicKey = await this.d.deriveIdentity(bundle)
      this.current()
      const identity = {
        ...bundle,
        ownerPubkey: this.d.signer.pubkey,
        identityPublicKey,
      }
      const walletId = portableWalletId(identity)
      const account = await this.d.store.load(this.d.signer.pubkey)
      const existing = account.wallets[walletId]
      // Duplicate import keeps current metadata; explicit import can reactivate a removal.
      const record = existing
        ? await this.decode(existing.event, options)
        : portableWalletRecordSchema.parse({
            ...identity,
            format: "conduit.portable-wallet",
            version: 1,
            walletId,
            provider: "spark",
            name: name.trim() || "Conduit Wallet",
            lightningAddress: null,
            lifecycle: "active",
            setupPending,
            paySelectedAt: 0,
            receiveSelectedAt: 0,
          })
      const active = { ...record, lifecycle: "active" as const, setupPending }
      await this.write(account, active, options)
      return structuredClone(active)
    })
  }
  async update(
    walletId: string,
    patch: PortableWalletPatch,
    options: AccountSignerOperationOptions = {}
  ): Promise<void> {
    return this.run(async () => {
      const account = await this.d.store.load(this.d.signer.pubkey)
      const saved = account.wallets[walletId]
      if (!saved) throw new Error("Import this wallet first.")
      if (patch.name !== undefined) {
        const name = portableWalletRecordSchema.shape.name.parse(patch.name)
        account.pendingNames = { ...account.pendingNames, [walletId]: name }
        this.current()
        await this.d.store.save(account)
        await this.d.saveName?.(walletId, name)
      }
      const before = await this.decode(saved.event, options)
      if (before.lifecycle === "removed")
        throw new Error("This wallet was removed.")
      await this.write(
        account,
        portableWalletRecordSchema.parse({ ...before, ...patch }),
        options
      )
    })
  }
  private async write(
    account: PortableWalletAccount,
    record: PortableWalletRecord,
    options: AccountSignerOperationOptions
  ) {
    this.current()
    const previous = account.wallets[record.walletId]?.event
    const content = await this.d.signer.encryptNip44(
      this.d.signer.pubkey,
      JSON.stringify(record),
      options
    )
    this.current()
    const draft = {
      pubkey: this.d.signer.pubkey,
      kind: PORTABLE_WALLET_KIND,
      created_at: Math.max(
        Math.floor((this.d.now?.() ?? Date.now()) / 1000),
        (previous?.created_at ?? 0) + 1
      ),
      tags: [
        ["d", PORTABLE_WALLET_PREFIX + record.walletId],
        ["t", PORTABLE_WALLET_TAG],
      ],
      content,
    }
    const event = await this.d.signer.signEvent(draft, options)
    this.current()
    if (
      JSON.stringify([
        event.pubkey,
        event.kind,
        event.created_at,
        event.tags,
        event.content,
      ]) !==
      JSON.stringify([
        draft.pubkey,
        draft.kind,
        draft.created_at,
        draft.tags,
        draft.content,
      ])
    )
      throw new Error("Signer changed the wallet record.")
    // Validate encryption round-trip and native identity before retaining or sending.
    const verified = await this.decode(event, options)
    if (JSON.stringify(verified) !== JSON.stringify(record))
      throw new Error("Wallet encryption verification failed.")
    account.wallets[record.walletId] = { event, observed: [] }
    if (account.pendingNames?.[record.walletId] === record.name)
      delete account.pendingNames[record.walletId]
    this.current()
    await this.d.store.save(account)
    await this.project(account, options)
    this.changed({ status: "pending" })
  }
  sync(
    options: AccountSignerOperationOptions = { priority: "background" }
  ): Promise<void> {
    if (this.synchronization) return this.synchronization
    const run = this.run(async () => {
      this.changed({ status: "checking", blockedReason: undefined })
      try {
        const account = await this.d.store.load(this.d.signer.pubkey)
        const reads = await Promise.all(
          this.d.relays.map(async (url) => {
            try {
              return {
                url,
                ...(await this.d.transport.read(
                  url,
                  this.d.signer.pubkey,
                  undefined,
                  () => {
                    this.current()
                    return true
                  }
                )),
              }
            } catch {
              this.current()
              return { url, status: "unavailable" as const, events: [] }
            }
          })
        )
        let invalidCount = 0
        const observations = new Map<string, Set<string>>()
        const candidates = new Map<string, SignedNostrEvent>()
        for (const saved of Object.values(account.wallets))
          if (isPortableWalletEvent(saved?.event, this.d.signer.pubkey))
            candidates.set(saved.event.id, saved.event)
        for (const read of reads)
          for (const event of read.events) {
            if (!isPortableWalletEvent(event, this.d.signer.pubkey)) continue
            candidates.set(event.id, event)
            const sources = observations.get(event.id) ?? new Set<string>()
            sources.add(read.url)
            observations.set(event.id, sources)
          }
        // Validate independently: malformed newer data cannot veto another valid wallet.
        const winners = new Map<string, SignedNostrEvent>()
        for (const event of [...candidates.values()].sort(
          compareWalletEvents
        )) {
          try {
            const record = await this.decode(event, options)
            if (!winners.has(record.walletId))
              winners.set(record.walletId, event)
          } catch (error) {
            this.current()
            if (
              error instanceof NostrSignerError ||
              error instanceof SessionSignerError
            )
              throw error
            invalidCount++
          }
        }
        account.wallets = {}
        for (const [id, event] of winners) {
          account.wallets[id] = {
            event,
            observed: [...new Set([...(observations.get(event.id) ?? [])])],
          }
        }
        this.current()
        await this.d.store.save(account)
        await this.project(account, options)
        for (const [id, name] of Object.entries(account.pendingNames ?? {})) {
          const saved = account.wallets[id]
          if (!saved) continue
          const record = await this.decode(saved.event, options)
          if (record.lifecycle !== "active") {
            delete account.pendingNames![id]
            continue
          }
          await this.write(
            account,
            portableWalletRecordSchema.parse({ ...record, name }),
            options
          )
        }
        // Exact signed bytes survive restarts and lost ACKs. Readback, not ACK, confirms storage.
        for (const saved of Object.values(account.wallets))
          for (const url of this.d.relays) {
            if (saved.observed.includes(url)) continue
            this.current()
            try {
              await this.d.transport.publish(url, saved.event, () => {
                this.current()
                return true
              })
              const read = await this.d.transport.read(
                url,
                this.d.signer.pubkey,
                saved.event.id,
                () => {
                  this.current()
                  return true
                }
              )
              if (
                read.events.some(
                  (e) =>
                    e.id === saved.event.id &&
                    isPortableWalletEvent(e, this.d.signer.pubkey)
                )
              )
                saved.observed.push(url)
            } catch {
              this.current()
            }
          }
        this.current()
        await this.d.store.save(account)
        const coverage = reads.every((r) => r.status === "complete")
          ? "complete"
          : reads.some((r) => r.status !== "unavailable")
            ? "partial"
            : "unavailable"
        this.changed({
          coverage,
          invalidCount,
          status:
            this.d.relays.length > 0 &&
            coverage === "complete" &&
            Object.values(account.wallets).every((w) =>
              this.d.relays.every((r) => w.observed.includes(r))
            )
              ? "ready"
              : "pending",
        })
      } catch (error) {
        this.changed({
          status: "blocked",
          blockedReason:
            error instanceof NostrSignerError ||
            error instanceof SessionSignerError
              ? "signer"
              : "storage",
        })
        throw error
      }
    })
    this.synchronization = run.finally(() => {
      this.synchronization = undefined
    })
    return this.synchronization
  }
}

const services = new WeakMap<AccountSigner, PortableWalletSync>()
export function getPortableWalletSync(
  signer: AccountSigner
): PortableWalletSync {
  let service = services.get(signer)
  if (!service) {
    service = new PortableWalletSync({
      signer,
      store: new DexiePortableWalletStore(),
      transport: createAccountWalletTransport(signer),
      relays: getAccountStorageRelays().map((r) =>
        typeof r === "string" ? r : r.url
      ),
      deriveIdentity: deriveSparkRecoveryIdentity,
      project: (records, options) =>
        projectPortableWallets(signer, records, options),
      saveName: (id, name) => getMarketWalletStore().rename(id, name),
    })
    services.set(signer, service)
    const scoped = service
    const unsubscribe = subscribeToAccountSignerChanges(() => {
      try {
        assertWalletSignerCurrent(signer)
      } catch {
        scoped.clear()
        unsubscribe()
      }
    })
  }
  return service
}

export async function projectPortableWallets(
  signer: AccountSigner,
  records: PortableWalletRecord[],
  options: AccountSignerOperationOptions = {},
  dependencies: {
    store?: ReturnType<typeof getMarketWalletStore>
    registry?: ReturnType<typeof getMarketWalletRegistry>
  } = {}
) {
  const store = dependencies.store ?? getMarketWalletStore()
  const registry = dependencies.registry ?? getMarketWalletRegistry()
  const credentials = new Map<
    string,
    Awaited<ReturnType<typeof sealSignerSparkRecovery>>
  >()
  for (const record of records) {
    if (record.lifecycle !== "active") continue
    if (!(await store.getSparkRecovery(record.walletId)))
      credentials.set(
        record.walletId,
        await sealSignerSparkRecovery(
          record.mnemonic,
          {
            walletId: record.walletId,
            providerId: "spark",
            network: record.network,
            accountNumber: record.accountNumber,
          },
          signer,
          options
        )
      )
  }
  await store.transaction(async () => {
    assertWalletSignerCurrent(signer)
    const previous = new Map((await store.list()).map((w) => [w.id, w]))
    for (const record of records) {
      const existing = (await store.list()).find(
        (w) => w.id === record.walletId
      )
      if (record.lifecycle === "removed") {
        // Keep credentials/payment references; visibility follows the signed lifecycle.
        if (existing)
          await store.put({
            ...existing,
            portableRecordVersion: 1,
            accountRemoved: true,
          })
        continue
      }
      const wallet =
        existing ??
        (await registry.add({
          id: record.walletId,
          providerId: "spark",
          kind: "portable",
          network: record.network,
          label: record.name,
          capabilities: [
            "pay_invoice",
            "receive",
            "balance",
            "history",
            "spark_transfer",
          ],
        }))
      await store.put({
        ...wallet,
        label: record.name,
        portableRecordVersion: 1,
        accountRemoved: false,
        accountPaySelectedAt: record.paySelectedAt,
        accountReceiveSelectedAt: record.receiveSelectedAt,
      })
      const recovery = credentials.get(record.walletId)
      if (recovery) await store.putSparkRecovery(record.walletId, recovery)
    }
    for (const network of new Set(records.map((r) => r.network))) {
      const available = records.filter(
        (r) => r.network === network && r.lifecycle === "active"
      )
      for (const [field, intent] of [
        ["paySelectedAt", "pay_invoice"],
        ["receiveSelectedAt", "receive"],
      ] as const) {
        const chosen = available
          .filter((r) => r[field] > 0)
          .sort(
            (a, b) =>
              b[field] - a[field] || a.walletId.localeCompare(b.walletId)
          )[0]
        const applied = chosen && previous.get(chosen.walletId)
        const lastSelectedAt =
          field === "paySelectedAt"
            ? applied?.accountPaySelectedAt
            : applied?.accountReceiveSelectedAt
        if (chosen && chosen[field] > (lastSelectedAt ?? 0))
          await registry.setDefault(chosen.walletId, intent)
      }
    }
    assertWalletSignerCurrent(signer)
  })
}

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
export async function listAutomaticSignerSparkWallets(input: {
  signer: AccountSigner
  network: WalletNetwork
  recoverySync: WalletSyncStatus
  store: ReturnType<typeof getMarketWalletStore>
  deliberatelyLockedIds?: ReadonlySet<string>
}) {
  if (["idle", "checking"].includes(input.recoverySync)) return []
  assertWalletSignerCurrent(input.signer)
  return (await input.store.listVisible(input.signer.pubkey)).filter(
    (w) =>
      w.providerId === "spark" &&
      w.network === input.network &&
      !input.deliberatelyLockedIds?.has(w.id)
  )
}
