import { describe, expect, it } from "bun:test"
import { pubkeyToNpub } from "@conduit/core"
import { parseEventCatalogSearch } from "../apps/market/src/lib/event-catalog-search"

const MERCHANT_PUBKEY = "a".repeat(64)

describe("event catalog route search", () => {
  it("canonicalizes hex and npub merchant filters as portable npubs", () => {
    expect(
      parseEventCatalogSearch({ merchant: MERCHANT_PUBKEY.toUpperCase() })
    ).toEqual({ merchant: pubkeyToNpub(MERCHANT_PUBKEY) })
    expect(
      parseEventCatalogSearch({ merchant: pubkeyToNpub(MERCHANT_PUBKEY) })
    ).toEqual({ merchant: pubkeyToNpub(MERCHANT_PUBKEY) })
  })

  it("drops malformed merchant filters", () => {
    expect(parseEventCatalogSearch({ merchant: "not-a-pubkey" })).toEqual({})
    expect(parseEventCatalogSearch({ merchant: [MERCHANT_PUBKEY] })).toEqual({})
  })
})
