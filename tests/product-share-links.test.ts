import { describe, expect, it } from "bun:test"
import {
  buildMarketProductShareUrl,
  decodeProductReference,
  encodeProductNaddr,
  isConduitMarketOrigin,
} from "@conduit/core"

const MERCHANT_PUBKEY = "a".repeat(64)
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:summer/tea:large`

describe("product share links", () => {
  it("round-trips the complete product coordinate through naddr", () => {
    const naddr = encodeProductNaddr(PRODUCT_ADDRESS)

    expect(naddr.startsWith("naddr1")).toBe(true)
    expect(decodeProductReference(naddr)).toEqual({
      kind: 30402,
      authorPubkey: MERCHANT_PUBKEY,
      dTag: "summer/tea:large",
      addressId: PRODUCT_ADDRESS,
    })
  })

  it("preserves literal percent sequences before URI-decoding fallback", () => {
    const literalPercentAddress = `30402:${MERCHANT_PUBKEY}:offer%2Fblue`
    const naddr = encodeProductNaddr(literalPercentAddress)
    const url = buildMarketProductShareUrl(
      "https://shop.conduit.market",
      literalPercentAddress
    )

    expect(decodeProductReference(literalPercentAddress)?.addressId).toBe(
      literalPercentAddress
    )
    expect(decodeProductReference(naddr)?.addressId).toBe(literalPercentAddress)
    expect(
      decodeProductReference(new URL(url).pathname.replace("/products/", ""))
        ?.addressId
    ).toBe(literalPercentAddress)
  })

  it("accepts URI-encoded coordinates and existing naddr input", () => {
    const encodedAddress = encodeURIComponent(PRODUCT_ADDRESS)
    const naddr = encodeProductNaddr(PRODUCT_ADDRESS)

    expect(decodeProductReference(encodedAddress)?.addressId).toBe(
      PRODUCT_ADDRESS
    )
    expect(decodeProductReference(naddr)?.addressId).toBe(PRODUCT_ADDRESS)

    const url = new URL(
      buildMarketProductShareUrl("https://shop.conduit.market", encodedAddress)
    )
    expect(url.origin).toBe("https://shop.conduit.market")
    expect(url.pathname.startsWith("/products/naddr1")).toBe(true)
    expect(url.search).toBe("")
    expect(url.hash).toBe("")
  })

  it("preserves line terminators in raw, encoded, and naddr references", () => {
    for (const lineTerminator of ["\n", "\r", "\u2028", "\u2029"]) {
      const addressId = `30402:${MERCHANT_PUBKEY}:line${lineTerminator}break`
      const naddr = encodeProductNaddr(addressId)

      for (const reference of [
        addressId,
        encodeURIComponent(addressId),
        naddr,
      ]) {
        expect(decodeProductReference(reference)?.addressId).toBe(addressId)
      }
    }
  })

  it("enforces the NIP-19 identifier byte limit without truncation", () => {
    const acceptedDTags = ["a".repeat(255), `${"é".repeat(127)}a`]
    const rejectedDTags = ["a".repeat(256), "é".repeat(128)]

    for (const dTag of acceptedDTags) {
      const addressId = `30402:${MERCHANT_PUBKEY}:${dTag}`
      expect(new TextEncoder().encode(dTag)).toHaveLength(255)
      expect(
        decodeProductReference(encodeProductNaddr(addressId))
      ).toMatchObject({ dTag, addressId })
    }

    for (const dTag of rejectedDTags) {
      const addressId = `30402:${MERCHANT_PUBKEY}:${dTag}`
      expect(new TextEncoder().encode(dTag)).toHaveLength(256)
      expect(() => encodeProductNaddr(addressId)).toThrow(
        "Product identifier must not exceed 255 UTF-8 bytes."
      )
    }
  })

  it("accepts production, preview, signet, and forwarded local Market origins", () => {
    for (const origin of [
      "https://shop.conduit.market",
      "https://share-links.conduit-market-coo.pages.dev",
      "https://share-links.conduit-market-signet.pages.dev",
      "http://127.0.0.1:7000",
      "http://mybox.tailnet.ts.net:7000",
    ]) {
      expect(isConduitMarketOrigin(origin)).toBe(true)
      expect(buildMarketProductShareUrl(origin, PRODUCT_ADDRESS)).toStartWith(
        `${origin}/products/naddr1`
      )
    }
  })

  it("rejects unsafe origins and malformed product references", () => {
    const credentialOrigin = new URL("https://shop.conduit.market")
    credentialOrigin.username = "user"
    credentialOrigin.password = "password"

    for (const origin of [
      "https://attacker.example",
      "https://shop.conduit.market.attacker.example",
      "https://sell.conduit.market",
      credentialOrigin.toString(),
      "https://shop.conduit.market/path",
      "https://shop.conduit.market?source=unsafe",
      "https://shop.conduit.market#unsafe",
    ]) {
      expect(isConduitMarketOrigin(origin)).toBe(false)
      expect(() => buildMarketProductShareUrl(origin, PRODUCT_ADDRESS)).toThrow(
        "safe Market origin"
      )
    }

    for (const reference of [
      `30403:${MERCHANT_PUBKEY}:summer-tea`,
      "30402:short:summer-tea",
      `30402:${"g".repeat(64)}:summer-tea`,
      `30402:${MERCHANT_PUBKEY}:`,
      `30402%3A${MERCHANT_PUBKEY}%3Aitem%ZZ`,
      "naddr1notvalid",
    ]) {
      expect(decodeProductReference(reference)).toBeNull()
    }
  })
})
