import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  __resetEventMarketMerchandiseTestOverrides,
  __setEventMarketMerchandiseTestOverrides,
  isVerifiedEventMarketReceiptMerchandiseResolution,
} from "@conduit/core/protocol/event-market-merchandise"
import {
  getFutureMarketReceiptMerchandise,
  resolveFutureMarketReceiptMerchandiseEvidence,
} from "@conduit/core/protocol/future-market-merchandise"
import {
  futureMarketReadyReceiptSchema,
  type FutureMarketReadyReceiptSchema,
} from "@conduit/core/schemas"
import { publishFutureMarketHandoffAck } from "@conduit/core/protocol/future-market-handoff"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER = getPublicKey(generateSecretKey())
const CREATED_AT = 1_700_000_000
const RELAY_URL = "wss://future-merchandise.example"
const COVERAGE = {
  attemptedRelayCount: 1,
  completeRelayCount: 1,
  partialRelayCount: 0,
  failedRelayCount: 0,
}

function productEvent(
  dTag: string,
  title: string,
  createdAt = CREATED_AT,
  secret = MERCHANT_SECRET
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      tags: [
        ["d", dTag],
        ["title", title],
        ["price", "1000", "SAT"],
        ["type", "simple", "physical"],
        ["spec", "Scent", "Citrus"],
      ],
      content: title,
    },
    secret
  )
}

function receiptFor(
  products: readonly SignedPublicNostrEvent[]
): FutureMarketReadyReceiptSchema {
  return futureMarketReadyReceiptSchema.parse({
    version: 2,
    type: "future_market_ready",
    releaseAuthorized: true,
    claimRef: "f".repeat(64),
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    market: {
      coordinate: `30409:${ORGANIZER}:fair`,
      eventId: "a".repeat(64),
      createdAt: CREATED_AT * 1_000,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:fair-day`,
      eventId: "b".repeat(64),
      createdAt: CREATED_AT * 1_000,
    },
    grant: { eventId: "c".repeat(64), createdAt: CREATED_AT * 1_000 },
    items: products.map((product, index) => ({
      product: {
        coordinate: `30402:${MERCHANT}:${product.tags.find((tag) => tag[0] === "d")![1]}`,
        eventId: product.id,
        createdAt: product.created_at * 1_000,
      },
      quantity: index + 2,
      selectedSpecifications: [{ key: "Scent", value: "Citrus" }],
    })),
    issuedAt: CREATED_AT + 10,
  })
}

afterEach(__resetEventMarketMerchandiseTestOverrides)

describe("future organizer exact merchandise", () => {
  it("authenticates every exact revision and preserves quantities and selected specifications", () => {
    const soap = productEvent("soap", "Signed citrus soap")
    const candle = productEvent("candle", "Signed citrus candle")
    const receipt = receiptFor([soap, candle])
    const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt,
      events: [soap, candle],
      coverage: COVERAGE,
    })
    expect(resolution.state).toBe("verified")
    expect(
      resolution.items.map(({ title, quantity, selectedSpecifications }) => ({
        title,
        quantity,
        selectedSpecifications,
      }))
    ).toEqual([
      {
        title: "Signed citrus soap",
        quantity: 2,
        selectedSpecifications: [{ key: "Scent", value: "Citrus" }],
      },
      {
        title: "Signed citrus candle",
        quantity: 3,
        selectedSpecifications: [{ key: "Scent", value: "Citrus" }],
      },
    ])
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      true
    )
    expect(
      isVerifiedEventMarketReceiptMerchandiseResolution({ ...resolution })
    ).toBe(false)
    receipt.items[0]!.selectedSpecifications![0]!.value = "Changed after read"
    expect(resolution.items[0]!.selectedSpecifications![0]!.value).toBe(
      "Citrus"
    )
  })

  it("keeps the historical signed revision when the coordinate has a newer revision", () => {
    const historical = productEvent("soap", "Historical soap")
    const newer = productEvent("soap", "New soap", CREATED_AT + 100)
    const receipt = receiptFor([historical])
    const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt,
      events: [newer, historical],
      coverage: COVERAGE,
    })
    expect(resolution.state).toBe("verified")
    expect(resolution.items[0]!.title).toBe("Historical soap")
    expect(
      resolveFutureMarketReceiptMerchandiseEvidence({
        receipt,
        events: [newer],
        coverage: COVERAGE,
      }).state
    ).toBe("missing")
  })

  it("blocks missing and unavailable exact evidence independently of receipt quantity", () => {
    const product = productEvent("soap", "Signed soap")
    const receipt = receiptFor([product])
    expect(
      resolveFutureMarketReceiptMerchandiseEvidence({
        receipt,
        events: [],
        coverage: COVERAGE,
      }).state
    ).toBe("missing")
    expect(
      resolveFutureMarketReceiptMerchandiseEvidence({
        receipt,
        events: [],
        coverage: { ...COVERAGE, completeRelayCount: 0, failedRelayCount: 1 },
      }).state
    ).toBe("unavailable")
  })

  it("blocks timestamp, coordinate, merchant, and signature mismatches", () => {
    const product = productEvent("soap", "Signed soap")
    const receipt = receiptFor([product])
    for (const changedReceipt of [
      {
        ...receipt,
        items: [
          {
            ...receipt.items[0]!,
            product: {
              ...receipt.items[0]!.product,
              createdAt: CREATED_AT * 1_000 + 1_000,
            },
          },
        ],
      },
      {
        ...receipt,
        items: [
          {
            ...receipt.items[0]!,
            product: {
              ...receipt.items[0]!.product,
              coordinate: `30402:${MERCHANT}:other`,
            },
          },
        ],
      },
    ]) {
      expect(
        resolveFutureMarketReceiptMerchandiseEvidence({
          receipt: changedReceipt,
          events: [product],
          coverage: COVERAGE,
        }).state
      ).toBe("malformed")
    }
    const otherMerchantProduct = productEvent(
      "soap",
      "Foreign soap",
      CREATED_AT,
      generateSecretKey()
    )
    expect(
      resolveFutureMarketReceiptMerchandiseEvidence({
        receipt: receiptFor([otherMerchantProduct]),
        events: [otherMerchantProduct],
        coverage: COVERAGE,
      }).state
    ).toBe("malformed")
    expect(
      resolveFutureMarketReceiptMerchandiseEvidence({
        receipt,
        events: [{ ...product, sig: "0".repeat(128) }],
        coverage: COVERAGE,
      }).state
    ).toBe("malformed")
  })

  it("blocks the whole release if one exact item is missing", () => {
    const soap = productEvent("soap", "Signed soap")
    const candle = productEvent("candle", "Signed candle")
    const receipt = receiptFor([soap, candle])
    const missing = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt,
      events: [soap],
      coverage: COVERAGE,
    })
    expect(missing.items.map((item) => item.state)).toEqual([
      "verified",
      "missing",
    ])
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(missing)).toBe(
      false
    )
  })

  it("retains signed historical physical terms after a later product deletion", () => {
    const product = productEvent("soap", "Historical signed soap")
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: CREATED_AT + 1,
        tags: [
          ["e", product.id],
          ["a", `30402:${MERCHANT}:soap`],
          ["k", "30402"],
        ],
        content: "",
      },
      MERCHANT_SECRET
    )
    const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt: receiptFor([product]),
      events: [product, deletion],
      coverage: COVERAGE,
    })
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      true
    )
    expect(resolution.items[0]!.title).toBe("Historical signed soap")
  })

  it("rejects a signed digital revision as organizer physical merchandise", () => {
    const product = finalizeEvent(
      {
        kind: 30402,
        created_at: CREATED_AT,
        tags: [
          ["d", "digital"],
          ["title", "Digital download"],
          ["price", "1000", "SAT"],
          ["type", "simple", "digital"],
        ],
        content: "Digital download",
      },
      MERCHANT_SECRET
    )
    const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt: receiptFor([product]),
      events: [product],
      coverage: COVERAGE,
    })
    expect(resolution.state).toBe("malformed")
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      false
    )
  })

  it("rejects hidden or private exact merchandise without substituting a newer revision", () => {
    for (const visibility of ["hidden", "private"]) {
      const product = finalizeEvent(
        {
          kind: 30402,
          created_at: CREATED_AT,
          tags: [
            ["d", "soap"],
            ["title", "Unavailable soap"],
            ["price", "1000", "SAT"],
            ["type", "simple", "physical"],
            ["visibility", visibility],
          ],
          content: "Unavailable soap",
        },
        MERCHANT_SECRET
      )
      const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
        receipt: receiptFor([product]),
        events: [product],
        coverage: COVERAGE,
      })
      expect(resolution.state).toBe("malformed")
      expect(
        isVerifiedEventMarketReceiptMerchandiseResolution(resolution)
      ).toBe(false)
    }
  })

  it("permits positive signed exact evidence with degraded public relay coverage", () => {
    const product = productEvent("soap", "Signed soap")
    const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt: receiptFor([product]),
      events: [product],
      coverage: {
        attemptedRelayCount: 2,
        completeRelayCount: 0,
        partialRelayCount: 1,
        failedRelayCount: 1,
      },
    })
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      true
    )
  })

  it("uses shared bounded exact-id and deletion reads for future receipts", async () => {
    const product = productEvent("soap", "Signed soap")
    const observedFilters: NDKFilter[] = []
    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: (async () =>
        new Map([
          [
            MERCHANT,
            {
              pubkey: MERCHANT,
              readRelayUrls: [],
              writeRelayUrls: [RELAY_URL],
              eventCreatedAt: CREATED_AT,
              lookupState: "network",
              cachedAt: Date.now(),
            },
          ],
        ])) as never,
      fetchEventsFanoutDetailed: (async (filter, options) => {
        observedFilters.push(filter)
        const events = filter.kinds?.includes(30402) ? [product] : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success",
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      }) as never,
    })
    const resolution = await getFutureMarketReceiptMerchandise({
      receipt: receiptFor([product]),
    })
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      true
    )
    expect(resolution.items[0]!.selectedSpecifications).toEqual([
      { key: "Scent", value: "Citrus" },
    ])
    expect(
      observedFilters.find((filter) => filter.kinds?.includes(30402))?.ids
    ).toEqual([product.id])
    expect(
      observedFilters
        .filter((filter) => filter["#e"])
        .every((filter) => filter["#e"]?.length === 1 && filter.limit === 4)
    ).toBe(true)
    expect(
      observedFilters
        .filter((filter) => filter["#a"])
        .every((filter) => filter["#a"]?.length === 1 && filter.limit === 4)
    ).toBe(true)
  })

  it("blocks composed handoff signing and persistence for missing or mismatched merchandise", async () => {
    const product = productEvent("soap", "Signed soap")
    for (const mismatched of [false, true]) {
      const payload = receiptFor([product])
      if (mismatched) payload.items[0]!.product.createdAt += 1_000
      let signatures = 0
      let encryptions = 0
      let persistedWraps = 0
      __setEventMarketMerchandiseTestOverrides({
        getRelayLists: (async () => new Map()) as never,
        fetchEventsFanoutDetailed: (async (filter, options) => {
          const events =
            mismatched && filter.kinds?.includes(30402) ? [product] : []
          return {
            events: events.map((event) => new NDKEvent(undefined, event)),
            relays: options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success",
              eventCount: events.length,
            })),
            eventsVerified: true,
          }
        }) as never,
      })
      const signer = {
        sign: async () => {
          signatures += 1
          return ""
        },
        encrypt: async () => {
          encryptions += 1
          return ""
        },
      } as unknown as NDKSigner
      await expect(
        publishFutureMarketHandoffAck({
          organizerPubkey: ORGANIZER,
          authenticatedPubkey: ORGANIZER,
          claim: {
            state: "ready_for_pickup",
            receipt: {
              id: "d".repeat(64),
              orderId: "",
              createdAt: CREATED_AT * 1_000,
              rawContent: "",
              senderPubkey: MERCHANT,
              recipientPubkey: ORGANIZER,
              type: "future_market_ready",
              payload,
            },
          },
          physicalReleaseConfirmed: true,
          signer,
          persistExactWraps: () => {
            persistedWraps += 1
          },
        })
      ).rejects.toThrow(
        "Exact signed merchandise must be verified before handoff."
      )
      expect(signatures).toBe(0)
      expect(encryptions).toBe(0)
      expect(persistedWraps).toBe(0)
    }
  })

  it("rejects a cancelled owner read before returning authenticated merchandise", async () => {
    const product = productEvent("soap", "Signed soap")
    let current = true
    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: (async () => new Map()) as never,
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        current = false
        return {
          events: [new NDKEvent(undefined, product)],
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success",
            eventCount: 1,
          })),
          eventsVerified: true,
        }
      }) as never,
    })
    await expect(
      getFutureMarketReceiptMerchandise({
        receipt: receiptFor([product]),
        shouldContinue: () => current,
      })
    ).rejects.toThrow("cancelled")
    await expect(
      getFutureMarketReceiptMerchandise({
        receipt: receiptFor([product]),
        shouldContinue: () => false,
      })
    ).rejects.toThrow("cancelled")
  })
})
