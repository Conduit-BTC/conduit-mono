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
import { reconcileNwcWalletRegistration } from "../packages/core/src/wallets/wallet-migration"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import { sealSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import { plainTestSigner } from "./helpers/plain-signer"

let active: SessionSigner | undefined
let database: ConduitDB | undefined
function connect(provider: NDKPrivateKeySigner) {
  if (active) retireAccountSigner(active)
  active = new SessionSigner(plainTestSigner(provider), {
    expectedPubkey: provider.pubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
    hasAuthority: () => true,
  })
  activateAccountSigner(active)
}
afterEach(async () => {
  if (active) retireAccountSigner(active)
  active = undefined
  await database?.delete()
  database = undefined
})

test("shared NWC defaults remain independent across account replacement, network and intent", async () => {
  database = new ConduitDB(`wallet-defaults-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database)
  const registry = new WalletRegistry(store)
  const owner = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  const other = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  connect(owner)
  const spark = await registry.add({
    kind: "portable",
    providerId: "spark",
    label: "Owner wallet",
    network: "mainnet",
    capabilities: ["pay_invoice", "receive"],
  })
  await store.putSparkRecovery(
    spark.id,
    await sealSignerSparkRecovery(generateSparkMnemonic(), {
      walletId: spark.id,
      providerId: "spark",
      network: "mainnet",
      accountNumber: 7,
    })
  )
  const shared = await registry.add({
    kind: "connected",
    providerId: "nwc",
    label: "Shared wallet",
    network: "mainnet",
    capabilities: ["pay_invoice", "receive"],
  })
  const foreign = await registry.add({
    kind: "connected",
    providerId: "nwc",
    label: "Test wallet",
    network: "testnet",
    capabilities: ["pay_invoice", "receive"],
  })
  for (const intent of ["pay_invoice", "receive"] as const) {
    await registry.setDefault(spark.id, intent)
    await registry.setDefault(foreign.id, intent)
  }
  connect(other)
  for (const intent of ["pay_invoice", "receive"] as const)
    await registry.setDefault(shared.id, intent)

  connect(owner)
  database.close()
  await database.open()
  const reopened = new MarketWalletStore(database)
  const defaults = async () => {
    const rows = await reopened.list()
    return JSON.stringify(
      rows.map(({ defaultIntents, defaultIntentsByScope }) => ({
        defaultIntents,
        defaultIntentsByScope,
      }))
    )
  }
  const beforeRename = await defaults()
  connect(other)
  await reopened.rename(shared.id, "Renamed shared wallet")
  expect((await defaults()) === beforeRename).toBe(true)
  expect(
    (await reopened.list()).find((row) => row.id === shared.id)?.label
  ).toBe("Renamed shared wallet")
  connect(owner)
  for (const intent of ["pay_invoice", "receive"] as const) {
    const mine = await reopened.listVisible(owner.pubkey)
    expect(
      mine
        .filter(
          (w) => w.network === "mainnet" && w.defaultIntents.includes(intent)
        )
        .map((w) => w.id)
    ).toEqual([spark.id])
    expect(
      mine
        .filter(
          (w) => w.network === "testnet" && w.defaultIntents.includes(intent)
        )
        .map((w) => w.id)
    ).toEqual([foreign.id])
    const theirs = await reopened.listVisible(other.pubkey)
    expect(
      theirs
        .filter(
          (w) => w.network === "mainnet" && w.defaultIntents.includes(intent)
        )
        .map((w) => w.id)
    ).toEqual([shared.id])
  }
  expect(await database.walletCredentials.count()).toBe(1)
})

test("legacy defaults remain intact and ambiguity requires an explicit device choice", async () => {
  database = new ConduitDB(`wallet-legacy-defaults-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database)
  const registry = new WalletRegistry(store)
  const first = await registry.add({
    kind: "connected",
    providerId: "nwc",
    label: "First",
    network: "mainnet",
    capabilities: ["pay_invoice"],
  })
  await store.put({ ...first, defaultIntents: ["pay_invoice"] })
  expect(
    (await store.listVisible(null))
      .filter((w) => w.defaultIntents.includes("pay_invoice"))
      .map((w) => w.id)
  ).toEqual([first.id])
  const second = await registry.add({
    kind: "connected",
    providerId: "nwc",
    label: "Second",
    network: "mainnet",
    capabilities: ["pay_invoice"],
  })
  await store.put({ ...second, defaultIntents: ["pay_invoice"] })
  expect(
    (await store.listVisible(null)).filter((w) =>
      w.defaultIntents.includes("pay_invoice")
    )
  ).toHaveLength(0)
  await registry.setDefault(second.id, "pay_invoice")
  expect(
    (await store.listVisible(null))
      .filter((w) => w.defaultIntents.includes("pay_invoice"))
      .map((w) => w.id)
  ).toEqual([second.id])
  await store.rename(first.id, "Renamed first")
  expect((await store.list()).map((w) => w.defaultIntents)).toEqual([
    ["pay_invoice"],
    ["pay_invoice"],
  ])
})

test("account replacement during default read aborts the preference transaction", async () => {
  database = new ConduitDB(`wallet-default-fence-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new MarketWalletStore(database)
  const registry = new WalletRegistry(store)
  const owner = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  const other = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  )
  connect(owner)
  const wallet = await registry.add({
    kind: "connected",
    providerId: "nwc",
    label: "Shared",
    network: "mainnet",
    capabilities: ["pay_invoice"],
  })
  const listVisible = store.listVisible.bind(store)
  store.listVisible = async (pubkey) => {
    const rows = await listVisible(pubkey)
    connect(other)
    return rows
  }
  await expect(registry.setDefault(wallet.id, "pay_invoice")).rejects.toThrow(
    "Wallet sign-in changed."
  )
  expect((await store.list())[0].defaultIntentsByScope).toBeUndefined()
})

for (const change of ["capability", "network"] as const) {
  test(`live NWC ${change} reconciliation repairs only the active account default`, async () => {
    database = new ConduitDB(`wallet-reconcile-${crypto.randomUUID()}`, {
      indexedDB: new IDBFactory(),
      IDBKeyRange,
    })
    const store = new MarketWalletStore(database)
    let timestamp = 0
    const registry = new WalletRegistry(store, { now: () => ++timestamp })
    const owner = new NDKPrivateKeySigner(
      Buffer.from(generateSecretKey()).toString("hex")
    )
    const other = new NDKPrivateKeySigner(
      Buffer.from(generateSecretKey()).toString("hex")
    )
    connect(owner)
    const add = (label: string) =>
      registry.add({
        kind: "connected",
        providerId: "nwc",
        label,
        network: "mainnet",
        capabilities: ["pay_invoice", "receive"],
      })
    const selected = await add("Selected")
    const replacement = await add("Replacement")
    const otherChoice = await add("Other account choice")
    await registry.setDefault(selected.id, "pay_invoice")
    connect(other)
    await registry.setDefault(otherChoice.id, "pay_invoice")
    connect(owner)
    await reconcileNwcWalletRegistration({
      walletId: selected.id,
      ownerPubkey: owner.pubkey,
      info: {
        network: change === "network" ? "testnet" : "mainnet",
        methods:
          change === "capability"
            ? ["make_invoice"]
            : ["pay_invoice", "make_invoice"],
      },
      store,
    })
    const defaults = (rows: Awaited<ReturnType<typeof store.listVisible>>) =>
      rows
        .filter(
          (w) =>
            w.network === "mainnet" && w.defaultIntents.includes("pay_invoice")
        )
        .map((w) => w.id)
    expect(defaults(await store.listVisible(owner.pubkey))).toEqual([
      replacement.id,
    ])
    expect(defaults(await store.listVisible(other.pubkey))).toEqual([
      otherChoice.id,
    ])
    expect(
      (await store.list()).every((w) => w.defaultIntents.length === 0)
    ).toBe(true)
  })
}

for (const failure of ["account", "write"] as const) {
  test(`live NWC reconciliation rolls back registration and defaults after ${failure} failure`, async () => {
    database = new ConduitDB(
      `wallet-reconcile-rollback-${crypto.randomUUID()}`,
      {
        indexedDB: new IDBFactory(),
        IDBKeyRange,
      }
    )
    const store = new MarketWalletStore(database)
    let timestamp = 0
    const registry = new WalletRegistry(store, { now: () => ++timestamp })
    const owner = new NDKPrivateKeySigner(
      Buffer.from(generateSecretKey()).toString("hex")
    )
    const other = new NDKPrivateKeySigner(
      Buffer.from(generateSecretKey()).toString("hex")
    )
    connect(owner)
    const add = (label: string) =>
      registry.add({
        kind: "connected",
        providerId: "nwc",
        label,
        network: "mainnet",
        capabilities: ["pay_invoice", "receive"],
      })
    const selected = await add("Selected")
    const replacement = await add("Replacement")
    await registry.setDefault(selected.id, "pay_invoice")
    connect(other)
    await registry.setDefault(replacement.id, "pay_invoice")
    connect(owner)
    const scope = active
    const before = await store.list()
    if (failure === "account") {
      const original = store.put.bind(store)
      store.put = async (wallet) => {
        await original(wallet)
        connect(other)
      }
    } else {
      const original = store.setDefault.bind(store)
      store.setDefault = async (input) => {
        await original(input)
        throw new Error("Synthetic scoped-default failure")
      }
    }
    await expect(
      reconcileNwcWalletRegistration({
        walletId: selected.id,
        ownerPubkey: owner.pubkey,
        info: { network: "mainnet", methods: ["make_invoice"] },
        store,
        shouldContinue: () => active === scope,
      })
    ).rejects.toThrow(
      failure === "account"
        ? "Wallet sign-in changed"
        : "Synthetic scoped-default failure"
    )
    expect(await store.list()).toEqual(before)
  })
}
