import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { formatNpub, pubkeyToNpub } from "@conduit/core"
import { EventActorName } from "../apps/market/src/components/EventActorIdentity"
import {
  getEventActorIdentityView,
  getEventActorProvenance,
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
        lookupSettled: true,
        fallbackPrefix: "Pickup handler",
      })
    ).toEqual({ displayName: "Staci", status: "resolved" })
  })

  it("uses the exact identity fallback while profile lookup is pending", () => {
    expect(
      getEventActorIdentityView({
        pubkey: handlerPubkey,
        lookupSettled: false,
        fallbackPrefix: "Pickup handler",
      })
    ).toEqual({
      displayName: `Pickup handler ${formatNpub(handlerPubkey, 8)}`,
      status: "pending",
    })
  })

  it("keeps the shortened npub fallback after an empty lookup settles", () => {
    expect(
      getEventActorIdentityView({
        pubkey: handlerPubkey,
        lookupSettled: true,
        fallbackPrefix: "Pickup handler",
      })
    ).toEqual({
      displayName: `Pickup handler ${formatNpub(handlerPubkey, 8)}`,
      status: "fallback",
    })
  })

  it("selects and renders the exact handler identity for both handoff modes", () => {
    const merchant: EventActorIdentityView = {
      displayName: "Staci",
      status: "resolved",
    }
    const organizer: EventActorIdentityView = {
      displayName: "Bowser",
      status: "resolved",
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

  it("keeps exact npub profile and copy provenance behind the friendly name", () => {
    for (const pubkey of [handlerPubkey, organizerPubkey]) {
      const provenance = getEventActorProvenance(pubkey)

      expect(provenance.displayNpub).toBe(formatNpub(pubkey, 8))
      expect(provenance.profileRef).toBe(pubkeyToNpub(pubkey))
      expect(pubkeyToNpub(provenance.copyValue)).toBe(pubkeyToNpub(pubkey))
    }
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
    const root = await Bun.file("apps/market/src/routes/__root.tsx").text()

    expect(identityComponent).toContain("<CopyButton")
    expect(identityHook).toContain("useProfiles(pubkeys")
    expect(identityHook).toContain("enabled: !!pubkey && !batch")
    expect(root).toContain("<EventActorIdentityProvider>")

    expect(surfaces.join("\n")).not.toMatch(
      /(?:Handled by|Signed by|pickup author is).*formatNpub/
    )
  })
})
