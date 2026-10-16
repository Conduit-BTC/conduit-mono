import { admitFixture } from "./helpers/public-event"
import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketRosterDraft,
  buildEventMarketAuthorizationDraft,
  buildProductListingEventDraft,
  parseEventMarketRosterEvent,
  resolveEventMarketAuthorization,
  parseProductEvent,
} from "@conduit/core"
import { setEventMarketProductAssociation } from "../apps/merchant/src/lib/event-market-product"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const marketCoordinate = `30409:${organizer}:fair-market`

async function market(approved: boolean) {
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
    await admitFixture(
      finalizeEvent({ ...draft, created_at: 100 }, organizerSecret)
    )
  )!
}

async function ordinaryProduct() {
  return parseProductEvent(
    await admitFixture(
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
  )
}

async function activeAuthorization() {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state: "active",
    sequence: 0,
    parentIds: [],
  })
  const signed = await admitFixture(
    finalizeEvent({ ...draft, created_at: 101 }, organizerSecret)
  )
  return {
    marketCoordinate,
    merchantPubkey: merchant,
    resolution: resolveEventMarketAuthorization({
      marketCoordinate,
      merchantPubkey: merchant,
      transitions: [signed],
    }),
    coverage: "complete" as const,
    retained: true,
    actionable: true,
    observedEvidence: [signed],
  }
}

describe("future Event Market product publishing", () => {
  it("adds only the market association and retains ordinary shop shipping", async () => {
    const baseline = await ordinaryProduct()
    const associated = setEventMarketProductAssociation({
      product: baseline,
      market: await market(true),
      authorization: await activeAuthorization(),
      enabled: true,
      authorizationActive: true,
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
      market: await market(false),
      enabled: false,
    })
    expect(
      buildProductListingEventDraft({ product: untagged, dTag: "soap" }).tags
    ).not.toContainEqual(["a", marketCoordinate])
  })

  it("does not tag an unapproved merchant product", async () => {
    await expect(
      (async () =>
        setEventMarketProductAssociation({
          product: await ordinaryProduct(),
          market: await market(false),
          enabled: true,
          authorizationActive: true,
        }))()
    ).rejects.toThrow("not approved")
    await expect(
      (async () =>
        setEventMarketProductAssociation({
          product: await ordinaryProduct(),
          market: await market(true),
          enabled: true,
        }))()
    ).rejects.toThrow("organizer-signed merchant grant")
  })

  it("requires a current merchant grant before a new association", async () => {
    await expect(
      (async () =>
        setEventMarketProductAssociation({
          product: await ordinaryProduct(),
          market: await market(true),
          enabled: true,
        }))()
    ).rejects.toThrow("organizer-signed merchant grant")
  })
})
