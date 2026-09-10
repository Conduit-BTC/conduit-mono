import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { formatNpub, pubkeyToNpub } from "@conduit/core"
import { EventPickupHandlerIdentity } from "../apps/merchant/src/components/EventActorIdentity"
import {
  getEventActorDisplayName,
  groupEventActorRelayHints,
} from "../apps/merchant/src/lib/event-actor-identity"

const actorPubkey = "a".repeat(64)
const otherPubkey = "b".repeat(64)

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
})
