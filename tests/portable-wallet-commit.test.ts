import { resolveSparkLightningAddress } from "../packages/core/src/wallets/resolve-spark-lightning-address"
import { expect, test } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey } from "nostr-tools/pure"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
  WalletRegistry,
} from "@conduit/core"
import { ConduitDB } from "../packages/core/src/db"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import {
  PortableWalletSync,
  projectPortableWallets,
  type PortableWalletAccount,
} from "../packages/core/src/wallets/portable-wallet-sync"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import { deriveSparkRecoveryIdentity } from "../packages/core/src/wallets/spark-sdk"
import { plainTestSigner } from "../tests/helpers/plain-signer"
import { NostrSignerError } from "../packages/core/src/protocol/nostr-event-signer"

async function fixture() {
  const provider = plainTestSigner(
    new NDKPrivateKeySigner(Buffer.from(generateSecretKey()).toString("hex"))
  )
  const signer = new SessionSigner(provider, {
    expectedPubkey: provider.pubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      nip44: true,
      signEvent: true,
      nip04Decrypt: false,
    }),
    hasAuthority: () => true,
  })
  activateAccountSigner(signer)
  const database = new ConduitDB(`new-findings-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database),
    registry = new WalletRegistry(store)
  const published: string[] = []
  const storeRecords = {
    load: async (ownerPubkey: string) =>
      (await database.portableWalletAccounts.get(ownerPubkey)) ?? {
        ownerPubkey,
        wallets: {},
      },
    save: async (account: PortableWalletAccount) => {
      await database.portableWalletAccounts.put(account)
    },
  }
  const make = () =>
    new PortableWalletSync({
      signer,
      store: storeRecords,
      relays: ["wss://fixture.example"],
      deriveIdentity: deriveSparkRecoveryIdentity,
      transport: {
        read: async () => ({ status: "complete", events: [] }),
        publish: async (_url, event) => {
          published.push(event.id)
          return "acked"
        },
      },
      project: (records, options, retain) =>
        projectPortableWallets(signer, records, options, {
          store,
          registry,
          retain,
        }),
    })
  const service = make()
  const wallet = await service.import(
    { mnemonic: generateSparkMnemonic(), network: "mainnet", accountNumber: 0 },
    "Synthetic"
  )
  return {
    provider,
    signer,
    database,
    store,
    registry,
    service,
    wallet,
    storeRecords,
    published,
    make,
    close: async () => {
      retireAccountSigner(signer)
      await database.delete()
    },
  }
}
for (const failIntent of ["pay_invoice", "receive"] as const)
  test(`failed ${failIntent} write rolls back the signed preference and both defaults`, async () => {
    const f = await fixture()
    try {
      await f.service.update(f.wallet.walletId, {
        paySelectedAt: 1,
        receiveSelectedAt: 1,
      })
      const second = await f.service.import(
        {
          mnemonic: generateSparkMnemonic(),
          network: "mainnet",
          accountNumber: 1,
        },
        "Second"
      )
      const before = (await f.storeRecords.load(f.signer.pubkey)).wallets[
        second.walletId
      ].event.id
      const original = f.registry.setDefault.bind(f.registry)
      f.registry.setDefault = async (id, intent) => {
        if (intent === failIntent) throw new Error("injected default failure")
        await original(id, intent)
      }
      await expect(
        f.service.update(
          second.walletId,
          { paySelectedAt: 2, receiveSelectedAt: 2 },
          { priority: "foreground" }
        )
      ).rejects.toThrow("injected default failure")
      const defaults = async () =>
        (await f.store.listVisible(f.signer.pubkey))
          .filter((w) => w.defaultIntents.length)
          .map((w) => ({ id: w.id, intents: w.defaultIntents.sort() }))
      const expected = [
        { id: f.wallet.walletId, intents: ["pay_invoice", "receive"] },
      ]
      expect(await defaults()).toEqual(expected)
      expect(
        (await f.storeRecords.load(f.signer.pubkey)).wallets[second.walletId]
          .event.id
      ).toBe(before)
      expect((await f.service.get(second.walletId)).paySelectedAt).toBe(0)
      f.registry.setDefault = original
      // Finishing without Make main does not issue another preference write.
      await f.make().sync({ priority: "foreground" })
      expect(await defaults()).toEqual(expected)
      expect(
        (await f.storeRecords.load(f.signer.pubkey)).wallets[second.walletId]
          .event.id
      ).toBe(before)
      expect(f.published).toContain(before)
      // A subsequent explicit choice still commits both defaults and its record.
      await f.service.update(second.walletId, {
        paySelectedAt: 3,
        receiveSelectedAt: 3,
      })
      expect(await defaults()).toEqual([
        { id: second.walletId, intents: ["pay_invoice", "receive"] },
      ])
      expect((await f.make().get(second.walletId)).receiveSelectedAt).toBe(3)
    } finally {
      await f.close()
    }
  })

test("verified address remains available during refusal and pending metadata retries with foreground consent", async () => {
  const f = await fixture()
  try {
    const original = f.provider.encryptNip44
    f.provider.encryptNip44 = async () => {
      throw new NostrSignerError("authorization_denied")
    }
    await expect(
      f.signer.encryptNip44(f.signer.pubkey, "synthetic", {
        priority: "background",
      })
    ).rejects.toMatchObject({ code: "authorization_denied" })
    f.provider.encryptNip44 = original
    // Successful foreground access does not lift the background pause.
    await f.signer.encryptNip44(f.signer.pubkey, "synthetic", {
      priority: "foreground",
    })
    let delivery: Promise<void> | undefined
    const resolve = (priority: "foreground" | "background") =>
      resolveSparkLightningAddress({
        walletId: f.wallet.walletId,
        manager: {
          getLightningAddress: async (_id, _register, _name, domain) =>
            domain === "conduit.cash"
              ? { status: "registered", address: "synthetic@conduit.cash" }
              : { status: "registered", address: "synthetic@breez.tips" },
        },
        assertCurrent: () => {
          if (f.signer.pubkey !== f.wallet.ownerPubkey)
            throw new Error("Wrong owner")
        },
        onRegistered: (address) => {
          f.service.rememberLightningAddress(f.wallet.walletId, address)
          delivery = f.service.sync({ priority })
          void delivery.catch(() => {})
        },
      })
    expect(await resolve("background")).toEqual({
      status: "registered",
      address: "synthetic@conduit.cash",
    })
    await expect(delivery!).rejects.toMatchObject({ code: "background_paused" })
    expect((await f.service.get(f.wallet.walletId)).lightningAddress).toBeNull()
    expect(f.service.snapshot.status).toBe("blocked")
    // Retry has a usable provider result immediately, and explicitly authorizes signing.
    expect(await resolve("foreground")).toEqual({
      status: "registered",
      address: "synthetic@conduit.cash",
    })
    await delivery
    expect(
      (await f.make().get(f.wallet.walletId, { priority: "foreground" }))
        .lightningAddress
    ).toBe("synthetic@conduit.cash")
    expect(f.published.length).toBeGreaterThan(0)
    await expect(
      f.signer.encryptNip44(f.signer.pubkey, "synthetic", {
        priority: "background",
      })
    ).rejects.toMatchObject({ code: "background_paused" })
    // Matching metadata is a no-op, even with background signing still paused.
    const retained = (await f.storeRecords.load(f.signer.pubkey)).wallets[
      f.wallet.walletId
    ].event.id
    await resolve("background")
    await delivery
    expect(
      (await f.storeRecords.load(f.signer.pubkey)).wallets[f.wallet.walletId]
        .event.id
    ).toBe(retained)
  } finally {
    await f.close()
  }
})

test("pending addresses are discarded on session clear or observed removal", async () => {
  const f = await fixture()
  try {
    f.service.rememberLightningAddress(
      f.wallet.walletId,
      "synthetic@breez.tips"
    )
    f.service.clear()
    await f.service.sync({ priority: "foreground" })
    expect((await f.service.get(f.wallet.walletId)).lightningAddress).toBeNull()
    f.service.rememberLightningAddress(
      f.wallet.walletId,
      "synthetic@breez.tips"
    )
    await f.service.update(f.wallet.walletId, { lifecycle: "removed" })
    await f.service.sync({ priority: "foreground" })
    expect((await f.service.get(f.wallet.walletId)).lifecycle).toBe("removed")
    expect((await f.service.get(f.wallet.walletId)).lightningAddress).toBeNull()
  } finally {
    await f.close()
  }
})

test("address resolution fences account changes before displaying a provider result", async () => {
  let retained = false
  await expect(
    resolveSparkLightningAddress({
      walletId: "synthetic",
      domain: "breez.tips",
      manager: {
        getLightningAddress: async () => ({
          status: "registered",
          address: "synthetic@breez.tips",
        }),
      },
      assertCurrent: () => {
        throw new Error("Sign-in changed")
      },
      onRegistered: () => {
        retained = true
      },
    })
  ).rejects.toThrow("Sign-in changed")
  expect(retained).toBe(false)
})

test("signed-record storage failure rolls back local defaults", async () => {
  const f = await fixture()
  try {
    const before = (await f.storeRecords.load(f.signer.pubkey)).wallets[
      f.wallet.walletId
    ].event.id
    const save = f.storeRecords.save
    f.storeRecords.save = async (account) => {
      await save(account)
      throw new Error("injected record failure")
    }
    await expect(
      f.service.update(f.wallet.walletId, {
        paySelectedAt: 1,
        receiveSelectedAt: 1,
      })
    ).rejects.toThrow("injected record failure")
    expect(
      (await f.store.listVisible(f.signer.pubkey))[0].defaultIntents
    ).toEqual([])
    expect(
      (await f.storeRecords.load(f.signer.pubkey)).wallets[f.wallet.walletId]
        .event.id
    ).toBe(before)
    f.storeRecords.save = save
    await f.make().sync({ priority: "foreground" })
    expect(
      (await f.store.listVisible(f.signer.pubkey))[0].defaultIntents
    ).toEqual([])
  } finally {
    await f.close()
  }
})
