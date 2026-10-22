import { expect, test } from "bun:test"
import Dexie from "dexie"
import { isDeepStrictEqual } from "node:util"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import type { WalletDescriptor } from "../packages/core/src/wallets"
import { DexieAddressRequestStore } from "../packages/core/src/wallets/address-request-store"
import {
  addressRequestsDTag,
  walletNamesDTag,
} from "../packages/core/src/wallets/spark-recovery-address"
import { generateSparkMnemonic } from "../packages/core/src/wallets/spark-recovery-contract"
import type { SparkRecoveryState } from "../packages/core/src/wallets/spark-recovery-service"
import { DexieSparkRecoveryStore } from "../packages/core/src/wallets/spark-recovery-store"
import {
  sparkRecoveryIdentityKey,
  type SignerSparkRecovery,
} from "../packages/core/src/wallets/signer-spark-recovery"
import { DexieWalletNameStore } from "../packages/core/src/wallets/wallet-name-store"
import {
  MarketWalletStore,
  serializeStoredSparkWalletRecovery,
} from "../packages/core/src/wallets/wallet-storage"

for (const priorVersion of [24, 25]) {
  test(`v${priorVersion} wallet upgrade retains encrypted credentials and both optional journals`, async () => {
    const databaseName = `wallet-journal-migration-${crypto.randomUUID()}`
    const dependencies = { indexedDB: new IDBFactory(), IDBKeyRange }
    const secret = generateSecretKey()
    const owner = getPublicKey(secret)
    const conversation = v2.utils.getConversationKey(secret, owner)
    const walletId = crypto.randomUUID()
    const token = crypto.randomUUID()
    const createdAt = Math.floor(Date.now() / 1000)
    const signed = (address: string) =>
      finalizeEvent(
        {
          kind: 30078,
          created_at: createdAt,
          tags: [["d", address]],
          content: v2.encrypt("disposable migration fixture", conversation),
        },
        secret
      )
    const nameEvent = signed(walletNamesDTag("mainnet"))
    const requestEvent = signed(addressRequestsDTag("mainnet"))
    const state: SparkRecoveryState = {
      ownerPubkey: owner,
      records: [],
      unresolvedObserved: true,
      removedWalletIds: [crypto.randomUUID()],
      registryExcludedWalletIds: [crypto.randomUUID()],
      walletNameSync: {
        mainnet: {
          pending: { [walletId]: { name: "Pending local name", token } },
          observed: nameEvent,
          operation: {
            event: nameEvent,
            targets: ["wss://relay.conduit.market"],
            intents: { [walletId]: token },
          },
        },
      },
      addressRequestSync: {
        mainnet: {
          observed: requestEvent,
          operation: {
            event: requestEvent,
            targets: ["wss://relay.conduit.market"],
          },
        },
      },
    }
    const descriptor: WalletDescriptor = {
      id: walletId,
      kind: "portable",
      providerId: "spark",
      label: "Saved local name",
      network: "mainnet",
      capabilities: ["receive", "pay_invoice"],
      defaultIntents: ["receive"],
      status: "registered",
      createdAt,
      updatedAt: createdAt,
    }
    const binding = {
      walletId,
      providerId: "spark" as const,
      network: "mainnet" as const,
      accountNumber: 1,
    }
    const mnemonic = generateSparkMnemonic()
    const identityKey = await sparkRecoveryIdentityKey(mnemonic, binding)
    const recoveryPlaintext = JSON.stringify({
      domain: "conduit:local-spark-recovery:v1",
      ...binding,
      ownerPubkey: owner,
      identityKey,
      mnemonic,
    })
    const recovery: SignerSparkRecovery = {
      ...binding,
      type: "signer",
      version: 1,
      ownerPubkey: owner,
      identityKey,
      ciphertext: v2.encrypt(recoveryPlaintext, conversation),
    }
    const credential = {
      walletId,
      providerId: "spark",
      credential: serializeStoredSparkWalletRecovery(recovery),
      createdAt,
      updatedAt: createdAt,
    }
    const prior = new Dexie(databaseName, dependencies)
    prior.version(priorVersion).stores({
      wallets: "id",
      walletCredentials: "walletId",
      sparkRecoveryEvidence: "ownerPubkey",
    })
    await prior.open()
    await prior.table("wallets").put(descriptor)
    await prior.table("walletCredentials").put(credential)
    await prior.table("sparkRecoveryEvidence").put(state)
    prior.close()
    const upgraded = new ConduitDB(databaseName, dependencies)
    try {
      await upgraded.open()
      expect(upgraded.verno).toBe(30)
      expect(upgraded.backendDB().version).toBe(300)
      expect(upgraded.tables.map((table) => table.name)).toEqual(
        expect.arrayContaining([
          "eventMarketOrganizerStockPools",
          "eventMarketOrganizerStockEntries",
          "eventMarketOrganizerStockWriters",
        ])
      )
      expect(await upgraded.eventMarketOrganizerStockWriters.count()).toBe(0)
      // Compare privately so failed assertions cannot dump encrypted fixtures.
      const equal = (left: unknown, right: unknown) =>
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(left)),
          JSON.parse(JSON.stringify(right))
        )
      const wallets = new MarketWalletStore(upgraded)
      expect(equal(await wallets.list(), [descriptor])).toBe(true)
      expect(
        equal(await upgraded.walletCredentials.get(walletId), credential)
      ).toBe(true)
      const restored = await wallets.getSparkRecovery(walletId)
      expect(equal(restored, recovery)).toBe(true)
      expect(
        restored?.type === "signer" &&
          v2.decrypt(restored.ciphertext, conversation) === recoveryPlaintext
      ).toBe(true)
      expect(
        equal(await new DexieSparkRecoveryStore(upgraded).load(owner), state)
      ).toBe(true)
      expect(
        equal(
          await new DexieWalletNameStore(upgraded).load(owner, "mainnet"),
          state.walletNameSync!.mainnet
        )
      ).toBe(true)
      expect(
        equal(
          await new DexieAddressRequestStore(upgraded).load(owner, "mainnet"),
          state.addressRequestSync!.mainnet
        )
      ).toBe(true)
      // Ordinary recovery writes must preserve the optional journals after upgrade.
      await new DexieSparkRecoveryStore(upgraded).retain(owner, [])
      expect(
        equal(await new DexieSparkRecoveryStore(upgraded).load(owner), state)
      ).toBe(true)
    } finally {
      await upgraded.delete()
    }
  })
}
