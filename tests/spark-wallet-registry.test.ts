import { afterEach, expect, test } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { WalletRegistry } from "../packages/core/src/wallets"
import { ConduitDB } from "../packages/core/src/db"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import { NostrSignerError } from "../packages/core/src/protocol/nostr-event-signer"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  accountRegistryReadiness,
  SparkRecoveryService,
  type SparkRecoveryTransport,
} from "../packages/core/src/wallets/spark-recovery-service"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery-contract"
import { sparkWalletRegistryDTag } from "../packages/core/src/wallets/spark-wallet-registry"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import { sealSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import {
  applyAccountWalletRegistryDefaults,
  applyAccountWalletRegistryNames,
  bootstrapLegacyAccountWalletRegistry,
  isCompleteAccountRegistryDiscovery,
  listAutomaticSignerSparkWallets,
  reconcileAccountWalletRegistryMembership,
  restoreAccountSparkWallets,
} from "../packages/core/src/wallets/account-spark-recovery"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})

test("explicit main choice seeds a fresh device but leaves later local NWC choices intact", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const journal = f.newStore()
    const service = f.service(journal)
    const walletId = crypto.randomUUID()
    const backup = await backedUp(service, walletId)
    const main = await service.prepareMain(backup)
    expect((await service.deliver(main)).ready).toBe(true)
    const added = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId,
      name: "Shared account wallet",
    })
    expect((await service.deliver(added)).ready).toBe(true)
    const discovery = await f.service().discover(false, "mainnet")

    const device = new ConduitDB(
      `wallet-registry-default-${crypto.randomUUID()}`,
      {
        indexedDB,
        IDBKeyRange,
      }
    )
    databases.push(device)
    const store = new MarketWalletStore(device)
    const registry = new WalletRegistry(store)
    const spark = await registry.add({
      id: walletId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Account wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      spark.id,
      await sealSignerSparkRecovery(
        generateSparkMnemonic(),
        {
          walletId,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        f.signer
      )
    )
    const nwc = await registry.add({
      kind: "connected",
      providerId: "nwc",
      network: "mainnet",
      label: "Device wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    const sync = () =>
      applyAccountWalletRegistryDefaults({
        signer: f.signer,
        discovery,
        network: "mainnet",
        store,
        registry,
      })
    await sync()
    await applyAccountWalletRegistryNames({
      signer: f.signer,
      discovery,
      network: "mainnet",
      store,
      journal: new DexieSparkRecoveryStore(device),
    })
    expect(
      (await store.listVisible(f.owner)).find(
        (wallet) => wallet.id === spark.id
      )?.label
    ).toBe("Shared account wallet")
    expect(
      (await store.listVisible(f.owner)).find((wallet) =>
        wallet.defaultIntents.includes("pay_invoice")
      )?.id
    ).toBe(spark.id)
    await registry.setDefault(nwc.id, "pay_invoice")
    await registry.setDefault(nwc.id, "receive")
    await sync()
    const visible = await store.listVisible(f.owner)
    expect(
      visible.find((wallet) => wallet.defaultIntents.includes("pay_invoice"))
        ?.id
    ).toBe(nwc.id)
    expect(
      visible.find((wallet) => wallet.defaultIntents.includes("receive"))?.id
    ).toBe(nwc.id)
    f.unavailableRelays.add(f.relayUrls[0])
    const partial = await service.discover(false, "mainnet")
    expect(partial.coverage).toBe("partial")
    await store.rename(spark.id, "Keep local name during incomplete reads")
    await applyAccountWalletRegistryNames({
      signer: f.signer,
      discovery: partial,
      network: "mainnet",
      store,
      journal: new DexieSparkRecoveryStore(device),
    })
    expect(
      (await store.listVisible(f.owner)).find(
        (wallet) => wallet.id === spark.id
      )?.label
    ).toBe("Keep local name during incomplete reads")
    await applyAccountWalletRegistryDefaults({
      signer: f.signer,
      discovery: partial,
      network: "mainnet",
      store,
      registry,
    })
    const afterPartial = await store.listVisible(f.owner)
    expect(
      afterPartial.find((wallet) =>
        wallet.defaultIntents.includes("pay_invoice")
      )?.id
    ).toBe(nwc.id)
    expect(
      afterPartial.find((wallet) => wallet.defaultIntents.includes("receive"))
        ?.id
    ).toBe(nwc.id)
    f.unavailableRelays.clear()
    const newerName = await service.prepareRegistry("mainnet", {
      type: "rename",
      walletId,
      name: "Newer local name",
    })
    const intent = (await journal.load(f.owner)).records.find(
      (record) => record.event.id === newerName
    )!
    await new DexieSparkRecoveryStore(device).retain(f.owner, [intent])
    await store.rename(spark.id, "Newer local name")
    await applyAccountWalletRegistryNames({
      signer: f.signer,
      discovery,
      network: "mainnet",
      store,
      journal: new DexieSparkRecoveryStore(device),
    })
    expect(
      (await store.listVisible(f.owner)).find(
        (wallet) => wallet.id === spark.id
      )?.label
    ).toBe("Newer local name")
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("an implicit registry preference does not become a fresh device default", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const service = f.service()
    const walletId = crypto.randomUUID()
    await backedUp(service, walletId)
    const registryEventId = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    expect((await service.deliver(registryEventId)).ready).toBe(true)
    const discovery = await f.service().discover(false, "mainnet")
    expect(discovery.registry?.payInvoiceWalletId).toBe(walletId)
    expect(discovery.mainChoiceWalletId).toBeUndefined()
    const device = new ConduitDB(
      `wallet-registry-implicit-default-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(device)
    const store = new MarketWalletStore(device)
    const local = new WalletRegistry(store)
    const wallet = await local.add({
      id: walletId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Account wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      wallet.id,
      await sealSignerSparkRecovery(
        generateSparkMnemonic(),
        {
          walletId,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        f.signer
      )
    )
    await applyAccountWalletRegistryDefaults({
      signer: f.signer,
      discovery,
      network: "mainnet",
      store,
      registry: local,
    })
    expect((await store.listVisible(f.owner))[0]?.defaultIntents).toEqual([])
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("encrypted names survive a fresh device, immutable retry and removal", async () => {
  const f = fixture()
  const journal = f.newStore()
  const service = f.service(journal)
  const walletId = crypto.randomUUID()
  await backedUp(service, walletId)
  const added = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId,
    name: "Travel wallet",
  })
  expect((await service.deliver(added)).ready).toBe(true)
  const renamed = await service.prepareRegistry("mainnet", {
    type: "rename",
    walletId,
    name: "Family wallet",
  })
  const signed = (await journal.load(f.owner)).records.find(
    (record) => record.event.id === renamed
  )!.event
  expect(JSON.stringify(signed)).not.toContain("Family wallet")
  f.unavailableRelays.add(f.relayUrls[0])
  await expect(service.deliver(renamed)).rejects.toThrow("conflict")
  await expect(
    service.prepareRegistry("mainnet", {
      type: "rename",
      walletId,
      name: "Do not replace pending intent",
    })
  ).rejects.toThrow()
  f.unavailableRelays.clear()
  expect((await service.deliver(renamed)).ready).toBe(true)
  expect(
    (await journal.load(f.owner)).records.find(
      (record) => record.event.id === renamed
    )!.event
  ).toEqual(signed)
  const fresh = await f.service().discover(false, "mainnet")
  expect(fresh.registry?.walletNames).toEqual({ [walletId]: "Family wallet" })
  const removed = await service.prepareRegistry("mainnet", {
    type: "remove",
    walletId,
  })
  expect((await service.deliver(removed)).ready).toBe(true)
  const afterRemoval = await f.service().discover(false, "mainnet")
  expect(afterRemoval.registry?.walletNames).toEqual({})
  expect(afterRemoval.registry?.removedWalletIds).toContain(walletId)
  await expect(
    service.prepareRegistry("mainnet", {
      type: "rename",
      walletId,
      name: "Cannot restore",
    })
  ).rejects.toThrow("conflict")
})

test("legacy successors retain known ancestor names and preserve other encrypted metadata", async () => {
  const f = fixture()
  const service = f.service()
  const walletId = crypto.randomUUID()
  await backedUp(service, walletId)
  const added = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId,
    name: "Named wallet",
  })
  expect((await service.deliver(added)).ready).toBe(true)
  const previous = (await service.discover(false, "mainnet")).registry!
  const { walletNames: _names, ...legacy } = previous
  const createdAt = previous.createdAt + 1
  const successor = await f.provider.signEvent({
    kind: 30078,
    pubkey: f.owner,
    created_at: createdAt,
    tags: [["d", sparkWalletRegistryDTag("mainnet")]],
    content: await f.provider.encryptNip44!(
      f.owner,
      JSON.stringify({
        ...legacy,
        revision: previous.revision + 1,
        parentEventId: added,
        createdAt,
        extensionOwnedByAnotherWorkflow: { retained: true },
      })
    ),
  })
  for (const events of f.relays.values()) {
    events.delete(added)
    events.set(successor.id, successor)
  }
  const observed = await service.discover(false, "mainnet")
  expect(observed.registry?.walletNames?.[walletId]).toBe("Named wallet")
  const renamed = await service.prepareRegistry("mainnet", {
    type: "rename",
    walletId,
    name: "Later name",
  })
  expect((await service.deliver(renamed)).ready).toBe(true)
  const fresh = await f.service().discover(false, "mainnet")
  expect(fresh.registry?.walletNames?.[walletId]).toBe("Later name")
  expect(fresh.registry?.extensionOwnedByAnotherWorkflow).toEqual({
    retained: true,
  })
  for (const name of ["", " ", "x".repeat(81)]) {
    await expect(
      service.prepareRegistry("mainnet", { type: "rename", walletId, name })
    ).rejects.toThrow()
  }
})

function fixture() {
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const conversation = v2.utils.getConversationKey(secret, owner)
  const provider: NostrKeySigner = {
    pubkey: owner,
    getPublicKey: async () => owner,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (_peer, plaintext) =>
      v2.encrypt(plaintext, conversation),
    decryptNip44: async (_peer, ciphertext) =>
      v2.decrypt(ciphertext, conversation),
    decryptLegacy: async () => {
      throw new Error("unused")
    },
  }
  const signer = new SessionSigner(provider, {
    expectedPubkey: owner,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
    hasAuthority: () => true,
  })
  const relayUrls = [
    "wss://relay.conduit.market",
    "wss://relay.damus.io",
    "wss://nos.lol",
  ]
  const relays = new Map(
    relayUrls.map((url) => [url, new Map<string, SignedNostrEvent>()])
  )
  const unavailableRelays = new Set<string>()
  const transport: SparkRecoveryTransport = {
    async publish(url, event, authorized) {
      if (!authorized()) return "cancelled"
      const events = relays.get(url)!
      const address = event.tags.find((tag) => tag[0] === "d")?.[1]
      for (const old of events.values()) {
        if (
          old.pubkey !== event.pubkey ||
          old.kind !== event.kind ||
          old.tags.find((tag) => tag[0] === "d")?.[1] !== address
        )
          continue
        if (
          old.created_at > event.created_at ||
          (old.created_at === event.created_at && old.id < event.id)
        )
          return "acked"
        events.delete(old.id)
      }
      events.set(event.id, structuredClone(event))
      return "acked"
    },
    async read(url, _owner, eventId, authorized, address) {
      if (!authorized() || unavailableRelays.has(url))
        return { status: "unavailable", events: [] }
      return {
        status: "complete",
        events: [...relays.get(url)!.values()].filter(
          (event) =>
            (!eventId || event.id === eventId) &&
            (!address ||
              event.tags.some((tag) => tag[0] === "d" && tag[1] === address))
        ),
      }
    },
  }
  const newStore = () => {
    const database = new ConduitDB(`wallet-registry-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    databases.push(database)
    return new DexieSparkRecoveryStore(database)
  }
  const service = (store = newStore()) =>
    new SparkRecoveryService({
      signer,
      currentSigner: () => signer,
      store,
      transport,
      deriveIdentity: async () => "02" + getPublicKey(secret),
    })
  return {
    owner,
    signer,
    provider,
    relays,
    relayUrls,
    unavailableRelays,
    newStore,
    service,
  }
}

async function backedUp(
  service: SparkRecoveryService,
  walletId: string,
  rootBackupEventId?: string
) {
  const candidate = await service.prepare(
    {
      mnemonic: generateSparkMnemonic(),
      network: "mainnet",
      accountNumber: 1,
    },
    walletId,
    rootBackupEventId
  )
  expect((await service.deliver(candidate.eventId)).ready).toBe(true)
  return candidate
}

test("registry delivery needs every planned readback even with two operators or an export", async () => {
  const f = fixture()
  const journal = f.newStore()
  const service = f.service(journal)
  const walletId = crypto.randomUUID()
  await backedUp(service, walletId)
  const eventId = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId,
  })
  expect(await service.deliver(eventId)).toEqual({
    ready: true,
    independentCopies: 3,
  })
  const record = (await journal.load(f.owner)).records.find(
    (item) => item.event.id === eventId
  )!
  const extraUrl = "wss://wallet-extra.example"
  const missingUserRelay = {
    ...record,
    exported: true,
    targets: [...record.targets, { url: extraUrl, operator: null }],
    delivery: [
      ...record.delivery,
      {
        url: extraUrl,
        status: "pending" as const,
        accepted: false,
        readBack: false,
        lastRead: "not_queried" as const,
        checkedAt: 0,
      },
    ],
  }
  expect(accountRegistryReadiness(missingUserRelay)).toEqual({
    ready: false,
    independentCopies: 3,
  })
  const deliveredUserRelay = {
    ...missingUserRelay,
    delivery: missingUserRelay.delivery.map((evidence) =>
      evidence.url === extraUrl
        ? {
            ...evidence,
            status: "acked" as const,
            accepted: true,
            readBack: true,
            lastRead: "present" as const,
            checkedAt: Date.now(),
          }
        : evidence
    ),
  }
  expect(accountRegistryReadiness(deliveredUserRelay)).toEqual({
    ready: true,
    independentCopies: 3,
  })
  const localOnly = {
    ...record,
    exported: false,
    targets: [{ url: "ws://127.0.0.1:7777", operator: null }],
    delivery: [
      {
        url: "ws://127.0.0.1:7777",
        status: "acked" as const,
        accepted: true,
        readBack: true,
        lastRead: "present" as const,
        checkedAt: Date.now(),
      },
    ],
  }
  expect(accountRegistryReadiness(localOnly)).toEqual({
    ready: true,
    independentCopies: 0,
  })
  expect(
    accountRegistryReadiness({
      ...localOnly,
      exported: true,
      delivery: [
        { ...localOnly.delivery[0], lastRead: "unavailable" as const },
      ],
    }).ready
  ).toBe(false)
})

test("complete legacy recovery bootstraps one registry before a fresh app selects wallets", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const journal = f.newStore()
    const service = f.service(journal)
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    const first = await backedUp(service, firstId)
    const second = await backedUp(service, secondId, first.eventId)
    const main = await service.prepareMain(second)
    expect((await service.deliver(main)).ready).toBe(true)
    const device = new ConduitDB(
      `wallet-registry-legacy-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(device)
    f.unavailableRelays.add(f.relayUrls[0])
    const partial = await service.discover(false, "mainnet")
    expect(partial.coverage).toBe("partial")
    const deferred = await bootstrapLegacyAccountWalletRegistry({
      signer: f.signer,
      discovery: partial,
      network: "mainnet",
      service,
      store: new MarketWalletStore(device),
      journal,
    })
    expect(deferred.attempted).toBe(false)
    expect(deferred.discovery.registry).toBeUndefined()
    f.unavailableRelays.delete(f.relayUrls[0])
    const discovery = await service.discover(false, "mainnet")
    expect(discovery.registry).toBeUndefined()
    const bootstrap = await bootstrapLegacyAccountWalletRegistry({
      signer: f.signer,
      discovery,
      network: "mainnet",
      service,
      store: new MarketWalletStore(device),
      journal,
    })
    expect(bootstrap).toMatchObject({ attempted: true, ready: true })
    expect(bootstrap.discovery.registry?.activeWalletIds).toEqual(
      [firstId, secondId].sort()
    )
    expect(bootstrap.discovery.main?.walletId).toBe(secondId)
    expect(
      (
        await bootstrapLegacyAccountWalletRegistry({
          signer: f.signer,
          discovery,
          network: "mainnet",
          service,
          store: new MarketWalletStore(device),
          journal,
        })
      ).attempted
    ).toBe(false)
    const fresh = await f.service(f.newStore()).discover(false, "mainnet")
    expect(fresh.registry?.activeWalletIds).toEqual([firstId, secondId].sort())
    expect(fresh.registry?.receiveWalletId).toBe(secondId)
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("fresh device bootstraps a resolved Addy import from its matching Conduit backup", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const mnemonic = generateSparkMnemonic()
    const walletId = crypto.randomUUID()
    const addy = await f.provider.signEvent({
      kind: 30078,
      created_at: 100,
      tags: [["d", "spark-wallet-backup"]],
      content: await f.provider.encryptNip44(f.owner, mnemonic),
    })
    for (const url of f.relayUrls) f.relays.get(url)!.set(addy.id, addy)

    const freshJournal = f.newStore()
    const freshService = f.service(freshJournal)
    const device = new ConduitDB(
      `wallet-registry-resolved-addy-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(device)
    const unresolved = await freshService.discover(false, "mainnet")
    expect(
      unresolved.candidates.find((candidate) => candidate.source === "addy")
        ?.resolved
    ).toBe(false)
    expect(
      (
        await bootstrapLegacyAccountWalletRegistry({
          signer: f.signer,
          discovery: unresolved,
          network: "mainnet",
          service: freshService,
          store: new MarketWalletStore(device),
          journal: freshJournal,
        })
      ).attempted
    ).toBe(false)

    const source = f.service()
    const backup = await source.prepare(
      { mnemonic, network: "mainnet", accountNumber: 7 },
      walletId
    )
    expect((await source.deliver(backup.eventId)).ready).toBe(true)
    const discovery = await freshService.discover(false, "mainnet")
    expect(discovery.registry).toBeUndefined()
    expect(discovery.state).toBe("recoverable")
    expect(discovery.candidates).toHaveLength(2)
    expect(
      discovery.candidates.find((candidate) => candidate.source === "addy")
        ?.resolved
    ).toBe(true)
    expect(
      discovery.candidates.find(
        (candidate) => candidate.source === "conduit_v1"
      )?.walletId
    ).toBe(walletId)

    const bootstrap = await bootstrapLegacyAccountWalletRegistry({
      signer: f.signer,
      discovery,
      network: "mainnet",
      service: freshService,
      store: new MarketWalletStore(device),
      journal: freshJournal,
    })
    expect(bootstrap).toMatchObject({ attempted: true, ready: true })
    expect(bootstrap.discovery.registryMembershipReady).toBe(true)
    expect(bootstrap.discovery.registry?.activeWalletIds).toEqual([walletId])
    for (const url of f.relayUrls)
      expect(
        [...f.relays.get(url)!.values()].some((event) =>
          event.tags.some(
            (tag) =>
              tag[0] === "d" && tag[1] === sparkWalletRegistryDTag("mainnet")
          )
        )
      ).toBe(true)
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("legacy bootstrap carries known removal history and never selects that old backup", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const journal = f.newStore()
    const service = f.service(journal)
    const oldId = crypto.randomUUID()
    const currentId = crypto.randomUUID()
    const root = await backedUp(service, oldId)
    await backedUp(service, currentId, root.eventId)
    await journal.setDeviceRemoved(f.owner, oldId, true)
    const device = new ConduitDB(
      `wallet-registry-legacy-removed-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(device)
    const bootstrap = await bootstrapLegacyAccountWalletRegistry({
      signer: f.signer,
      discovery: await service.discover(false, "mainnet"),
      network: "mainnet",
      service,
      store: new MarketWalletStore(device),
      journal,
    })
    expect(bootstrap).toMatchObject({ attempted: true, ready: true })
    expect(bootstrap.discovery.registry?.activeWalletIds).toEqual([currentId])
    expect(bootstrap.discovery.registry?.removedWalletIds).toContain(oldId)
    const freshService = f.service(f.newStore())
    const fresh = await freshService.discover(false, "mainnet")
    expect(fresh.candidates.map((candidate) => candidate.walletId)).toEqual([
      currentId,
    ])
    expect((await freshService.restore(root)).walletId).toBe(oldId)
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("legacy bootstrap keeps a locally deleted-all account empty on fresh sign-in", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const journal = f.newStore()
    const service = f.service(journal)
    const walletId = crypto.randomUUID()
    await backedUp(service, walletId)
    await journal.setDeviceRemoved(f.owner, walletId, true)
    const device = new ConduitDB(
      `wallet-registry-legacy-empty-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(device)
    const bootstrap = await bootstrapLegacyAccountWalletRegistry({
      signer: f.signer,
      discovery: await service.discover(false, "mainnet"),
      network: "mainnet",
      service,
      store: new MarketWalletStore(device),
      journal,
    })
    expect(bootstrap).toMatchObject({ attempted: true, ready: true })
    expect(bootstrap.discovery.registry?.activeWalletIds).toEqual([])
    expect(bootstrap.discovery.registry?.removedWalletIds).toEqual([walletId])
    const fresh = await f.service(f.newStore()).discover(false, "mainnet")
    expect(fresh.candidates).toEqual([])
    expect(fresh.state).toBe("absent_within_scope")
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("account removal survives a fresh store while independent old backups remain intact", async () => {
  const f = fixture()
  const first = f.service()
  const walletId = crypto.randomUUID()
  const backup = await backedUp(first, walletId)
  const primaryId = await first.preparePrimary(backup)
  expect((await first.deliver(primaryId)).ready).toBe(true)
  const added = await first.prepareRegistry("mainnet", {
    type: "add",
    walletId,
  })
  expect((await first.deliver(added)).ready).toBe(true)
  const firstSnapshot = (await f.service().discover(false, "mainnet")).registry
  expect(firstSnapshot?.payInvoiceWalletId).toBe(walletId)
  expect(firstSnapshot?.receiveWalletId).toBe(walletId)
  expect(
    (await f.service().discover(false, "mainnet")).candidates.map(
      (c) => c.walletId
    )
  ).toEqual([walletId])

  const removed = await first.prepareRegistry("mainnet", {
    type: "remove",
    walletId,
  })
  expect(
    await first.prepareRegistry("mainnet", { type: "remove", walletId })
  ).toBe(removed)
  expect((await first.deliver(removed)).ready).toBe(true)
  const fresh = f.service()
  const discovery = await fresh.discover(false, "mainnet")
  expect(discovery.registry?.activeWalletIds).toEqual([])
  expect(discovery.registry?.removedWalletIds).toContain(walletId)
  expect(discovery.candidates).toEqual([])
  expect(discovery.state).toBe("absent_within_scope")
  expect(
    await restoreAccountSparkWallets(f.signer, discovery, "mainnet")
  ).toEqual([])
  expect((await f.newStore().load(f.owner)).records).toEqual([])
  expect((await first.restore(backup)).walletId).toBe(walletId)
  await expect(
    first.prepareRegistry("mainnet", { type: "add", walletId })
  ).rejects.toThrow("conflict")
})

test("a retained removal stays locally usable until its exact registry event reaches every relay", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const database = new ConduitDB(
      `wallet-registry-removal-retry-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(database)
    const store = new MarketWalletStore(database)
    const journal = new DexieSparkRecoveryStore(database)
    const service = f.service(journal)
    const walletId = crypto.randomUUID()
    const mnemonic = generateSparkMnemonic()
    const backup = await service.prepare(
      { mnemonic, network: "mainnet", accountNumber: 1 },
      walletId
    )
    expect((await service.deliver(backup.eventId)).ready).toBe(true)
    const added = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    expect((await service.deliver(added)).ready).toBe(true)
    await new WalletRegistry(store).add({
      id: walletId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Wallet awaiting removal",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      walletId,
      await sealSignerSparkRecovery(
        mnemonic,
        { walletId, providerId: "spark", network: "mainnet", accountNumber: 1 },
        f.signer
      )
    )
    const previouslyRemovedId = crypto.randomUUID()
    const previousMnemonic = generateSparkMnemonic()
    const previousBackup = await service.prepare(
      { mnemonic: previousMnemonic, network: "mainnet", accountNumber: 1 },
      previouslyRemovedId,
      backup.eventId
    )
    expect((await service.deliver(previousBackup.eventId)).ready).toBe(true)
    const previousAdd = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: previouslyRemovedId,
    })
    expect((await service.deliver(previousAdd)).ready).toBe(true)
    await new WalletRegistry(store).add({
      id: previouslyRemovedId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Previously removed wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      previouslyRemovedId,
      await sealSignerSparkRecovery(
        previousMnemonic,
        {
          walletId: previouslyRemovedId,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        f.signer
      )
    )
    const previousRemoval = await service.prepareRegistry("mainnet", {
      type: "remove",
      walletId: previouslyRemovedId,
    })
    expect((await service.deliver(previousRemoval)).ready).toBe(true)

    const removal = await service.prepareRegistry("mainnet", {
      type: "remove",
      walletId,
    })
    f.unavailableRelays.add(f.relayUrls[0])
    await expect(service.deliver(removal)).rejects.toThrow("conflict")
    const partial = await service.discover(false, "mainnet")
    expect(partial.coverage).toBe("partial")
    expect(partial.confirmedRemovedWalletIds).toEqual([previouslyRemovedId])
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: partial,
      network: "mainnet",
      store,
      journal,
    })
    expect(
      (await store.listVisible(f.owner)).map((wallet) => wallet.id)
    ).toEqual([walletId])
    f.unavailableRelays.clear()
    const pending = await service.discover(false, "mainnet")
    expect(pending.registryMembershipReady).toBe(false)
    expect(isCompleteAccountRegistryDiscovery(pending)).toBe(false)
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: pending,
      network: "mainnet",
      store,
      journal,
    })
    expect(
      (await store.listVisible(f.owner)).map((wallet) => wallet.id)
    ).toEqual([walletId])
    expect((await journal.load(f.owner)).removedWalletIds).toEqual([
      previouslyRemovedId,
    ])
    expect(
      await service.prepareRegistry("mainnet", { type: "remove", walletId })
    ).toBe(removal)

    expect((await service.deliver(removal)).ready).toBe(true)
    const committed = await service.discover(false, "mainnet")
    expect(committed.registryMembershipReady).toBe(true)
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: committed,
      network: "mainnet",
      store,
      journal,
    })
    expect(await store.listVisible(f.owner)).toEqual([])
    expect(new Set((await journal.load(f.owner)).removedWalletIds)).toEqual(
      new Set([previouslyRemovedId, walletId])
    )
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("first registry snapshot carries a validated legacy local tombstone to a fresh app", async () => {
  const f = fixture()
  const local = f.newStore()
  const service = f.service(local)
  const oldWalletId = crypto.randomUUID()
  const currentWalletId = crypto.randomUUID()
  const oldBackup = await backedUp(service, oldWalletId)
  const primary = await service.preparePrimary(oldBackup)
  expect((await service.deliver(primary)).ready).toBe(true)
  await backedUp(service, currentWalletId, oldBackup.eventId)
  await local.setDeviceRemoved(f.owner, oldWalletId, true)
  const firstRegistry = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId: currentWalletId,
  })
  expect((await service.deliver(firstRegistry)).ready).toBe(true)

  const fresh = f.service(f.newStore())
  const discovery = await fresh.discover(false, "mainnet")
  expect(discovery.registry?.activeWalletIds).toEqual([currentWalletId])
  expect(discovery.registry?.removedWalletIds).toContain(oldWalletId)
  expect(discovery.registry?.payInvoiceWalletId).toBe(currentWalletId)
  expect(discovery.candidates.map((candidate) => candidate.walletId)).toEqual([
    currentWalletId,
  ])
  expect((await fresh.restore(oldBackup)).walletId).toBe(oldWalletId)
  await expect(
    fresh.prepareRegistry("mainnet", { type: "add", walletId: oldWalletId })
  ).rejects.toThrow("conflict")
})

test("existing registry absorbs a local tombstone for an inactive validated backup", async () => {
  const f = fixture()
  const local = f.newStore()
  const service = f.service(local)
  const currentWalletId = crypto.randomUUID()
  const oldWalletId = crypto.randomUUID()
  const currentBackup = await backedUp(service, currentWalletId)
  const initial = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId: currentWalletId,
  })
  expect((await service.deliver(initial)).ready).toBe(true)
  await backedUp(service, oldWalletId, currentBackup.eventId)
  await local.setDeviceRemoved(f.owner, oldWalletId, true)
  const updated = await service.prepareRegistry("mainnet", {
    type: "main",
    walletId: currentWalletId,
  })
  expect(updated).not.toBe(initial)
  expect((await service.deliver(updated)).ready).toBe(true)

  const fresh = await f.service(f.newStore()).discover(false, "mainnet")
  expect(fresh.registry?.activeWalletIds).toEqual([currentWalletId])
  expect(fresh.registry?.removedWalletIds).toContain(oldWalletId)
  expect(fresh.candidates.map((candidate) => candidate.walletId)).toEqual([
    currentWalletId,
  ])
})

test("partial account registry reads do not auto-restore a backed-up wallet", async () => {
  const f = fixture()
  const service = f.service()
  const walletId = crypto.randomUUID()
  await backedUp(service, walletId)
  const added = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId,
  })
  expect((await service.deliver(added)).ready).toBe(true)
  f.unavailableRelays.add(f.relayUrls[0])
  const partial = await f.service().discover(false, "mainnet")
  expect(partial.coverage).toBe("partial")
  expect(partial.registry?.activeWalletIds).toContain(walletId)
  expect(isCompleteAccountRegistryDiscovery(partial)).toBe(false)
  expect(
    await restoreAccountSparkWallets(f.signer, partial, "mainnet")
  ).toEqual([])
  expect(
    isCompleteAccountRegistryDiscovery({
      ...partial,
      coverage: "complete",
      state: "conflict",
    })
  ).toBe(false)
})

test("registry bootstrap preserves an existing main choice across both wallets", async () => {
  const f = fixture()
  const service = f.service()
  const firstId = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  const first = await backedUp(service, firstId)
  const primary = await service.preparePrimary(first)
  expect((await service.deliver(primary)).ready).toBe(true)
  const second = await service.prepare(
    {
      mnemonic: generateSparkMnemonic(),
      network: "mainnet",
      accountNumber: 1,
    },
    secondId,
    first.eventId
  )
  expect((await service.deliver(second.eventId)).ready).toBe(true)
  const main = await service.prepareMain(second)
  expect((await service.deliver(main)).ready).toBe(true)
  const initial = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId: secondId,
  })
  expect((await service.deliver(initial)).ready).toBe(true)
  const fresh = await f.service().discover(false, "mainnet")
  expect(fresh.registry?.activeWalletIds).toEqual([firstId, secondId].sort())
  expect(fresh.registry?.payInvoiceWalletId).toBe(secondId)
  expect(fresh.registry?.receiveWalletId).toBe(secondId)
})

test("removal publishes the selected account replacement and a stable receiving fallback", async () => {
  const f = fixture()
  const service = f.service()
  const [removedId, otherId, replacementId] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ].sort()
  const root = await backedUp(service, removedId)
  for (const walletId of [removedId, otherId, replacementId]) {
    if (walletId !== removedId) await backedUp(service, walletId, root.eventId)
    const eventId = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    expect((await service.deliver(eventId)).ready).toBe(true)
  }
  const selected = await service.prepareRegistry("mainnet", {
    type: "main",
    walletId: removedId,
  })
  expect((await service.deliver(selected)).ready).toBe(true)
  const removed = await service.prepareRegistry("mainnet", {
    type: "remove",
    walletId: removedId,
    replacementPayWalletId: replacementId,
  })
  expect((await service.deliver(removed)).ready).toBe(true)
  const fresh = await f.service().discover(false, "mainnet")
  expect(fresh.registry?.activeWalletIds).toEqual([otherId, replacementId])
  expect(fresh.registry?.payInvoiceWalletId).toBe(replacementId)
  expect(fresh.registry?.receiveWalletId).toBe(otherId)
  expect(fresh.registry?.removedWalletIds).toContain(removedId)
})

test("fresh account registry hides a cached wallet removed on another app without deleting its recovery", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const first = f.service()
    const walletId = crypto.randomUUID()
    await backedUp(first, walletId)
    const added = await first.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    expect((await first.deliver(added)).ready).toBe(true)

    const device = new ConduitDB(
      `wallet-registry-device-${crypto.randomUUID()}`,
      {
        indexedDB,
        IDBKeyRange,
      }
    )
    databases.push(device)
    const store = new MarketWalletStore(device)
    const localRegistry = new WalletRegistry(store)
    const wallet = await localRegistry.add({
      id: walletId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Cached wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      wallet.id,
      await sealSignerSparkRecovery(
        generateSparkMnemonic(),
        {
          walletId,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        f.signer
      )
    )
    expect((await store.listVisible(f.owner)).map((item) => item.id)).toEqual([
      walletId,
    ])

    const removed = await first.prepareRegistry("mainnet", {
      type: "remove",
      walletId,
    })
    expect((await first.deliver(removed)).ready).toBe(true)
    const freshDiscovery = await f
      .service(new DexieSparkRecoveryStore(device))
      .discover(false, "mainnet")
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: freshDiscovery,
      network: "mainnet",
      store,
      journal: new DexieSparkRecoveryStore(device),
    })
    expect(await store.listVisible(f.owner)).toEqual([])
    expect((await store.list()).map((item) => item.id)).toEqual([walletId])
    expect(await store.getSparkRecovery(walletId)).not.toBeNull()
    expect(
      await listAutomaticSignerSparkWallets({
        signer: f.signer,
        network: "mainnet",
        recoverySync: "pending",
        store,
      })
    ).toEqual([])
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("a failed account add remains locally usable and retries with the same wallet ID", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const service = f.service()
    const firstId = crypto.randomUUID()
    const first = await backedUp(service, firstId)
    const firstRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: firstId,
    })
    expect((await service.deliver(firstRegistry)).ready).toBe(true)

    const device = new ConduitDB(
      `wallet-registry-pending-${crypto.randomUUID()}`,
      {
        indexedDB,
        IDBKeyRange,
      }
    )
    databases.push(device)
    const store = new MarketWalletStore(device)
    const journal = new DexieSparkRecoveryStore(device)
    const walletId = crypto.randomUUID()
    const mnemonic = generateSparkMnemonic()
    const wallet = await new WalletRegistry(store).add({
      id: walletId,
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Pending wallet",
      capabilities: ["pay_invoice", "receive"],
    })
    await store.putSparkRecovery(
      wallet.id,
      await sealSignerSparkRecovery(
        mnemonic,
        {
          walletId,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        f.signer
      )
    )
    const pendingBackup = await service.prepare(
      { mnemonic, network: "mainnet", accountNumber: 1 },
      walletId,
      first.eventId
    )
    expect((await service.deliver(pendingBackup.eventId)).ready).toBe(true)
    const secondRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId,
    })
    f.unavailableRelays.add(f.relayUrls[0])
    await expect(service.deliver(secondRegistry)).rejects.toThrow("conflict")
    f.unavailableRelays.delete(f.relayUrls[0])
    const firstDiscovery = await f.service(journal).discover(false, "mainnet")
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: firstDiscovery,
      network: "mainnet",
      store,
      journal,
    })
    expect((await store.listVisible(f.owner)).map((item) => item.id)).toEqual([
      walletId,
    ])
    expect((await journal.load(f.owner)).removedWalletIds).toBeUndefined()
    expect((await journal.load(f.owner)).registryExcludedWalletIds).toEqual([])
    expect(
      (
        await listAutomaticSignerSparkWallets({
          signer: f.signer,
          network: "mainnet",
          recoverySync: "pending",
          store,
        })
      ).map((candidate) => candidate.id)
    ).toEqual([walletId])
    expect(
      await listAutomaticSignerSparkWallets({
        signer: f.signer,
        network: "mainnet",
        recoverySync: "checking",
        store,
      })
    ).toEqual([])

    expect((await service.deliver(secondRegistry)).ready).toBe(true)
    const secondDiscovery = await f.service(journal).discover(false, "mainnet")
    await reconcileAccountWalletRegistryMembership({
      signer: f.signer,
      discovery: secondDiscovery,
      network: "mainnet",
      store,
      journal,
    })
    expect((await store.listVisible(f.owner)).map((item) => item.id)).toEqual([
      walletId,
    ])
    expect((await journal.load(f.owner)).registryExcludedWalletIds).toEqual([])
    expect(await store.getSparkRecovery(walletId)).not.toBeNull()
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("a failed local main choice leaves neither signed choice retained nor published", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const database = new ConduitDB(
      `wallet-main-transaction-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(database)
    const journal = new DexieSparkRecoveryStore(database)
    const service = f.service(journal)
    const store = new MarketWalletStore(database)
    const registry = new WalletRegistry(store)
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    await backedUp(service, firstId)
    const firstRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: firstId,
    })
    expect((await service.deliver(firstRegistry)).ready).toBe(true)
    const second = await backedUp(service, secondId)
    const secondRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: secondId,
    })
    expect((await service.deliver(secondRegistry)).ready).toBe(true)
    for (const id of [firstId, secondId])
      await registry.add({
        id,
        kind: "portable",
        providerId: "spark",
        network: "mainnet",
        label: "Account wallet",
        capabilities: ["pay_invoice", "receive"],
      })
    await registry.setDefault(firstId, "pay_invoice")
    await registry.setDefault(firstId, "receive")
    const beforeJournal = (await journal.load(f.owner)).records.map(
      (record) => record.event.id
    )
    const beforeRelay = f.relayUrls.map((url) => [...f.relays.get(url)!.keys()])

    await expect(
      service.prepareRegistry(
        "mainnet",
        { type: "main", walletId: secondId },
        async (retainRegistry) => {
          await service.prepareMain(second, (retainMain) =>
            store.transaction(async () => {
              await registry.setDefault(secondId, "pay_invoice")
              await retainRegistry()
              await retainMain()
              throw new Error("Local main choice write failed")
            })
          )
        }
      )
    ).rejects.toThrow("Local main choice write failed")
    const visible = await store.listVisible(f.owner)
    for (const intent of ["pay_invoice", "receive"] as const)
      expect(
        visible.find((wallet) => wallet.defaultIntents.includes(intent))?.id
      ).toBe(firstId)
    expect(
      (await journal.load(f.owner)).records.map((record) => record.event.id)
    ).toEqual(beforeJournal)
    expect(f.relayUrls.map((url) => [...f.relays.get(url)!.keys()])).toEqual(
      beforeRelay
    )
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("an idempotent registry main choice still commits local defaults and its signed main event", async () => {
  const f = fixture()
  activateAccountSigner(f.signer)
  try {
    const database = new ConduitDB(
      `wallet-main-idempotent-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    databases.push(database)
    const journal = new DexieSparkRecoveryStore(database)
    const service = f.service(journal)
    const store = new MarketWalletStore(database)
    const registry = new WalletRegistry(store)
    const firstId = crypto.randomUUID()
    const secondId = crypto.randomUUID()
    await backedUp(service, firstId)
    const firstRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: firstId,
    })
    expect((await service.deliver(firstRegistry)).ready).toBe(true)
    const second = await backedUp(service, secondId)
    const secondRegistry = await service.prepareRegistry("mainnet", {
      type: "add",
      walletId: secondId,
    })
    expect((await service.deliver(secondRegistry)).ready).toBe(true)
    const selected = await service.prepareRegistry("mainnet", {
      type: "main",
      walletId: secondId,
    })
    expect((await service.deliver(selected)).ready).toBe(true)
    for (const id of [firstId, secondId])
      await registry.add({
        id,
        kind: "portable",
        providerId: "spark",
        network: "mainnet",
        label: "Account wallet",
        capabilities: ["pay_invoice", "receive"],
      })
    await registry.setDefault(firstId, "pay_invoice")
    await registry.setDefault(firstId, "receive")
    let mainEventId: string | undefined
    const repeated = await service.prepareRegistry(
      "mainnet",
      { type: "main", walletId: secondId },
      async (retainRegistry) => {
        mainEventId = await service.prepareMain(second, (retainMain) =>
          store.transaction(async () => {
            await registry.setDefault(secondId, "pay_invoice")
            await registry.setDefault(secondId, "receive")
            await retainRegistry()
            await retainMain()
          })
        )
      }
    )
    expect(repeated).toBe(selected)
    expect(mainEventId).toBeDefined()
    expect((await service.deliver(repeated)).ready).toBe(true)
    expect((await service.deliver(mainEventId!)).ready).toBe(true)
    const visible = await store.listVisible(f.owner)
    for (const intent of ["pay_invoice", "receive"] as const)
      expect(
        visible.find((wallet) => wallet.defaultIntents.includes(intent))?.id
      ).toBe(secondId)
    expect(
      (await journal.load(f.owner)).records.some(
        (record) => record.event.id === mainEventId
      )
    ).toBe(true)
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("latest defaults survive and a divergent relay head blocks stale writes", async () => {
  const f = fixture()
  const service = f.service()
  const firstId = crypto.randomUUID()
  const secondId = crypto.randomUUID()
  await backedUp(service, firstId)
  const firstRegistry = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId: firstId,
  })
  expect((await service.deliver(firstRegistry)).ready).toBe(true)
  await backedUp(service, secondId)
  const secondRegistry = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId: secondId,
  })
  expect((await service.deliver(secondRegistry)).ready).toBe(true)
  const defaultEvent = await service.prepareRegistry("mainnet", {
    type: "main",
    walletId: secondId,
  })
  expect((await service.deliver(defaultEvent)).ready).toBe(true)
  const fresh = await f.service().discover(false, "mainnet")
  expect(fresh.registry?.activeWalletIds).toEqual([firstId, secondId].sort())
  expect(fresh.registry?.payInvoiceWalletId).toBe(secondId)
  expect(fresh.registry?.receiveWalletId).toBe(secondId)

  const address = sparkWalletRegistryDTag("mainnet")
  const staleRelay = f.relays.get(f.relayUrls[0])!
  staleRelay.delete(defaultEvent)
  const old = [...f.relays.get(f.relayUrls[1])!.values()].find(
    (event) =>
      event.id === secondRegistry &&
      event.tags.some((tag) => tag[1] === address)
  )
  // Replaceable relays may retain a stale head; the writer must not accept it.
  // The previous signed event is still in the local ciphertext journal.
  const stored = await new DexieSparkRecoveryStore(databases[0]).load(f.owner)
  const previous = stored.records.find(
    (record) => record.event.id === secondRegistry
  )!.event
  staleRelay.set(previous.id, previous)
  expect(old).toBeUndefined()
  await expect(
    service.prepareRegistry("mainnet", {
      type: "remove",
      walletId: firstId,
    })
  ).rejects.toThrow("conflict")
  expect(
    (await f.service().discover(false, "mainnet")).registry?.payInvoiceWalletId
  ).toBe(secondId)
})

test("explicit registry verification succeeds after denial without resuming background consent", async () => {
  const f = fixture()
  const service = f.service()
  const walletId = crypto.randomUUID()
  await backedUp(service, walletId)
  const decrypt = f.provider.decryptNip44!
  f.provider.decryptNip44 = async () => {
    throw new NostrSignerError("authorization_denied")
  }
  await expect(f.signer.decryptNip44(f.owner, "unused")).rejects.toMatchObject({
    code: "authorization_denied",
  })
  f.provider.decryptNip44 = decrypt
  const registry = await service.prepareRegistry("mainnet", {
    type: "add",
    walletId,
  })
  expect(
    (await service.deliver(registry, { priority: "foreground" })).ready
  ).toBe(true)
  expect(
    (await service.discover(false, "mainnet", { priority: "foreground" }))
      .registry?.activeWalletIds
  ).toEqual([walletId])
  await expect(
    f.signer.decryptNip44(f.owner, "unused", { priority: "background" })
  ).rejects.toMatchObject({ code: "background_paused" })
})
