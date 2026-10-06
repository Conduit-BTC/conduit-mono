import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
  isEventMarketAssignmentProductSuitable,
  parseEventMarketAssignmentEvent,
  type EventMarketAssignmentDraftInput,
} from "@conduit/core/protocol/event-market-assignment"
import { parseProductEvent } from "@conduit/core/protocol/products"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const otherSecret = generateSecretKey()
const other = getPublicKey(otherSecret)

const tuple = {
  marketCoordinate: "30409:" + organizer + ":fair-market",
  occurrenceCoordinate: "31923:" + organizer + ":fair-week-1",
  productCoordinate: "30402:" + merchant + ":soap",
}
const base: EventMarketAssignmentDraftInput = {
  ...tuple,
  merchantPubkey: merchant,
  state: "active",
  inventory: { mode: "tracked", quantity: 4 },
  fulfillmentMethods: ["pickup", "shipping"],
}

function sign(
  tags: string[][],
  secret = merchantSecret,
  content = ""
): SignedPublicNostrEvent {
  return finalizeEvent({ kind: 30410, tags, content, created_at: 100 }, secret)
}

function assignment(input: EventMarketAssignmentDraftInput = base) {
  const draft = buildEventMarketAssignmentDraft(input)
  return finalizeEvent({ ...draft, created_at: 100 }, merchantSecret)
}

function signedMutation(
  mutate: (tags: string[][]) => void,
  source: SignedPublicNostrEvent = assignment(),
  secret = merchantSecret
) {
  const tags = source.tags.map((tag) => [...tag])
  mutate(tags)
  return sign(tags, secret)
}

describe("experimental occurrence product assignment", () => {
  it("matches the frozen tuple hash vector", () => {
    expect(
      computeEventMarketAssignmentDTag({
        marketCoordinate: "30409:" + "1".repeat(64) + ":fair-market",
        occurrenceCoordinate: "31923:" + "1".repeat(64) + ":fair-week-1",
        productCoordinate: "30402:" + "2".repeat(64) + ":soap",
      })
    ).toBe("3fd6f9c22e854c3ebb1c76ea8b9538f8fa0b8a3219559d2a955f82b263b12367")
  })

  it("round trips a real signed active revision and retains hints and display tags", () => {
    const draft = buildEventMarketAssignmentDraft({
      ...base,
      relayHints: {
        market: "wss://example.com",
        product: "wss://relay.example.com",
      },
    })
    const signed = finalizeEvent(
      {
        ...draft,
        tags: [...draft.tags, ["title", "Booth soap"]],
        created_at: 100,
      },
      merchantSecret
    )
    const parsed = parseEventMarketAssignmentEvent(signed)
    expect(parsed).toMatchObject({
      eventId: signed.id,
      coordinate:
        "30410:" + merchant + ":" + computeEventMarketAssignmentDTag(tuple),
      ...tuple,
      organizerPubkey: organizer,
      merchantPubkey: merchant,
      state: "active",
      inventory: { mode: "tracked", quantity: 4 },
      fulfillmentMethods: ["pickup", "shipping"],
      relayHints: {
        market: "wss://example.com",
        product: "wss://relay.example.com",
      },
    })
    expect(parsed?.signedEvent).toEqual(signed)
  })

  it("keeps colons and Unicode in exact d values without normalization", () => {
    const withColons = {
      ...base,
      marketCoordinate: "30409:" + organizer + ":fair:market",
      occurrenceCoordinate: "31922:" + organizer + ":café:☕",
      productCoordinate: "30402:" + merchant + ":soap:lavender",
    }
    const parsed = parseEventMarketAssignmentEvent(assignment(withColons))
    expect(parsed?.occurrenceCoordinate).toBe(withColons.occurrenceCoordinate)
    expect(parsed?.productCoordinate).toBe(withColons.productCoordinate)
    expect(computeEventMarketAssignmentDTag(withColons)).not.toBe(
      computeEventMarketAssignmentDTag({
        ...withColons,
        occurrenceCoordinate: "31922:" + organizer + ":cafe\u0301:☕",
      })
    )
  })

  it("allows zero tracked remote allocation and untracked active, and enforces removal shape", () => {
    const shipping = assignment({
      ...base,
      inventory: { mode: "tracked", quantity: 0 },
      fulfillmentMethods: ["shipping"],
    })
    expect(parseEventMarketAssignmentEvent(shipping)?.inventory).toEqual({
      mode: "tracked",
      quantity: 0,
    })
    expect(
      parseEventMarketAssignmentEvent(
        assignment({
          ...base,
          inventory: { mode: "untracked" },
          fulfillmentMethods: ["digital"],
        })
      )?.state
    ).toBe("active")
    const removed = assignment({
      ...base,
      state: "removed",
      inventory: { mode: "tracked", quantity: 0 },
      fulfillmentMethods: [],
      previousEventId: shipping.id,
    })
    expect(parseEventMarketAssignmentEvent(removed)?.previousEventId).toBe(
      shipping.id
    )
    expect(() =>
      buildEventMarketAssignmentDraft({
        ...base,
        state: "removed",
        fulfillmentMethods: [],
      })
    ).toThrow()
    expect(() =>
      buildEventMarketAssignmentDraft({
        ...base,
        fulfillmentMethods: ["shipping"],
      })
    ).toThrow()
  })

  it("rejects changed signed bytes, wrong author, nonempty content and oversized envelope", () => {
    const current = assignment()
    expect(
      parseEventMarketAssignmentEvent({ ...current, content: "changed" })
    ).toBeNull()
    expect(
      parseEventMarketAssignmentEvent(sign(current.tags, otherSecret))
    ).toBeNull()
    expect(
      parseEventMarketAssignmentEvent(
        sign(current.tags, merchantSecret, "body")
      )
    ).toBeNull()
    expect(
      parseEventMarketAssignmentEvent(
        signedMutation((tags) => {
          tags.push(["title", "x".repeat(66_000)])
        })
      )
    ).toBeNull()
  })

  it("rejects malformed or duplicate contract fields in re-signed records", () => {
    const bad: Array<(tags: string[][]) => void> = [
      (tags) => {
        tags.push(["d", "0".repeat(64)])
      },
      (tags) => {
        tags[0] = ["d", "A".repeat(64)]
      },
      (tags) => {
        tags[0] = ["d", "0".repeat(64)]
      },
      (tags) => {
        tags.push(["openmarkets", "event-market-assignment", "1"])
      },
      (tags) => {
        tags[1] = ["openmarkets", "event-market-assignment", "2"]
      },
      (tags) => {
        tags[1] = ["openmarkets", "other", "1"]
      },
      (tags) => {
        tags.push(["state", "active"])
      },
      (tags) => {
        tags[5] = ["state", "paused"]
      },
      (tags) => {
        tags.push(["inventory", "untracked"])
      },
      (tags) => {
        tags[6] = ["inventory", "tracked", "04"]
      },
      (tags) => {
        tags[6] = ["inventory", "tracked", "-1"]
      },
      (tags) => {
        tags[6] = ["inventory", "tracked", "2147483648"]
      },
      (tags) => {
        tags[6] = ["inventory", "untracked", "4"]
      },
      (tags) => {
        tags.push(["fulfillment", "pickup"])
      },
      (tags) => {
        tags[7] = ["fulfillment", "courier"]
      },
      (tags) => {
        tags.push(["prev", "f".repeat(64)], ["prev", "e".repeat(64)])
      },
      (tags) => {
        tags.push(["prev", "F".repeat(64)])
      },
      (tags) => {
        tags.push(["alt", "Open Markets occurrence product assignment"])
      },
      (tags) => {
        tags[tags.length - 1] = ["alt", "other"]
      },
      (tags) => {
        tags.push(["a", tuple.productCoordinate])
      },
      (tags) => {
        tags[2] = ["a", tuple.marketCoordinate, "https://example.com"]
      },
      (tags) => {
        tags[3] = ["a", "31924:" + organizer + ":series"]
      },
      (tags) => {
        tags[3] = ["a", "31923:" + other + ":fair-week-1"]
      },
      (tags) => {
        tags[4] = ["a", "30402:" + other + ":soap"]
      },
      (tags) => {
        tags[4] = ["a", "030402:" + merchant + ":soap"]
      },
      (tags) => {
        tags[4] = ["a", "30402:" + merchant.toUpperCase() + ":soap"]
      },
    ]
    for (const mutate of bad) {
      const invalid = signedMutation(mutate)
      expect(parseEventMarketAssignmentEvent(invalid)).toBeNull()
    }
  })

  it("checks current product type, format, stock and variation parent", () => {
    const parsed = parseEventMarketAssignmentEvent(assignment())!
    const productEvent = finalizeEvent(
      {
        kind: 30402,
        tags: [
          ["d", "soap"],
          ["title", "Soap"],
          ["price", "12", "USD"],
          ["type", "simple", "physical"],
          ["stock", "4"],
        ],
        content: "Soap",
        created_at: 101,
      },
      merchantSecret
    )
    const product = parseProductEvent(productEvent)
    expect(
      isEventMarketAssignmentProductSuitable({ assignment: parsed, product })
    ).toBe(true)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: parsed,
        product: { ...product, stock: 3 },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: parsed,
        product: { ...product, type: "variable" },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: parsed,
        product: { ...product, format: "digital" },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: parsed,
        product: {
          ...product,
          type: "variation",
          parentProductId: "30402:" + merchant + ":parent",
        },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: parsed,
        product: {
          ...product,
          type: "variation",
          parentProductId: "30402:" + merchant + ":parent",
        },
        parentProduct: {
          ...product,
          id: "30402:" + merchant + ":parent",
          type: "variable",
        },
      })
    ).toBe(true)
  })
})
