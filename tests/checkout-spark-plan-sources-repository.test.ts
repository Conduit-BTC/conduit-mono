import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledOutgoingTarget,
  type SignedPublicNostrEvent,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(generateSecretKey())

function invoice(sats: number, byte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${sats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function signedEvent(
  kind: number,
  created_at: number,
  content: string,
  tags: string[][]
): SignedPublicNostrEvent {
  const event = finalizeEvent(
    { kind, created_at, content, tags },
    MERCHANT_SECRET
  )
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind,
    created_at,
    content,
    tags,
    sig: event.sig,
  }
}

function fixture() {
  const product = signedEvent(
    30_402,
    NOW / 1_000 - 2,
    "Digital source fixture",
    [
      ["d", "source-item"],
      ["title", "Source item"],
      ["price", "1000", "SAT"],
      ["type", "simple", "digital"],
    ]
  )
  const profile = signedEvent(
    0,
    NOW / 1_000 - 1,
    JSON.stringify({ lud16: "merchant@example.test" }),
    []
  )
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "source-checkout",
    orderId: "source-order",
    merchantPubkey: MERCHANT,
    walletId: "source-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:source-item`,
          productEventId: product.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "source-receive",
      paymentRequest: invoice(1_113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${MERCHANT}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
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
            profileEventId: profile.id,
            profileEventCreatedAt: profile.created_at,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
  return { plan, sources: [product, profile] }
}

function witness(plan: CheckoutSparkSettledPlan) {
  const event = new NDKEvent(undefined)
  event.kind = 16
  event.pubkey = BUYER
  event.created_at = NOW / 1_000 + 1
  const coordinate = plan.commerceQuote.lines[0]!.productCoordinate
  event.content = JSON.stringify({
    id: plan.orderId,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: coordinate,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: NOW + 1_000,
  })
  event.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", plan.orderId],
    ["amount", "1000"],
    ["currency", "SATS"],
    ["item", coordinate, "1"],
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  event.id = event.getEventHash()
  const evidence = readCheckoutSparkMerchantOrderEvidence(event)
  if (!evidence) throw new Error("Expected valid fixture order evidence")
  const result = createCheckoutSparkMerchantOrderWitness(plan, evidence, BUYER)
  if (!result) throw new Error("Expected exact fixture order witness")
  return result
}

function creditProof(plan: CheckoutSparkSettledPlan) {
  return {
    mode: "ordinary_v3" as const,
    requestId: plan.funding.requestId,
    transferId: "source-credit",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats: 1_111,
  }
}

async function importOrder(
  repository: DexieCheckoutSparkSettledRepository,
  plan: CheckoutSparkSettledPlan
) {
  await repository.importMerchantOrderRecovery(
    createCheckoutSparkSettledReconciliation(plan),
    witness(plan),
    () => {}
  )
}

describe("Merchant local signed-source repository admission", () => {
  it("keeps old witnessed provider facts unresolved until exact sources are recorded, without changing those facts", async () => {
    const database = new ConduitDB(`source-admission-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const { plan, sources } = fixture()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await importOrder(repository, plan)
      await repository.recordMerchantCredit(
        plan,
        creditProof(plan),
        NOW + 2_000
      )
      const beforeState = await repository.load(
        plan.checkoutId,
        plan.planDigest
      )
      const beforeFacts = await repository.loadMerchantSettlement(
        MERCHANT,
        plan.checkoutId,
        plan.planDigest
      )
      expect(beforeFacts?.credit).not.toBeNull()
      expect(
        await repository.loadMerchantOrderWitness(
          MERCHANT,
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual(witness(plan))
      expect(await repository.loadMerchantOrderSettlements(MERCHANT)).toEqual(
        []
      )
      expect(
        await repository.loadMerchantPlanSourceEvents(
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual([])

      const newerProfile = signedEvent(
        0,
        NOW / 1_000 + 1,
        JSON.stringify({ lud16: "new-address@example.test" }),
        []
      )
      await repository.recordMerchantPlanSources(
        plan,
        [...sources, newerProfile],
        () => {}
      )
      expect(await repository.load(plan.checkoutId, plan.planDigest)).toEqual(
        beforeState
      )
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual(beforeFacts)
      const rows = await repository.loadMerchantOrderSettlements(MERCHANT, [
        plan.orderId,
      ])
      expect(rows).toHaveLength(1)
      expect(
        projectCheckoutSparkMerchantSettlement(rows[0]!.settlement)
          .commerceVerified
      ).toBe(false)
      const binding = await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      )
      expect(binding?.sourceValidation).toEqual({
        schemaVersion: 1,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        merchantPubkey: MERCHANT,
      })
      expect(binding?.sourceEvents).toEqual(sources)
      expect(JSON.stringify(rows)).not.toContain("merchant@example.test")
      expect(JSON.stringify(rows)).not.toContain(productBody(sources))
    } finally {
      await database.delete()
    }
  })

  it("retains exact source bytes across reload and idempotent recording, independently of caller arrays", async () => {
    const database = new ConduitDB(`source-reload-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const { plan, sources } = fixture()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await importOrder(repository, plan)
      await repository.recordMerchantPlanSources(plan, sources, () => {})
      const before = await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      )
      await repository.recordMerchantPlanSources(
        plan,
        [...sources].reverse(),
        () => {}
      )
      expect(
        await database.checkoutSparkPlanBindings.get(plan.checkoutId)
      ).toEqual(before)
      database.close()
      await database.open()
      const restored = new DexieCheckoutSparkSettledRepository(database)
      const loaded = await restored.loadMerchantPlanSourceEvents(
        plan.checkoutId,
        plan.planDigest
      )
      expect(loaded).toEqual(sources)
      loaded.pop()
      expect(
        await restored.loadMerchantPlanSourceEvents(
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual(sources)
      expect(
        (await restored.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("active")
    } finally {
      await database.delete()
    }
  })

  it("requires an existing active binding and rolls back admission when authority changes during storage", async () => {
    const database = new ConduitDB(`source-authority-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const { plan, sources } = fixture()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await expect(
        repository.recordMerchantPlanSources(plan, sources, () => {})
      ).rejects.toThrow()
      expect(
        (await repository.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("absent")
      await importOrder(repository, plan)
      const before = await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      )
      let current = true
      const revoke = () => {
        current = false
      }
      database.checkoutSparkPlanBindings.hook("updating", revoke)
      await expect(
        repository.recordMerchantPlanSources(plan, sources, () => {
          if (!current) throw new Error("Session changed")
        })
      ).rejects.toThrow("Session changed")
      database.checkoutSparkPlanBindings.hook("updating").unsubscribe(revoke)
      expect(
        await database.checkoutSparkPlanBindings.get(plan.checkoutId)
      ).toEqual(before)
      expect(
        await repository.loadMerchantPlanSourceEvents(
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual([])
    } finally {
      await database.delete()
    }
  })

  it("removes active public source bodies on terminal retirement but retains local admission and settlement", async () => {
    const database = new ConduitDB(`source-retirement-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const { plan, sources } = fixture()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await importOrder(repository, plan)
      await repository.recordMerchantPlanSources(plan, sources, () => {})
      let state = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(plan),
        {
          ...creditProof(plan),
          paymentHash: plan.funding.paymentHash,
          observedAt: NOW + 1,
        }
      )
      await repository.recordMerchantCredit(plan, creditProof(plan), NOW + 1)
      let revision = 1
      for (const [index, leg] of state.legs.entries()) {
        const allocationSats = leg.allocationSats!
        const intent = {
          legId: leg.legId,
          transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
          paymentRequest: invoice(allocationSats - 1, index + 2),
          paymentHash: (index + 2).toString(16).padStart(2, "0").repeat(32),
          invoiceAmountSats: allocationSats - 1,
          maxFeeSats: 1,
          preparedAt: NOW + 2 + index * 2,
        }
        state = prepareCheckoutSparkSettledLeg(state, intent)
        const resolved = await resolveCheckoutSparkFixtureInvoice(
          {
            lud16: plan.recipients[index]!.destination.value,
            network: plan.network,
            amountSats: intent.invoiceAmountSats,
            nowSeconds: Math.floor(intent.preparedAt / 1_000),
            shouldContinue: () => true,
          },
          intent.paymentRequest
        )
        const prepared = await repository.savePreparedWithInvoiceOrigin(
          state,
          revision,
          { legId: leg.legId, origin: resolved.origin! }
        )
        if (prepared.status !== "active")
          throw new Error("Expected active fixture")
        revision = prepared.revision
        state = recordCheckoutSparkSettledLegStatus(state, {
          legId: leg.legId,
          transferId: intent.transferId,
          paymentHash: intent.paymentHash,
          status: "paid",
          observedAt: intent.preparedAt + 1,
          finalFeeSats: 1,
          finalDebitSats: allocationSats,
        })
        const saved = await repository.save(state, revision)
        if (saved.status !== "active")
          throw new Error("Expected active fixture")
        revision = saved.revision
        const target: CheckoutSparkSettledOutgoingTarget = {
          walletId: plan.walletId,
          network: plan.network,
          legId: leg.legId,
          recipientId: plan.recipients[index]!.recipientId,
          allocationSats,
          unpaidAllocationSats: allocationSats,
          intent,
        }
        await repository.recordMerchantPayout(
          plan,
          target,
          {
            ...intent,
            status: "paid",
            finalFeeSats: 1,
            finalDebitSats: allocationSats,
          },
          intent.preparedAt + 1
        )
      }
      const before = await repository.loadMerchantOrderSettlements(MERCHANT)
      expect(
        projectCheckoutSparkMerchantSettlement(before[0]!.settlement)
          .commerceVerified
      ).toBe(true)
      const admission = (await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      ))!.sourceValidation
      await repository.retire({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        expectedRevision: revision,
        evidence: {
          walletId: plan.walletId,
          network: plan.network,
          observedAt: state.updatedAt + 1,
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
          fundingReceiveTerminal: true,
          sendHistoryTerminal: true,
          claimsTerminal: true,
          refundsTerminal: true,
        },
      })
      const retained = await database.checkoutSparkPlanBindings.get(
        plan.checkoutId
      )
      expect(retained?.sourceValidation).toEqual(admission)
      expect(retained).not.toHaveProperty("sourceEvents")
      expect(retained).not.toHaveProperty("invoiceOrigins")
      expect(
        await repository.loadMerchantPlanSourceEvents(
          plan.checkoutId,
          plan.planDigest
        )
      ).toEqual([])
      expect(await repository.loadMerchantOrderSettlements(MERCHANT)).toEqual(
        before
      )
      // A repeated discovery imports terminal history idempotently. Callers
      // skip active-only source recording from this returned snapshot.
      const rediscovered = await repository.importMerchantOrderRecovery(
        state,
        witness(plan),
        () => {}
      )
      expect(rediscovered.status).toBe("retired")
      expect(
        await database.checkoutSparkPlanBindings.get(plan.checkoutId)
      ).toEqual(retained)
      await expect(
        repository.recordMerchantPlanSources(plan, sources, () => {})
      ).rejects.toThrow()
      expect(
        (await repository.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("retired")
    } finally {
      await database.delete()
    }
  })
})

function productBody(sources: readonly SignedPublicNostrEvent[]) {
  return sources.find((event) => event.kind === 30_402)!.content
}
