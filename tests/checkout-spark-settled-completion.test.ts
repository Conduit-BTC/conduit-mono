import { describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import {
  runCheckoutSparkFinancialWorkflow,
  type CheckoutSparkFinancialWorkflowPorts,
} from "../packages/core/src/protocol/checkout-spark-financial-workflow"
import { resolveCheckoutSparkLnurlInvoice } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  classifyCheckoutSparkSettledPayment,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingTarget,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

/**
 * End-to-end COMPLETION scenarios for a funded settled-Spark checkout, fully
 * offline: fake Spark SDK/ledger (shared by both actors, so "exactly one send
 * across both actors" is a real count), real Dexie repositories (fake-indexeddb)
 * for Buyer and Merchant, a fake relay ACK that imports each Buyer snapshot into
 * the Merchant repository, and the real financial workflow / outgoing step /
 * leg preparation. No network, wallet, relay or secret is touched.
 *
 * Scope note: the funding credit is attested with `recordCheckoutSparkSettledCredit`
 * (as every existing fixture does) rather than a live receive-credit proof.
 */

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 60_000
const MERCHANT = "a".repeat(64)
const sha256Hex = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

function invoiceFor(amountSats: number, preimage: Buffer, createdAtMs: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: Math.floor(createdAtMs / 1_000),
    fields: [
      bolt11PaymentHashField(
        new Uint8Array(createHash("sha256").update(preimage).digest())
      ),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function unpreparedCredited(): CheckoutSparkSettledReconciliation {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: makeSignedBolt11Fixture({
        hrp: `lnbc${1_113 * 10}n`,
        createdAt: CREATED_AT / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(3)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  return recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer-1",
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1,
    }
  )
}

/** Fake Spark SDK/ledger shared by Buyer and Merchant. */
function fakeSpark() {
  const preimages = new Map<string, Buffer>() // paymentHash -> preimage
  const completed = new Set<string>() // transferIds the SDK actually paid
  const sends: CheckoutSparkSettledOutgoingTarget[] = []
  const send_by_actor: string[] = []
  const lookups: CheckoutSparkSettledOutgoingTarget[] = []
  const behaviour = { lookup: "ledger" as "ledger" | "not_found" }
  const classify = (
    target: CheckoutSparkSettledOutgoingTarget
  ): Promise<CheckoutSparkSettledOutgoingObservation> => {
    const preimage = preimages.get(target.intent.paymentHash)
    return classifyCheckoutSparkSettledPayment(
      {
        status: "completed",
        fees: 1n,
        details: {
          type: "lightning",
          htlcDetails: {
            paymentHash: target.intent.paymentHash,
            preimage: preimage?.toString("hex") ?? "00".repeat(32),
          },
        },
      },
      target,
      target.intent.invoiceAmountSats + 1
    )
  }
  const notFound = (
    target: CheckoutSparkSettledOutgoingTarget
  ): CheckoutSparkSettledOutgoingObservation => ({
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
    status: "not_found",
  })
  const provider = (actor: string): CheckoutSparkSettledOutgoingProvider => ({
    async reconcile(target) {
      lookups.push(target)
      return behaviour.lookup === "ledger" &&
        completed.has(target.intent.transferId)
        ? classify(target)
        : notFound(target)
    },
    async preflight() {
      return "ready"
    },
    async send(target) {
      sends.push(target)
      send_by_actor.push(actor)
      completed.add(target.intent.transferId)
      return classify(target)
    },
  })
  return {
    preimages,
    completed,
    sends,
    send_by_actor,
    lookups,
    behaviour,
    provider,
  }
}

/** Fake LNURL endpoint (real resolver, real origin evidence, no network). */
function resolver(
  spark: ReturnType<typeof fakeSpark>,
  nowMs: () => number,
  counters: { invoices: number }
) {
  return (input: Parameters<typeof resolveCheckoutSparkLnurlInvoice>[0]) =>
    resolveCheckoutSparkLnurlInvoice(
      { ...input, receiverMode: undefined },
      {
        fetchMetadata: async () =>
          ({
            tag: "payRequest",
            callback: "https://wallet.conduit.market/callback",
            minSendable: 1_000,
            maxSendable: 10_000_000_000,
            metadata: "[]",
            allowsNostr: false,
          }) as never,
        fetchInvoice: async (_callback: string, amountMsats: number) => {
          counters.invoices += 1
          const preimage = randomBytes(32)
          const invoice = invoiceFor(amountMsats / 1_000, preimage, nowMs())
          spark.preimages.set(sha256Hex(preimage), preimage)
          return { invoice } as never
        },
      }
    )
}

async function repo(initial: CheckoutSparkSettledReconciliation) {
  const database = new ConduitDB(`completion-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  await database.checkoutSparkPlanBindings.add({
    checkoutId: initial.plan.checkoutId,
    planDigest: initial.plan.planDigest,
  })
  await database.checkoutSparkReconciliations.add({
    checkoutId: initial.plan.checkoutId,
    revision: 1,
    state: initial,
  })
  return {
    database,
    repository: new DexieCheckoutSparkSettledRepository(database),
  }
}

async function load(
  r: DexieCheckoutSparkSettledRepository,
  s: CheckoutSparkSettledReconciliation
) {
  const snap = await r.load(s.plan.checkoutId, s.plan.planDigest)
  if (snap.status !== "active") throw new Error("not active")
  return snap
}

/**
 * Everything the two actors share: clock, ledger, relay (Buyer ACK -> Merchant
 * import), and per-actor workflow drivers.
 */
async function world(initial: CheckoutSparkSettledReconciliation) {
  const buyerDb = await repo(initial)
  const merchantDb = await repo(initial)
  const spark = fakeSpark()
  const clock = { now: CREATED_AT + 3 }
  const counters = { invoices: 0 }
  const relay = { acked: [] as CheckoutSparkSettledReconciliation[], up: true }
  const paidRecords: string[] = []
  const hooks: { afterBuyerAck?: (status: string) => void } = {}

  const base = (actor: "shopper" | "merchant") => {
    const repository =
      actor === "shopper" ? buyerDb.repository : merchantDb.repository
    const ports: CheckoutSparkFinancialWorkflowPorts = {
      store: repository,
      assertCurrent: () => {},
      now: () => clock.now,
      outgoing: spark.provider(actor),
      recordPaid: async (target, observation) => {
        // Merchant/Buyer independently verify the exact paid evidence.
        paidRecords.push(
          `${actor}:${target.intent.paymentHash}:${observation.finalDebitSats}`
        )
        return true
      },
      acknowledgeRecoverySnapshot: async (state) => {
        if (actor === "merchant") return
        if (!relay.up) throw new Error("relay unavailable")
        relay.acked.push(structuredClone(state))
        await merchantDb.repository.importRecoveryState(state, () => {})
        hooks.afterBuyerAck?.(state.legs[0]!.status)
      },
    }
    return { repository, ports }
  }

  const preparation = (actor: "shopper" | "merchant") => {
    const { repository, ports } = base(actor)
    return {
      repository,
      estimateFee: async () => 1,
      resolveInvoice: resolver(spark, () => clock.now, counters),
      assertAuthority: (_state: unknown, nowMs: number) => {
        const ok =
          actor === "shopper" ? nowMs < TAKEOVER_AT : nowMs >= TAKEOVER_AT
        if (!ok) throw new Error(`${actor} has no payout authority at ${nowMs}`)
      },
      acknowledgeRecoverySnapshot: ports.acknowledgeRecoverySnapshot,
      nowMs: () => clock.now,
    }
  }

  const run = (
    actor: "shopper" | "merchant",
    mode: "prepare" | "advance" | "reconcile",
    extra: Partial<CheckoutSparkFinancialWorkflowPorts> = {},
    flags: { allowRenewal?: boolean; withPreparation?: boolean } = {}
  ) => {
    const { ports } = base(actor)
    return runCheckoutSparkFinancialWorkflow(
      {
        checkoutId: initial.plan.checkoutId,
        planDigest: initial.plan.planDigest,
        actor,
        mode,
        legId: initial.plan.recipients[0]!.legId,
        ...(flags.allowRenewal ? { allowRenewal: true } : {}),
      },
      {
        ...ports,
        ...(flags.withPreparation === false
          ? {}
          : {
              preparation: {
                ...preparation(actor),
                // Same renewal-proof seam on the preparation dependencies.
                ...(extra.proveRenewalReturn
                  ? { proveRenewalReturn: extra.proveRenewalReturn }
                  : {}),
              } as never,
            }),
        ...extra,
      }
    )
  }

  return {
    buyerDb,
    merchantDb,
    spark,
    clock,
    counters,
    relay,
    paidRecords,
    hooks,
    run,
    buyerState: async () => (await load(buyerDb.repository, initial)).state,
    merchantState: async () =>
      (await load(merchantDb.repository, initial)).state,
    close: async () => {
      for (const { database } of [buyerDb, merchantDb]) {
        database.close()
        await database.delete()
      }
    },
  }
}

const merchantLeg = (s: CheckoutSparkSettledReconciliation) => s.legs[0]!
const ambiguousLegs = (s: CheckoutSparkSettledReconciliation) =>
  s.legs.filter((leg) =>
    [
      "submitted",
      "ambiguous",
      "lookup_unavailable",
      "conflicting_evidence",
    ].includes(leg.status)
  )

describe("funded checkout completion (offline)", () => {
  // 1. The "working checkout" proof: must PASS today.
  it("S1 prompt Pay before takeover: Buyer routes, payout paid with a hash-matching preimage, Merchant confirms; one send, zero ambiguous legs", async () => {
    const w = await world(unpreparedCredited())
    try {
      const prepared = await w.run("shopper", "prepare")
      expect(prepared.status).toBe("payout_prepared")
      const sent = await w.run("shopper", "advance")
      expect(sent.status).toBe("outgoing_step")
      if (sent.status !== "outgoing_step") throw new Error("unreachable")
      expect(sent.step.outcome).toBe("paid")
      expect(sent.step.sendAttempted).toBe(true)

      // Exactly one provider send; preimage hashes to the payout invoice hash.
      expect(w.spark.sends).toHaveLength(1)
      const target = w.spark.sends[0]!
      const preimage = w.spark.preimages.get(target.intent.paymentHash)!
      expect(sha256Hex(preimage)).toBe(target.intent.paymentHash)

      const buyer = await w.buyerState()
      expect(merchantLeg(buyer).status).toBe("paid")
      expect(ambiguousLegs(buyer)).toHaveLength(0)

      // Merchant imported the ACKed snapshots (prepared -> submitted -> paid).
      const ackSequence = w.relay.acked
        .map((s) => s.legs[0]!.status)
        .filter((status, i, all) => status !== all[i - 1])
      expect(ackSequence).toEqual(["prepared", "submitted", "paid"])
      expect(merchantLeg(await w.merchantState()).status).toBe("paid")

      // Merchant confirmation: its own exact-history reconcile attests the same
      // payment and sends nothing.
      w.clock.now = TAKEOVER_AT + 1_000
      const confirmed = await w.run(
        "merchant",
        "reconcile",
        {},
        { withPreparation: false }
      )
      expect(confirmed.status).toBe("reconciled")
      expect(merchantLeg(await w.merchantState()).status).toBe("paid")
      expect(w.paidRecords.some((r) => r.startsWith("merchant:"))).toBe(true)
      expect(ambiguousLegs(await w.merchantState())).toHaveLength(0)
      expect(w.spark.sends).toHaveLength(1)
    } finally {
      await w.close()
    }
  })

  // 2. Late Pay after takeover, Merchant automatic processing active.
  it("S2 late Pay after takeover: Buyer does not route; Merchant prepares and sends; paid; exactly one send across both actors", async () => {
    const w = await world(unpreparedCredited())
    try {
      w.clock.now = TAKEOVER_AT + 1_000
      // Buyer after takeover: no preparation, no send (core authority fence).
      const buyerPrepare = w.run("shopper", "prepare").catch((e: unknown) => e)
      expect(await buyerPrepare).toBeInstanceOf(Error)
      const buyerAdvance = await w.run(
        "shopper",
        "advance",
        {},
        { withPreparation: false }
      )
      expect(buyerAdvance.status).toBe("outgoing_step")
      expect(w.spark.sends).toHaveLength(0)

      // Merchant automatic processing: prepare then advance.
      const prepared = await w.run("merchant", "prepare")
      expect(prepared.status).toBe("payout_prepared")
      const sent = await w.run("merchant", "advance")
      if (sent.status !== "outgoing_step")
        throw new Error("expected outgoing_step")
      expect(sent.step.outcome).toBe("paid")

      expect(w.spark.sends).toHaveLength(1)
      expect(w.spark.send_by_actor).toEqual(["merchant"])
      const target = w.spark.sends[0]!
      expect(sha256Hex(w.spark.preimages.get(target.intent.paymentHash)!)).toBe(
        target.intent.paymentHash
      )
      const merchant = await w.merchantState()
      expect(merchantLeg(merchant).status).toBe("paid")
      expect(ambiguousLegs(merchant)).toHaveLength(0)
      // Buyer never produced a payout intent.
      expect(merchantLeg(await w.buyerState()).status).toBe("unprepared")
    } finally {
      await w.close()
    }
  })
})
