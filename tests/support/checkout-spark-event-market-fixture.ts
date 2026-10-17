import { randomBytes } from "node:crypto"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import {
  calculateCheckoutSparkEventAllocationWeights,
  calculateCheckoutSparkEventSettledGrossFundingSats,
} from "@conduit/core/protocol/checkout-spark-settled-allocation"
import {
  freezeCheckoutSparkSettledEventPlan,
  type FreezeCheckoutSparkSettledPlanInput,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  type CheckoutSparkNativeTreasuryPlan,
} from "@conduit/core/protocol/checkout-spark-treasury-finalization"
import type { CheckoutSparkEventMarketBinding } from "@conduit/core/protocol/checkout-spark-event-market"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
  type EventMarketAssignmentOrganizerStockPool,
} from "@conduit/core/protocol/event-market-assignment"
import { buildEventMarketAuthorizationDraft } from "@conduit/core/protocol/event-market-authorization"
import {
  buildEventMarketCalendarDraft,
  parseEventMarketCalendarFieldsForPrivateOrder,
} from "@conduit/core/protocol/event-market"
import { orderSchema } from "@conduit/core/schemas"
import { parseCheckoutSparkSignedProductFields } from "@conduit/core/protocol/checkout-spark-product-fields"
import {
  calculateEventMarketOrganizerFeeSats,
  parseEventMarketOrganizerFeeTerms,
  type EventMarketOrganizerFeeAuthoring,
} from "@conduit/core/protocol/event-market-organizer-fee"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { buildEventMarketSeriesDraft } from "@conduit/core/protocol/event-market-schedule"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import type { NostrKeySigner } from "@conduit/core/protocol/nostr-event-signer"
import { createEventMarketStockAuthorityRumor } from "@conduit/core/protocol/event-market-stock-authority"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./signed-bolt11-fixture"

export const EVENT_MARKET_FIXTURE_AT = 1_800_000_000_000
const SOURCE_SECONDS = EVENT_MARKET_FIXTURE_AT / 1_000 - 10
// Ordinary fresh test identities; raw credentials never leave this test process.
const merchantSecret = generateSecretKey()
const organizerSecret = generateSecretKey()
const supplierSecret = generateSecretKey()
export const eventMarketFixtureParties = Object.freeze({
  merchantPubkey: getPublicKey(merchantSecret),
  organizerPubkey: getPublicKey(organizerSecret),
  supplierPubkey: getPublicKey(supplierSecret),
})
const { merchantPubkey, organizerPubkey, supplierPubkey } =
  eventMarketFixtureParties
const marketCoordinate = `30409:${organizerPubkey}:fair`
const occurrenceCoordinate = `31923:${organizerPubkey}:fair-day`
type Draft = {
  kind: number
  tags: string[][]
  content: string
  created_at?: number
}

/** Sign only inside the bounded fixture process; no raw credential is exported. */
function sign(draft: Draft, secret: Uint8Array): SignedPublicNostrEvent {
  return finalizeEvent(
    { ...draft, created_at: draft.created_at ?? SOURCE_SECONDS },
    secret
  )
}

export function eventMarketFixtureInvoice(amountSats: number) {
  const paymentHash = randomBytes(32)
  return {
    paymentHash: paymentHash.toString("hex"),
    paymentRequest: makeSignedBolt11Fixture({
      hrp: `lnbc${amountSats * 10}n`,
      createdAt: EVENT_MARKET_FIXTURE_AT / 1_000,
      fields: [
        bolt11PaymentHashField(paymentHash),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
      ],
    }),
  }
}

function signer(secret: Uint8Array): NostrKeySigner {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (peer, plaintext) =>
      nip44.encrypt(plaintext, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      nip44.decrypt(ciphertext, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy decryption is outside this fixture")
    },
  }
}

/** Real Nostr signatures plus pure payment metadata; never live payment proof. */
export function checkoutSparkEventMarketFixture(
  options: {
    commerceTotalSats?: number
    supplier?: boolean
    organizerFee?: EventMarketOrganizerFeeAuthoring | "absent"
    mode?: "merchant_present" | "organizer_handoff"
    schedule?: boolean
    variation?: boolean
    stockPool?: EventMarketAssignmentOrganizerStockPool
    stockGrant?: { writerId: string; quantity: number }
    receiverDomain?: string
  } = {}
) {
  const commerceTotalSats = options.commerceTotalSats ?? 100_000
  const supplier = commerceTotalSats > 0 && (options.supplier ?? true)
  const mode = options.mode ?? "merchant_present"
  const receiverDomain = options.receiverDomain ?? "example.test"
  const productCoordinate = `30402:${merchantPubkey}:apples`
  const parentCoordinate = `30402:${merchantPubkey}:fruit-family`
  const feeAuthoring: EventMarketOrganizerFeeAuthoring | "absent" =
    options.organizerFee ?? {
      state: "active",
      basisPoints: 250,
      minimumSats: 5,
      lightningAddress: `organizer@${receiverDomain}`,
    }
  const scheduleCoordinate = `31924:${organizerPubkey}:fair-series`
  const schedule = options.schedule
    ? sign(
        buildEventMarketSeriesDraft({
          dTag: "fair-series",
          organizerPubkey,
          title: "Fixture market days",
          memberCoordinates: [occurrenceCoordinate],
        }),
        organizerSecret
      )
    : undefined
  const market = sign(
    buildEventMarketRosterDraft({
      dTag: "fair",
      organizerPubkey,
      calendarCoordinate: schedule ? scheduleCoordinate : occurrenceCoordinate,
      state: "open",
      merchants: [{ pubkey: merchantPubkey, mode, assignment: "Booth 1" }],
      ...(feeAuthoring === "absent" ? {} : { organizerFee: feeAuthoring }),
    }),
    organizerSecret
  )
  const occurrence = sign(
    buildEventMarketCalendarDraft({
      kind: 31_923,
      dTag: "fair-day",
      title: "Fixture market day",
      start: EVENT_MARKET_FIXTURE_AT / 1_000 - 3_600,
      end: EVENT_MARKET_FIXTURE_AT / 1_000 + 3_600,
    }),
    organizerSecret
  )
  const grant = sign(
    buildEventMarketAuthorizationDraft({
      marketCoordinate,
      merchantPubkey,
      state: "active",
      sequence: 0,
      parentIds: [],
    }),
    organizerSecret
  )
  const parentProduct = options.variation
    ? sign(
        {
          kind: 30_402,
          content: "Fixture product family",
          tags: [
            ["d", "fruit-family"],
            ["title", "Fixture fruit"],
            ["type", "variable", "physical"],
            ["visibility", "public"],
            ["price", String(commerceTotalSats), "SAT"],
          ],
        },
        merchantSecret
      )
    : undefined
  const product = sign(
    {
      kind: 30_402,
      content: "Fixture apples",
      tags: [
        ["d", "apples"],
        ["title", "Fixture apples"],
        ["price", String(commerceTotalSats), "SAT"],
        ["type", options.variation ? "variation" : "simple", "physical"],
        ["visibility", "public"],
        ["stock", "10"],
        ...(parentProduct
          ? [
              ["a", parentCoordinate],
              ["spec", "size", "large"],
            ]
          : []),
        ...(supplier
          ? [
              ["conduit_supplier_allocation", "1"],
              ["zap", merchantPubkey, "wss://relay.conduit.market", "4"],
              ["zap", supplierPubkey, "wss://relay.conduit.market", "1"],
            ]
          : []),
      ],
    },
    merchantSecret
  )
  const originalAssignment = sign(
    buildEventMarketAssignmentDraft({
      marketCoordinate,
      occurrenceCoordinate,
      productCoordinate,
      merchantPubkey,
      state: "active",
      inventory: { mode: "tracked", quantity: 5 },
      fulfillmentMethods: ["pickup"],
    }),
    merchantSecret
  )
  const stockGrant = options.stockGrant
    ? createEventMarketStockAuthorityRumor({
        createdAt: SOURCE_SECONDS,
        payload: {
          version: 1,
          type: "grant",
          merchantPubkey,
          organizerPubkey,
          writerId: options.stockGrant.writerId,
          nonce: crypto.randomUUID(),
          productCoordinate,
          assignmentCoordinate: `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate })}`,
          marketCoordinate,
          occurrenceCoordinate,
          productEventId: product.id,
          assignmentEventId: originalAssignment.id,
          marketEventId: market.id,
          occurrenceEventId: occurrence.id,
          grantEventId: grant.id,
          ...(schedule ? { scheduleEventId: schedule.id } : {}),
          quantity: options.stockGrant.quantity,
          expiresAtMs: EVENT_MARKET_FIXTURE_AT + 30 * 60_000,
        },
      })
    : undefined
  const stockPool =
    (stockGrant && options.stockGrant
      ? {
          state: "active" as const,
          poolId: stockGrant.id,
          organizerPubkey,
          quantity: options.stockGrant.quantity,
          importedQuantity: 0,
        }
      : undefined) ??
    options.stockPool ??
    (mode === "organizer_handoff"
      ? {
          state: "active" as const,
          poolId: randomBytes(32).toString("hex"),
          organizerPubkey,
          quantity: 5,
          importedQuantity: 0,
        }
      : undefined)
  const assignment = sign(
    buildEventMarketAssignmentDraft({
      marketCoordinate,
      occurrenceCoordinate,
      productCoordinate,
      merchantPubkey,
      state: "active",
      inventory: { mode: "tracked", quantity: 5 },
      fulfillmentMethods: ["pickup"],
      ...(stockPool ? { organizerStockPool: stockPool } : {}),
      ...(stockGrant ? { previousEventId: originalAssignment.id } : {}),
    }),
    merchantSecret
  )
  const merchantProfile = sign(
    {
      kind: 0,
      tags: [],
      content: JSON.stringify({ lud16: `merchant@${receiverDomain}` }),
    },
    merchantSecret
  )
  const supplierProfile = sign(
    {
      kind: 0,
      tags: [],
      content: JSON.stringify({ lud16: `supplier@${receiverDomain}` }),
    },
    supplierSecret
  )
  const fee = parseEventMarketOrganizerFeeTerms({
    marketCoordinate,
    event: market,
  })
  if (fee.state === "invalid")
    throw new Error("Invalid signed fixture fee terms")
  const organizerFeeSats =
    fee.state === "active"
      ? calculateEventMarketOrganizerFeeSats({
          commerceTotalSats,
          basisPoints: fee.basisPoints,
          minimumSats: fee.minimumSats,
        })
      : 0
  const eventMarket: CheckoutSparkEventMarketBinding = {
    schemaVersion: 1,
    organizerPubkey,
    marketCoordinate,
    marketEventId: market.id,
    occurrenceCoordinate,
    occurrenceEventId: occurrence.id,
    ...(schedule
      ? { schedule: { coordinate: scheduleCoordinate, eventId: schedule.id } }
      : {}),
    grantEventId: grant.id,
    grantAncestryEventIds: [grant.id],
    observedDeletionEventIds: [],
    mode,
    assignment: "Booth 1",
    lines: [
      {
        productCoordinate,
        productEventId: product.id,
        assignmentCoordinate: `30410:${merchantPubkey}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate })}`,
        assignmentEventId: assignment.id,
        quantity: 1,
        ...(mode === "organizer_handoff"
          ? { stockPoolId: stockPool!.poolId }
          : {}),
        ...(parentProduct
          ? {
              parentProduct: {
                coordinate: parentCoordinate,
                eventId: parentProduct.id,
              },
            }
          : {}),
      },
    ],
    organizerFee: fee,
    organizerFeeSats,
  }
  const weights = calculateCheckoutSparkEventAllocationWeights(
    commerceTotalSats,
    organizerFeeSats
  )
  const grossFundingSats = calculateCheckoutSparkEventSettledGrossFundingSats(
    commerceTotalSats,
    organizerFeeSats
  )
  const supplierWeight = supplier ? Math.floor(commerceTotalSats / 5) : 0
  const input: FreezeCheckoutSparkSettledPlanInput & {
    nativeTreasury: CheckoutSparkNativeTreasuryPlan
    eventMarket: CheckoutSparkEventMarketBinding
  } = {
    checkoutId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    merchantPubkey,
    walletId: crypto.randomUUID(),
    network: "mainnet",
    createdAt: EVENT_MARKET_FIXTURE_AT,
    takeoverAt: EVENT_MARKET_FIXTURE_AT + 120_000,
    commerceQuote: {
      commerceTotalSats,
      lines: [
        {
          productCoordinate,
          productEventId: product.id,
          merchantPubkey,
          quantity: 1,
          unitMerchandiseSats: commerceTotalSats,
          unitShippingSats: 0,
          ...(parentProduct
            ? {
                variation: {
                  familyCoordinate: parentCoordinate,
                  specifications: [{ key: "size", value: "large" }],
                },
              }
            : {}),
        },
      ],
    },
    funding: {
      ...eventMarketFixtureInvoice(grossFundingSats),
      requestId: crypto.randomUUID(),
      receiverIdentityPublicKey: `02${getPublicKey(generateSecretKey())}`,
      grossFundingSats,
      createdAt: EVENT_MARKET_FIXTURE_AT,
      expiresAt: EVENT_MARKET_FIXTURE_AT + 3_600_000,
    },
    recipients: [
      ...(commerceTotalSats === 0
        ? []
        : [
            {
              kind: "merchant" as const,
              recipientId: merchantPubkey,
              weightSats: commerceTotalSats - supplierWeight,
              destination: {
                type: "lightning_address" as const,
                value: `merchant@${receiverDomain}`,
                source: {
                  type: "signed_profile" as const,
                  profileEventId: merchantProfile.id,
                  profileEventCreatedAt: merchantProfile.created_at,
                },
              },
            },
          ]),
      ...(supplier
        ? [
            {
              kind: "supplier" as const,
              recipientId: supplierPubkey,
              weightSats: supplierWeight,
              destination: {
                type: "lightning_address" as const,
                value: `supplier@${receiverDomain}`,
                source: {
                  type: "signed_profile" as const,
                  profileEventId: supplierProfile.id,
                  profileEventCreatedAt: supplierProfile.created_at,
                },
              },
            },
          ]
        : []),
      ...(organizerFeeSats > 0 && fee.state === "active"
        ? [
            {
              kind: "organizer" as const,
              recipientId: organizerPubkey,
              weightSats: organizerFeeSats,
              destination: {
                type: "lightning_address" as const,
                value: fee.lightningAddress,
                source: {
                  type: "signed_event_market" as const,
                  marketCoordinate,
                  eventId: market.id,
                  eventCreatedAt: fee.createdAt,
                },
              },
            },
          ]
        : []),
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: weights.conduitWeightSats,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
    nativeTreasury: {
      schemaVersion: 1,
      sparkAddress: "spark-event-treasury-test-fixture",
      senderIdentityPublicKey: "",
      receiverIdentityPublicKey: `02${getPublicKey(generateSecretKey())}`,
      invoiceId: "",
      invoiceRequest: "event-open-amount-native-test-fixture",
      feePolicy: "zero_required",
      residualPolicy: "unused_commerce_reserves",
    },
    eventMarket,
  }
  input.nativeTreasury = {
    ...input.nativeTreasury,
    senderIdentityPublicKey: input.funding.receiverIdentityPublicKey,
    invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId({
      ...input,
      ...input.nativeTreasury,
      senderIdentityPublicKey: input.funding.receiverIdentityPublicKey,
    }),
  }
  const sourceEvents = [
    market,
    occurrence,
    grant,
    product,
    assignment,
    ...(commerceTotalSats > 0 ? [merchantProfile] : []),
    ...(supplier ? [supplierProfile] : []),
    ...(schedule ? [schedule] : []),
    ...(parentProduct ? [parentProduct] : []),
  ]
  return {
    stockGrant,
    originalAssignment,
    input,
    plan: freezeCheckoutSparkSettledEventPlan(input),
    eventMarket,
    sourceEvents,
    events: {
      market,
      occurrence,
      grant,
      product,
      assignment,
      merchantProfile,
      supplierProfile,
      schedule,
      parentProduct,
    },
    ...eventMarketFixtureParties,
    organizerSigner: signer(organizerSecret),
    merchantSigner: signer(merchantSecret),
    signMerchant: (draft: Draft) => sign(draft, merchantSecret),
    signOrganizer: (draft: Draft) => sign(draft, organizerSecret),
  }
}

export function createCheckoutSparkEventMarketFixtureOrder(
  fixture: ReturnType<typeof checkoutSparkEventMarketFixture>,
  buyerPubkey: string,
  createdAt = EVENT_MARKET_FIXTURE_AT + 500,
  bindingOverride?: CheckoutSparkEventMarketBinding
) {
  const { plan } = fixture
  const binding = bindingOverride ?? plan.eventMarket!
  const calendar = parseEventMarketCalendarFieldsForPrivateOrder(
    fixture.events.occurrence
  )!
  const evidence = (coordinate: string, eventId: string) => {
    const signedEvent = fixture.sourceEvents.find(
      (event) => event.id === eventId
    )!
    return {
      coordinate,
      eventId,
      createdAt: signedEvent.created_at * 1_000,
      signedEvent,
    }
  }
  return orderSchema.parse({
    id: plan.orderId,
    merchantPubkey: plan.merchantPubkey,
    buyerPubkey,
    currency: "SATS",
    subtotal: plan.commerceQuote.commerceTotalSats,
    shippingCostSats: 0,
    createdAt,
    items: plan.commerceQuote.lines.map((line) => {
      const eventLine = binding.lines.find(
        (candidate) => candidate.productCoordinate === line.productCoordinate
      )!
      const signedProduct = fixture.sourceEvents.find(
        (event) => event.id === line.productEventId
      )!
      const product = parseCheckoutSparkSignedProductFields(signedProduct)
      return {
        productId: line.productCoordinate,
        title: product.title,
        format: "physical",
        quantity: line.quantity,
        priceAtPurchase: line.unitMerchandiseSats,
        currency: "SATS",
        shippingCostSats: 0,
        sourcePrice: product.sourcePrice,
        ...(line.variation
          ? {
              familyProductId: line.variation.familyCoordinate,
              selectedSpecifications: line.variation.specifications,
            }
          : {}),
        fulfillment: {
          type: "event_market_pickup",
          organizerPubkey: binding.organizerPubkey,
          merchantPubkey: plan.merchantPubkey,
          payeePubkey: plan.merchantPubkey,
          market: evidence(binding.marketCoordinate, binding.marketEventId),
          calendar: {
            ...evidence(
              binding.occurrenceCoordinate,
              binding.occurrenceEventId
            ),
            start: calendar.start,
            end: calendar.end,
          },
          ...(binding.schedule
            ? {
                schedule: evidence(
                  binding.schedule.coordinate,
                  binding.schedule.eventId
                ),
              }
            : {}),
          grant: {
            kind: 3841,
            pubkey: binding.organizerPubkey,
            eventId: binding.grantEventId,
            createdAt:
              fixture.sourceEvents.find(
                (event) => event.id === binding.grantEventId
              )!.created_at * 1_000,
            ancestryEventIds: [...binding.grantAncestryEventIds],
            observedDeletionEventIds: [...binding.observedDeletionEventIds],
            signedEvidence: {
              tip: fixture.events.grant,
              ancestry: binding.grantAncestryEventIds.map((id) =>
                fixture.sourceEvents.find((event) => event.id === id)!
              ),
              deletions: binding.observedDeletionEventIds.map((id) =>
                fixture.sourceEvents.find((event) => event.id === id)!
              ),
            },
          },
          product: evidence(line.productCoordinate, line.productEventId),
          ...(eventLine.parentProduct
            ? {
                parentProduct: evidence(
                  eventLine.parentProduct.coordinate,
                  eventLine.parentProduct.eventId
                ),
              }
            : {}),
          occurrenceAssignment: evidence(
            eventLine.assignmentCoordinate,
            eventLine.assignmentEventId
          ),
          mode: binding.mode,
          assignment: binding.assignment,
        },
      }
    }),
  })
}
