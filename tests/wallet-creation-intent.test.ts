import { expect, test } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey } from "nostr-tools/pure"
import { ConduitDB } from "../packages/core/src/db"
import { WalletRegistry } from "../packages/core/src/wallets"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  pendingSparkCreation,
  completeSparkCreation,
} from "../packages/core/src/wallets/account-spark-recovery"
import { sealSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import {
  setTestAccountSigner,
  clearTestAccountSigner,
} from "./helpers/plain-signer"

async function fixture() {
  const database = new ConduitDB(`creation-intent-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const signer = setTestAccountSigner(
    new NDKPrivateKeySigner(Buffer.from(generateSecretKey()).toString("hex"))
  )
  const store = new MarketWalletStore(database)
  const journal = new DexieSparkRecoveryStore(database)
  const registry = new WalletRegistry(store)
  const add = async () => {
    const wallet = await registry.add({
      kind: "portable",
      providerId: "spark",
      network: "mainnet",
      label: "Pending",
      capabilities: ["pay_invoice", "receive"],
    })
    const recovery = {
      ...(await sealSignerSparkRecovery(
        generateSparkMnemonic(),
        {
          walletId: wallet.id,
          providerId: "spark",
          network: "mainnet",
          accountNumber: 1,
        },
        signer
      )),
      creationPending: true as const,
    }
    await store.putSparkRecovery(wallet.id, recovery)
    return { wallet, recovery }
  }
  const input = { signer, store, journal, network: "mainnet" as const }
  return {
    database,
    input,
    add,
    async close() {
      clearTestAccountSigner()
      await database.delete()
    },
  }
}

test("durable creation intent survives reload and failed acknowledgement without replacing encrypted identity", async () => {
  const f = await fixture()
  try {
    const first = await f.add()
    f.database.close()
    await f.database.open()
    expect(await pendingSparkCreation(f.input)).toEqual(first)
    const write = f.input.store.putSparkRecovery.bind(f.input.store)
    f.input.store.putSparkRecovery = async () => {
      throw new Error("interrupted write")
    }
    await expect(
      completeSparkCreation({ ...f.input, walletId: first.wallet.id })
    ).rejects.toThrow("interrupted write")
    f.input.store.putSparkRecovery = write
    expect(await pendingSparkCreation(f.input)).toEqual(first)
    await completeSparkCreation({ ...f.input, walletId: first.wallet.id })
    expect(await pendingSparkCreation(f.input)).toBeUndefined()
    const { creationPending: _, ...complete } = first.recovery
    expect(await f.input.store.getSparkRecovery(first.wallet.id)).toEqual(
      complete
    )
    expect((await f.input.store.list())[0].defaultIntents).toEqual([])
  } finally {
    await f.close()
  }
})

test("creation intent never chooses between conflicting attempts or resurrects device removals", async () => {
  const f = await fixture()
  try {
    const first = await f.add()
    const second = await f.add()
    await expect(pendingSparkCreation(f.input)).rejects.toThrow(
      "Several unfinished"
    )
    await f.input.journal.setDeviceRemoved(
      f.input.signer.pubkey,
      first.wallet.id,
      true
    )
    expect(await pendingSparkCreation(f.input)).toEqual(second)
    await f.input.journal.setDeviceRemoved(
      f.input.signer.pubkey,
      second.wallet.id,
      true
    )
    expect(await pendingSparkCreation(f.input)).toBeUndefined()
    expect(
      (await f.input.journal.load(f.input.signer.pubkey)).removedWalletIds
    ).toHaveLength(2)
    expect(await f.input.store.getSparkRecovery(first.wallet.id)).toEqual(
      first.recovery
    )
  } finally {
    await f.close()
  }
})

test("account replacement fences retained creation and export acknowledgement", async () => {
  const f = await fixture()
  try {
    const first = await f.add()
    const replacement = setTestAccountSigner(
      new NDKPrivateKeySigner(Buffer.from(generateSecretKey()).toString("hex"))
    )
    await expect(pendingSparkCreation(f.input)).rejects.toThrow()
    await expect(
      completeSparkCreation({ ...f.input, walletId: first.wallet.id })
    ).rejects.toThrow()
    expect(
      await pendingSparkCreation({ ...f.input, signer: replacement })
    ).toBeUndefined()
    expect(await f.input.store.getSparkRecovery(first.wallet.id)).toEqual(
      first.recovery
    )
  } finally {
    await f.close()
  }
})
