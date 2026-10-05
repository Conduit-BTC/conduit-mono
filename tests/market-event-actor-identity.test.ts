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
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { EventActorName } from "../apps/market/src/components/EventActorIdentity"
import {
  getEventActorIdentityView,
  normalizeEventActorPubkey,
  selectEventHandoffIdentity,
  type EventActorIdentityView,
} from "../apps/market/src/lib/event-actor-identity"

const signedFixture = createEventMarketOrderFixture()
const handlerPubkey = signedFixture.merchant
const organizerPubkey = signedFixture.organizer

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("Market event actor identity", () => {
  it("matches an uppercase organizer reference to its lowercase profile", () => {
    const organizer = organizerPubkey.toUpperCase()
    expect(
      getEventActorIdentityView({
        pubkey: organizer,
        profile: { pubkey: organizerPubkey, displayName: "Event organizer" },
      })
    ).toEqual({ displayName: "Event organizer" })
    expect(pubkeyToNpub(organizer)).toBe(pubkeyToNpub(organizerPubkey))
  })

  it("hydrates both order actors through a strict lowercase profile read", async () => {
    const organizer = organizerPubkey.toUpperCase()
    const pubkeys = [handlerPubkey, normalizeEventActorPubkey(organizer)]
    const authorFilters: string[][] = []
    __setRelayListTestOverrides({
      loadCached: async (pubkey) => ({
        pubkey,
        readRelayUrls: [],
        writeRelayUrls: ["wss://profiles.conduit.market"],
        eventCreatedAt: 1,
        cachedAt: Date.now(),
      }),
    })
    __setCommerceTestOverrides({
      getCachedProducts: async () => [],
      getCachedProfiles: async (keys) => keys.map(() => undefined),
      putCachedProfiles: async () => {},
      fetchPublicEvents: async (filter) => {
        const authors = filter.authors ?? []
        authorFilters.push([...authors])
        if (authors.some((key) => !/^[0-9a-f]{64}$/.test(key))) return []
        return [handlerPubkey, organizerPubkey]
          .filter((key) => authors.includes(key))
          .map((pubkey) => ({
            id: pubkey,
            pubkey,
            created_at: 10,
            kind: 0,
            content: JSON.stringify({
              display_name:
                pubkey === handlerPubkey ? "Pickup handler" : "Event organizer",
            }),
            tags: [],
          })) as never
      },
    })

    const profiles = await getProfiles({ pubkeys, skipCache: true })
    expect(authorFilters.length).toBeGreaterThan(0)
    for (const authors of authorFilters) {
      expect(authors).toEqual(pubkeys)
    }
    for (const [pubkey, name] of [
      [handlerPubkey, "Pickup handler"],
      [organizer, "Event organizer"],
    ]) {
      const identity = getEventActorIdentityView({
        pubkey,
        profile: profiles.data[normalizeEventActorPubkey(pubkey)],
      })
      expect(
        renderToStaticMarkup(createElement(EventActorName, { identity }))
      ).toContain(name)
      expect(pubkeyToNpub(pubkey)).toBe(
        pubkeyToNpub(normalizeEventActorPubkey(pubkey))
      )
    }
    expect(organizer).toBe(organizerPubkey.toUpperCase())

    const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()
    expect(orders).toContain('pickup.mode === "organizer_handoff"')
    expect(orders).toContain("pickup.organizerPubkey")
    expect(orders).toContain("pickup.merchantPubkey")
    expect(orders).toContain(
      "profile: eventActorProfiles.data[normalizeEventActorPubkey(pubkey)]"
    )
    expect(orders).not.toContain("<EventActorProvenance")
  })

  it("prefers a hydrated profile name without changing the signed pubkey", () => {
    expect(
      getEventActorIdentityView({
        pubkey: handlerPubkey,
        profile: {
          pubkey: handlerPubkey,
          displayName: "Staci",
          name: "staci",
        },
      })
    ).toEqual({ displayName: "Staci" })
  })

  it("uses the shortened exact npub when profile metadata is unavailable", () => {
    expect(
      getEventActorIdentityView({
        pubkey: handlerPubkey,
      })
    ).toEqual({
      displayName: formatNpub(handlerPubkey, 8),
    })
  })

  it("does not label the signed handler with another account's metadata", () => {
    expect(
      getEventActorIdentityView({
        pubkey: handlerPubkey,
        profile: { pubkey: organizerPubkey, displayName: "Organizer" },
      })
    ).toEqual({ displayName: formatNpub(handlerPubkey, 8) })
  })

  it("selects and renders the exact handler identity for both handoff modes", () => {
    const merchant: EventActorIdentityView = {
      displayName: "Staci",
    }
    const organizer: EventActorIdentityView = {
      displayName: "Bowser",
    }

    const merchantHandoff = selectEventHandoffIdentity({
      mode: "merchant_present",
      handlerPubkey,
      merchant: { pubkey: handlerPubkey, identity: merchant },
      organizer: { pubkey: organizerPubkey, identity: organizer },
    })
    const organizerHandoff = selectEventHandoffIdentity({
      mode: "organizer_handoff",
      handlerPubkey: organizerPubkey,
      merchant: { pubkey: handlerPubkey, identity: merchant },
      organizer: { pubkey: organizerPubkey, identity: organizer },
    })

    expect(
      renderToStaticMarkup(
        createElement(EventActorName, { identity: merchantHandoff })
      )
    ).toContain("Staci")
    expect(
      renderToStaticMarkup(
        createElement(EventActorName, { identity: organizerHandoff })
      )
    ).toContain("Bowser")

    expect(
      selectEventHandoffIdentity({
        mode: "merchant_present",
        handlerPubkey: organizerPubkey,
        merchant: { pubkey: handlerPubkey, identity: merchant },
        organizer: { pubkey: organizerPubkey, identity: organizer },
      }).displayName
    ).toBe(formatNpub(organizerPubkey, 8))
  })

  it("uses the shared identity treatment across shopper pickup surfaces", async () => {
    const surfaces = await Promise.all(
      [
        "apps/market/src/routes/products/$productId.tsx",
        "apps/market/src/routes/checkout.tsx",
        "apps/market/src/routes/orders.tsx",
      ].map((path) => Bun.file(path).text())
    )
    for (const source of surfaces) expect(source).toContain("EventActorName")
    expect(surfaces[0]).toContain("EventActorProvenance")
    for (const source of surfaces.slice(1))
      expect(source).not.toContain("EventActorProvenance")
    const eventPage = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    expect(eventPage).toContain(
      "getMerchantDisplayName(organizerProfile, organizerPubkey"
    )
    const cart = await Bun.file("apps/market/src/routes/cart.tsx").text()
    expect(cart).toContain("getMerchantDisplayName(profile, merchantPubkey)")
    expect(cart).toContain(
      "navigator.clipboard.writeText(pubkeyToNpub(merchantPubkey))"
    )

    const identityComponent = await Bun.file(
      "apps/market/src/components/EventActorIdentity.tsx"
    ).text()
    const identityHook = await Bun.file(
      "apps/market/src/hooks/useEventActorIdentity.ts"
    ).text()
    const identityModel = await Bun.file(
      "apps/market/src/lib/event-actor-identity.ts"
    ).text()
    const root = await Bun.file("apps/market/src/routes/__root.tsx").text()

    expect(identityComponent).toContain("<CopyButton")
    expect(identityComponent).toContain(
      "params={{ identityRef: pubkeyToNpub(pubkey) }}"
    )
    expect(identityComponent).toContain("{formatNpub(pubkey, 8)}")
    expect(identityComponent).toContain("<CopyButton value={pubkey}")
    expect(identityHook).toContain("useProfiles(pubkeys")
    expect(identityHook).toContain(
      'session.mode === "signed_in" ? session.pubkey : null'
    )
    expect(identityHook).toContain("authenticatedPubkey: accountPubkey")
    expect(identityHook).toContain(
      "shouldContinue: () => authGenerationRef.current === authGeneration"
    )
    expect(identityHook).toContain("useLayoutEffect(() => {")
    expect(identityHook).toContain(
      "enabled: session.relaySettingsReady && pubkeys.length > 0"
    )
    expect(identityHook).not.toContain("useProfile(")
    expect(identityHook).toContain(
      "useEventActorIdentity must be used within EventActorIdentityProvider"
    )
    expect(identityModel).not.toContain("lookupSettled")
    expect(identityModel).not.toContain("fallbackPrefix")
    expect(identityModel).not.toContain("getEventActorProvenance")
    expect(cart).not.toContain("pickupHandlerPubkeys")
    expect(cart).not.toContain("pickupHandlerIdentity={")
    expect(surfaces[1]).toContain(
      "const pickupHandlerIdentity = useEventActorIdentity("
    )
    expect(root).toContain("<EventActorIdentityProvider>")

    expect(surfaces.join("\n")).not.toMatch(
      /(?:Handled by|Signed by|pickup author is).*formatNpub/
    )
  })
})
