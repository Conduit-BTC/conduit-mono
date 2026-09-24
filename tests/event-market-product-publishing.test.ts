import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  buildProductListingEventDraft,
  parseEventMarketRosterEvent,
  parseProductEvent,
} from "@conduit/core"
import { setEventMarketProductAssociation } from "../apps/merchant/src/lib/event-market-product"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const marketCoordinate = `30409:${organizer}:fair-market`

function market(approved: boolean) {
  const draft = buildEventMarketRosterDraft({
    dTag: "fair-market",
    organizerPubkey: organizer,
    calendarCoordinate: `31923:${organizer}:fair`,
    state: "open",
    merchants: approved
      ? [{ pubkey: merchant, mode: "merchant_present", assignment: "Booth 12" }]
      : [],
  })
  return parseEventMarketRosterEvent(
    finalizeEvent({ ...draft, created_at: 100 }, organizerSecret)
  )!
}

function ordinaryProduct() {
  return parseProductEvent(
    finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        content: "Soap",
        tags: [
          ["d", "soap"],
          ["title", "Soap"],
          ["price", "12", "USD"],
          ["type", "simple", "physical"],
          ["shipping_option", `30406:${merchant}:postage`],
        ],
      },
      merchantSecret
    )
  )
}

describe("future Event Market product publishing", () => {
  it("adds only the market association and retains ordinary shop shipping", () => {
    const baseline = ordinaryProduct()
    const associated = setEventMarketProductAssociation({
      product: baseline,
      market: market(true),
      enabled: true,
    })
    const draft = buildProductListingEventDraft({
      product: associated,
      dTag: "soap",
    })
    expect(draft.tags).toContainEqual(["a", marketCoordinate])
    expect(draft.tags.some((tag) => tag[0] === "shipping_option")).toBe(true)
    expect(
      draft.tags.some((tag) => tag[0] === "pickup" || tag[0] === "handler")
    ).toBe(false)
    expect(associated.shippingOptionRefs).toEqual(baseline.shippingOptionRefs)
    const untagged = setEventMarketProductAssociation({
      product: associated,
      market: market(false),
      enabled: false,
    })
    expect(
      buildProductListingEventDraft({ product: untagged, dTag: "soap" }).tags
    ).not.toContainEqual(["a", marketCoordinate])
  })

  it("does not tag an unapproved merchant product", () => {
    expect(() =>
      setEventMarketProductAssociation({
        product: ordinaryProduct(),
        market: market(false),
        enabled: true,
      })
    ).toThrow("not approved")
  })
})
