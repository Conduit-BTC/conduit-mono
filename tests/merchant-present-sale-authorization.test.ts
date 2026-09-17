import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import {
  assertMerchantPresentSalePaymentReview,
  buildMerchantPresentSaleReviewedCommerceFingerprint,
  buildMerchantPresentSaleAuthorization,
  buildMerchantPresentSaleAuthorizationRumor,
  consumeMerchantPresentSaleAuthorization,
  createMerchantPresentSaleAuthorizationNonce,
  EVENT_KINDS,
  getMerchantPresentSaleAuthorizationUseRef,
  getMerchantPresentSaleCommerceFingerprintRef,
  merchantPresentSaleAuthorizationSchema,
  parseMerchantPresentSaleReviewedCommerceFingerprint,
  parseMerchantPresentSaleAuthorizationRumor,
  parseOrderMessageRumorEvent,
  prepareMerchantPresentSaleDirectWrap,
  receiveMerchantPresentSaleDirectWrap,
  validateMerchantPresentSaleAuthorization,
  type OrderSchema,
} from "@conduit/core"
import { createGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"

const merchantPubkey = "a".repeat(64)
const buyerPubkey = "b".repeat(64)
const organizerPubkey = "c".repeat(64)
const calendarCoordinate = `31923:${organizerPubkey}:market-day`
const collectionCoordinate = `30405:${organizerPubkey}:market-day`
const optionCoordinate = `30406:${merchantPubkey}:market-day-booth`
const productOne = `30402:${merchantPubkey}:coffee`
const productTwo = `30402:${merchantPubkey}:tea`
const reviewedCommerceFingerprint = JSON.stringify({
  items: [productOne, productTwo],
  total: 42,
  currency: "USD",
  paymentDestination: "merchant-reviewed-target",
})

function pickupFulfillment(product: string, eventId: string) {
  return {
    type: "pickup" as const,
    organizerPubkey,
    product: {
      coordinate: product,
      eventId,
      createdAt: 100,
      merchantPubkey,
    },
    calendar: {
      coordinate: calendarCoordinate,
      eventId: "3".repeat(64),
      createdAt: 101,
    },
    collection: {
      coordinate: collectionCoordinate,
      eventId: "4".repeat(64),
      createdAt: 102,
    },
    option: {
      coordinate: optionCoordinate,
      eventId: "5".repeat(64),
      createdAt: 103,
      title: "Merchant booth",
      location: "North hall",
    },
    handoffMode: "merchant_handoff" as const,
    handlerPubkey: merchantPubkey,
    costSats: 0,
    sourceCost: {
      amount: 0,
      currency: "SAT",
      normalizedCurrency: "SAT",
    },
  }
}

function order(): OrderSchema {
  return {
    id: "booth-order-1",
    merchantPubkey,
    buyerPubkey,
    items: [
      {
        productId: productOne,
        title: "Coffee",
        format: "physical",
        fulfillment: pickupFulfillment(productOne, "1".repeat(64)),
        quantity: 2,
        priceAtPurchase: 12,
        currency: "USD",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SAT",
          normalizedCurrency: "SAT",
        },
        shippingOptionId: optionCoordinate,
        shippingOptionDTag: "market-day-booth",
      },
      {
        productId: productTwo,
        title: "Tea",
        format: "physical",
        fulfillment: pickupFulfillment(productTwo, "2".repeat(64)),
        quantity: 1,
        priceAtPurchase: 18,
        currency: "USD",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SAT",
          normalizedCurrency: "SAT",
        },
        shippingOptionId: optionCoordinate,
        shippingOptionDTag: "market-day-booth",
      },
    ],
    subtotal: 42,
    currency: "USD",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    purchaseContext: {
      type: "merchant_present",
      merchantPubkey,
      collection: {
        coordinate: collectionCoordinate,
        eventId: "4".repeat(64),
        createdAt: 102,
      },
      reviewedCommerceFingerprintRef:
        getMerchantPresentSaleCommerceFingerprintRef(
          reviewedCommerceFingerprint
        ),
    },
    createdAt: 1_000_000,
  }
}

function authorization() {
  return buildMerchantPresentSaleAuthorization({
    order: order(),
    nonce: "6".repeat(64),
    issuedAt: 1_000,
    expiresAt: 1_240,
  })
}

function rekeyOrder(
  source: OrderSchema,
  nextMerchantPubkey: string,
  nextBuyerPubkey: string
): OrderSchema {
  const previousMerchantPubkey = source.merchantPubkey
  source.merchantPubkey = nextMerchantPubkey
  source.buyerPubkey = nextBuyerPubkey
  if (source.purchaseContext?.type === "merchant_present") {
    source.purchaseContext.merchantPubkey = nextMerchantPubkey
  }
  for (const item of source.items) {
    item.productId = item.productId.replace(
      previousMerchantPubkey,
      nextMerchantPubkey
    )
    item.shippingOptionId = item.shippingOptionId?.replace(
      previousMerchantPubkey,
      nextMerchantPubkey
    )
    if (item.fulfillment?.type !== "pickup") continue
    item.fulfillment.product.coordinate = item.productId
    item.fulfillment.product.merchantPubkey = nextMerchantPubkey
    item.fulfillment.option.coordinate =
      item.fulfillment.option.coordinate.replace(
        previousMerchantPubkey,
        nextMerchantPubkey
      )
    item.fulfillment.handlerPubkey = nextMerchantPubkey
  }
  return source
}

describe("merchant-present sale authorization", () => {
  it("binds the exact cart, merchant, total, and payment destination reviewed by the buyer", () => {
    expect(
      buildMerchantPresentSaleReviewedCommerceFingerprint({
        cartCommerceFingerprint: "cart-fingerprint-v1",
        merchantPubkey: merchantPubkey.toUpperCase(),
        paymentDestination: " merchant@example.com ",
        totalSats: 4_200,
      })
    ).toBe(
      JSON.stringify({
        version: 1,
        merchantPubkey,
        paymentDestination: "merchant@example.com",
        totalSats: 4_200,
        cartCommerceFingerprint: "cart-fingerprint-v1",
      })
    )
  })

  it("normalizes and validates the retained booth payment review", () => {
    const fingerprint = buildMerchantPresentSaleReviewedCommerceFingerprint({
      cartCommerceFingerprint: "cart-fingerprint-v1",
      merchantPubkey,
      paymentDestination: "Merchant@Example.COM",
      totalSats: 4_200,
    })

    expect(
      parseMerchantPresentSaleReviewedCommerceFingerprint(fingerprint)
    ).toEqual({
      version: 1,
      merchantPubkey,
      paymentDestination: "merchant@example.com",
      totalSats: 4_200,
      cartCommerceFingerprint: "cart-fingerprint-v1",
    })
    expect(
      assertMerchantPresentSalePaymentReview({
        reviewedCommerceFingerprint: fingerprint,
        merchantPubkey,
        totalSats: 4_200,
        currentPaymentDestination: "MERCHANT@example.com",
      }).paymentDestination
    ).toBe("merchant@example.com")
    expect(() =>
      assertMerchantPresentSalePaymentReview({
        reviewedCommerceFingerprint: fingerprint,
        merchantPubkey,
        totalSats: 4_200,
        currentPaymentDestination: "changed@example.com",
      })
    ).toThrow("payment destination changed")
  })

  it("records no payment destination for a zero-cost booth handoff", () => {
    const fingerprint = buildMerchantPresentSaleReviewedCommerceFingerprint({
      cartCommerceFingerprint: "cart-fingerprint-v1",
      merchantPubkey,
      paymentDestination: null,
      totalSats: 0,
    })

    expect(
      parseMerchantPresentSaleReviewedCommerceFingerprint(fingerprint)
    ).toMatchObject({ paymentDestination: null, totalSats: 0 })
    expect(() =>
      assertMerchantPresentSalePaymentReview({
        reviewedCommerceFingerprint: fingerprint,
        merchantPubkey,
        totalSats: 0,
        currentPaymentDestination: null,
      })
    ).not.toThrow()
  })

  it("refuses an incomplete booth commerce review", () => {
    expect(() =>
      buildMerchantPresentSaleReviewedCommerceFingerprint({
        cartCommerceFingerprint: "",
        merchantPubkey,
        paymentDestination: "merchant@example.com",
        totalSats: 4_200,
      })
    ).toThrow("exact cart terms")
    expect(() =>
      buildMerchantPresentSaleReviewedCommerceFingerprint({
        cartCommerceFingerprint: "cart-fingerprint-v1",
        merchantPubkey,
        paymentDestination: "",
        totalSats: 4_200,
      })
    ).toThrow("payment destination")
  })

  it("builds one minimal capability for exact graph and product revisions", () => {
    const built = authorization()

    expect(built).toEqual({
      version: 1,
      type: "merchant_present_sale_authorization",
      scope: "physical_availability_only",
      orderId: "booth-order-1",
      merchantPubkey,
      buyerPubkey,
      organizerPubkey,
      calendar: {
        coordinate: calendarCoordinate,
        eventId: "3".repeat(64),
        createdAt: 101,
      },
      collection: {
        coordinate: collectionCoordinate,
        eventId: "4".repeat(64),
        createdAt: 102,
      },
      option: {
        coordinate: optionCoordinate,
        eventId: "5".repeat(64),
        createdAt: 103,
      },
      items: [
        {
          product: {
            coordinate: productOne,
            eventId: "1".repeat(64),
            createdAt: 100,
          },
          quantity: 2,
        },
        {
          product: {
            coordinate: productTwo,
            eventId: "2".repeat(64),
            createdAt: 100,
          },
          quantity: 1,
        },
      ],
      reviewedCommerceFingerprintRef:
        getMerchantPresentSaleCommerceFingerprintRef(
          reviewedCommerceFingerprint
        ),
      nonce: "6".repeat(64),
      issuedAt: 1_000,
      expiresAt: 1_240,
    })
    expect(JSON.stringify(built)).not.toContain("paymentDestination")
    expect(JSON.stringify(built)).not.toContain("priceAtPurchase")
    expect(JSON.stringify(built)).not.toContain("guestContact")
  })

  it("round-trips through the strict kind-16 and shared order parsers", () => {
    const built = authorization()
    const rumor = buildMerchantPresentSaleAuthorizationRumor(built)

    expect(rumor.kind).toBe(EVENT_KINDS.ORDER)
    expect(rumor.pubkey).toBe(merchantPubkey)
    expect(rumor.tags).toContainEqual(["p", buyerPubkey])
    expect(rumor.tags).toContainEqual([
      "type",
      "merchant_present_sale_authorization",
    ])
    expect(rumor.tags).toContainEqual(["order", built.orderId])
    expect(parseMerchantPresentSaleAuthorizationRumor(rumor)).toEqual(built)

    const parsed = parseOrderMessageRumorEvent(rumor)
    expect(parsed.type).toBe("merchant_present_sale_authorization")
    expect(parsed.orderId).toBe(built.orderId)
    if (parsed.type !== "merchant_present_sale_authorization") return
    expect(parsed.payload.scope).toBe("physical_availability_only")
  })

  it("rejects changed reviewed terms, quantities, and product revisions", () => {
    const built = authorization()
    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: built,
        order: order(),
        reviewedCommerceFingerprint: `${reviewedCommerceFingerprint}-changed`,
        now: 1_100,
      })
    ).toThrow("no longer match the buyer's signed merchant-present order")

    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: {
          ...built,
          reviewedCommerceFingerprintRef: "9".repeat(64),
        },
        order: order(),
        reviewedCommerceFingerprint,
        now: 1_100,
      })
    ).toThrow("does not match the buyer's reviewed order context")

    const changedQuantity = order()
    changedQuantity.items[0]!.quantity = 3
    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: built,
        order: changedQuantity,
        reviewedCommerceFingerprint,
        now: 1_100,
      })
    ).toThrow("exact product revisions and quantities")

    const changedRevision = order()
    if (changedRevision.items[0]!.fulfillment?.type !== "pickup") {
      throw new Error("Expected pickup test fixture")
    }
    changedRevision.items[0]!.fulfillment.product.eventId = "9".repeat(64)
    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: built,
        order: changedRevision,
        reviewedCommerceFingerprint,
        now: 1_100,
      })
    ).toThrow("exact product revisions and quantities")
  })

  it("rejects organizer handoff, legacy ambiguity, and forged rumor bindings", () => {
    const organizerOrder = order()
    if (organizerOrder.items[0]!.fulfillment?.type !== "pickup") {
      throw new Error("Expected pickup test fixture")
    }
    organizerOrder.items[0]!.fulfillment.handoffMode = "organizer_handoff"
    organizerOrder.items[0]!.fulfillment.handlerPubkey = organizerPubkey
    expect(() =>
      buildMerchantPresentSaleAuthorization({
        order: organizerOrder,
        nonce: "7".repeat(64),
        issuedAt: 1_000,
      })
    ).toThrow()

    const legacyOrder = order()
    for (const item of legacyOrder.items) {
      if (item.fulfillment?.type !== "pickup") continue
      delete item.fulfillment.handoffMode
      delete item.fulfillment.handlerPubkey
    }
    expect(() =>
      buildMerchantPresentSaleAuthorization({
        order: legacyOrder,
        nonce: "7".repeat(64),
        issuedAt: 1_000,
      })
    ).toThrow()

    const rumor = buildMerchantPresentSaleAuthorizationRumor(authorization())
    rumor.tags.push(["p", "d".repeat(64)])
    expect(() => parseMerchantPresentSaleAuthorizationRumor(rumor)).toThrow(
      "rumor authority is invalid"
    )
  })

  it("keeps the capability short-lived and physically scoped", () => {
    const built = authorization()
    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: built,
        order: order(),
        reviewedCommerceFingerprint,
        now: built.expiresAt,
      })
    ).toThrow("authorization expired")
    expect(() =>
      merchantPresentSaleAuthorizationSchema.parse({
        ...built,
        paymentConfirmed: true,
      })
    ).toThrow()
    expect(() =>
      merchantPresentSaleAuthorizationSchema.parse({
        ...built,
        expiresAt: built.issuedAt + 301,
      })
    ).toThrow("expire within five minutes")
  })

  it("does not upgrade a remote merchant-pickup order at authorization time", () => {
    const remoteOrder = order()
    delete remoteOrder.purchaseContext
    expect(() =>
      buildMerchantPresentSaleAuthorization({
        order: remoteOrder,
        nonce: "7".repeat(64),
        issuedAt: 1_000,
      })
    ).toThrow("Remote pickup orders cannot be upgraded")
    expect(() =>
      validateMerchantPresentSaleAuthorization({
        authorization: authorization(),
        order: remoteOrder,
        reviewedCommerceFingerprint,
        now: 1_100,
      })
    ).toThrow("Remote pickup orders cannot be upgraded")
  })

  it("requires an atomic single-use nonce consumption", async () => {
    const built = authorization()
    const consumed = new Set<string>()
    const consumeNonce = ({ useRef }: { useRef: string }) => {
      if (consumed.has(useRef)) return false
      consumed.add(useRef)
      return true
    }
    const input = {
      authorization: built,
      order: order(),
      reviewedCommerceFingerprint,
      now: 1_100,
      consumeNonce,
    }

    await expect(
      consumeMerchantPresentSaleAuthorization(input)
    ).resolves.toEqual(built)
    expect(consumed).toEqual(
      new Set([getMerchantPresentSaleAuthorizationUseRef(built)])
    )
    await expect(
      consumeMerchantPresentSaleAuthorization(input)
    ).rejects.toThrow("already used")
  })

  it("generates an exact 256-bit nonce", () => {
    expect(
      createMerchantPresentSaleAuthorizationNonce((length) =>
        new Uint8Array(length).fill(0xab)
      )
    ).toBe("ab".repeat(32))
    expect(() =>
      createMerchantPresentSaleAuthorizationNonce(() => new Uint8Array(31))
    ).toThrow("must be 32 bytes")
  })

  it("prepares and receives one direct guest wrap without relay or signing authority", async () => {
    const merchantSigner = NDKPrivateKeySigner.generate()
    const buyerSigner = NDKPrivateKeySigner.generate()
    const dynamicOrder = rekeyOrder(
      order(),
      (await merchantSigner.user()).pubkey,
      (await buyerSigner.user()).pubkey
    )
    dynamicOrder.buyerIdentityKind = "guest_ephemeral"
    const fingerprint = JSON.stringify(
      dynamicOrder.items.map((item) => [item.productId, item.quantity])
    )
    if (dynamicOrder.purchaseContext?.type !== "merchant_present") {
      throw new Error("Expected merchant-present purchase context")
    }
    dynamicOrder.purchaseContext.reviewedCommerceFingerprintRef =
      getMerchantPresentSaleCommerceFingerprintRef(fingerprint)
    const issuedAt = Math.floor(Date.now() / 1_000)
    const built = buildMerchantPresentSaleAuthorization({
      order: dynamicOrder,
      nonce: "8".repeat(64),
      issuedAt,
    })

    const wrap = await prepareMerchantPresentSaleDirectWrap({
      authorization: built,
      merchantSigner,
    })
    expect(wrap.kind).toBe(EVENT_KINDS.GIFT_WRAP)
    expect(wrap.tags).toEqual([["p", dynamicOrder.buyerPubkey]])

    const guestIdentity = createGuestOrderSigningIdentity(
      dynamicOrder.id,
      dynamicOrder.merchantPubkey,
      () => buyerSigner
    )
    const decrypt = guestIdentity.createMerchantPresentSaleDirectDecrypt({
      orderId: dynamicOrder.id,
      merchantPubkey: dynamicOrder.merchantPubkey,
      wrap,
    })
    const received = await receiveMerchantPresentSaleDirectWrap({
      wrap,
      order: dynamicOrder,
      reviewedCommerceFingerprint: fingerprint,
      now: issuedAt,
      decrypt,
    })
    expect(received).toEqual(built)
    await expect(
      decrypt(new NDKUser({ pubkey: wrap.pubkey }), wrap.content, "nip44")
    ).rejects.toThrow("limited to one")

    let wrongBuyerDecryptCalls = 0
    await expect(
      receiveMerchantPresentSaleDirectWrap({
        wrap,
        order: { ...dynamicOrder, buyerPubkey: "d".repeat(64) },
        reviewedCommerceFingerprint: fingerprint,
        now: issuedAt,
        decrypt: async () => {
          wrongBuyerDecryptCalls += 1
          throw new Error("must not decrypt")
        },
      })
    ).rejects.toThrow("belongs to another buyer")
    expect(wrongBuyerDecryptCalls).toBe(0)
  })
})
