import { expect, test } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey } from "nostr-tools/pure"
import { DefaultSparkSigner } from "../apps/market/node_modules/@buildonspark/spark-sdk"
import { mnemonicToSeedSync } from "../apps/market/node_modules/@scure/bip39"
import { ConduitDB } from "../packages/core/src/db"
import { WalletRegistry } from "../packages/core/src/wallets"
import { accountAddressRequests } from "../packages/core/src/wallets/account-address-request"
import { MarketWalletStore } from "../packages/core/src/wallets/wallet-storage"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import { DexieAddressRequestStore } from "../packages/core/src/wallets/address-request-store"
import { AddressRequestService } from "../packages/core/src/wallets/address-request-service"
import { SparkRecoveryService } from "../packages/core/src/wallets/spark-recovery-service"
import { deriveSparkRecoveryIdentity } from "../packages/core/src/wallets/spark-sdk"
import { createSparkBreezAddressAccess } from "../packages/core/src/wallets/spark-breez-address-access"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery"
import { sealSignerSparkRecovery } from "../packages/core/src/wallets/signer-spark-recovery"
import {
  clearTestAccountSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"

async function fixture(coverage: "partial" | "unavailable") {
  const database = new ConduitDB(`selected-address-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const signer = setTestAccountSigner(
    new NDKPrivateKeySigner(Buffer.from(generateSecretKey()).toString("hex"))
  )
  const store = new MarketWalletStore(database)
  const registry = new WalletRegistry(store)
  const journal = new DexieSparkRecoveryStore(database)
  const requests = new DexieAddressRequestStore(database)
  const wallet = await registry.add({
    kind: "portable",
    providerId: "spark",
    network: "mainnet",
    label: "Selected",
    capabilities: ["pay_invoice", "receive"],
  })
  const mnemonic = generateSparkMnemonic()
  await store.putSparkRecovery(
    wallet.id,
    await sealSignerSparkRecovery(
      mnemonic,
      {
        walletId: wallet.id,
        providerId: "spark",
        network: "mainnet",
        accountNumber: 1,
      },
      signer
    )
  )
  const native = new DefaultSparkSigner()
  await native.createSparkWalletFromSeed(mnemonicToSeedSync(mnemonic), 1)
  const address = createSparkBreezAddressAccess({
    network: "mainnet",
    signer: {
      assertActive() {},
      getIdentityPublicKey: async () =>
        Buffer.from(await native.getIdentityPublicKey()).toString("hex"),
      signDigest: (digest) => native.signMessageWithIdentityKey(digest),
    },
  })
  const transport = {
    read: async () => ({ status: coverage, events: [] }),
    publish: async () => "timed_out" as const,
  }
  const recovery = new SparkRecoveryService({
    signer,
    store: journal,
    transport,
    deriveIdentity: deriveSparkRecoveryIdentity,
  })
  const metadata = new AddressRequestService({
    signer,
    store: requests,
    transport,
  })
  let tail = Promise.resolve<unknown>(undefined)
  const originalLocks = navigator.locks
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_: string, run: () => Promise<unknown>) => {
        const result = tail.then(run)
        tail = result.catch(() => {})
        return result
      },
    },
  })
  let lost = true
  let received: string | undefined
  const calls: string[] = []
  const manager = {
    getAddressIdentity: async () => address.getAddressIdentity(),
    signAddressNameRequest: async (
      _id: string,
      input: Parameters<typeof address.signAddressNameRequest>[0]
    ) => address.signAddressNameRequest(input),
    getLightningAddress: async () => ({ status: "absent" as const }),
  }
  const workflow = () =>
    accountAddressRequests(signer, "market", {
      recovery,
      metadata,
      store,
      journal,
      manager,
      fetch: (async (url, init) => {
        // Every external submission/status sees exact, encrypted, read-back local intent.
        const local = await metadata.loadLocal("mainnet")
        expect(local.records[wallet.id].payload).toBe(String(init?.body))
        calls.push(String(url).endsWith("/status") ? "status" : "submit")
        if (String(url).endsWith("/status"))
          return Response.json(
            { status: received ? "received" : "not_received" },
            { status: received ? 200 : 404 }
          )
        expect(received).toBeUndefined()
        received = String(init?.body)
        if (lost) {
          lost = false
          throw new Error("Lost reply")
        }
        return Response.json({ status: "received" })
      }) as typeof fetch,
    })
  return {
    database,
    signer,
    store,
    journal,
    metadata,
    requests,
    wallet,
    calls,
    workflow,
    manager,
    recovery,
    receiveReplies() {
      lost = false
    },
    async settle() {
      await tail
      await tail
    },
    async close() {
      await tail
      await tail
      clearTestAccountSigner()
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      })
      await database.delete()
    },
  }
}
for (const coverage of ["partial", "unavailable"] as const) {
  test(`production name workflow preserves one intent across lost reply/reload with ${coverage} recovery`, async () => {
    const f = await fixture(coverage)
    try {
      const before = JSON.stringify(await f.store.list())
      const initial = await f
        .workflow()
        .submit(f.wallet.id, { desiredName: "EXISTING", token: "controlled" })
      expect(initial.record.phase).toBe("pending")
      expect(initial.publication).toBe("local")
      await f.settle()
      f.database.close()
      await f.database.open()
      const resumed = await f
        .workflow()
        .submit(f.wallet.id, { desiredName: "another", token: "controlled" })
      expect(resumed.record.phase).toBe("received")
      expect(resumed.record.payload).toBe(initial.record.payload)
      expect(resumed.record.accountProof).toBe(initial.record.accountProof)
      expect(f.calls).toEqual(["submit", "status"])
      expect(JSON.stringify(await f.store.list())).toBe(before)
      await f.settle()
      await f.journal.setDeviceRemoved(f.signer.pubkey, f.wallet.id, true)
      await expect(f.workflow().check(f.wallet.id)).rejects.toThrow(
        "available wallet"
      )
      expect(f.calls).toEqual(["submit", "status"])
    } finally {
      await f.close()
    }
  })
}
test("production selected-wallet authority rejects native identity replacement and account revocation before HTTP", async () => {
  const f = await fixture("unavailable")
  try {
    f.manager.getAddressIdentity = async () => `02${"ab".repeat(32)}`
    await expect(
      f
        .workflow()
        .submit(f.wallet.id, { desiredName: "existing", token: "controlled" })
    ).rejects.toThrow("identity")
    expect(f.calls).toHaveLength(0)
    const revoked = f.workflow()
    clearTestAccountSigner()
    await expect(
      revoked.submit(f.wallet.id, {
        desiredName: "existing",
        token: "controlled",
      })
    ).rejects.toThrow("sign-in changed")
    expect(f.calls).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test("a committed gateway receipt with an interrupted local write resumes status for the same intent", async () => {
  const f = await fixture("unavailable")
  try {
    f.receiveReplies()
    const update = f.requests.update.bind(f.requests)
    let writes = 0
    f.requests.update = async (...args) => {
      if (++writes === 2) throw new Error("Interrupted receipt write")
      return update(...args)
    }
    await expect(
      f
        .workflow()
        .submit(f.wallet.id, { desiredName: "existing", token: "controlled" })
    ).rejects.toThrow("Interrupted receipt write")
    const retained = (await f.metadata.loadLocal("mainnet")).records[
      f.wallet.id
    ]
    expect(retained.phase).toBe("pending")
    f.requests.update = update
    const resumed = await f
      .workflow()
      .submit(f.wallet.id, { desiredName: "different", token: "controlled" })
    expect(resumed.record.phase).toBe("received")
    expect(resumed.record.payload).toBe(retained.payload)
    expect(resumed.record.accountProof).toBe(retained.accountProof)
    expect(f.calls).toEqual(["submit", "status"])
  } finally {
    await f.close()
  }
})

test("retained valid but conflicting backup blocks selected-wallet authority during unavailable discovery", async () => {
  const f = await fixture("unavailable")
  try {
    await f.recovery.prepare(
      {
        mnemonic: generateSparkMnemonic(),
        network: "mainnet",
        accountNumber: 1,
      },
      f.wallet.id
    )
    await expect(
      f
        .workflow()
        .submit(f.wallet.id, { desiredName: "existing", token: "controlled" })
    ).rejects.toThrow("Conflicting recovery")
    expect(f.calls).toHaveLength(0)
    expect((await f.journal.load(f.signer.pubkey)).records).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("a local selected request stays local when confirmed membership omits that exact wallet", async () => {
  const f = await fixture("unavailable")
  try {
    const initial = await f
      .workflow()
      .submit(f.wallet.id, { desiredName: "existing", token: "controlled" })
    const complete = {
      ...initial.record,
      phase: "complete" as const,
      profileEventId: "b".repeat(64),
    }
    await f.metadata.stage("mainnet", f.wallet.id, complete)
    const discover = f.recovery.discover.bind(f.recovery)
    f.recovery.discover = async (...args) => ({
      ...(await discover(...args)),
      coverage: "complete",
      state: "absent_within_scope",
      registryMembershipReady: true,
      invalidCount: 0,
      unresolvedObserved: false,
      registry: {
        format: "conduit.spark.registry",
        version: 1,
        ownerPubkey: f.signer.pubkey,
        network: "mainnet",
        revision: 1,
        parentEventId: null,
        activeWalletIds: [],
        removedWalletIds: [],
        payInvoiceWalletId: null,
        receiveWalletId: null,
        createdAt: 1,
      },
    })
    // An unrelated empty snapshot can be confirmed; it has no selected-wallet receipt.
    f.metadata.load = async () => ({ records: {}, confirmed: true })
    const loaded = await f.workflow().load(f.wallet.id)
    expect(loaded?.record).toEqual(complete)
    expect(loaded?.publication).toBe("local")
    expect(loaded?.sync?.reason).toBe("request_contents_unconfirmed")
  } finally {
    await f.close()
  }
})

test("unresolved recovery resumes the selected wallet's validated legacy request without a replacement intent", async () => {
  const f = await fixture("unavailable")
  try {
    const first = await f
      .workflow()
      .submit(f.wallet.id, { desiredName: "existing", token: "controlled" })
    await f.metadata.syncPending(() => f.recovery.discover(false, "mainnet"))
    await f.requests.update(f.signer.pubkey, "mainnet", () => ({}))
    const createdAt = Math.floor(Date.now() / 1000)
    const snapshot = {
      format: "conduit.spark.registry",
      version: 1,
      ownerPubkey: f.signer.pubkey,
      network: "mainnet",
      revision: 1,
      parentEventId: null,
      activeWalletIds: [f.wallet.id, crypto.randomUUID()].sort(),
      removedWalletIds: [],
      payInvoiceWalletId: null,
      receiveWalletId: null,
      addressNameRequests: { [f.wallet.id]: first.record },
      createdAt,
    }
    const event = await f.signer.signEvent({
      kind: 30078,
      pubkey: f.signer.pubkey,
      created_at: createdAt,
      tags: [["d", "conduit:spark:registry:v1:mainnet"]],
      content: await f.signer.encryptNip44(
        f.signer.pubkey,
        JSON.stringify(snapshot)
      ),
    })
    await f.journal.retain(f.signer.pubkey, [
      {
        event,
        targets: [{ url: "wss://relay.conduit.market", operator: null }],
        delivery: [
          {
            url: "wss://relay.conduit.market",
            status: "pending",
            accepted: false,
            readBack: false,
            lastRead: "not_queried",
            checkedAt: 0,
          },
        ],
        exported: false,
      },
    ])
    expect((await f.recovery.discover(false, "mainnet")).state).toBe(
      "unresolved"
    )
    const loaded = await f.workflow().load(f.wallet.id)
    expect(loaded?.record.payload === first.record.payload).toBe(true)
    expect(loaded?.record.accountProof === first.record.accountProof).toBe(true)
    const resumed = await f
      .workflow()
      .submit(f.wallet.id, { desiredName: "replacement", token: "controlled" })
    expect(resumed.record.payload === first.record.payload).toBe(true)
    expect(resumed.record.accountProof === first.record.accountProof).toBe(true)
    expect(resumed.record.phase).toBe("received")
    expect(f.calls).toEqual(["submit", "status", "status"])
  } finally {
    await f.close()
  }
})
