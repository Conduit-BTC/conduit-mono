import { afterEach, expect, test } from "bun:test"
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
import { projectPortableWallets } from "../packages/core/src/wallets/portable-wallet-sync"
import {
  portableWalletId,
  type PortableWalletRecord,
} from "../packages/core/src/wallets/portable-wallet-record"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import { openSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import { deriveSparkRecoveryIdentity } from "../packages/core/src/wallets/spark-sdk"
import { plainTestSigner } from "./helpers/plain-signer"
let active: SessionSigner | undefined
let database: ConduitDB | undefined
afterEach(async () => {
  if (active) retireAccountSigner(active)
  active = undefined
  await database?.delete()
  database = undefined
})

test("projects a complete wallet atomically into isolated provider credentials with the actual native identity", async () => {
  const provider = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  active = new SessionSigner(plainTestSigner(provider), {
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
  activateAccountSigner(active)
  database = new ConduitDB(`wallet-projection-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database),
    registry = new WalletRegistry(store)
  const bundle = {
    mnemonic: generateSparkMnemonic(),
    accountNumber: 7,
    network: "mainnet" as const,
  }
  const identityPublicKey = await deriveSparkRecoveryIdentity(bundle)
  const identity = { ...bundle, identityPublicKey, ownerPubkey: active.pubkey }
  const record: PortableWalletRecord = {
    ...identity,
    walletId: portableWalletId(identity),
    format: "conduit.portable-wallet",
    version: 1,
    provider: "spark",
    name: "Imported",
    lifecycle: "active",
    setupPending: false,
    lightningAddress: "imported@breez.tips",
    paySelectedAt: 1,
    receiveSelectedAt: 1,
  }
  await projectPortableWallets(
    active,
    [record],
    { priority: "foreground" },
    { store, registry }
  )
  // A routine readback must not invalidate wallet subscribers or restart
  // their provider balance reads when the complete record is unchanged.
  let descriptorWrites = 0
  const countWrite = () => {
    descriptorWrites++
  }
  database.wallets.hook("updating", countWrite)
  await projectPortableWallets(active, [record], {}, { store, registry })
  database.wallets.hook("updating").unsubscribe(countWrite)
  expect(descriptorWrites).toBe(0)
  const visible = await store.listVisible(active.pubkey)
  expect(visible.length).toBe(1)
  expect(visible[0].label).toBe("Imported")
  expect(visible[0].defaultIntents.sort()).toEqual(["pay_invoice", "receive"])
  const credential = await store.getSparkRecovery(record.walletId)
  expect(credential?.accountNumber).toBe(7)
  const recovered = await openSignerSparkRecovery(
    credential!,
    {
      walletId: record.walletId,
      providerId: "spark",
      network: "mainnet",
      accountNumber: 7,
    },
    active
  )
  expect(
    (await deriveSparkRecoveryIdentity({ ...bundle, mnemonic: recovered })) ===
      identityPublicKey
  ).toBe(true)
  expect(
    JSON.stringify(await database.walletCredentials.toArray()).includes(
      bundle.mnemonic
    )
  ).toBe(false)
  await projectPortableWallets(
    active,
    [{ ...record, name: "Renamed" }],
    {},
    { store, registry }
  )
  expect((await store.listVisible(active.pubkey))[0].label).toBe("Renamed")
  expect(
    (await store.getSparkRecovery(record.walletId))?.ciphertext ===
      credential?.ciphertext
  ).toBe(true)
  const secondIdentity = { ...identity, accountNumber: 8 }
  secondIdentity.identityPublicKey =
    await deriveSparkRecoveryIdentity(secondIdentity)
  const second: PortableWalletRecord = {
    ...record,
    ...secondIdentity,
    walletId: portableWalletId(secondIdentity),
    name: "Second",
    paySelectedAt: 2,
    receiveSelectedAt: 2,
  }
  await projectPortableWallets(
    active,
    [record, second],
    {},
    { store, registry }
  )
  expect(
    (await store.listVisible(active.pubkey))
      .find((w) => w.id === second.walletId)
      ?.defaultIntents.sort()
  ).toEqual(["pay_invoice", "receive"])
  const removedSecond = { ...second, lifecycle: "removed" as const }
  await projectPortableWallets(
    active,
    [record, removedSecond],
    {},
    { store, registry }
  )
  const remaining = await store.listVisible(active.pubkey)
  expect(remaining).toHaveLength(1)
  expect(remaining[0].defaultIntents.sort()).toEqual(["pay_invoice", "receive"])
  const fresh = new ConduitDB(`wallet-fresh-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  try {
    const freshStore = new MarketWalletStore(fresh),
      freshRegistry = new WalletRegistry(freshStore)
    await projectPortableWallets(
      active,
      [record, removedSecond],
      {},
      { store: freshStore, registry: freshRegistry }
    )
    expect(
      (await freshStore.listVisible(active.pubkey))[0].defaultIntents.sort()
    ).toEqual(remaining[0].defaultIntents.sort())
  } finally {
    await fresh.delete()
  }
  const external = await registry.add({
    providerId: "nwc",
    kind: "connected",
    network: "mainnet",
    label: "External",
    capabilities: ["pay_invoice"],
  })
  await registry.setDefault(external.id, "pay_invoice")
  // Removing another wallet must not override a deliberate local NWC choice.
  await projectPortableWallets(
    active,
    [record, second],
    {},
    { store, registry }
  )
  await registry.setDefault(external.id, "pay_invoice")
  await projectPortableWallets(
    active,
    [record, removedSecond],
    {},
    { store, registry }
  )
  expect(
    (await store.listVisible(active.pubkey)).find((w) => w.id === external.id)
      ?.defaultIntents
  ).toContain("pay_invoice")
  await projectPortableWallets(
    active,
    [{ ...record, paySelectedAt: 2 }],
    {},
    { store, registry }
  )
  expect(
    (await store.listVisible(active.pubkey)).find(
      (w) => w.id === record.walletId
    )?.defaultIntents
  ).toContain("pay_invoice")
  await registry.remove(external.id)
  await projectPortableWallets(
    active,
    [{ ...record, lifecycle: "removed" }],
    {},
    { store, registry }
  )
  expect((await store.listVisible(active.pubkey)).length).toBe(0)
  expect(await database.walletCredentials.count()).toBe(2)
  expect(await database.sparkRecoveryEvidence.count()).toBe(0)
}, 15000)
