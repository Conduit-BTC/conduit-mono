import {
  installPrivateInboxTestRead,
  cleanupPrivateInboxTestReads,
} from "./helpers/private-inbox"
import { plainTestSigner } from "./helpers/plain-signer"
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
import {
  buildFutureMarketPrivateRumor,
  __resetFutureMarketHandoffTestState,
  publishFutureMarketHandoffAck,
  readFutureMarketReadyReceipts,
  verifyFutureMarketReceiptAuthority,
} from "@conduit/core/protocol/future-market-handoff"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
} from "@conduit/core/protocol/commerce"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
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

function signedApproval(
  kind: number,
  tags: string[][],
  createdAt = CREATED_AT
) {
  return finalizeEvent(
    { kind, tags, created_at: createdAt, content: "" },
    ORGANIZER_SECRET
  )
}

function approvalEvidence() {
  return [
    signedApproval(30409, [
      ["d", "fair"],
      ["a", `31923:${ORGANIZER}:fair-day`],
      ["event_market", "2", "open"],
      ["merchant", MERCHANT, "organizer_handoff", "Pickup desk"],
    ]),
    signedApproval(31923, [
      ["d", "fair-day"],
      ["title", "Fair"],
      ["start", String(CREATED_AT)],
      ["end", String(CREATED_AT + 3600)],
      ["D", String(Math.floor(CREATED_AT / 86400))],
    ]),
    signedApproval(3841, [
      ["openmarkets", "event-market-auth", "1"],
      ["a", `30409:${ORGANIZER}:fair`],
      ["p", MERCHANT],
      ["state", "active"],
      ["seq", "0"],
      ["alt", "Open Markets event merchant authorization"],
    ]),
  ]
}

function receiptFor(
  products: readonly SignedPublicNostrEvent[],
  embedded = false
): FutureMarketReadyReceiptSchema {
  const authorityEvidence = approvalEvidence()
  return futureMarketReadyReceiptSchema.parse({
    version: 2,
    type: "future_market_ready",
    releaseAuthorized: true,
    claimRef: "f".repeat(64),
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    market: {
      coordinate: `30409:${ORGANIZER}:fair`,
      eventId: authorityEvidence[0]!.id,
      createdAt: CREATED_AT * 1_000,
    },
    calendar: {
      coordinate: `31923:${ORGANIZER}:fair-day`,
      eventId: authorityEvidence[1]!.id,
      createdAt: CREATED_AT * 1_000,
    },
    grant: { eventId: authorityEvidence[2]!.id, createdAt: CREATED_AT * 1_000 },
    authorityEvidence,
    items: products.map((product, index) => ({
      product: {
        coordinate: `30402:${MERCHANT}:${product.tags.find((tag) => tag[0] === "d")![1]}`,
        eventId: product.id,
        createdAt: product.created_at * 1_000,
        ...(embedded ? { signedEvent: product } : {}),
      },
      quantity: index + 2,
      selectedSpecifications: [{ key: "Scent", value: "Citrus" }],
    })),
    issuedAt: CREATED_AT + 10,
  })
}

afterEach(async () => {
  await cleanupPrivateInboxTestReads()
  __resetFutureMarketHandoffTestState()
  __resetEventMarketMerchandiseTestOverrides()
  __resetCommerceTestOverrides()
})

function forbidPublicMerchandiseReads(): () => number {
  let reads = 0
  const unexpectedRead = async () => {
    reads += 1
    throw new Error("Embedded merchandise must not request relay retention")
  }
  __setEventMarketMerchandiseTestOverrides({
    getRelayLists: unexpectedRead,
    fetchSignedEventsFanoutDetailed: unexpectedRead,
  })
  return () => reads
}

describe("future organizer exact merchandise", () => {
  it("verifies carried original bytes after relays prune the old revision without any public reads", async () => {
    const original = productEvent("soap", "Original citrus soap")
    const newer = productEvent("soap", "Edited soap", CREATED_AT + 100)
    const receipt = receiptFor([original], true)
    const publicReads = forbidPublicMerchandiseReads()
    const local = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt,
      events: [newer],
      coverage: COVERAGE,
    })
    const fetched = await getFutureMarketReceiptMerchandise({ receipt })
    for (const resolution of [local, fetched]) {
      expect(
        isVerifiedEventMarketReceiptMerchandiseResolution(resolution)
      ).toBe(true)
      expect(resolution.items[0]!.title).toBe("Original citrus soap")
      expect(resolution.items[0]!.product.eventId).toBe(original.id)
      expect(resolution.items[0]!.quantity).toBe(2)
      expect(resolution.items[0]!.selectedSpecifications).toEqual([
        { key: "Scent", value: "Citrus" },
      ])
    }
    expect(publicReads()).toBe(0)
    expect(fetched.coverage.attemptedRelayCount).toBe(0)
  })

  it("does not certify forged receipt labels against an exact signed variation", async () => {
    const variation = finalizeEvent(
      {
        kind: 30402,
        created_at: CREATED_AT,
        tags: [
          ["d", "soap-small"],
          ["title", "Small soap"],
          ["price", "1000", "SAT"],
          ["type", "variation", "physical"],
          ["a", `30402:${MERCHANT}:soap`],
          ["spec", "Size", "Small"],
        ],
        content: "Small soap",
      },
      MERCHANT_SECRET
    )
    const valid = receiptFor([variation], true)
    valid.items[0]!.selectedSpecifications = [{ key: "Size", value: "Small" }]
    const validResolution = resolveFutureMarketReceiptMerchandiseEvidence({
      receipt: valid,
      events: [],
      coverage: COVERAGE,
    })
    expect(
      isVerifiedEventMarketReceiptMerchandiseResolution(validResolution)
    ).toBe(true)
    for (const forged of [
      [{ key: "Size", value: "Large" }],
      [{ key: "Color", value: "Small" }],
      [
        { key: "Size", value: "Small" },
        { key: "Color", value: "Blue" },
      ],
      undefined,
    ]) {
      const receipt = receiptFor([variation], true)
      receipt.items[0]!.selectedSpecifications = forged
      const resolution = resolveFutureMarketReceiptMerchandiseEvidence({
        receipt,
        events: [],
        coverage: COVERAGE,
      })
      expect(resolution.state).toBe("malformed")
      expect(resolution.items[0]!.selectedSpecifications).toBeUndefined()
      expect(
        isVerifiedEventMarketReceiptMerchandiseResolution(resolution)
      ).toBe(false)
    }
    const forged = receiptFor([variation], true)
    forged.items[0]!.selectedSpecifications = [{ key: "Size", value: "Large" }]
    const publicReads = forbidPublicMerchandiseReads()
    const fetched = await getFutureMarketReceiptMerchandise({ receipt: forged })
    expect(fetched.state).toBe("malformed")
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(fetched)).toBe(
      false
    )
    expect(publicReads()).toBe(0)
  })

  it("rejects forged or mismatched carried bytes without relay fallback or signing", async () => {
    const original = productEvent("soap", "Original soap")
    const newer = productEvent("soap", "Edited soap", CREATED_AT + 100)
    const receipts = [
      receiptFor([original], true),
      receiptFor([original], true),
      receiptFor([original], true),
      receiptFor([original], true),
    ]
    receipts[0]!.items[0]!.product.signedEvent!.sig = "0".repeat(128)
    receipts[1]!.items[0]!.product.signedEvent = newer
    receipts[2]!.items[0]!.product.coordinate = `30402:${MERCHANT}:other`
    receipts[3]!.items[0]!.product.createdAt += 1_000
    for (const payload of receipts) {
      const publicReads = forbidPublicMerchandiseReads()
      let signatures = 0
      let persisted = 0
      const signer = {
        sign: async () => {
          signatures += 1
          return ""
        },
      } as unknown as NDKSigner
      expect(futureMarketReadyReceiptSchema.safeParse(payload).success).toBe(
        false
      )
      await expect(
        getFutureMarketReceiptMerchandise({ receipt: payload })
      ).rejects.toThrow()
      await expect(
        publishFutureMarketHandoffAck({
          organizerPubkey: ORGANIZER,
          authenticatedPubkey: ORGANIZER,
          physicalReleaseConfirmed: true,
          signer: plainTestSigner(signer),
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
          persistExactWraps: () => {
            persisted += 1
          },
        })
      ).rejects.toThrow()
      expect(publicReads()).toBe(0)
      expect(signatures).toBe(0)
      expect(persisted).toBe(0)
    }
  })

  it("rejects carried nonphysical or nonpublic signed revisions without fallback", async () => {
    for (const [format, visibility] of [
      ["digital", "public"],
      ["physical", "hidden"],
      ["physical", "private"],
    ]) {
      const product = finalizeEvent(
        {
          kind: 30402,
          created_at: CREATED_AT,
          tags: [
            ["d", "soap"],
            ["title", "Soap"],
            ["price", "1000", "SAT"],
            ["type", "simple", format!],
            ["visibility", visibility!],
          ],
          content: "Soap",
        },
        MERCHANT_SECRET
      )
      const publicReads = forbidPublicMerchandiseReads()
      const resolution = await getFutureMarketReceiptMerchandise({
        receipt: receiptFor([product], true),
      })
      expect(resolution.state).toBe("malformed")
      expect(
        isVerifiedEventMarketReceiptMerchandiseResolution(resolution)
      ).toBe(false)
      expect(publicReads()).toBe(0)
    }
  })

  it("looks up only absent bytes in a mixed compatibility receipt", async () => {
    const soap = productEvent("soap", "Retained soap")
    const candle = productEvent("candle", "Legacy candle")
    const receipt = receiptFor([soap, candle], true)
    delete receipt.items[1]!.product.signedEvent
    const filters: NDKFilter[] = []
    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: async () => new Map(),
      fetchSignedEventsFanoutDetailed: (async (filter, options) => {
        filters.push(filter)
        const events = filter.kinds?.includes(30402) ? [candle] : []
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
    const resolution = await getFutureMarketReceiptMerchandise({ receipt })
    expect(isVerifiedEventMarketReceiptMerchandiseResolution(resolution)).toBe(
      true
    )
    expect(resolution.items.map((item) => item.title)).toEqual([
      "Retained soap",
      "Legacy candle",
    ])
    expect(
      filters.find((filter) => filter.kinds?.includes(30402))?.ids
    ).toEqual([candle.id])
    expect(
      filters.some(
        (filter) =>
          filter.ids?.includes(soap.id) || filter["#e"]?.includes(soap.id)
      )
    ).toBe(false)
  })

  it("passes the ACK evidence boundary with carried bytes and the exact private claim despite product pruning", async () => {
    const product = productEvent("soap", "Retained soap")
    const payload = receiptFor([product], true)
    const publicReads = forbidPublicMerchandiseReads()
    const rumor = buildFutureMarketPrivateRumor(payload)
    installPrivateInboxTestRead({
      principalSecret: ORGANIZER_SECRET,
      authorSecrets: [MERCHANT_SECRET],
      rumors: [rumor],
    })
    const read = await readFutureMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
    })
    expect(read.claims).toHaveLength(1)
    let deliveryOwnershipChecks = 0
    const signer = {
      user: async () => {
        deliveryOwnershipChecks += 1
        throw new Error("Reached ACK delivery ownership check")
      },
    } as unknown as NDKSigner
    await expect(
      publishFutureMarketHandoffAck({
        organizerPubkey: ORGANIZER,
        authenticatedPubkey: ORGANIZER,
        claim: read.claims[0]!,
        physicalReleaseConfirmed: true,
        signer: plainTestSigner(signer),
        persistExactWraps: () => {},
      })
    ).rejects.toThrow("Reached ACK delivery ownership check")
    expect(deliveryOwnershipChecks).toBe(1)
    expect(publicReads()).toBe(0)
  })

  it("rejects an authenticated receipt with fabricated organizer approval before ACK signing", async () => {
    const product = productEvent("soap", "Retained soap")
    const payload = receiptFor([product], true)
    delete payload.authorityEvidence
    const publicReads = forbidPublicMerchandiseReads()
    const rumor = buildFutureMarketPrivateRumor(payload)
    installPrivateInboxTestRead({
      principalSecret: ORGANIZER_SECRET,
      authorSecrets: [MERCHANT_SECRET],
      rumors: [rumor],
    })
    const read = await readFutureMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
    })
    expect(read.claims).toHaveLength(1)
    let deliveryOwnershipChecks = 0
    const signer = {
      user: async () => {
        deliveryOwnershipChecks += 1
        throw new Error("Reached ACK delivery ownership check")
      },
    } as unknown as NDKSigner
    await expect(
      publishFutureMarketHandoffAck({
        organizerPubkey: ORGANIZER,
        authenticatedPubkey: ORGANIZER,
        claim: read.claims[0]!,
        physicalReleaseConfirmed: true,
        signer: plainTestSigner(signer),
        persistExactWraps: () => {},
      })
    ).rejects.toThrow("Original signed organizer handoff approval is required.")
    expect(deliveryOwnershipChecks).toBe(0)
    expect(publicReads()).toBe(0)
  })

  for (const defect of [
    "market-reference",
    "calendar-reference",
    "grant-reference",
    "missing-row",
    "merchant-booth",
    "closed-market",
    "wrong-calendar",
    "wrong-merchant-grant",
    "missing-parent",
    "deleted-market",
    "deleted-calendar",
    "forged-signature",
    "future-evidence",
  ] as const) {
    it(`blocks ${defect} approval before any ACK read, signing or persistence`, async () => {
      const payload = receiptFor([productEvent("soap", "Signed soap")], true)
      const bundle = payload.authorityEvidence!
      const replaceMarket = (tags: string[][]) => {
        bundle[0] = signedApproval(30409, tags)
        payload.market.eventId = bundle[0].id
      }
      if (defect === "market-reference") payload.market.eventId = "a".repeat(64)
      if (defect === "calendar-reference")
        payload.calendar.eventId = "b".repeat(64)
      if (defect === "grant-reference") payload.grant.eventId = "c".repeat(64)
      if (defect === "missing-row")
        replaceMarket(bundle[0]!.tags.filter((tag) => tag[0] !== "merchant"))
      if (defect === "merchant-booth")
        replaceMarket(
          bundle[0]!.tags.map((tag) =>
            tag[0] === "merchant"
              ? ["merchant", MERCHANT, "merchant_present", "Booth 12"]
              : tag
          )
        )
      if (defect === "closed-market")
        replaceMarket(
          bundle[0]!.tags.map((tag) =>
            tag[0] === "event_market" ? ["event_market", "2", "closed"] : tag
          )
        )
      if (defect === "wrong-calendar")
        replaceMarket(
          bundle[0]!.tags.map((tag) =>
            tag[0] === "a" ? ["a", `31923:${ORGANIZER}:other-day`] : tag
          )
        )
      if (defect === "wrong-merchant-grant") {
        bundle[2] = signedApproval(
          3841,
          bundle[2]!.tags.map((tag) =>
            tag[0] === "p" ? ["p", getPublicKey(generateSecretKey())] : tag
          )
        )
        payload.grant.eventId = bundle[2].id
      }
      if (defect === "missing-parent") {
        bundle[2] = signedApproval(3841, [
          ...bundle[2]!.tags.map((tag) =>
            tag[0] === "seq" ? ["seq", "1"] : tag
          ),
          ["auth_parent", "e".repeat(64)],
        ])
        payload.grant.eventId = bundle[2].id
      }
      if (defect === "deleted-market" || defect === "deleted-calendar")
        bundle.push(
          signedApproval(
            5,
            [["e", bundle[defect === "deleted-market" ? 0 : 1]!.id]],
            CREATED_AT + 5
          )
        )
      if (defect === "forged-signature") bundle[2]!.sig = "0".repeat(128)
      if (defect === "future-evidence") {
        bundle[2] = signedApproval(3841, bundle[2]!.tags, CREATED_AT + 100)
        payload.grant.eventId = bundle[2].id
        payload.grant.createdAt = bundle[2].created_at * 1000
      }
      expect(verifyFutureMarketReceiptAuthority(payload)).toBe(false)
      const publicReads = forbidPublicMerchandiseReads()
      let privateReads = 0
      let signatures = 0
      let persisted = 0
      __setCommerceTestOverrides({
        getAccountSigner: () => {
          privateReads++
          throw new Error("Unexpected private read")
        },
      })
      const signer = {
        sign: async () => {
          signatures++
          return ""
        },
      } as unknown as NDKSigner
      await expect(
        publishFutureMarketHandoffAck({
          organizerPubkey: ORGANIZER,
          authenticatedPubkey: ORGANIZER,
          physicalReleaseConfirmed: true,
          signer: plainTestSigner(signer),
          claim: {
            state: "ready_for_pickup",
            receipt: {
              id: "d".repeat(64),
              orderId: "",
              createdAt: CREATED_AT * 1000,
              rawContent: "",
              senderPubkey: MERCHANT,
              recipientPubkey: ORGANIZER,
              type: "future_market_ready",
              payload,
            },
          },
          persistExactWraps: () => {
            persisted++
          },
        })
      ).rejects.toThrow(
        "Original signed organizer handoff approval is required."
      )
      expect([publicReads(), privateReads, signatures, persisted]).toEqual([
        0, 0, 0, 0,
      ])
    })
  }

  it("authenticates only the original signed series membership, independent of current time and relay edits", () => {
    const payload = receiptFor([productEvent("soap", "Signed soap")], true)
    const bundle = payload.authorityEvidence!
    const masterCoordinate = `31924:${ORGANIZER}:fair-series`
    bundle[0] = signedApproval(
      30409,
      bundle[0]!.tags.map((tag) =>
        tag[0] === "a" ? ["a", masterCoordinate] : tag
      )
    )
    payload.market.eventId = bundle[0].id
    expect(verifyFutureMarketReceiptAuthority(payload)).toBe(false)
    const master = signedApproval(31924, [
      ["d", "fair-series"],
      ["title", "Fair dates"],
      ["a", payload.calendar.coordinate],
    ])
    bundle.push(master)
    expect(verifyFutureMarketReceiptAuthority(payload)).toBe(true)
    const wrongDate = signedApproval(31924, [
      ["d", "fair-series"],
      ["title", "Fair dates"],
      ["a", `31923:${ORGANIZER}:other-day`],
    ])
    bundle[bundle.length - 1] = wrongDate
    expect(verifyFutureMarketReceiptAuthority(payload)).toBe(false)
    bundle[bundle.length - 1] = master
    bundle.push(signedApproval(5, [["e", master.id]], CREATED_AT + 5))
    expect(verifyFutureMarketReceiptAuthority(payload)).toBe(false)
  })

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
      fetchSignedEventsFanoutDetailed: (async (filter, options) => {
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
        fetchSignedEventsFanoutDetailed: (async (filter, options) => {
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
          signer: plainTestSigner(signer),
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
      fetchSignedEventsFanoutDetailed: (async (_filter, options) => {
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
