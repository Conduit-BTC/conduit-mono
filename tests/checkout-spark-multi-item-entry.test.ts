import { describe, expect, it } from "bun:test"
import { admitFixture } from "./helpers/public-event"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  calculateConduitCheckoutFeeSats,
  calculateCheckoutSparkSettledGrossFundingSats,
  checkoutSparkConduitFeeRecipient,
  getNdk,
  isSatsLikeCurrency,
  parseProductEvent,
  type CheckoutSparkRecipientPayoutAddressResolution,
} from "@conduit/core"
import {
  CheckoutSparkSettledPayoutPreflightError,
  isCheckoutSparkSettledDigitalCart,
  prepareCheckoutSparkSettledOrder,
  type PrepareCheckoutSparkSettledOrderInput,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import type { PreparedCheckoutSparkSettledFunding } from "../apps/market/src/lib/checkout-spark-settled-preparation"
import type { PublishedCheckoutSparkBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MERCHANT_PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@example.test" }),
  },
  MERCHANT_SECRET
)
const BUYER = NDKPrivateKeySigner.generate()

async function product(
  id: string,
  price: number,
  tags: string[][] = [],
  currency = "SAT"
) {
  const event = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000,
      tags: [
        ["d", id],
        ["title", "Synthetic digital item"],
        ["price", String(price), currency],
        ["type", "simple", "digital"],
        ...tags,
      ],
      content: "Synthetic test listing",
    },
    MERCHANT_SECRET
  )
  return {
    ...parseProductEvent(await admitFixture(event)),
    sourceEventId: event.id,
  }
}

async function request(
  guest = false,
  selectedEntries?: Array<{
    product: Awaited<ReturnType<typeof product>>
    quantity: number
  }>
): Promise<PrepareCheckoutSparkSettledOrderInput> {
  const entries = selectedEntries ?? [
    { product: await product("first", 1_000), quantity: 2 },
    { product: await product("second", 250), quantity: 3 },
  ]
  const products = entries.map((entry) => entry.product)
  const quantities = entries.map((entry) => entry.quantity)
  const pricing = buildCheckoutPricingIntent(
    products.map((item, index) => ({
      ...createCartItemFromProduct(item),
      quantity: quantities[index]!,
    })),
    null,
    NOW
  )
  if (pricing.status !== "ok") throw new Error("Expected exact digital pricing")
  return {
    checkoutId: "multi-entry-checkout",
    orderId: "multi-entry-order",
    buyer: guest
      ? createSessionGuestOrderSigningIdentity("multi-entry-order", MERCHANT, {
          nowMs: NOW,
          storage: null,
        })
      : { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
    guestContact: guest
      ? { email: "guest@example.test", phone: "+12025550123" }
      : undefined,
    network: "mainnet",
    nowMs: NOW,
    shouldContinue: () => true,
    quoteAuthority: {
      products,
      lines: products.map((item, index) => ({
        productCoordinate: item.id,
        productEventId: item.sourceEventId!,
        merchantPubkey: MERCHANT,
        quantity: quantities[index]!,
      })),
      pricing,
    },
  }
}

describe("same-merchant multi-item settled entry", () => {
  it("prepares a buyer-approved fiat final quote without republishing the unmarked listing", async () => {
    const listing = await product("fiat-entry", 2.5, [], "USD")
    const input = await request()
    const pricing = buildCheckoutPricingIntent(
      [{ ...createCartItemFromProduct(listing), quantity: 2 }],
      { rate: 100_000, fetchedAt: NOW, source: "mempool" },
      NOW
    )
    if (pricing.status !== "ok") throw new Error("Expected fiat pricing")
    input.quoteAuthority = {
      products: [listing],
      pricing,
      lines: [
        {
          productCoordinate: listing.id,
          productEventId: listing.sourceEventId!,
          merchantPubkey: MERCHANT,
          quantity: 2,
        },
      ],
    }
    let publications = 0
    await prepareCheckoutSparkSettledOrder(input, {
      now: () => NOW,
      ndk: getNdk(),
      readRecipientPayout: async () => ({
        state: "ready",
        recipientPubkey: MERCHANT,
        lud16: "merchant@example.test",
        profileEventId: MERCHANT_PROFILE.id,
        profileEventCreatedAt: NOW / 1_000,
        signedEvent: MERCHANT_PROFILE,
      }),
      prepareFunding: async (terms) => {
        expect(terms.recipients[0]?.weightSats).toBe(5_000)
        return {
          plan: { createdAt: NOW },
        } as PreparedCheckoutSparkSettledFunding
      },
      publishOrder: async (publish) => {
        publications++
        expect(publish.order.checkoutSparkPricing?.rate.rate).toBe(100_000)
        expect(publish.order.items[0]?.sourcePrice).toEqual(listing.sourcePrice)
        return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
      },
    })
    expect(publications).toBe(1)
  })

  it.each([false, true])(
    "prepares one combined order and funding plan with guest=%s",
    async (guest) => {
      const input = await request(guest)
      input.quoteAuthority.products = [
        ...input.quoteAuthority.products,
      ].reverse()
      input.quoteAuthority.pricing.items.reverse()
      let reads = 0
      let preparations = 0
      let publications = 0
      await prepareCheckoutSparkSettledOrder(input, {
        now: () => NOW,
        ndk: getNdk(),
        readRecipientPayout: async (read) => {
          reads++
          expect(read.recipientPubkey).toBe(MERCHANT)
          expect(read.accountPubkey).toBe(guest ? null : BUYER.pubkey)
          expect(read.authenticatedPubkey).toBe(guest ? null : BUYER.pubkey)
          return {
            state: "ready",
            recipientPubkey: MERCHANT,
            lud16: "merchant@example.test",
            profileEventId: MERCHANT_PROFILE.id,
            profileEventCreatedAt: NOW / 1_000,
            signedEvent: MERCHANT_PROFILE,
          }
        },
        prepareFunding: async (terms) => {
          preparations++
          expect(terms.checkoutId).toBe(input.checkoutId)
          expect(terms.orderId).toBe(input.orderId)
          expect(terms.quoteAuthority).toEqual(input.quoteAuthority)
          expect(terms.sourceEvents).toHaveLength(3)
          expect(terms.recipients.map((recipient) => recipient.kind)).toEqual([
            "merchant",
            "conduit",
          ])
          expect(terms.recipients[0]?.weightSats).toBe(2_750)
          expect(terms.grossFundingSats).toBe(
            calculateCheckoutSparkSettledGrossFundingSats(2_750)
          )
          expect(terms.fundingExpirySecs).toBe(15 * 60)
          expect(terms.takeoverAt).toBe(NOW + 2 * 60_000)
          return {
            plan: { createdAt: NOW },
          } as PreparedCheckoutSparkSettledFunding
        },
        publishOrder: async (publish) => {
          publications++
          expect(publish.order.id).toBe(input.orderId)
          expect(publish.order.items).toEqual(
            input.quoteAuthority.pricing.items
          )
          expect(publish.order.subtotal).toBe(2_750)
          expect(publish.order.guestContact).toEqual(input.guestContact)
          expect(publish.authenticatedPubkey).toBe(guest ? null : BUYER.pubkey)
          return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
        },
      })
      expect([reads, preparations, publications]).toEqual([1, 1, 1])
    }
  )

  it("snapshots all quote arrays before awaiting a profile read", async () => {
    const input = await request()
    const original = structuredClone(input.quoteAuthority)
    await prepareCheckoutSparkSettledOrder(input, {
      now: () => NOW,
      ndk: getNdk(),
      readRecipientPayout: async () => {
        input.quoteAuthority.pricing.items[0]!.priceAtPurchase += 3
        input.quoteAuthority.pricing.items[1]!.priceAtPurchase -= 2
        input.quoteAuthority.lines[1]!.quantity = 1
        input.quoteAuthority.products[1]!.supplierAllocation!.revisionEvent!.tags.push(
          ["changed"]
        )
        return {
          state: "ready",
          recipientPubkey: MERCHANT,
          lud16: "merchant@example.test",
          profileEventId: MERCHANT_PROFILE.id,
          profileEventCreatedAt: NOW / 1_000,
          signedEvent: MERCHANT_PROFILE,
        }
      },
      prepareFunding: async (terms) => {
        expect(terms.quoteAuthority).toEqual(original)
        return {
          plan: { createdAt: NOW },
        } as PreparedCheckoutSparkSettledFunding
      },
      publishOrder: async (publish) => {
        expect(publish.order.items).toEqual(original.pricing.items)
        return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
      },
    })
  })

  const invalid = [
    "empty",
    "missing_product",
    "missing_price",
    "duplicate_line",
    "duplicate_product",
    "duplicate_price",
    "coordinate",
    "event_id",
    "quantity",
    "same_total_price_drift",
    "merchant",
    "product_currency",
    "priced_currency",
    "product_format",
    "priced_format",
    "fulfillment",
    "shipping_option",
    "shipping_cost",
    "source_shipping",
    "source_price",
    "variant",
    "specifications",
    "approximate",
    "subtotal",
    "msats",
    "overflow",
    "takeover_overflow",
  ] as const
  it.each(invalid)(
    "rejects %s before profile, wallet or publication work",
    async (mode) => {
      const input = await request()
      const quote = input.quoteAuthority
      const lines = [...quote.lines]
      const products = [...quote.products]
      const priced = quote.pricing.items
      quote.lines = lines
      quote.products = products
      if (mode === "empty") {
        quote.lines = []
        quote.products = []
        quote.pricing.items = []
      }
      if (mode === "missing_product") products.pop()
      if (mode === "missing_price") priced.pop()
      if (mode === "duplicate_line") lines[1] = { ...lines[0]! }
      if (mode === "duplicate_product") products[1] = { ...products[0]! }
      if (mode === "duplicate_price") priced[1] = { ...priced[0]! }
      if (mode === "coordinate") priced[1]!.productId += "-other"
      if (mode === "event_id") lines[1]!.productEventId = "f".repeat(64)
      if (mode === "quantity") lines[1]!.quantity++
      if (mode === "same_total_price_drift") {
        priced[0]!.priceAtPurchase += 3
        priced[1]!.priceAtPurchase -= 2
      }
      if (mode === "merchant") lines[1]!.merchantPubkey = "f".repeat(64)
      if (mode === "product_currency") products[1]!.currency = "USD"
      if (mode === "priced_currency")
        Object.assign(priced[1]!, { currency: "USD" })
      if (mode === "product_format") products[1]!.format = "physical"
      if (mode === "priced_format") priced[1]!.format = "physical"
      if (mode === "fulfillment")
        Object.assign(priced[1]!, {
          fulfillment: { type: "event_pickup_pending" },
        })
      if (mode === "shipping_option")
        lines[1]!.shippingOption = {
          coordinate: `30406:${MERCHANT}:shipping`,
          eventId: "f".repeat(64),
        }
      if (mode === "shipping_cost") priced[1]!.shippingCostSats = 1
      if (mode === "source_shipping")
        priced[1]!.sourceShippingCost = {
          amount: 1,
          currency: "SAT",
          normalizedCurrency: "SATS",
        }
      if (mode === "source_price")
        priced[1]!.sourcePrice = {
          amount: 251,
          currency: "SAT",
          normalizedCurrency: "SATS",
        }
      if (mode === "variant")
        priced[1]!.familyProductId = `30402:${MERCHANT}:family`
      if (mode === "specifications")
        priced[1]!.selectedSpecifications = [{ key: "Size", value: "Changed" }]
      if (mode === "approximate") {
        quote.pricing.approximate = true
        priced[1]!.sourcePrice = {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        }
      }
      if (mode === "subtotal") quote.pricing.itemSubtotalSats--
      if (mode === "msats") quote.pricing.totalMsats--
      if (mode === "overflow") quote.pricing.totalSats = Number.MAX_SAFE_INTEGER
      if (mode === "takeover_overflow") input.nowMs = Number.MAX_SAFE_INTEGER
      let calls = 0
      await expect(
        prepareCheckoutSparkSettledOrder(input, {
          now: () => NOW,
          readRecipientPayout: async () => {
            calls++
            throw new Error("must not read")
          },
          prepareFunding: async () => {
            calls++
            throw new Error("must not prepare")
          },
          publishOrder: async () => {
            calls++
            throw new Error("must not publish")
          },
        })
      ).rejects.toThrow()
      expect(calls).toBe(0)
    }
  )
})

describe("signed supplier settled entry", () => {
  const supplierSecrets = [generateSecretKey(), generateSecretKey()]
  const suppliers = supplierSecrets.map(getPublicKey)
  const profiles = [
    MERCHANT_PROFILE,
    ...supplierSecrets.map((secret, index) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: NOW / 1_000,
          tags: [],
          content: JSON.stringify({ lud16: `supplier${index}@example.test` }),
        },
        secret
      )
    ),
  ]
  const recipientOrder = [MERCHANT, ...[...suppliers].sort()]
  type ReadyPayout = Extract<
    CheckoutSparkRecipientPayoutAddressResolution,
    { state: "ready" }
  >
  function payout(pubkey: string): ReadyPayout {
    const profile = profiles.find((event) => event.pubkey === pubkey)!
    return {
      state: "ready",
      recipientPubkey: pubkey,
      lud16: JSON.parse(profile.content).lud16,
      profileEventId: profile.id,
      profileEventCreatedAt: profile.created_at,
      signedEvent: structuredClone(profile),
    }
  }
  async function supplierRequest(guest = false) {
    const terms = (recipients: string[]) => [
      ["conduit_supplier_allocation", "1"],
      ...[MERCHANT, ...recipients].map((pubkey) => [
        "zap",
        pubkey,
        "wss://relay.conduit.market",
        "1",
      ]),
    ]
    return request(guest, [
      {
        product: await product("shared-first", 333, terms([suppliers[0]!])),
        quantity: 3,
      },
      {
        product: await product("shared-second", 101, terms(suppliers)),
        quantity: 2,
      },
      { product: await product("unmarked", 100), quantity: 1 },
    ])
  }
  const prepared = {
    plan: { createdAt: NOW },
  } as PreparedCheckoutSparkSettledFunding

  it.each([false, true])(
    "prepares exact aggregated merchant and supplier legs with guest=%s",
    async (guest) => {
      const input = await supplierRequest(guest)
      const reads: string[] = []
      let preparations = 0
      let publications = 0
      const amounts = new Map([
        [MERCHANT, 668], // 500 + 68 + 100, including each line's rounding residue.
        [suppliers[0]!, 566], // 499 + 67, aggregated before reading its profile.
        [suppliers[1]!, 67],
      ])
      await prepareCheckoutSparkSettledOrder(input, {
        now: () => NOW,
        ndk: getNdk(),
        readRecipientPayout: async (read) => {
          reads.push(read.recipientPubkey)
          expect(read.accountPubkey).toBe(guest ? null : BUYER.pubkey)
          expect(read.authenticatedPubkey).toBe(guest ? null : BUYER.pubkey)
          expect(read.shouldContinue()).toBe(true)
          return payout(read.recipientPubkey)
        },
        prepareFunding: async (terms) => {
          preparations++
          expect(reads).toEqual(recipientOrder)
          expect(terms.recipients.slice(0, -1)).toEqual(
            recipientOrder.map((pubkey) => {
              const resolved = payout(pubkey)
              return {
                kind: pubkey === MERCHANT ? "merchant" : "supplier",
                recipientId: pubkey,
                destination: {
                  type: "lightning_address",
                  value: resolved.lud16,
                  source: {
                    type: "signed_profile",
                    profileEventId: resolved.profileEventId,
                    profileEventCreatedAt: resolved.profileEventCreatedAt,
                  },
                },
                weightSats: amounts.get(pubkey),
              }
            })
          )
          expect(terms.recipients.at(-1)).toMatchObject({
            kind: "conduit",
            recipientId: checkoutSparkConduitFeeRecipient("production"),
            weightSats: calculateConduitCheckoutFeeSats(1_301),
          })
          expect(terms.grossFundingSats).toBe(
            calculateCheckoutSparkSettledGrossFundingSats(1_301)
          )
          const expectedSources = [
            ...input.quoteAuthority.products.map(
              (item) => item.supplierAllocation!.revisionEvent!
            ),
            ...profiles,
          ].sort((left, right) => left.id.localeCompare(right.id))
          expect(terms.sourceEvents).toEqual(structuredClone(expectedSources))
          expect(
            new Set(terms.sourceEvents.map((event) => event.id)).size
          ).toBe(6)
          expect(Object.isFrozen(terms.sourceEvents)).toBe(true)
          expect(terms.quoteAuthority).toEqual(input.quoteAuthority)
          return prepared
        },
        publishOrder: async (publish) => {
          publications++
          expect(publish.order.items).toEqual(
            input.quoteAuthority.pricing.items
          )
          expect(publish.order.subtotal).toBe(1_301)
          expect(publish.authenticatedPubkey).toBe(guest ? null : BUYER.pubkey)
          return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
        },
      })
      expect([preparations, publications]).toEqual([1, 1])
    }
  )

  it("detaches each selected profile and the quote before later recipient reads", async () => {
    const input = await supplierRequest()
    const originalQuote = structuredClone(input.quoteAuthority)
    const merchantPayout = payout(MERCHANT)
    const originalProfile = structuredClone(merchantPayout.signedEvent!)
    const laterProfile = finalizeEvent(
      {
        kind: 0,
        created_at: NOW / 1_000 + 1,
        tags: [["client", "Synthetic updated profile"]],
        content: JSON.stringify({ lud16: "updated@example.test" }),
      },
      MERCHANT_SECRET
    )
    await prepareCheckoutSparkSettledOrder(input, {
      now: () => NOW,
      ndk: getNdk(),
      readRecipientPayout: async ({ recipientPubkey }) => {
        if (recipientPubkey === MERCHANT) return merchantPayout
        Object.assign(merchantPayout.signedEvent!, laterProfile)
        merchantPayout.lud16 = "updated@example.test"
        merchantPayout.profileEventId = laterProfile.id
        merchantPayout.profileEventCreatedAt = laterProfile.created_at
        input.quoteAuthority.products = [await product("later-quote", 100)]
        input.quoteAuthority.pricing.items.reverse()
        return payout(recipientPubkey)
      },
      prepareFunding: async (terms) => {
        expect(terms.quoteAuthority).toEqual(originalQuote)
        expect(terms.sourceEvents).toContainEqual(originalProfile)
        expect(terms.sourceEvents).not.toContainEqual(laterProfile)
        expect(terms.recipients[0]?.destination).toEqual({
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: originalProfile.id,
            profileEventCreatedAt: originalProfile.created_at,
          },
        })
        return prepared
      },
      publishOrder: async (publish) => {
        expect(publish.order.items).toEqual(originalQuote.pricing.items)
        return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
      },
    })
  })

  it.each([
    "profile_unavailable",
    "profile_not_observed",
    "read_incomplete",
    "payment_address_missing",
    "profile_source_unavailable",
  ] as const)(
    "stops before funding for supplier evidence %s",
    async (reason) => {
      let preparedCalls = 0
      let publishedCalls = 0
      const reads: string[] = []
      await expect(
        prepareCheckoutSparkSettledOrder(await supplierRequest(), {
          now: () => NOW,
          readRecipientPayout: async ({ recipientPubkey }) => {
            reads.push(recipientPubkey)
            if (recipientPubkey === MERCHANT) return payout(recipientPubkey)
            if (reason !== "profile_source_unavailable") {
              return { state: "unavailable", reason }
            }
            return { ...payout(recipientPubkey), signedEvent: undefined }
          },
          prepareFunding: async () => {
            preparedCalls++
            return prepared
          },
          publishOrder: async () => {
            publishedCalls++
            throw new Error("must not publish")
          },
        })
      ).rejects.toMatchObject({
        name: CheckoutSparkSettledPayoutPreflightError.name,
        reason,
      })
      expect(reads).toEqual(recipientOrder.slice(0, 2))
      expect([preparedCalls, publishedCalls]).toEqual([0, 0])
    }
  )

  it("bounds the combined signed source bundle before funding preparation", async () => {
    const largeProfiles = supplierSecrets.map((secret, index) =>
      finalizeEvent(
        {
          kind: 0,
          created_at: NOW / 1_000,
          tags: [],
          content: JSON.stringify({
            lud16: `supplier${index}@example.test`,
            about: "Synthetic profile description. ".repeat(600),
          }),
        },
        secret
      )
    )
    let preparedCalls = 0
    let publishedCalls = 0
    await expect(
      prepareCheckoutSparkSettledOrder(await supplierRequest(), {
        now: () => NOW,
        readRecipientPayout: async ({ recipientPubkey }) => {
          const result = payout(recipientPubkey)
          const large = largeProfiles.find(
            (event) => event.pubkey === recipientPubkey
          )
          return large
            ? { ...result, profileEventId: large.id, signedEvent: large }
            : result
        },
        prepareFunding: async () => {
          preparedCalls++
          return prepared
        },
        publishOrder: async () => {
          publishedCalls++
          throw new Error("must not publish")
        },
      })
    ).rejects.toThrow("signed plan sources are unavailable")
    expect([preparedCalls, publishedCalls]).toEqual([0, 0])
  })

  it.each(["account_changed", "guest_expired", "guest_caller_revoked"])(
    "stops subsequent recipient reads and funding after %s",
    async (reason) => {
      const input = await supplierRequest(reason !== "account_changed")
      let now = NOW
      let current = true
      input.shouldContinue = () => current
      let preparedCalls = 0
      let publishedCalls = 0
      const reads: string[] = []
      let releaseRead!: (result: ReadyPayout) => void
      let announceRead!: () => void
      let isCurrent = () => true
      const heldRead = new Promise<ReadyPayout>((resolve) => {
        releaseRead = resolve
      })
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve
      })
      const operation = prepareCheckoutSparkSettledOrder(input, {
        now: () => now,
        readRecipientPayout: async (read) => {
          reads.push(read.recipientPubkey)
          if (reads.length === 2) {
            isCurrent = read.shouldContinue
            announceRead()
            return heldRead
          }
          return payout(read.recipientPubkey)
        },
        prepareFunding: async () => {
          preparedCalls++
          return prepared
        },
        publishOrder: async () => {
          publishedCalls++
          throw new Error("must not publish")
        },
      })
      await Promise.race([readStarted, operation])
      if (
        reason === "guest_expired" &&
        input.buyer.kind === "guest_ephemeral"
      ) {
        now = input.buyer.expiresAt
      } else current = false
      releaseRead(payout(recipientOrder[1]!))
      expect(isCurrent()).toBe(false)
      await expect(operation).rejects.toThrow("buyer session changed")
      expect(reads).toEqual(recipientOrder.slice(0, 2))
      expect([preparedCalls, publishedCalls]).toEqual([0, 0])
    }
  )
})

describe("settled router cart target", () => {
  const item = {
    merchantPubkey: MERCHANT,
    format: "digital" as const,
    currency: "SATS",
  }
  it("admits one or several SAT digital items from one merchant", () => {
    expect(isCheckoutSparkSettledDigitalCart([item])).toBe(true)
    expect(
      isCheckoutSparkSettledDigitalCart([
        item,
        { ...item, fulfillment: { type: "digital" } },
      ])
    ).toBe(true)
  })
  it.each([
    { currency: "SAT", amount: 1_000, eligible: true },
    { currency: "SATS", amount: 1_000, eligible: true },
    { currency: "BTC", amount: 0.00001, eligible: false },
    { currency: "MSAT", amount: 1_000_000, eligible: false },
  ])(
    "uses the original $currency source, not its canonical SATS projection",
    async ({ currency, amount, eligible }) => {
      const parsed = await product(`source-${currency}`, amount, [], currency)
      const cartItem = createCartItemFromProduct(parsed)
      expect(cartItem.currency).toBe("SATS")
      expect(cartItem.priceSats).toBe(1_000)
      expect(
        isSatsLikeCurrency(cartItem.sourcePrice?.normalizedCurrency ?? "")
      ).toBe(eligible)
      expect(isCheckoutSparkSettledDigitalCart([cartItem])).toBe(eligible)
      expect(isCheckoutSparkSettledDigitalCart([item, cartItem])).toBe(eligible)
    }
  )
  it("keeps empty, physical, unsupported currency, event and multi-merchant carts out while admitting fiat", () => {
    expect(isCheckoutSparkSettledDigitalCart([])).toBe(false)
    expect(
      isCheckoutSparkSettledDigitalCart([item, { ...item, format: "physical" }])
    ).toBe(false)
    expect(
      isCheckoutSparkSettledDigitalCart([item, { ...item, currency: "USD" }])
    ).toBe(true)
    expect(
      isCheckoutSparkSettledDigitalCart([{ ...item, currency: "UNKNOWN" }])
    ).toBe(false)
    expect(
      isCheckoutSparkSettledDigitalCart([
        item,
        {
          ...item,
          fulfillment: {
            type: "event_pickup_pending",
            collectionCoordinate: `30405:${MERCHANT}:event`,
          },
        },
      ])
    ).toBe(false)
    expect(
      isCheckoutSparkSettledDigitalCart([
        item,
        { ...item, merchantPubkey: "f".repeat(64) },
      ])
    ).toBe(false)
  })
})
