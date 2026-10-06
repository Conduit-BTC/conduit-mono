import { describe, expect, it } from "bun:test"
import type { CommerceProductRecord, CommerceResult } from "@conduit/core"
import {
  getBrowseBackgroundHydrationPubkeys,
  getPagedMerchantPubkeys,
  getProductSourceRelayHintsByPubkey,
  mergeRelayHintsByPubkey,
  normalizeRelayHints,
  splitMerchantHydrationTargets,
} from "../apps/market/src/lib/clientHydration"

function productRecord(
  pubkey: string,
  sourceRelayUrls: string[]
): CommerceProductRecord {
  return {
    eventId: `event-${pubkey}`,
    addressId: `30402:${pubkey}:item`,
    dTag: "item",
    eventCreatedAt: 1,
    sourceRelayUrls,
    product: {
      id: `30402:${pubkey}:item`,
      pubkey,
      title: "Item",
      price: 1,
      currency: "SAT",
      type: "simple",
      visibility: "public",
      images: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

function productResult(
  records: CommerceProductRecord[]
): CommerceResult<CommerceProductRecord[]> {
  return {
    data: records,
    meta: {
      source: "public",
      query: "marketplace_products",
      capabilities: [],
    },
  }
}

describe("client hydration helpers", () => {
  it("normalizes, dedupes, and caps relay hints", () => {
    expect(
      normalizeRelayHints([
        "Relay.Example.com/",
        "https://relay.example.com",
        "not a relay",
        "wss://second.example",
        "wss://third.example",
      ])
    ).toEqual([
      "wss://relay.example.com",
      "wss://second.example",
      "wss://third.example",
    ])

    expect(
      normalizeRelayHints(
        ["wss://one.example", "wss://two.example", "wss://three.example"],
        2
      )
    ).toEqual(["wss://one.example", "wss://two.example"])
  })

  it("merges product source relays by merchant pubkey", () => {
    const hints = getProductSourceRelayHintsByPubkey(
      productResult([
        productRecord("merchant-a", [
          "wss://first.example",
          "wss://shared.example",
        ]),
      ]),
      productResult([
        productRecord("merchant-a", [
          "wss://shared.example",
          "https://second.example",
        ]),
        productRecord("merchant-b", ["relay-b.example"]),
      ])
    )

    expect(hints).toEqual({
      "merchant-a": [
        "wss://first.example",
        "wss://shared.example",
        "wss://second.example",
      ],
      "merchant-b": ["wss://relay-b.example"],
    })
  })

  it("merges explicit hint maps with the same relay rules", () => {
    expect(
      mergeRelayHintsByPubkey(
        { alice: ["Relay.Example.com", "wss://second.example"] },
        { alice: ["wss://second.example", "wss://third.example"] }
      )
    ).toEqual({
      alice: [
        "wss://relay.example.com",
        "wss://second.example",
        "wss://third.example",
      ],
    })
  })

  it("splits visible and background merchant hydration targets", () => {
    expect(
      splitMerchantHydrationTargets({
        allMerchantPubkeys: ["a", "b", "a", "c"],
        visibleMerchantPubkeys: ["b", "b"],
      })
    ).toEqual({
      visibleMerchantPubkeys: ["b"],
      backgroundMerchantPubkeys: ["a", "c"],
    })
  })

  it("requests off-screen merchant profiles only for active browse surfaces", () => {
    const input = {
      menuMerchantPubkeys: ["menu", "menu"],
      selectedMerchantPubkeys: ["selected"],
      searchMerchantPubkeys: ["visible", "menu"],
      isSearching: false,
      storeMenuOpen: false,
    }

    expect(getBrowseBackgroundHydrationPubkeys(input)).toEqual(["selected"])
    expect(
      getBrowseBackgroundHydrationPubkeys({ ...input, storeMenuOpen: true })
    ).toEqual(["menu", "selected"])
    expect(
      getBrowseBackgroundHydrationPubkeys({ ...input, isSearching: true })
    ).toEqual(["visible", "menu", "selected"])
    expect(
      getBrowseBackgroundHydrationPubkeys({
        ...input,
        isSearching: true,
        storeMenuOpen: true,
        menuMerchantPubkeys: ["new-menu"],
      })
    ).toEqual(["visible", "menu", "new-menu", "selected"])
  })

  it("keeps merchant profile targets to visible rows plus one next page", () => {
    const pubkeys = Array.from(
      { length: 80 },
      (_, index) => `merchant-${index}`
    )
    expect(getPagedMerchantPubkeys(pubkeys, 12)).toEqual(pubkeys.slice(0, 24))
    expect(getPagedMerchantPubkeys(pubkeys, 24)).toEqual(pubkeys.slice(0, 36))
    expect(getPagedMerchantPubkeys(["a", "a", "b", "c"], 1, 1)).toEqual([
      "a",
      "b",
    ])
  })
})
