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
  futureMarketReadyReceiptSchema,
  orderEventMarketPickupFulfillmentSchema,
  pubkeyToNpub,
} from "@conduit/core"
import {
  EventActorName,
  EventActorProvenance,
  EventPickupHandlerIdentity,
} from "../apps/merchant/src/components/EventActorIdentity"
import {
  getEventActorDisplayName,
  getOrganizerEventParticipantPubkeys,
  groupEventActorRelayHints,
  normalizeEventActorPubkey,
} from "../apps/merchant/src/lib/event-actor-identity"

const actorPubkey = "a".repeat(64)
const otherPubkey = "b".repeat(64)
const orderOrganizerPubkey = "ab".repeat(32)
const receiptMerchantPubkey = "cd".repeat(32)

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("Merchant event actor identity", () => {
  it("binds actor-profile reads to explicit live account authority", async () => {
    for (const name of [
      "FutureEventMarketManager",
      "FutureEventMerchantParticipation",
    ]) {
      const source = await Bun.file(
        `apps/merchant/src/components/${name}.tsx`
      ).text()
      const profileRead = source.slice(
        source.indexOf("useProfiles("),
        source.indexOf("useProfiles(") + 500
      )
      expect(profileRead).toContain("accountPubkey")
      expect(profileRead).toContain("authenticatedPubkey")
      expect(profileRead).toContain("shouldContinue")
      expect(profileRead).toContain("isAuthGenerationCurrent(authGeneration)")
      expect(profileRead).not.toMatch(
        /authenticatedPubkey:\s*(merchantPubkey|organizerPubkey|market\.)/
      )
    }
    const [manager, queue] = await Promise.all([
      Bun.file(
        "apps/merchant/src/components/FutureEventMarketManager.tsx"
      ).text(),
      Bun.file(
        "apps/merchant/src/components/FutureOrganizerClaimQueue.tsx"
      ).text(),
    ])
    expect(manager).toMatch(
      /<FutureOrganizerClaimQueue[\s\S]{0,180}organizerPubkey=\{accountPubkey\}/
    )
    expect(queue).toMatch(
      /accountPubkey === organizerPubkey &&\s+pubkey === organizerPubkey &&\s+signerReadiness === "ready"/
    )
    expect(queue).not.toMatch(/authenticatedPubkey:\s*receipt\.merchantPubkey/)
  })

  it("uses exact seller profiles for signs without borrowing organizer relay hints", async () => {
    const manager = await Bun.file(
      "apps/merchant/src/components/FutureEventMarketManager.tsx"
    ).text()
    const profileRead = manager.slice(
      manager.indexOf("const profiles = useProfiles("),
      manager.indexOf("const sheets =")
    )
    expect(profileRead).not.toContain("relayHints")
    expect(manager).toContain("profiles: profiles.data")
    const signage = await Bun.file(
      "apps/merchant/src/lib/event-signage.ts"
    ).text()
    expect(signage).toContain("candidateProfile?.pubkey === row.pubkey")
  })

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

  it("keeps same-name organizer profiles distinguishable by exact npub", () => {
    const sharedName = "Same organizer name"
    const first = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(EventActorName, {
          pubkey: actorPubkey,
          profile: { pubkey: actorPubkey, name: sharedName },
        }),
        createElement(EventActorProvenance, {
          pubkey: actorPubkey,
          copyLabel: "Copy organizer npub",
        })
      )
    )
    const second = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(EventActorName, {
          pubkey: otherPubkey,
          profile: { pubkey: otherPubkey, name: sharedName },
        }),
        createElement(EventActorProvenance, {
          pubkey: otherPubkey,
          copyLabel: "Copy organizer npub",
        })
      )
    )

    expect(first).toContain(sharedName)
    expect(second).toContain(sharedName)
    expect(first).toContain(pubkeyToNpub(actorPubkey))
    expect(second).toContain(pubkeyToNpub(otherPubkey))
    expect(first).not.toContain(pubkeyToNpub(otherPubkey))
    expect(second).not.toContain(pubkeyToNpub(actorPubkey))
  })

  it("keeps compact organizer provenance in host and merchant views", async () => {
    for (const name of [
      "FutureEventMarketManager",
      "FutureEventMerchantParticipation",
    ]) {
      const source = await Bun.file(
        `apps/merchant/src/components/${name}.tsx`
      ).text()
      expect(source).toContain("EventActorProvenance")
      expect(source).toContain('copyLabel="Copy organizer npub"')
      expect(source).toContain("market.organizerPubkey")
    }
  })

  it("renders organizer handoff with friendly identity and exact provenance", () => {
    const markup = renderToStaticMarkup(
      createElement(EventPickupHandlerIdentity, {
        mode: "organizer_handoff",
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
        mode: "merchant_present",
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
        mode: "merchant_present",
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

  it.each([
    [
      "order organizer",
      orderEventMarketPickupFulfillmentSchema.shape.organizerPubkey,
      orderOrganizerPubkey,
    ],
    [
      "receipt merchant",
      futureMarketReadyReceiptSchema.shape.merchantPubkey,
      receiptMerchantPubkey,
    ],
  ] as const)(
    "normalizes a schema-valid uppercase %s without changing provenance",
    (_role, schema, pubkey) => {
      const embeddedActor = schema.parse(pubkey.toUpperCase())
      expect(normalizeEventActorPubkey(embeddedActor)).toBe(pubkey)
      expect(pubkeyToNpub(embeddedActor)).toBe(pubkeyToNpub(pubkey))
    }
  )

  it("keeps organizer event relays separate from participant profile reads", async () => {
    const organizerRelayUrls = Array.from(
      { length: 7 },
      (_, index) => `wss://event-${index + 1}.conduit.market`
    )
    const participantRelayUrl = "wss://participant-profile.conduit.market"
    const participantPubkeys = getOrganizerEventParticipantPubkeys({
      organizerPubkey: actorPubkey,
      participantPubkeys: [actorPubkey, otherPubkey, otherPubkey.toUpperCase()],
    })

    expect(participantPubkeys).toEqual([otherPubkey])

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
      fetchPublicEvents: async (filter, options) => {
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
      pubkeys: [actorPubkey],
      authenticatedPubkey: actorPubkey,
      relayHintsByPubkey: {
        [actorPubkey]: organizerRelayUrls,
      },
      priority: "visible",
      skipCache: true,
      readPolicy: { maxRelays: 8 },
    })
    const participantProfiles = await getProfiles({
      pubkeys: participantPubkeys,
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
