import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { formatNpub } from "@conduit/core"
import { EventActorName } from "../apps/market/src/components/EventActorIdentity"
import {
  getEventActorIdentityView,
  selectEventHandoffIdentity,
  type EventActorIdentityView,
} from "../apps/market/src/lib/event-actor-identity"

const handlerPubkey = "a".repeat(64)
const organizerPubkey = "b".repeat(64)

describe("Market event actor identity", () => {
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
      mode: "merchant_handoff",
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
        mode: "merchant_handoff",
        handlerPubkey: organizerPubkey,
        merchant: { pubkey: handlerPubkey, identity: merchant },
        organizer: { pubkey: organizerPubkey, identity: organizer },
      }).displayName
    ).toBe(formatNpub(organizerPubkey, 8))
  })

  it("uses the shared identity treatment across shopper pickup surfaces", async () => {
    const surfaces = await Promise.all(
      [
        "apps/market/src/routes/events/$collectionRef.tsx",
        "apps/market/src/components/ResolvedProductGridCard.tsx",
        "apps/market/src/routes/products/$productId.tsx",
        "apps/market/src/routes/cart.tsx",
        "apps/market/src/routes/checkout.tsx",
        "apps/market/src/routes/orders.tsx",
      ].map((path) => Bun.file(path).text())
    )

    for (const source of surfaces) {
      expect(source).toContain("EventActorName")
      expect(source).toContain("EventActorProvenance")
    }

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
    const cart = surfaces[3]

    expect(identityComponent).toContain("<CopyButton")
    expect(identityComponent).toContain(
      "params={{ profileRef: pubkeyToNpub(pubkey) }}"
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
    expect(cart).toContain(
      "const pickupHandlerIdentity = useEventActorIdentity("
    )
    expect(root).toContain("<EventActorIdentityProvider>")

    expect(surfaces.join("\n")).not.toMatch(
      /(?:Handled by|Signed by|pickup author is).*formatNpub/
    )
  })
})
