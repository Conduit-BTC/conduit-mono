import { afterEach, describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  formatNpub,
  getProfiles,
  pubkeyToNpub,
} from "@conduit/core"
import { EventPickupHandlerIdentity } from "../apps/merchant/src/components/EventActorIdentity"
import {
  getEventActorDisplayName,
  groupEventActorRelayHints,
  planOrganizerEventActorProfileLookups,
} from "../apps/merchant/src/lib/event-actor-identity"

const actorPubkey = "a".repeat(64)
const otherPubkey = "b".repeat(64)

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("Merchant event actor identity", () => {
  it("prefers a hydrated profile name without changing signed provenance", () => {
    expect(
      getEventActorDisplayName(actorPubkey, {
        pubkey: actorPubkey,
        displayName: "Event organizer",
        name: "organizer",
      })
    ).toBe("Event organizer")
  })

  it("never decorates one signed actor with another profile", () => {
    expect(
      getEventActorDisplayName(actorPubkey, {
        pubkey: otherPubkey,
        displayName: "Wrong actor",
      })
    ).toBe(formatNpub(actorPubkey, 8))
  })

  it("keeps an immediate exact fallback without adding a duplicate role", () => {
    expect(getEventActorDisplayName(actorPubkey)).toBe(
      formatNpub(actorPubkey, 8)
    )
  })

  it("renders organizer handoff with friendly identity and exact provenance", () => {
    const markup = renderToStaticMarkup(
      createElement(EventPickupHandlerIdentity, {
        handoffMode: "organizer_handoff",
        handlerPubkey: actorPubkey,
        profile: { pubkey: actorPubkey, name: "Friendly organizer" },
      })
    )

    expect(markup).toContain("Organizer hands out")
    expect(markup).toContain("Friendly organizer")
    expect(markup).toContain(formatNpub(actorPubkey, 8))
    expect(markup).toContain(pubkeyToNpub(actorPubkey))
    expect(markup).toContain("Copy pickup handler npub")
  })

  it("renders merchant handoff with a safe fallback for a mismatched profile", () => {
    const markup = renderToStaticMarkup(
      createElement(EventPickupHandlerIdentity, {
        handoffMode: "merchant_handoff",
        handlerPubkey: actorPubkey,
        profile: { pubkey: otherPubkey, name: "Wrong merchant" },
      })
    )

    expect(markup).toContain("Merchant hands out")
    expect(markup).not.toContain("Wrong merchant")
    expect(markup).toContain(formatNpub(actorPubkey, 8))
    expect(markup).toContain(pubkeyToNpub(actorPubkey))
  })

  it("renders an immediate npub fallback while profile metadata is missing", () => {
    const markup = renderToStaticMarkup(
      createElement(EventPickupHandlerIdentity, {
        handoffMode: "merchant_handoff",
        handlerPubkey: actorPubkey,
      })
    )

    expect(markup).toContain("Merchant hands out")
    expect(
      markup.match(new RegExp(formatNpub(actorPubkey, 8), "g"))
    ).toHaveLength(2)
    expect(markup).toContain(pubkeyToNpub(actorPubkey))
  })

  it("groups and deduplicates source relay hints by exact actor", () => {
    expect(
      groupEventActorRelayHints([
        {
          pubkey: actorPubkey,
          relayUrls: ["wss://event-a.example", "wss://shared.example"],
        },
        {
          pubkey: actorPubkey.toUpperCase(),
          relayUrls: ["wss://shared.example", "wss://event-b.example"],
        },
        { pubkey: otherPubkey, relayUrls: ["wss://merchant.example"] },
      ])
    ).toEqual({
      [actorPubkey]: [
        "wss://event-a.example",
        "wss://shared.example",
        "wss://event-b.example",
      ],
      [otherPubkey]: ["wss://merchant.example"],
    })
  })

  it("keeps organizer event relays separate from participant profile reads", async () => {
    const organizerRelayUrls = Array.from(
      { length: 7 },
      (_, index) => `wss://event-${index + 1}.conduit.market`
    )
    const participantRelayUrl = "wss://participant-profile.conduit.market"
    const lookupPlan = planOrganizerEventActorProfileLookups({
      organizerPubkey: actorPubkey,
      participantPubkeys: [actorPubkey, otherPubkey, otherPubkey.toUpperCase()],
      organizerRelayUrls,
    })

    expect(lookupPlan).toEqual({
      organizerPubkeys: [actorPubkey],
      participantPubkeys: [otherPubkey],
      organizerRelayHintsByPubkey: {
        [actorPubkey]: organizerRelayUrls,
      },
    })

    __setRelayListTestOverrides({
      loadCached: async (pubkey) =>
        pubkey === otherPubkey
          ? {
              pubkey,
              readRelayUrls: [],
              writeRelayUrls: [participantRelayUrl],
              eventCreatedAt: 1,
              cachedAt: Date.now(),
            }
          : undefined,
    })
    const observedRelayPlans = new Map<string, string[]>()
    __setCommerceTestOverrides({
      getCachedProducts: async () => [],
      getCachedProfiles: async (pubkeys) => pubkeys.map(() => undefined),
      putCachedProfiles: async () => {},
      fetchEventsFanout: async (filter, options) => {
        const pubkey = filter.authors?.[0]
        if (!pubkey) return []
        const relayUrls = [...(options?.relayUrls ?? [])]
        observedRelayPlans.set(pubkey, relayUrls)
        if (
          pubkey === actorPubkey &&
          organizerRelayUrls.every((relayUrl) => relayUrls.includes(relayUrl))
        ) {
          return [
            {
              id: "organizer-profile",
              pubkey,
              created_at: 10,
              content: JSON.stringify({ display_name: "Event organizer" }),
              tags: [],
            } as never,
          ]
        }
        if (pubkey === otherPubkey && relayUrls.includes(participantRelayUrl)) {
          return [
            {
              id: "participant-profile",
              pubkey,
              created_at: 10,
              content: JSON.stringify({ display_name: "Event merchant" }),
              tags: [],
            } as never,
          ]
        }
        return []
      },
    })

    const organizerProfiles = await getProfiles({
      pubkeys: lookupPlan.organizerPubkeys,
      authenticatedPubkey: actorPubkey,
      relayHintsByPubkey: lookupPlan.organizerRelayHintsByPubkey,
      priority: "visible",
      skipCache: true,
      readPolicy: { maxRelays: 8 },
    })
    const participantProfiles = await getProfiles({
      pubkeys: lookupPlan.participantPubkeys,
      authenticatedPubkey: actorPubkey,
      priority: "visible",
      skipCache: true,
      readPolicy: { maxRelays: 8 },
    })

    expect(observedRelayPlans.get(actorPubkey)).toEqual(
      expect.arrayContaining(organizerRelayUrls)
    )
    expect(observedRelayPlans.get(otherPubkey)).toContain(participantRelayUrl)
    for (const relayUrl of organizerRelayUrls) {
      expect(observedRelayPlans.get(otherPubkey)).not.toContain(relayUrl)
    }
    expect(organizerProfiles.data[actorPubkey]?.displayName).toBe(
      "Event organizer"
    )
    expect(participantProfiles.data[otherPubkey]?.displayName).toBe(
      "Event merchant"
    )
  })
})
