import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkSettledReconciliation,
  fetchLnurlPayMetadata,
  openCheckoutSparkRecoveryDelivery,
  parseProductEvent,
  type CheckoutSparkBuyerSettlementRepositorySnapshot,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import {
  cleanupCompletedCheckoutSparkSettledExecution,
  getCheckoutSparkSettledPreparation,
  listCheckoutSparkSettledPreparations,
  prepareCheckoutSparkSettledFunding,
  saveCheckoutSparkSettledPreparation,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  getArchivedCheckoutSparkRecoveryDeliveries,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { plainTestSigner } from "./helpers/plain-signer"
import { admitFixture } from "./helpers/public-event"
import type { CheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { qualifiedReceiverMetadataFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const OUTBOX = "conduit:checkout-spark-recovery-outbox:v1"
const RETRIES = "conduit:checkout-spark-recovery-snapshot-retries:v1"
const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const BUYER = plainTestSigner(NDKPrivateKeySigner.generate())
const PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  },
  SECRET
)
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const INVOICE = makeSignedBolt11Fixture({
  hrp: `lnbc${GROSS * 10}n`,
  createdAt: NOW / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(0x44)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
    { tag: "x", words: [28, 4] },
  ],
})

class MemoryStorage {
  values = new Map<string, string>()
  failOnce: ((key: string, value: string) => boolean) | null = null
  interruptAfterOnce: ((key: string, value: string) => boolean) | null = null
  rewriteOnce: ((key: string, value: string) => string | null) | null = null
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failOnce?.(key, value)) {
      this.failOnce = null
      throw new Error("Synthetic interrupted storage")
    }
    const rewritten = this.rewriteOnce?.(key, value)
    if (rewritten !== null && rewritten !== undefined) this.rewriteOnce = null
    this.values.set(key, rewritten ?? value)
    if (this.interruptAfterOnce?.(key, value)) {
      this.interruptAfterOnce = null
      throw new Error("Synthetic post-commit interruption")
    }
  }
  removeItem(key: string) {
    if (this.failOnce?.(key, "")) {
      this.failOnce = null
      throw new Error("Synthetic interrupted removal")
    }
    this.values.delete(key)
  }
}

function fixture() {
  const storage = new MemoryStorage()
  const states = new Map<string, CheckoutSparkSettledPlan>()
  const terminal = new Set<string>()
  const calls = { wallet: 0, receive: 0, publish: 0, funds: 0 }
  const published: string[] = []
  const repository = {
    create: async (plan: CheckoutSparkSettledPlan) => {
      states.set(plan.checkoutId, plan)
      return {
        status: "active" as const,
        revision: 1,
        state: createCheckoutSparkSettledReconciliation(plan),
      }
    },
    load: async () => ({ status: "absent" as const }),
    // Synthetic terminal persistence port: these tests cover queue composition,
    // not funding, provider retirement evidence or a deployed receiver.
    loadBuyerSettlement: async (
      checkoutId: string,
      digest: string,
      buyer: string
    ): Promise<CheckoutSparkBuyerSettlementRepositorySnapshot> => {
      const plan = states.get(checkoutId)
      if (
        !plan ||
        plan.planDigest !== digest ||
        buyer !== BUYER.pubkey ||
        !terminal.has(checkoutId)
      )
        return { status: "absent" }
      const binding = {
        schemaVersion: 1 as const,
        checkoutId,
        planDigest: digest,
        orderId: plan.orderId,
        merchantPubkey: MERCHANT,
        buyerPubkey: buyer,
        walletId: plan.walletId,
        commerceTotalSats: 1_000,
      }
      return {
        status: "retired",
        buyerBinding: binding,
        settlement: null,
        summary: {
          schemaVersion: 1,
          checkoutId,
          planDigest: digest,
          orderId: plan.orderId,
          merchantPubkey: MERCHANT,
          walletId: plan.walletId,
          commerceTotalSats: 1_000,
          credit: null,
          legs: [],
        },
      }
    },
  }
  let acknowledged = true
  const transport = {
    recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
    publishFn: async (
      event: unknown,
      options: { exclusiveRelayUrls?: readonly string[] }
    ) => {
      calls.publish += 1
      published.push(JSON.stringify(event))
      const relays = options.exclusiveRelayUrls ?? []
      return {
        attemptedRelayUrls: [...relays],
        successfulRelayUrls: acknowledged ? [...relays] : [],
        failedRelayUrls: acknowledged ? [] : [...relays],
        relayFailureMessages: {},
      }
    },
  }
  async function prepare(index: number) {
    const signedProduct = finalizeEvent(
      {
        kind: 30_402,
        created_at: NOW / 1_000,
        tags: [
          ["d", "cleanup-fixture"],
          ["title", "Queue cleanup fixture"],
          ["price", "1000", "SAT"],
          ["type", "simple", "digital"],
        ],
        content: "Synthetic queue fixture",
      },
      SECRET
    )
    const product = parseProductEvent(await admitFixture(signedProduct))
    const coordinate = `30402:${MERCHANT}:cleanup-fixture`
    const quoteAuthority: CheckoutSparkQuoteAuthority = {
      pricing: {
        status: "ok",
        totalSats: 1_000,
        items: [
          {
            productId: coordinate,
            quantity: 1,
            priceAtPurchase: 1_000,
            shippingCostSats: 0,
          },
        ],
      },
      products: [{ ...product, sourceEventId: signedProduct.id }],
      lines: [
        {
          productCoordinate: coordinate,
          productEventId: signedProduct.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
        },
      ],
    } as CheckoutSparkQuoteAuthority
    const conduit = checkoutSparkConduitFeeRecipient("production")
    const walletId = `cleanup-wallet-${index}`
    const mnemonic = createRuntimeMnemonic()
    const prepared = await prepareCheckoutSparkSettledFunding(
      {
        checkoutId: `cleanup-checkout-${index}`,
        orderId: `cleanup-order-${index}`,
        merchantPubkey: MERCHANT,
        network: "mainnet",
        takeoverAt: NOW + 120_000,
        grossFundingSats: GROSS,
        fundingExpirySecs: 900,
        identity: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
        quoteAuthority,
        sourceEvents: [signedProduct, PROFILE],
        recipients: [
          {
            kind: "merchant",
            recipientId: MERCHANT,
            weightSats: 1_000,
            destination: {
              type: "lightning_address",
              value: "merchant@wallet.conduit.market",
              source: {
                type: "signed_profile",
                profileEventId: PROFILE.id,
                profileEventCreatedAt: PROFILE.created_at,
              },
            },
          },
          {
            kind: "conduit",
            recipientId: conduit,
            weightSats: calculateConduitCheckoutFeeSats(1_000),
            destination: {
              type: "lightning_address",
              value: conduit,
              source: { type: "conduit_allowlist", policy: "production" },
            },
          },
        ],
        storage,
        recoveryStorage: storage,
      },
      {
        now: () => NOW,
        repository,
        receiverContracts: qualifiedReceiverMetadataFixture(
          "merchant@wallet.conduit.market"
        ).contracts,
        fetchPayoutMetadata: (address: string) =>
          fetchLnurlPayMetadata(address, {
            fetchImpl: async () =>
              new Response(
                JSON.stringify({
                  tag: "payRequest",
                  callback: "https://wallet.conduit.market/callback",
                  minSendable: 1_000,
                  maxSendable: 10_000_000,
                  allowsNostr: false,
                  metadata:
                    qualifiedReceiverMetadataFixture(address).metadata.metadata,
                }),
                { status: 200 }
              ),
          }),
        createWalletMaterial: () => ({
          walletId,
          network: "mainnet",
          mnemonic,
          accountNumber: 1,
        }),
        openWallet: async () => {
          calls.wallet += 1
        },
        closeWallet: async () => {
          throw new Error("No provider close in queue test")
        },
        createFundingReceive: async () => {
          calls.receive += 1
          return {
            walletId,
            network: "mainnet",
            id: `cleanup-receive-${index}`,
            paymentRequest: INVOICE,
            paymentHash: "44".repeat(32),
            providerStatus: "INVOICE_CREATED",
            requiredNetSats: GROSS,
            grossFundingSats: GROSS,
            expirySecs: 900,
            createdAt: NOW,
            expiresAt: NOW + 900_000,
            receiveSettledPolicy: "ordinary-exact-credit-v3",
            receiverIdentityPublicKey: `02${"a".repeat(64)}`,
          }
        },
        publishRecoveryHandoff: (input) =>
          publishCheckoutSparkSettledRecoveryHandoff({
            ...input,
            transport,
            now: () => NOW,
          }),
      }
    )
    return { ...prepared, mnemonic }
  }
  async function progress(
    prepared: Awaited<ReturnType<typeof prepare>>,
    stage: number
  ) {
    return acknowledgeOrRetryCheckoutSparkSettledSnapshot({
      initialHandoffId: prepared.recoveryHandoffId,
      state: { ...prepared.state, updatedAt: NOW + stage },
      identity: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
      storage,
      transport,
      now: () => NOW + stage,
      lockManager: null,
      requireCrossTabLock: false,
    })
  }
  const clean = (
    prepared: Awaited<ReturnType<typeof prepare>>,
    options: Partial<
      Parameters<typeof cleanupCompletedCheckoutSparkSettledExecution>[0]
    > = {}
  ) =>
    cleanupCompletedCheckoutSparkSettledExecution({
      checkoutId: prepared.plan.checkoutId,
      planDigest: prepared.plan.planDigest,
      buyerPubkey: BUYER.pubkey,
      repository,
      storage,
      recoveryStorage: storage,
      recoveryTransport: transport,
      ...options,
    })
  const scope = (prepared: Awaited<ReturnType<typeof prepare>>) => ({
    checkoutId: prepared.plan.checkoutId,
    planDigest: prepared.plan.planDigest,
    orderId: prepared.plan.orderId,
    walletId: prepared.plan.walletId,
    merchantPubkey: MERCHANT,
    senderPubkey: BUYER.pubkey,
  })
  return {
    storage,
    calls,
    published,
    transport,
    terminal,
    prepare,
    progress,
    clean,
    scope,
    setAck: (value: boolean) => {
      acknowledged = value
    },
  }
}

describe("completed checkout execution queues", () => {
  it("retries the final unacknowledged ciphertext after retirement without reopening a wallet or signing another wrap", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    const pending = listCheckoutSparkRecoveryDeliveries(f.storage).find(
      (delivery) => delivery.deliveryProgress.acknowledgedRelayRefs.length === 0
    )!
    const exactWire = JSON.stringify(pending.record.signedRecipientWrap)
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    const calls = { ...f.calls }
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.published.at(-1)).toBe(exactWire)
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(0)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).toBeNull()
    const archive = getArchivedCheckoutSparkRecoveryDeliveries(
      f.scope(prepared),
      f.storage
    )
    expect(archive).toHaveLength(2)
    expect(
      JSON.stringify(
        archive.find(
          (delivery) => delivery.record.handoffId === pending.record.handoffId
        )!.record.signedRecipientWrap
      )
    ).toBe(exactWire)
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
  })

  it("composes 72 preparations and multiple exact progress wraps without exhausting either 64-entry queue", async () => {
    const f = fixture()
    const active = await f.prepare(0)
    await f.progress(active, 1)
    const activeBefore = listCheckoutSparkRecoveryDeliveries(f.storage)
    for (let index = 1; index <= 72; index += 1) {
      const prepared = await f.prepare(index)
      await f.progress(prepared, 2)
      await f.progress(prepared, 3)
      expect(await f.clean(prepared)).toBe("active")
      f.terminal.add(prepared.plan.checkoutId)
      expect(await f.clean(prepared)).toBe("cleaned")
      const archive = getArchivedCheckoutSparkRecoveryDeliveries(
        f.scope(prepared),
        f.storage
      )
      expect(archive).toHaveLength(3)
      if (index === 1) {
        const recovered = await openCheckoutSparkRecoveryDelivery({
          record: archive.find(
            (delivery) =>
              delivery.record.handoffId === prepared.recoveryHandoffId
          )!.record,
          signer: plainTestSigner(
            new NDKPrivateKeySigner(Buffer.from(SECRET).toString("hex"))
          ),
        })
        expect("wallet" in recovered && recovered.wallet.mnemonic).toBe(
          prepared.mnemonic
        )
      }
      expect(Array.from(f.storage.values.values()).join("")).not.toContain(
        prepared.mnemonic
      )
      expect(
        getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
      ).toBeNull()
    }
    expect(listCheckoutSparkSettledPreparations(f.storage)).toHaveLength(1)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toEqual(activeBefore)
    expect(Object.keys(JSON.parse(f.storage.getItem(RETRIES)!))).toHaveLength(1)
    expect(f.calls.wallet).toBe(73)
    expect(f.calls.receive).toBe(73)
    expect(f.calls.funds).toBe(0)
  }, 60_000)

  it("finishes interrupted completed queues before preparing another checkout", async () => {
    const f = fixture()
    const completed = await f.prepare(1)
    await f.progress(completed, 1)
    await f.progress(completed, 2)
    f.terminal.add(completed.plan.checkoutId)
    // Simulate reload after terminal persistence, before the cleanup callback.
    await f.prepare(2)
    expect(
      getCheckoutSparkSettledPreparation(completed.plan.checkoutId, f.storage)
    ).toBeNull()
    expect(
      getArchivedCheckoutSparkRecoveryDeliveries(f.scope(completed), f.storage)
    ).toHaveLength(3)
    expect(listCheckoutSparkSettledPreparations(f.storage)).toHaveLength(1)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(1)
    expect(Object.keys(JSON.parse(f.storage.getItem(RETRIES)!))).toHaveLength(0)
  })

  it("retains all queues if encrypted archive persistence fails before or after its write", async () => {
    for (const afterCommit of [false, true]) {
      const f = fixture()
      const prepared = await f.prepare(1)
      await f.progress(prepared, 1)
      f.terminal.add(prepared.plan.checkoutId)
      const before = f.storage.getItem(OUTBOX)
      const predicate = (key: string) =>
        key.startsWith("conduit:checkout-spark-completed-recovery:")
      if (afterCommit) f.storage.interruptAfterOnce = predicate
      else f.storage.failOnce = predicate
      await expect(f.clean(prepared)).rejects.toThrow("Synthetic")
      expect(f.storage.getItem(OUTBOX)).toBe(before)
      expect(
        getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
      ).not.toBeNull()
      const calls = { ...f.calls }
      expect(await f.clean(prepared)).toBe("cleaned")
      expect(f.calls).toEqual(calls)
      expect(
        getArchivedCheckoutSparkRecoveryDeliveries(f.scope(prepared), f.storage)
      ).toHaveLength(2)
    }
  })

  it("finishes interrupted terminal cleanup on reload without another provider or relay operation", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    await f.progress(prepared, 1)
    f.terminal.add(prepared.plan.checkoutId)
    f.storage.failOnce = (key) => key === OUTBOX
    await expect(f.clean(prepared)).rejects.toThrow("Synthetic")
    expect(Object.keys(JSON.parse(f.storage.getItem(RETRIES)!))).toHaveLength(0)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(2)
    const calls = { ...f.calls }
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual(calls)
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(0)
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(() =>
      saveCheckoutSparkSettledPreparation(
        {
          schemaVersion: 3,
          checkoutId: prepared.plan.checkoutId,
          planDigest: prepared.plan.planDigest,
          recoveryHandoffId: prepared.recoveryHandoffId,
          fundingInvoiceExposedAt: NOW,
          fundingSubmissionState: "provisional",
          savedAt: NOW,
        },
        f.storage
      )
    ).toThrow("cannot be reopened")
    await expect(f.prepare(1)).rejects.toThrow("already prepared")
    expect(f.calls).toEqual(calls)
  }, 15_000)

  it("requires exact archive readback before removing any active recovery evidence", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    await f.progress(prepared, 1)
    f.terminal.add(prepared.plan.checkoutId)
    const outbox = f.storage.getItem(OUTBOX)
    const retries = f.storage.getItem(RETRIES)
    f.storage.rewriteOnce = (key, value) => {
      if (!key.startsWith("conduit:checkout-spark-completed-recovery:"))
        return null
      const archive = JSON.parse(value)
      archive.deliveries.pop()
      archive.snapshotRetries = {}
      return JSON.stringify(archive)
    }
    await expect(f.clean(prepared)).rejects.toThrow("not durably saved")
    expect(f.storage.getItem(OUTBOX)).toBe(outbox)
    expect(f.storage.getItem(RETRIES)).toBe(retries)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).not.toBeNull()
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(
      getArchivedCheckoutSparkRecoveryDeliveries(f.scope(prepared), f.storage)
    ).toHaveLength(2)
  }, 15_000)

  it("leaves required unacknowledged progress and active preparations available for exact retry", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    f.terminal.add(prepared.plan.checkoutId)
    const before = listCheckoutSparkRecoveryDeliveries(f.storage)
    const calls = { ...f.calls }
    expect(await f.clean(prepared)).toBe("delivery_pending")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
    expect(
      listCheckoutSparkRecoveryDeliveries(f.storage).map(
        (delivery) => delivery.record
      )
    ).toEqual(before.map((delivery) => delivery.record))
    expect(listCheckoutSparkRecoveryDeliveries(f.storage)).toHaveLength(2)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).not.toBeNull()
    f.setAck(true)
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 2 })
  })

  it("finishes a lost final ACK and interrupted archive on reload using only the same stored ciphertext", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    f.storage.failOnce = (key) =>
      key.startsWith("conduit:checkout-spark-completed-recovery:")
    const before = listCheckoutSparkRecoveryDeliveries(f.storage)
    const calls = { ...f.calls }
    await expect(f.clean(prepared)).rejects.toThrow("Synthetic")
    const afterRetry = listCheckoutSparkRecoveryDeliveries(f.storage)
    expect(afterRetry.map((delivery) => delivery.record)).toEqual(
      before.map((delivery) => delivery.record)
    )
    expect(
      afterRetry.every(
        (delivery) => delivery.deliveryProgress.acknowledgedRelayRefs.length > 0
      )
    ).toBe(true)
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
    expect(
      getArchivedCheckoutSparkRecoveryDeliveries(f.scope(prepared), f.storage)
    ).toHaveLength(2)
  })

  it("bounds terminal retry work and preserves the remaining exact delivery queue for the next invocation", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    for (let stage = 1; stage <= 5; stage += 1)
      await expect(f.progress(prepared, stage)).rejects.toThrow("relay ACK")
    const before = listCheckoutSparkRecoveryDeliveries(f.storage)
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    const calls = { ...f.calls }
    expect(await f.clean(prepared)).toBe("delivery_pending")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 4 })
    const remaining = listCheckoutSparkRecoveryDeliveries(f.storage)
    expect(remaining).toHaveLength(6)
    expect(
      remaining.filter(
        (delivery) => !delivery.deliveryProgress.acknowledgedRelayRefs.length
      )
    ).toHaveLength(1)
    expect(remaining.map((delivery) => delivery.record)).toEqual(
      before.map((delivery) => delivery.record)
    )
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 5 })
  })

  it("never waits on old pending recovery delivery when preparing a fresh checkout", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    const pending = listCheckoutSparkRecoveryDeliveries(f.storage).find(
      (delivery) => !delivery.deliveryProgress.acknowledgedRelayRefs.length
    )!
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    const calls = { ...f.calls }
    await f.prepare(2)
    expect(f.calls).toEqual({
      ...calls,
      wallet: calls.wallet + 1,
      receive: calls.receive + 1,
      publish: calls.publish + 1,
    })
    expect(
      listCheckoutSparkRecoveryDeliveries(f.storage).find(
        (delivery) => delivery.record.handoffId === pending.record.handoffId
      )
    ).toEqual(pending)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).not.toBeNull()
  })

  it("cannot checkpoint a late delivery result after the buyer identity or terminal binding changes", async () => {
    for (const change of ["identity", "binding"] as const) {
      const f = fixture()
      const prepared = await f.prepare(1)
      f.setAck(false)
      await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
      const before = f.storage.getItem(OUTBOX)
      f.terminal.add(prepared.plan.checkoutId)
      f.setAck(true)
      let current = true
      const calls = { ...f.calls }
      await expect(
        f.clean(prepared, {
          assertCurrent: () => {
            if (!current) throw new Error("Synthetic identity changed")
          },
          recoveryTransport: {
            ...f.transport,
            publishFn: async (...args) => {
              if (change === "identity") current = false
              else f.terminal.delete(prepared.plan.checkoutId)
              return f.transport.publishFn(...args)
            },
          },
        })
      ).rejects.toThrow(
        change === "identity" ? "identity changed" : "binding changed"
      )
      expect(f.storage.getItem(OUTBOX)).toBe(before)
      expect(
        getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
      ).not.toBeNull()
      expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
      f.terminal.add(prepared.plan.checkoutId)
      expect(await f.clean(prepared)).toBe("cleaned")
      expect(f.calls).toEqual({ ...calls, publish: calls.publish + 2 })
    }
  })

  it("does not publish a stored wrap that conflicts with the positive terminal buyer binding", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    f.terminal.add(prepared.plan.checkoutId)
    const raw = JSON.parse(f.storage.getItem(OUTBOX)!)
    raw[1].record.walletId = "different-terminal-wallet"
    f.storage.setItem(OUTBOX, JSON.stringify(raw))
    const before = f.storage.getItem(OUTBOX)
    const calls = { ...f.calls }
    await expect(f.clean(prepared)).rejects.toThrow("scope changed")
    expect(f.calls).toEqual(calls)
    expect(f.storage.getItem(OUTBOX)).toBe(before)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).not.toBeNull()
  })

  it("does not checkpoint an ACK if terminal binding changes while its outbox storage lock is held", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    const before = f.storage.getItem(OUTBOX)
    const calls = { ...f.calls }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator"
    )
    let release: (() => void) | undefined
    let reached: (() => void) | undefined
    const acquired = new Promise<void>((resolve) => {
      reached = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    })
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (
            name: string,
            _options: unknown,
            callback: (lock: { name: string }) => unknown
          ) => {
            if (name === `conduit:checkout-spark-storage:${OUTBOX}`) {
              reached!()
              await waiting
            }
            return callback({ name })
          },
        },
      },
    })
    try {
      const cleaning = f.clean(prepared)
      await acquired
      f.terminal.delete(prepared.plan.checkoutId)
      release!()
      await expect(cleaning).rejects.toThrow("binding changed")
      expect(f.storage.getItem(OUTBOX)).toBe(before)
      expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
      expect(
        getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
      ).not.toBeNull()
    } finally {
      release?.()
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
      if (previousNavigator)
        Object.defineProperty(globalThis, "navigator", previousNavigator)
      else Reflect.deleteProperty(globalThis, "navigator")
    }
  })

  it("ends a stalled delivery window without a late transport callback checkpointing or retaining authority", async () => {
    const f = fixture()
    const prepared = await f.prepare(1)
    f.setAck(false)
    await expect(f.progress(prepared, 1)).rejects.toThrow("relay ACK")
    f.terminal.add(prepared.plan.checkoutId)
    f.setAck(true)
    const before = f.storage.getItem(OUTBOX)
    const calls = { ...f.calls }
    let release: (() => void) | undefined
    let lateGuard: (() => boolean) | undefined
    expect(
      await f.clean(prepared, {
        recoveryTransport: {
          ...f.transport,
          publishFn: async (event, options) => {
            lateGuard = options?.shouldContinue
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return f.transport.publishFn(event, options!)
          },
        },
      })
    ).toBe("delivery_pending")
    expect(typeof release).toBe("function")
    expect(lateGuard?.()).toBe(false)
    release!()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(f.storage.getItem(OUTBOX)).toBe(before)
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 1 })
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, f.storage)
    ).not.toBeNull()
    expect(await f.clean(prepared)).toBe("cleaned")
    expect(f.calls).toEqual({ ...calls, publish: calls.publish + 2 })
  }, 20_000)

  it("does not remove terminal execution queues if binding changes while a cleanup storage lock is held", async () => {
    for (const key of [
      OUTBOX,
      "conduit:checkout-spark-settled-preparations:v3",
    ]) {
      const f = fixture()
      const prepared = await f.prepare(1)
      f.terminal.add(prepared.plan.checkoutId)
      const before = f.storage.getItem(key)
      const calls = { ...f.calls }
      const previousWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        "window"
      )
      const previousNavigator = Object.getOwnPropertyDescriptor(
        globalThis,
        "navigator"
      )
      let release: (() => void) | undefined
      let reached: (() => void) | undefined
      const acquired = new Promise<void>((resolve) => {
        reached = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {},
      })
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          locks: {
            request: async (
              name: string,
              _options: unknown,
              callback: (lock: { name: string }) => unknown
            ) => {
              if (name === `conduit:checkout-spark-storage:${key}`) {
                reached!()
                await waiting
              }
              return callback({ name })
            },
          },
        },
      })
      try {
        const cleaning = f.clean(prepared)
        await acquired
        f.terminal.delete(prepared.plan.checkoutId)
        release!()
        await expect(cleaning).rejects.toThrow("binding changed")
        expect(f.storage.getItem(key)).toBe(before)
        expect(f.calls).toEqual(calls)
        expect(
          getCheckoutSparkSettledPreparation(
            prepared.plan.checkoutId,
            f.storage
          )
        ).not.toBeNull()
      } finally {
        release?.()
        if (previousWindow)
          Object.defineProperty(globalThis, "window", previousWindow)
        else Reflect.deleteProperty(globalThis, "window")
        if (previousNavigator)
          Object.defineProperty(globalThis, "navigator", previousNavigator)
        else Reflect.deleteProperty(globalThis, "navigator")
      }
    }
  })
})
