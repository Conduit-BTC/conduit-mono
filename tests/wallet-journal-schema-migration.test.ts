import { expect, test } from "bun:test"
import Dexie from "dexie"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"

test("clean-start storage preserves but never reads old wallet recovery data", async () => {
  const indexedDB = new IDBFactory()
  const name = `wallet-cutover-${crypto.randomUUID()}`
  const old = new Dexie(name, { indexedDB, IDBKeyRange })
  old.version(30).stores({
    wallets: "id",
    walletCredentials: "walletId",
    sparkRecoveryEvidence: "ownerPubkey",
    checkoutRecoveryStorage: "key",
  })
  const descriptor = {
    id: "old-wallet",
    providerId: "spark",
    kind: "portable",
    network: "mainnet",
    label: "Old name",
    capabilities: [],
    defaultIntents: [],
    createdAt: 1,
    updatedAt: 1,
    status: "registered",
  }
  await old.table("wallets").put(descriptor)
  await old.table("walletCredentials").put({
    walletId: descriptor.id,
    providerId: "spark",
    credential: crypto.randomUUID(),
  })
  await old
    .table("sparkRecoveryEvidence")
    .put({ ownerPubkey: "old-owner", records: [], unresolvedObserved: true })
  await old
    .table("checkoutRecoveryStorage")
    .put({ key: "pending-payment", value: "original-operation" })
  old.close()
  const fresh = new ConduitDB(name, { indexedDB, IDBKeyRange })
  try {
    const store = new MarketWalletStore(fresh)
    expect((await store.list()).length).toBe(0)
    expect(await store.getSparkRecovery(descriptor.id)).toBeNull()
    expect(await fresh.portableWalletAccounts.count()).toBe(0)
    expect(await fresh.wallets.count()).toBe(1)
    expect(await fresh.walletCredentials.count()).toBe(1)
    expect(await fresh.sparkRecoveryEvidence.count()).toBe(1)
    expect(
      (await fresh.table("checkoutRecoveryStorage").get("pending-payment"))
        .value
    ).toBe("original-operation")
  } finally {
    await fresh.delete()
  }
})
