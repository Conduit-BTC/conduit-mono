import { afterEach, expect, test } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import { WalletRegistry } from "../packages/core/src/wallets"
import {
  SessionSigner,
  activateAccountSigner,
  retireAccountSigner,
} from "../packages/core/src/protocol/session-signer"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import { sealSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery-contract"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  SparkRecoveryService,
  type SparkRecoveryTransport,
} from "../packages/core/src/wallets/spark-recovery-service"
import { parseSparkWalletRegistrySnapshot } from "../packages/core/src/wallets/spark-wallet-registry"
import { WalletNameService } from "../packages/core/src/wallets/wallet-name-service"
import {
  DexieWalletNameStore,
  saveWalletNameLocally,
} from "../packages/core/src/wallets/wallet-name-store"
import {
  walletNamesDTag,
  type WalletNameStates,
} from "../packages/core/src/wallets/wallet-name-contract"
import { synchronizeAccountWalletNames } from "../packages/core/src/wallets/account-spark-recovery"
import type {
  SignedNostrEvent,
  NostrKeySigner,
} from "../packages/core/src/protocol/nostr-event-signer"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
function device() {
  const database = new ConduitDB(`wallet-names-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  return {
    database,
    names: new DexieWalletNameStore(database),
    store: new MarketWalletStore(database),
    journal: new DexieSparkRecoveryStore(database),
  }
}
async function fixture() {
  const secret = generateSecretKey(),
    owner = getPublicKey(secret),
    conversation = v2.utils.getConversationKey(secret, owner)
  let signing = 0,
    failPublish = false
  const unavailable = new Set<string>()
  const relays = new Map(
    ["wss://relay.conduit.market", "wss://relay.damus.io", "wss://nos.lol"].map(
      (url) => [url, new Map<string, SignedNostrEvent>()]
    )
  )
  const provider: NostrKeySigner = {
    pubkey: owner,
    getPublicKey: async () => owner,
    signEvent: async (draft) => {
      signing++
      return finalizeEvent(draft, secret)
    },
    encryptNip44: async (_, plaintext) => v2.encrypt(plaintext, conversation),
    decryptNip44: async (_, ciphertext) => v2.decrypt(ciphertext, conversation),
    decryptLegacy: async () => {
      throw new Error("unused")
    },
  }
  const signer = new SessionSigner(provider, {
    expectedPubkey: owner,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    hasAuthority: () => true,
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
  })
  const sent: SignedNostrEvent[] = []
  const transport: SparkRecoveryTransport = {
    async read(url, _, eventId, authorized, address) {
      if (!authorized() || unavailable.has(url))
        return { status: "unavailable", events: [] }
      return {
        status: "complete",
        events: [...relays.get(url)!.values()].filter(
          (event) =>
            (!eventId || event.id === eventId) &&
            (!address ||
              event.tags.some((t) => t[0] === "d" && t[1] === address))
        ),
      }
    },
    async publish(url, event, authorized) {
      if (!authorized()) return "cancelled"
      if (event.tags[0][1] === walletNamesDTag("mainnet")) {
        sent.push(structuredClone(event))
        if (failPublish) return "timed_out"
      }
      const events = relays.get(url)!
      for (const old of events.values())
        if (
          old.kind === event.kind &&
          old.pubkey === event.pubkey &&
          old.tags[0][1] === event.tags[0][1]
        ) {
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
  }
  const local = device(),
    walletId = crypto.randomUUID()
  const recovery = new SparkRecoveryService({
    signer,
    currentSigner: () => signer,
    store: local.journal,
    transport,
    deriveIdentity: async () => "02" + owner,
  })
  const backup = await recovery.prepare(
    { mnemonic: generateSparkMnemonic(), network: "mainnet", accountNumber: 1 },
    walletId
  )
  await recovery.deliver(backup.eventId)
  const pointer = await recovery.preparePrimary(backup)
  await recovery.deliver(pointer)
  const registryId = await recovery.prepareRegistry("mainnet", {
    type: "add",
    walletId,
  })
  await recovery.deliver(registryId)
  const discovery = await recovery.discover(false, "mainnet")
  const namesService = (names = local.names) =>
    new WalletNameService({
      signer,
      currentSigner: () => signer,
      store: names,
      transport,
    })
  return {
    owner,
    signer,
    provider,
    walletId,
    local,
    discovery,
    relays,
    transport,
    recovery,
    unavailable,
    sent,
    namesService,
    signing: () => signing,
    failPublish: (value: boolean) => {
      failPublish = value
    },
    plaintext: (event: SignedNostrEvent) =>
      v2.decrypt(event.content, conversation),
  }
}
async function register(f: Awaited<ReturnType<typeof fixture>>) {
  activateAccountSigner(f.signer)
  await new WalletRegistry(f.local.store).add({
    id: f.walletId,
    kind: "portable",
    providerId: "spark",
    network: "mainnet",
    label: "Original",
    capabilities: ["pay_invoice", "receive"],
  })
  await f.local.store.putSparkRecovery(
    f.walletId,
    await sealSignerSparkRecovery(
      generateSparkMnemonic(),
      {
        walletId: f.walletId,
        providerId: "spark",
        network: "mainnet",
        accountNumber: 1,
      },
      f.signer
    )
  )
}

test("local rename and pending fence survive outage, reload, stale evidence and recovery-journal writes", async () => {
  const f = await fixture()
  await register(f)
  try {
    await f.local.names.queue(f.owner, "mainnet", f.walletId, "Remote old name")
    expect((await f.namesService().sync("mainnet", f.discovery)).ready).toBe(
      true
    )
    f.unavailable.add([...f.relays.keys()][0])
    await saveWalletNameLocally({
      walletId: f.walletId,
      name: "Local newer name",
      store: f.local.store,
      names: f.local.names,
    })
    const reloaded = new DexieWalletNameStore(f.local.database)
    await f.local.journal.retain(f.owner, [])
    expect(
      (await reloaded.load(f.owner, "mainnet")).pending[f.walletId].name
    ).toBe("Local newer name")
    expect(
      await synchronizeAccountWalletNames({
        signer: f.signer,
        discovery: f.discovery,
        network: "mainnet",
        store: f.local.store,
        names: reloaded,
        service: f.namesService(reloaded),
      })
    ).toBe(false)
    expect((await f.local.store.list())[0].label).toBe("Local newer name")
    f.unavailable.clear()
    expect(
      await synchronizeAccountWalletNames({
        signer: f.signer,
        discovery: f.discovery,
        network: "mainnet",
        store: f.local.store,
        names: reloaded,
        service: f.namesService(reloaded),
      })
    ).toBe(true)
    expect(
      (await f.namesService(device().names).sync("mainnet", f.discovery)).names[
        f.walletId
      ]
    ).toBe("Local newer name")
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("failed local persistence rolls back the label and leaves no rename intent", async () => {
  const f = await fixture()
  await register(f)
  try {
    const names = new DexieWalletNameStore(f.local.database)
    names.queue = async () => {
      throw new Error("Injected intent write failure")
    }
    await expect(
      saveWalletNameLocally({
        walletId: f.walletId,
        name: "Uncommitted",
        store: f.local.store,
        names,
      })
    ).rejects.toThrow("Injected")
    expect((await f.local.store.list())[0].label).toBe("Original")
    expect((await f.local.names.load(f.owner, "mainnet")).pending).toEqual({})
  } finally {
    retireAccountSigner(f.signer)
  }
})

test("delivery retries immutable signed bytes and retains a newer rename queued during delivery", async () => {
  const f = await fixture()
  await f.local.names.queue(f.owner, "mainnet", f.walletId, "First")
  f.failPublish(true)
  expect((await f.namesService().sync("mainnet", f.discovery)).ready).toBe(
    false
  )
  const operation = (await f.local.names.load(f.owner, "mainnet")).operation!
  expect(JSON.stringify(operation.event)).not.toContain("First")
  const signing = f.signing()
  await f.local.names.queue(f.owner, "mainnet", f.walletId, "Second")
  expect((await f.namesService().sync("mainnet", f.discovery)).ready).toBe(
    false
  )
  expect(f.signing()).toBe(signing)
  expect(
    f.sent.every(
      (event) => JSON.stringify(event) === JSON.stringify(operation.event)
    )
  ).toBe(true)
  f.failPublish(false)
  expect(
    (await f.namesService().sync("mainnet", f.discovery)).names[f.walletId]
  ).toBe("Second")
  expect((await f.local.names.load(f.owner, "mainnet")).pending).toEqual({})
})

test("names preserve deployed strict membership readers and survive an older membership successor", async () => {
  const f = await fixture()
  await f.local.names.queue(f.owner, "mainnet", f.walletId, "Shared name")
  expect((await f.namesService().sync("mainnet", f.discovery)).ready).toBe(true)
  const legacyDevice = device()
  const legacy = new SparkRecoveryService({
    signer: f.signer,
    currentSigner: () => f.signer,
    store: legacyDevice.journal,
    transport: f.transport,
    deriveIdentity: async () => "02" + f.owner,
  })
  const observed = await legacy.discover(false, "mainnet")
  expect(observed.invalidCount).toBe(0)
  const event = [...f.relays.values()][0].get(observed.registryEventId!)!
  expect(
    parseSparkWalletRegistrySnapshot(f.plaintext(event), event).activeWalletIds
  ).toEqual([f.walletId])
  expect(JSON.parse(f.plaintext(event)).walletNames).toBeUndefined()
  const main = await legacy.prepareRegistry("mainnet", {
    type: "main",
    walletId: f.walletId,
  })
  expect((await legacy.deliver(main)).ready).toBe(true)
  expect(
    (
      await f
        .namesService(device().names)
        .sync("mainnet", await legacy.discover(false, "mainnet"))
    ).names[f.walletId]
  ).toBe("Shared name")
})

test("removed membership dominates names and malformed optional names never poison recovery", async () => {
  const f = await fixture()
  await f.local.names.queue(f.owner, "mainnet", f.walletId, "Removed name")
  await f.namesService().sync("mainnet", f.discovery)
  const removal = await f.recovery.prepareRegistry("mainnet", {
    type: "remove",
    walletId: f.walletId,
  })
  await f.recovery.deliver(removal)
  const discovery = await f.recovery.discover(false, "mainnet")
  await f.local.names.queue(f.owner, "mainnet", f.walletId, "Cannot resurrect")
  expect((await f.namesService().sync("mainnet", discovery)).names).toEqual({})
  expect((await f.local.names.load(f.owner, "mainnet")).pending).toEqual({})
  const bad = await f.provider.signEvent({
    kind: 30078,
    pubkey: f.owner,
    created_at: Math.floor(Date.now() / 1000) + 50,
    tags: [["d", walletNamesDTag("mainnet")]],
    content: await f.provider.encryptNip44(
      f.owner,
      JSON.stringify({ names: "malformed" })
    ),
  })
  for (const events of f.relays.values()) {
    for (const event of events.values())
      if (event.tags[0][1] === walletNamesDTag("mainnet"))
        events.delete(event.id)
    events.set(bad.id, bad)
  }
  const recovered = await f.recovery.discover(false, "mainnet")
  expect(recovered.invalidCount).toBe(0)
  expect(recovered.registry?.removedWalletIds).toContain(f.walletId)
  expect(recovered.registry?.activeWalletIds).toEqual([])
})

test("damaged optional local name evidence cannot invalidate recovery", async () => {
  const f = await fixture()
  await f.local.database.sparkRecoveryEvidence.update(f.owner, {
    walletNameSync: {
      mainnet: { pending: "damaged" },
    } as unknown as WalletNameStates,
  })
  const observed = await f.recovery.discover(false, "mainnet")
  expect(observed.invalidCount).toBe(0)
  expect(observed.registry?.activeWalletIds).toEqual([f.walletId])
  expect(observed.registryMembershipReady).toBe(true)
})

test("signer denial leaves the saved local name and durable pending intent usable", async () => {
  const f = await fixture()
  await register(f)
  try {
    await f.local.names.queue(f.owner, "mainnet", f.walletId, "Previous name")
    await f.namesService().sync("mainnet", f.discovery)
    await saveWalletNameLocally({
      walletId: f.walletId,
      name: "Name without consent",
      store: f.local.store,
      names: f.local.names,
    })
    const decrypt = f.provider.decryptNip44
    f.provider.decryptNip44 = async () => {
      throw new Error("Injected consent denial")
    }
    expect(
      await synchronizeAccountWalletNames({
        signer: f.signer,
        discovery: f.discovery,
        network: "mainnet",
        store: f.local.store,
        names: f.local.names,
        service: f.namesService(),
      })
    ).toBe(false)
    expect((await f.local.store.list())[0].label).toBe("Name without consent")
    expect(
      (await f.local.names.load(f.owner, "mainnet")).pending[f.walletId].name
    ).toBe("Name without consent")
    f.provider.decryptNip44 = decrypt
  } finally {
    retireAccountSigner(f.signer)
  }
})
