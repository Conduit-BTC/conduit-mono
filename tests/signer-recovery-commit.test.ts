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
import {
  MarketWalletStore,
  serializeStoredSparkWalletRecovery,
} from "../packages/core/src/wallets/wallet-storage"
import {
  generateSparkMnemonic,
  encryptSparkMnemonic,
} from "../packages/core/src/wallets/spark-recovery"
import {
  sealSignerSparkRecovery,
  recoverStoredSparkMnemonic,
  assertWalletSignerCurrent,
} from "../packages/core/src/wallets/signer-spark-recovery"
import { commitVerifiedSignerRecovery } from "../packages/core/src/wallets/signer-recovery-commit"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import { plainTestSigner } from "./helpers/plain-signer"
let active: SessionSigner | undefined
let database: ConduitDB | undefined
afterEach(async () => {
  if (active) retireAccountSigner(active)
  active = undefined
  await database?.delete()
  database = undefined
})
async function fixture() {
  const provider = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  const signer = new SessionSigner(plainTestSigner(provider), {
    expectedPubkey: provider.pubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    hasAuthority: () => true,
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
  })
  activateAccountSigner(signer)
  active = signer
  database = new ConduitDB(`retire-password-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database),
    registry = new WalletRegistry(store)
  const wallet = await registry.add({
    kind: "portable",
    providerId: "spark",
    network: "mainnet",
    label: "Original wallet",
    capabilities: ["pay_invoice", "receive"],
  })
  const binding = {
    walletId: wallet.id,
    providerId: "spark" as const,
    network: "mainnet" as const,
    accountNumber: 7,
  }
  const mnemonic = generateSparkMnemonic(),
    password = crypto.randomUUID()
  const original = {
    ...binding,
    type: "password" as const,
    recovery: await encryptSparkMnemonic(mnemonic, password, binding, {
      iterations: 100000,
    }),
  }
  const verified = await sealSignerSparkRecovery(mnemonic, binding, signer)
  await store.putSparkRecovery(wallet.id, original)
  const commit = (
    record = original as
      typeof original | (typeof verified & { legacyRecovery: typeof original })
  ) =>
    commitVerifiedSignerRecovery({
      store,
      walletId: wallet.id,
      original: record,
      verified,
      assertAuthority: () => assertWalletSignerCurrent(signer),
    })
  return {
    store,
    wallet,
    binding,
    mnemonic,
    password,
    original,
    verified,
    signer,
    commit,
  }
}
test("successful migration retains the encrypted password fallback", async () => {
  const f = await fixture()
  await f.commit()
  const saved = (await f.store.getSparkRecovery(f.wallet.id))!
  expect(
    serializeStoredSparkWalletRecovery(saved) ===
      serializeStoredSparkWalletRecovery({
        ...f.verified,
        legacyRecovery: f.original,
      })
  ).toBe(true)
  expect(
    (await recoverStoredSparkMnemonic(saved, f.binding)).mnemonic === f.mnemonic
  ).toBe(true)
  expect((await f.store.listVisible(f.signer.pubkey))[0]!.id).toBe(f.wallet.id)
  expect(
    (await recoverStoredSparkMnemonic(saved, f.binding, f.password)).mnemonic
  ).toBe(f.mnemonic)
  const owner = f.signer.pubkey
  retireAccountSigner(f.signer)
  active = undefined
  expect((await f.store.listVisible(null))[0]!.id).toBe(f.wallet.id)
  await new DexieSparkRecoveryStore(database!).setDeviceRemoved(
    owner,
    f.wallet.id,
    true
  )
  expect(await f.store.listVisible(null)).toEqual([])
})
test("already-migrated records retain the exact legacy envelope after verification", async () => {
  const f = await fixture(),
    old = { ...f.verified, legacyRecovery: f.original }
  await f.store.putSparkRecovery(f.wallet.id, old)
  expect(
    (await recoverStoredSparkMnemonic(old, f.binding)).mnemonic === f.mnemonic
  ).toBe(true)
  await f.commit(old)
  expect(
    serializeStoredSparkWalletRecovery(
      (await f.store.getSparkRecovery(f.wallet.id))!
    ) === serializeStoredSparkWalletRecovery(old)
  ).toBe(true)
})
for (const failure of [
  "write",
  "readback",
  "revocation",
  "replacement",
] as const) {
  test(`migration ${failure} failure retains the original usable password record`, async () => {
    const f = await fixture(),
      put = f.store.putSparkRecovery.bind(f.store),
      get = f.store.getSparkRecovery.bind(f.store)
    if (failure === "write")
      f.store.putSparkRecovery = async (...args) => {
        await put(...args)
        throw new Error("Injected failure")
      }
    if (failure === "readback") {
      let reads = 0
      f.store.getSparkRecovery = async (id) => (++reads === 2 ? null : get(id))
    }
    if (failure === "revocation")
      f.store.putSparkRecovery = async (...args) => {
        await put(...args)
        retireAccountSigner(f.signer)
      }
    if (failure === "replacement") {
      await put(f.wallet.id, {
        ...f.original,
        recovery: await encryptSparkMnemonic(
          f.mnemonic,
          f.password,
          f.binding,
          { iterations: 100000 }
        ),
      })
    }
    const retained = await get(f.wallet.id)
    await expect(f.commit()).rejects.toThrow()
    expect(
      JSON.stringify(await get(f.wallet.id)) === JSON.stringify(retained)
    ).toBe(true)
    expect(
      (await recoverStoredSparkMnemonic(retained!, f.binding, f.password))
        .mnemonic === f.mnemonic
    ).toBe(true)
  })
}
