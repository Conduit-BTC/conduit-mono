import { NDKEvent } from "@nostr-dev-kit/ndk"
import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildFutureMarketPrivateRumor,
  readFutureMarketReadyReceipts,
  readFutureMarketHandoffAcks,
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  buildFutureMarketReadyReceipt,
  buildFutureMarketHandoffAck,
  buildFutureMarketRevocation,
  formatEventMarketPickupClaimCode,
  getFutureMarketClaimRef,
  loadFutureMarketPrivateDeliveries,
  saveFutureMarketPrivateDelivery,
  orderSchema,
  reduceFutureMarketOrganizerClaims,
  validateFutureMarketPrivateUpdate,
  verifyEventMarketOrderEvidence,
  type SignedPublicNostrEvent,
} from "@conduit/core"

afterEach(() => __resetCommerceTestOverrides())

const organizerSecret = generateSecretKey()
const merchantSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchant = getPublicKey(merchantSecret)
const marketCoordinate = `30409:${organizer}:fair`
const calendarCoordinate = `31923:${organizer}:fair`
const productCoordinate = `30402:${merchant}:soap`

const marketDraft = buildEventMarketRosterDraft({
  dTag: "fair",
  organizerPubkey: organizer,
  calendarCoordinate,
  state: "open",
  merchants: [
    { pubkey: merchant, mode: "merchant_present", assignment: "Booth 12" },
  ],
})
const market = finalizeEvent(
  { ...marketDraft, created_at: 100 },
  organizerSecret
)
const calendar = finalizeEvent(
  {
    kind: 31923,
    tags: [
      ["d", "fair"],
      ["title", "Fair"],
      ["start", "1790000000"],
      ["end", "1790003600"],
      ["D", "20717"],
    ],
    content: "",
    created_at: 100,
  },
  organizerSecret
)
const grantDraft = buildEventMarketAuthorizationDraft({
  marketCoordinate,
  merchantPubkey: merchant,
  state: "active",
  sequence: 0,
  parentIds: [],
})
const grant = finalizeEvent({ ...grantDraft, created_at: 99 }, organizerSecret)
const product = finalizeEvent(
  {
    kind: 30402,
    tags: [
      ["d", "soap"],
      ["title", "Soap"],
      ["price", "12", "USD"],
      ["type", "simple", "physical"],
      ["a", marketCoordinate],
    ],
    content: "Soap",
    created_at: 101,
  },
  merchantSecret
)
const signed = [market, calendar, grant, product] as SignedPublicNostrEvent[]
const order = orderSchema.parse({
  id: "order-1",
  merchantPubkey: merchant,
  buyerPubkey: "c".repeat(64),
  items: [
    {
      productId: productCoordinate,
      title: "Soap",
      format: "physical",
      quantity: 1,
      priceAtPurchase: 1200,
      currency: "SATS",
      sourcePrice: { amount: 12, currency: "USD", normalizedCurrency: "USD" },
      shippingCostSats: 0,
      fulfillment: {
        type: "event_market_pickup",
        organizerPubkey: organizer,
        merchantPubkey: merchant,
        payeePubkey: merchant,
        market: {
          coordinate: marketCoordinate,
          eventId: market.id,
          createdAt: 100_000,
          signedEvent: market,
        },
        calendar: {
          coordinate: calendarCoordinate,
          eventId: calendar.id,
          createdAt: 100_000,
          start: 1_790_000_000_000,
          end: 1_790_003_600_000,
          signedEvent: calendar,
        },
        grant: {
          kind: 3841,
          pubkey: organizer,
          eventId: grant.id,
          createdAt: 99_000,
          ancestryEventIds: [grant.id],
          observedDeletionEventIds: [],
          signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
        },
        product: {
          coordinate: productCoordinate,
          eventId: product.id,
          createdAt: 101_000,
          signedEvent: product,
        },
        mode: "merchant_present",
        assignment: "Booth 12",
      },
    },
  ],
  subtotal: 1200,
  currency: "SATS",
  shippingCostSats: 0,
  createdAt: 102_000,
})

describe("created future Event Market order evidence", () => {
  it("verifies exact historical signed revisions without consulting a later roster", () => {
    expect(verifyEventMarketOrderEvidence({ order, events: [] })).toMatchObject(
      {
        status: "verified",
        mode: "merchant_present",
        assignment: "Booth 12",
      }
    )
  })

  it("recovers every exact signed revision from the order and rejects coordinate-only claims", () => {
    expect(
      verifyEventMarketOrderEvidence({
        order,
        events: [],
      })
    ).toMatchObject({ status: "verified" })
    for (const field of ["market", "calendar", "product"] as const) {
      const coordinateOnly = {
        ...order,
        items: order.items.map((item) => ({
          ...item,
          fulfillment:
            item.fulfillment?.type === "event_market_pickup"
              ? {
                  ...item.fulfillment,
                  [field]: {
                    ...item.fulfillment[field],
                    signedEvent: undefined,
                  },
                }
              : item.fulfillment,
        })),
      }
      expect(orderSchema.safeParse(coordinateOnly).success).toBe(false)
      expect(
        verifyEventMarketOrderEvidence({
          order: coordinateOnly as typeof order,
          events: signed,
        })
      ).toEqual({ status: "invalid", reason: "order" })
    }
    const tampered = {
      ...order,
      items: order.items.map((item) => ({
        ...item,
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? {
                ...item.fulfillment,
                grant: {
                  ...item.fulfillment.grant,
                  signedEvidence: {
                    ...item.fulfillment.grant.signedEvidence,
                    tip: {
                      ...item.fulfillment.grant.signedEvidence.tip,
                      content: "tampered",
                    },
                  },
                },
              }
            : item.fulfillment,
      })),
    }
    expect(
      verifyEventMarketOrderEvidence({
        order: tampered as typeof order,
        events: signed,
      })
    ).toEqual({ status: "invalid", reason: "order" })
  })

  it("rejects a valid signed market with different roster terms", () => {
    const changedMarket = finalizeEvent(
      {
        ...buildEventMarketRosterDraft({
          dTag: "fair",
          organizerPubkey: organizer,
          calendarCoordinate,
          state: "open",
          merchants: [
            {
              pubkey: merchant,
              mode: "merchant_present",
              assignment: "Booth 13",
            },
          ],
        }),
        created_at: 100,
      },
      organizerSecret
    )
    const forged = {
      ...order,
      items: order.items.map((item) => ({
        ...item,
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? {
                ...item.fulfillment,
                market: {
                  ...item.fulfillment.market,
                  eventId: changedMarket.id,
                  signedEvent: changedMarket,
                },
              }
            : item.fulfillment,
      })),
    }
    expect(orderSchema.safeParse(forged).success).toBe(false)
    expect(
      verifyEventMarketOrderEvidence({
        order: forged as typeof order,
        events: [],
      })
    ).toEqual({ status: "invalid", reason: "order" })
  })

  it("matches a signed zero SAT source price after checkout normalizes the order to SATS", () => {
    const zeroProduct = finalizeEvent(
      {
        kind: 30402,
        created_at: 101,
        content: "Soap",
        tags: [
          ["d", "soap"],
          ["title", "Soap"],
          ["price", "0", "SAT"],
          ["type", "simple", "physical"],
          ["a", marketCoordinate],
        ],
      },
      merchantSecret
    )
    const zeroOrder = orderSchema.parse({
      ...order,
      subtotal: 0,
      items: order.items.map((item) => ({
        ...item,
        priceAtPurchase: 0,
        currency: "SATS",
        sourcePrice: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? {
                ...item.fulfillment,
                product: {
                  ...item.fulfillment.product,
                  eventId: zeroProduct.id,
                  signedEvent: zeroProduct,
                },
              }
            : item.fulfillment,
      })),
    })
    expect(
      verifyEventMarketOrderEvidence({
        order: zeroOrder,
        events: [
          market,
          calendar,
          grant,
          zeroProduct,
        ] as SignedPublicNostrEvent[],
      }).status
    ).toBe("verified")
  })
})

describe("future Event Market private physical handoff", () => {
  const handoffMarket = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "fair",
        organizerPubkey: organizer,
        calendarCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: merchant,
            mode: "organizer_handoff",
            assignment: "Pickup table",
          },
        ],
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const handoffOrder = orderSchema.parse({
    ...order,
    items: order.items.map((item) => ({
      ...item,
      selectedSpecifications: [{ key: "Scent", value: "Lavender" }],
      fulfillment:
        item.fulfillment?.type === "event_market_pickup"
          ? {
              ...item.fulfillment,
              mode: "organizer_handoff",
              assignment: "Pickup table",
              market: {
                ...item.fulfillment.market,
                eventId: handoffMarket.id,
                signedEvent: handoffMarket,
              },
            }
          : item.fulfillment,
    })),
  })
  const evidence = [
    handoffMarket,
    calendar,
    grant,
    product,
  ] as SignedPublicNostrEvent[]

  for (const visibility of ["hidden", "private"]) {
    it(`rejects the exact signed ${visibility} product before payment or release`, () => {
      const hiddenProduct = finalizeEvent(
        {
          kind: product.kind,
          content: product.content,
          created_at: product.created_at,
          tags: [...product.tags, ["visibility", visibility]],
        },
        merchantSecret
      )
      const hiddenOrder = {
        ...handoffOrder,
        items: handoffOrder.items.map((item) => ({
          ...item,
          fulfillment:
            item.fulfillment?.type === "event_market_pickup"
              ? {
                  ...item.fulfillment,
                  product: {
                    ...item.fulfillment.product,
                    eventId: hiddenProduct.id,
                    signedEvent: hiddenProduct,
                  },
                }
              : item.fulfillment,
        })),
      }
      expect(
        verifyEventMarketOrderEvidence({ order: hiddenOrder, events: [] })
          .status
      ).toBe("invalid")
      expect(() =>
        buildFutureMarketReadyReceipt({
          order: hiddenOrder,
          signedOrderEvidence: [],
          paymentAuthenticated: true,
          releaseConfirmed: true,
        })
      ).toThrow()
    })
  }

  it("rejects a positive signed fiat price forged into a free order", () => {
    const forged = {
      ...handoffOrder,
      subtotal: 0,
      items: handoffOrder.items.map((item) => ({
        ...item,
        priceAtPurchase: 0,
      })),
    }
    expect(orderSchema.safeParse(forged).success).toBe(false)
    expect(
      verifyEventMarketOrderEvidence({ order: forged, events: [] }).status
    ).toBe("invalid")
    expect(() =>
      buildFutureMarketReadyReceipt({
        order: forged,
        signedOrderEvidence: [],
        paymentAuthenticated: false,
        releaseConfirmed: true,
      })
    ).toThrow()
  })

  it("rejects a subtotal that does not equal the quantity-adjusted line prices", () => {
    const forged = {
      ...handoffOrder,
      subtotal: 1200,
      items: handoffOrder.items.map((item) => ({ ...item, quantity: 2 })),
    }
    expect(orderSchema.safeParse(forged).success).toBe(false)
    expect(
      verifyEventMarketOrderEvidence({ order: forged, events: [] }).status
    ).toBe("invalid")
    expect(() =>
      buildFutureMarketReadyReceipt({
        order: forged,
        signedOrderEvidence: [],
        paymentAuthenticated: true,
        releaseConfirmed: true,
      })
    ).toThrow()
  })

  it("permits an exact signed zero-price product without payment evidence", () => {
    const zeroProduct = finalizeEvent(
      {
        kind: product.kind,
        content: product.content,
        created_at: product.created_at,
        tags: product.tags.map((tag) =>
          tag[0] === "price" ? ["price", "0", "SAT"] : tag
        ),
      },
      merchantSecret
    )
    const zeroOrder = orderSchema.parse({
      ...handoffOrder,
      subtotal: 0,
      items: handoffOrder.items.map((item) => ({
        ...item,
        priceAtPurchase: 0,
        sourcePrice: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? {
                ...item.fulfillment,
                product: {
                  ...item.fulfillment.product,
                  eventId: zeroProduct.id,
                  signedEvent: zeroProduct,
                },
              }
            : item.fulfillment,
      })),
    })
    expect(
      buildFutureMarketReadyReceipt({
        order: zeroOrder,
        signedOrderEvidence: [],
        paymentAuthenticated: false,
        releaseConfirmed: true,
      }).releaseAuthorized
    ).toBe(true)
  })

  it("requires exact historical signed terms and paid merchant release, then redacts organizer payload", () => {
    expect(() =>
      buildFutureMarketReadyReceipt({
        order: handoffOrder,
        signedOrderEvidence: evidence,
        paymentAuthenticated: false,
        releaseConfirmed: true,
      })
    ).toThrow()
    const receipt = buildFutureMarketReadyReceipt({
      order: handoffOrder,
      signedOrderEvidence: [],
      paymentAuthenticated: true,
      releaseConfirmed: true,
      issuedAt: 200,
    })
    expect(receipt.items).toHaveLength(1)
    expect(receipt.items[0]?.quantity).toBe(1)
    const exactProduct = handoffOrder.items[0]!.fulfillment
    if (exactProduct?.type !== "event_market_pickup")
      throw new Error("Expected future pickup")
    expect(receipt.items[0]?.product.signedEvent).toEqual(
      exactProduct.product.signedEvent
    )
    expect(receipt.items[0]?.product.signedEvent?.id).toBe(
      exactProduct.product.eventId
    )
    expect(receipt.items[0]?.selectedSpecifications).toEqual([
      { key: "Scent", value: "Lavender" },
    ])
    expect(JSON.stringify(receipt)).not.toContain(handoffOrder.buyerPubkey)
    expect(JSON.stringify(receipt)).not.toContain(handoffOrder.id)
    expect(JSON.stringify(receipt)).not.toContain("paymentConfirmed")
    for (const privateField of [
      "orderId",
      "buyerPubkey",
      "subtotal",
      "shippingCostSats",
      "invoice",
      "preimage",
      "shippingAddress",
    ]) {
      expect(receipt).not.toHaveProperty(privateField)
    }
    expect(Object.keys(receipt.items[0]!.product).sort()).toEqual([
      "coordinate",
      "createdAt",
      "eventId",
      "signedEvent",
    ])
    expect(receipt.claimRef).toBe(
      getFutureMarketClaimRef({
        orderId: handoffOrder.id,
        merchantPubkey: merchant,
        organizerPubkey: organizer,
        marketCoordinate,
      })
    )
    expect(formatEventMarketPickupClaimCode(receipt.claimRef)).toMatch(
      /^[A-Z0-9-]+$/
    )
  })

  for (const coverage of ["partial", "capped"] as const) {
    it(`retains exact ready and ACK authority with ${coverage} inbox coverage`, async () => {
      const receipt = buildFutureMarketReadyReceipt({
        order: handoffOrder,
        signedOrderEvidence: [],
        paymentAuthenticated: true,
        releaseConfirmed: true,
        issuedAt: 200,
      })
      const ready = buildFutureMarketPrivateRumor(receipt)
      const ack = buildFutureMarketPrivateRumor(
        buildFutureMarketHandoffAck({
          receipt,
          readyReceiptId: ready.id!,
          handedOutAt: 201,
        })
      )
      let principal = organizer
      let rumors = [ready]
      const setRead = () =>
        __setCommerceTestOverrides({
          allowMissingProtectedReadAuthorization: true,
          getNdk: async () =>
            ({
              signer: { user: async () => ({ pubkey: principal }) },
            }) as never,
          resolveInboxRelayUrls: async () => ["wss://future.inbox.test"],
          fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
            events: rumors.map(
              (rumor) =>
                new NDKEvent(
                  undefined,
                  finalizeEvent(
                    {
                      kind: 1059,
                      created_at: rumor.created_at!,
                      tags: [["p", principal]],
                      content: rumor.id!,
                    },
                    merchantSecret
                  )
                )
            ),
            attemptedRelayUrls: [...(options?.relayUrls ?? [])],
            successfulRelayUrls: [...(options?.relayUrls ?? [])],
            failedRelayUrls:
              coverage === "partial" ? [...(options?.relayUrls ?? [])] : [],
            cappedRelayUrls:
              coverage === "capped" ? [...(options?.relayUrls ?? [])] : [],
          }),
          giftUnwrap: async (event) =>
            rumors.find((rumor) => rumor.id === event.content)!,
        })
      setRead()
      const organizerRead = await readFutureMarketReadyReceipts({
        organizerPubkey: organizer,
      })
      expect(organizerRead.inbox?.coverage).toBe("partial")
      expect(organizerRead.stale).toBe(false)
      expect(organizerRead.coverageDegraded).toBe(true)
      expect(organizerRead.claims[0]?.state).toBe("ready_for_pickup")
      __setCommerceTestOverrides({
        fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
          events: [],
          attemptedRelayUrls: [...(options?.relayUrls ?? [])],
          successfulRelayUrls: [],
          failedRelayUrls: [...(options?.relayUrls ?? [])],
          cappedRelayUrls: [],
        }),
      })
      const retained = await readFutureMarketReadyReceipts({
        organizerPubkey: organizer,
      })
      expect(retained.stale).toBe(true)
      expect(retained.claims[0]?.state).toBe("ready_for_pickup")
      principal = merchant
      rumors = [ack]
      setRead()
      const merchantRead = await readFutureMarketHandoffAcks({
        merchantPubkey: merchant,
        readyReceiptId: ready.id!,
        receipt,
      })
      expect(merchantRead.exactAck?.id).toBe(ack.id)
      expect(merchantRead.coverageDegraded).toBe(true)
      rumors = [
        ack,
        buildFutureMarketPrivateRumor(
          buildFutureMarketRevocation({
            receipt,
            readyReceiptId: ready.id!,
            issuedAt: 202,
          })
        ),
      ]
      setRead()
      const revoked = await readFutureMarketHandoffAcks({
        merchantPubkey: merchant,
        readyReceiptId: ready.id!,
        receipt,
      })
      expect(revoked.exactAck).toBeNull()
      expect(revoked.revoked).toBe(true)
      expect(revoked.conflicting).toBe(true)
      principal = organizer
      rumors = [ready, ...rumors]
      setRead()
      const organizerRevoked = await readFutureMarketReadyReceipts({
        organizerPubkey: organizer,
      })
      expect(organizerRevoked.claims[0]?.state).toBe("conflicting")
    })
  }

  it("binds ACK and revocation to one exact receipt and detects conflict", () => {
    const receipt = buildFutureMarketReadyReceipt({
      order: handoffOrder,
      signedOrderEvidence: evidence,
      paymentAuthenticated: true,
      releaseConfirmed: true,
      issuedAt: 200,
    })
    const readyId = "f".repeat(64)
    const ack = buildFutureMarketHandoffAck({
      receipt,
      readyReceiptId: readyId,
      handedOutAt: 201,
    })
    const revocation = buildFutureMarketRevocation({
      receipt,
      readyReceiptId: readyId,
      issuedAt: 202,
    })
    expect(() =>
      validateFutureMarketPrivateUpdate({
        receipt,
        readyReceiptId: readyId,
        update: ack,
      })
    ).not.toThrow()
    expect(() =>
      validateFutureMarketPrivateUpdate({
        receipt,
        readyReceiptId: "e".repeat(64),
        update: ack,
      })
    ).toThrow()
    const base = {
      orderId: "",
      createdAt: 200_000,
      rawContent: "",
      senderPubkey: merchant,
      recipientPubkey: organizer,
    }
    const ready = {
      ...base,
      id: readyId,
      type: "future_market_ready" as const,
      payload: receipt,
    }
    const handedOut = {
      ...base,
      id: "a".repeat(64),
      type: "future_market_handed_out" as const,
      senderPubkey: organizer,
      recipientPubkey: merchant,
      payload: ack,
    }
    const revoked = {
      ...base,
      id: "b".repeat(64),
      type: "future_market_revoked" as const,
      payload: revocation,
    }
    expect(
      reduceFutureMarketOrganizerClaims({
        organizerPubkey: organizer,
        messages: [ready],
      })[0]?.state
    ).toBe("ready_for_pickup")
    expect(
      reduceFutureMarketOrganizerClaims({
        organizerPubkey: organizer,
        messages: [ready, handedOut],
      })[0]?.state
    ).toBe("handed_out")
    expect(
      reduceFutureMarketOrganizerClaims({
        organizerPubkey: organizer,
        messages: [ready, revoked],
      })[0]?.state
    ).toBe("revoked")
    expect(
      reduceFutureMarketOrganizerClaims({
        organizerPubkey: organizer,
        messages: [ready, revoked, handedOut],
      })[0]?.state
    ).toBe("conflicting")
  })

  it("retains the same signed private wraps for exact delivery recovery", () => {
    const recipientWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", organizer]],
        content: "encrypted-recipient",
      },
      merchantSecret
    )
    const selfWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: 210,
        tags: [["p", merchant]],
        content: "encrypted-self",
      },
      merchantSecret
    )
    const record = {
      version: 2 as const,
      type: "future_market_ready" as const,
      rumorId: "a".repeat(64),
      readyReceiptId: "a".repeat(64),
      claimRef: "b".repeat(64),
      senderPubkey: merchant,
      recipientPubkey: organizer,
      signedRecipientWrap: recipientWrap,
      signedSelfWrap: selfWrap,
    }
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    saveFutureMarketPrivateDelivery(merchant, record, storage)
    saveFutureMarketPrivateDelivery(merchant, record, storage)
    expect(loadFutureMarketPrivateDeliveries(merchant, storage)).toMatchObject([
      {
        rumorId: record.rumorId,
        signedRecipientWrap: { id: recipientWrap.id },
        signedSelfWrap: { id: selfWrap.id },
      },
    ])
    expect(() =>
      saveFutureMarketPrivateDelivery(
        merchant,
        { ...record, signedRecipientWrap: selfWrap },
        storage
      )
    ).toThrow()
    expect(() =>
      saveFutureMarketPrivateDelivery(organizer, record, storage)
    ).toThrow()
  })
})
