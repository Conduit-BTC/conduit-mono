import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketCalendarDraft,
  buildEventMarketRosterDraft,
  parseEventMarketCalendarEvent,
  parseEventMarketRosterEvent,
  parseProductEvent,
  buildEventMarketProductAssociationDraft,
  publishEventMarketProductAssociation,
  type EventMarketProductAssociationInput,
  type AccountSigner,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const coordinate = `30409:${organizer}:fair`
const otherMarket = `30409:${organizer}:other`

function listing(dTag = "mug", parent?: string) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "Original description and options",
      tags: [
        ["d", dTag],
        ["title", "Mug"],
        ["price", "12", "USD"],
        ["type", parent ? "variation" : "simple", "physical"],
        ["shipping_option", `30406:${merchant}:older-shipping`],
        ["stock", "8"],
        ["a", otherMarket],
        ["t", "ceramics"],
        ["external-option", "untouched"],
        ...(parent
          ? [
              ["a", parent],
              ["variation", "size", "large"],
            ]
          : []),
      ],
    },
    merchantSecret
  )
}

function harness(events = [listing()]) {
  const calendarEvent = finalizeEvent(
    {
      ...buildEventMarketCalendarDraft({
        kind: 31923,
        dTag: "date",
        title: "Fair",
        start: 1893456000,
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const rosterEvent = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        organizerPubkey: organizer,
        dTag: "fair",
        calendarCoordinate: `31923:${organizer}:date`,
        state: "open",
        merchants: [
          { pubkey: merchant, mode: "merchant_present", assignment: "Booth 1" },
        ],
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const roster = {
    coordinate,
    resolution: {
      state: "current",
      market: parseEventMarketRosterEvent(rosterEvent)!,
    },
    retained: true,
    coverage: "partial",
    calendarCoverage: "partial",
    calendar: parseEventMarketCalendarEvent(calendarEvent)!,
  }
  const published: SignedPublicNostrEvent[] = []
  const cached: SignedPublicNostrEvent[] = []
  let signatures = 0
  let reads = 0
  let saved: SignedPublicNostrEvent[] = []
  const input: EventMarketProductAssociationInput = {
    merchantPubkey: merchant,
    authenticatedPubkey: merchant,
    marketReference: coordinate,
    products: events.map((event) => ({
      coordinate: `30402:${merchant}:${event.tags.find((tag) => tag[0] === "d")![1]}`,
      eventId: event.id,
    })),
    enabled: true,
    onSignedLocal: async (value) => {
      saved = value
    },
  }
  const deps: NonNullable<
    Parameters<typeof publishEventMarketProductAssociation>[1]
  > = {
    getSigner: () =>
      ({
        getPublicKey: async () => merchant,
        signEvent: async (draft) => {
          signatures++
          return finalizeEvent(draft, merchantSecret)
        },
      }) as AccountSigner,
    waitForVisibility: async () => {},
    readProducts: async () => {
      reads++
      return {
        data: events.map((event, index) => ({
          product: parseProductEvent(event),
          addressId: input.products[index]!.coordinate,
          eventId: event.id,
          eventCreatedAt: event.created_at,
          dTag: event.tags[0]![1]!,
        })),
        meta: {} as never,
        diagnostics: input.products.map((product) => ({
          productId: product.coordinate,
          addressId: product.coordinate,
          issue: null,
          coverage: { listing: "partial", deletion: "partial" },
        })),
      }
    },
    readMarket: async () => roster as never,
    readAuthorization: async () =>
      ({ resolution: { state: "active" }, actionable: true }) as never,
    cache: async (event) => {
      cached.push(event)
      return {
        product: parseProductEvent(event),
        addressId: `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")![1]}`,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        dTag: event.tags.find((tag) => tag[0] === "d")![1]!,
      }
    },
    publish: async (event) => {
      published.push(event)
      return {
        successfulRelayUrls: ["wss://relay.example"],
        failedRelayUrls: [],
        attemptedRelayUrls: ["wss://relay.example"],
        relayFailureMessages: {},
        plan: {} as never,
      }
    },
  }
  return {
    input,
    deps,
    published,
    cached,
    roster,
    get saved() {
      return saved
    },
    get signatures() {
      return signatures
    },
    get reads() {
      return reads
    },
  }
}

describe("focused Event Market product association", () => {
  it("adds only the selected market tag with older shop shipping and unknown options intact", async () => {
    const event = listing()
    const h = harness([event])
    const result = await publishEventMarketProductAssociation(h.input, h.deps)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.content).toBe(event.content)
    expect(result.events[0]!.tags).toEqual([...event.tags, ["a", coordinate]])
    expect(h.saved).toEqual(result.events)
    expect(h.published).toEqual(h.saved)
  })
  it("removes only the selected association without requiring an active grant or shipping edit", async () => {
    const event = finalizeEvent(
      { ...listing(), tags: [...listing().tags, ["a", coordinate]] },
      merchantSecret
    )
    const h = harness([event])
    h.input.enabled = false
    h.deps.readMarket = async () => {
      throw new Error("must not read")
    }
    h.deps.readAuthorization = async () => {
      throw new Error("must not read")
    }
    const result = await publishEventMarketProductAssociation(h.input, h.deps)
    expect(result.events[0]!.tags).toEqual(
      event.tags.filter((tag) => tag[1] !== coordinate)
    )
  })
  it("associates each selected variation while preserving its parent and option tags", async () => {
    const parent = listing()
    const child = listing("mug-large", `30402:${merchant}:mug`)
    const h = harness([parent, child])
    const result = await publishEventMarketProductAssociation(h.input, h.deps)
    expect(h.signatures).toBe(2)
    expect(result.events[1]!.tags).toEqual([...child.tags, ["a", coordinate]])
  })
  it("uses a newer timestamp and removes duplicate selected tags only", () => {
    const event = finalizeEvent(
      {
        ...listing(),
        tags: [...listing().tags, ["a", coordinate], ["a", coordinate]],
      },
      merchantSecret
    )
    const draft = buildEventMarketProductAssociationDraft({
      event,
      marketCoordinate: coordinate,
      enabled: true,
      now: 90,
    })
    expect(draft.created_at).toBe(101)
    expect(draft.tags.filter((tag) => tag[1] === coordinate)).toHaveLength(1)
    expect(draft.tags).toContainEqual(["a", otherMarket])
  })
  it.each(["changed", "cached-only", "missing", "wrong-coordinate"])(
    "rejects %s listing evidence before signing",
    async (state) => {
      const h = harness()
      if (state === "wrong-coordinate")
        h.input.products[0] = {
          ...h.input.products[0]!,
          coordinate: `30402:${merchant}:different`,
        }
      const read = h.deps.readProducts!
      h.deps.readProducts = async (...args) => {
        const result = await read(...args)
        if (state === "changed") result.data[0]!.eventId = "changed"
        if (state === "cached-only")
          result.diagnostics[0]!.issue = "cached_only"
        if (state === "missing") result.data = []
        return result
      }
      await expect(
        publishEventMarketProductAssociation(h.input, h.deps)
      ).rejects.toThrow("Refresh products")
      expect(h.signatures).toBe(0)
      expect(h.published).toHaveLength(0)
    }
  )
  it.each(["revoked", "missing", "conflicting"])(
    "rejects %s grant evidence before signing",
    async (state) => {
      const h = harness()
      h.deps.readAuthorization = async () =>
        ({ resolution: { state }, actionable: false }) as never
      await expect(
        publishEventMarketProductAssociation(h.input, h.deps)
      ).rejects.toThrow("approval and grant")
      expect(h.signatures).toBe(0)
    }
  )
  it("rejects closed markets, missing merchant rows and unreadable dates", async () => {
    for (const state of ["closed", "unapproved", "missing-date"]) {
      const h = harness()
      h.deps.readMarket = async () =>
        ({
          ...h.roster,
          ...(state === "missing-date"
            ? { calendar: undefined }
            : {
                resolution: {
                  state: "current",
                  market: {
                    ...h.roster.resolution.market,
                    ...(state === "closed"
                      ? { state: "closed" }
                      : { merchants: [] }),
                  },
                },
              }),
        }) as never
      await expect(
        publishEventMarketProductAssociation(h.input, h.deps)
      ).rejects.toThrow("approval and grant")
      expect(h.signatures).toBe(0)
    }
  })
  it("rejects account switches before signing or publishing", async () => {
    const h = harness()
    h.input.shouldContinue = () => false
    await expect(
      publishEventMarketProductAssociation(h.input, h.deps)
    ).rejects.toThrow("session changed")
    expect(h.reads).toBe(0)
    expect(h.signatures).toBe(0)
  })
  it("rejects signer modification of otherwise valid signed product content", async () => {
    const h = harness()
    h.deps.getSigner = () =>
      ({
        getPublicKey: async () => merchant,
        signEvent: async (draft) =>
          finalizeEvent(
            { ...draft, content: "changed shipping instructions" },
            merchantSecret
          ),
      }) as AccountSigner
    await expect(
      publishEventMarketProductAssociation(h.input, h.deps)
    ).rejects.toThrow("invalid product association")
    expect(h.published).toHaveLength(0)
  })
  it("retries identical signed bytes after delivery failure without rereading or resigning", async () => {
    const h = harness()
    h.deps.publish = async () => {
      throw new Error("offline")
    }
    await expect(
      publishEventMarketProductAssociation(h.input, h.deps)
    ).rejects.toThrow("offline")
    expect(h.saved).toHaveLength(1)
    h.deps.publish = async (event) => {
      h.published.push(event)
      return {
        successfulRelayUrls: [],
        failedRelayUrls: [],
        attemptedRelayUrls: [],
        relayFailureMessages: {},
        plan: {} as never,
      }
    }
    await publishEventMarketProductAssociation(
      { ...h.input, savedEvents: h.saved },
      h.deps
    )
    expect(h.signatures).toBe(1)
    expect(h.reads).toBe(1)
    expect(h.published).toEqual(h.saved)
  })
  it("does not publish if saving the signed retry bundle fails", async () => {
    const h = harness()
    h.input.onSignedLocal = async () => {
      throw new Error("storage unavailable")
    }
    await expect(
      publishEventMarketProductAssociation(h.input, h.deps)
    ).rejects.toThrow("storage unavailable")
    expect(h.published).toHaveLength(0)
  })
  it("rejects saved retries for another product or the opposite action", async () => {
    for (const savedEvents of [[listing("different")], [listing()]]) {
      const h = harness()
      await expect(
        publishEventMarketProductAssociation(
          { ...h.input, savedEvents },
          h.deps
        )
      ).rejects.toThrow("Saved product association does not match")
      expect(h.signatures).toBe(0)
      expect(h.reads).toBe(0)
      expect(h.published).toHaveLength(0)
    }
  })
})
