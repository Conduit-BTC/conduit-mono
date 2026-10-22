import { expect, test } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import { createCheckoutRecoveryStorage } from "@conduit/core/protocol/checkout-recovery-storage"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import {
  createCheckoutSparkSettledReconciliation,
  type NostrKeySigner,
} from "@conduit/core"
import {
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkEventRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

class QuotaStorage {
  readonly values = new Map<string, string>()
  readonly limit = 5 * 1024 * 1024
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    const next = new Map(this.values).set(key, value)
    const bytes = [...next].reduce(
      (total, [name, text]) => total + (name.length + text.length) * 2,
      0
    )
    if (bytes > this.limit)
      throw new DOMException("Storage quota exceeded", "QuotaExceededError")
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

test("retains event recovery before publishing when unrelated localStorage fills its quota", async () => {
  const event = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
  const key = generateSecretKey()
  const pubkey = getPublicKey(key)
  const signer: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, key),
    encryptNip44: async (peer, text) =>
      nip44.encrypt(text, nip44.utils.getConversationKey(key, peer)),
    decryptNip44: async (peer, text) =>
      nip44.decrypt(text, nip44.utils.getConversationKey(key, peer)),
    decryptLegacy: async () => {
      throw new Error("Unused legacy operation")
    },
  }
  const local = new QuotaStorage()
  const otherKey = "synthetic-unrelated-record"
  local.setItem(otherKey, "x".repeat(local.limit / 2 - otherKey.length - 256))
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  )
  const database = new ConduitDB(`recovery-quota-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const storage = createCheckoutRecoveryStorage(local, database)
  let writes: Promise<unknown> = Promise.resolve()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: local },
  })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          run: (lock: object) => unknown
        ) => {
          const next = writes.catch(() => {}).then(() => run({}))
          writes = next
          return next
        },
      },
    },
  })
  let publications = 0
  const relays = ["wss://relay.conduit.market"]
  const transport = {
    recipientInboxRelays: relays,
    publishFn: async () => {
      const retained = await listCheckoutSparkRecoveryDeliveries(storage)
      expect(retained.length > 0).toBe(true)
      expect(retained.every((entry) => !!entry.organizerDelivery)).toBe(true)
      publications++
      return {
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
        relayFailureMessages: {},
      }
    },
  }
  try {
    const result = await publishCheckoutSparkEventRecoveryHandoff({
      state: createCheckoutSparkSettledReconciliation(event.plan),
      sourceEvents: event.sourceEvents,
      recovery: {
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
        network: "mainnet",
      },
      identity: { kind: "signed_in", pubkey, signer },
      order: createCheckoutSparkEventMarketFixtureOrder(event, pubkey),
      preparedAt: AT + 1_000,
      now: () => AT + 1_000,
      storage,
      transport,
      organizerTransport: transport,
    })
    expect(result.canExposeFundingInvoice).toBe(true)
    expect(publications).toBe(2)
    expect(local.getItem(otherKey)?.length).toBe(
      local.limit / 2 - otherKey.length - 256
    )
  } finally {
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
    if (navigatorDescriptor)
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor)
    else Reflect.deleteProperty(globalThis, "navigator")
    await database.delete()
  }
})
