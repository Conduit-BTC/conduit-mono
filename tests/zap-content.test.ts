import { describe, expect, it } from "bun:test"
import { nip19 } from "nostr-tools"

import {
  buildProductZapTargetTags,
  buildZapRequestContent,
  countZapContentCodePoints,
  getProductZapNaddr,
  parseZapRequestContent,
  truncateZapNoteInput,
  validateAnonZapRequestDraft,
  ZAP_NOTE_MAX_CODE_POINTS,
  ZAP_REQUEST_CONTENT_MAX_CODE_POINTS,
} from "../packages/core/src/protocol"

const MERCHANT_PUBKEY = "A".repeat(64)
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:sick-shirt`
const CANONICAL_PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY.toLowerCase()}:sick-shirt`

describe("product zap request content", () => {
  it("composes and parses a shopper note with a deterministic product naddr", () => {
    const naddr = getProductZapNaddr(PRODUCT_ADDRESS)
    const content = buildZapRequestContent({
      note: "sick shirt 🔥",
      productAddress: PRODUCT_ADDRESS,
    })

    expect(content).toBe(`sick shirt 🔥\n\nnostr:${naddr}`)
    expect(parseZapRequestContent(content, PRODUCT_ADDRESS)).toEqual({
      note: "sick shirt 🔥",
      productAddress: CANONICAL_PRODUCT_ADDRESS,
      productNaddr: naddr,
    })
    expect(nip19.decode(naddr)).toMatchObject({
      type: "naddr",
      data: {
        kind: 30402,
        pubkey: MERCHANT_PUBKEY.toLowerCase(),
        identifier: "sick-shirt",
        relays: [],
      },
    })
  })

  it("uses only the naddr when the shopper note is empty", () => {
    const naddr = getProductZapNaddr(PRODUCT_ADDRESS)
    const content = buildZapRequestContent({
      note: " \r\n\t ",
      productAddress: PRODUCT_ADDRESS,
    })

    expect(content).toBe(`nostr:${naddr}`)
    expect(parseZapRequestContent(content, PRODUCT_ADDRESS)).toEqual({
      note: "",
      productAddress: CANONICAL_PRODUCT_ADDRESS,
      productNaddr: naddr,
    })
  })

  it("keeps empty merchant-only content empty", () => {
    expect(buildZapRequestContent({ note: " \r\n\t " })).toBe("")
    expect(parseZapRequestContent("")).toEqual({
      note: "",
      productAddress: null,
      productNaddr: null,
    })
  })

  it("normalizes line endings and tabs without collapsing internal text or NFC-normalizing", () => {
    const decomposed = "e\u0301"
    const normalized = truncateZapNoteInput(
      ` \t${decomposed}  first\r\nsecond\r🔥\tlast \n `,
      280
    )

    expect(normalized).toBe(`${decomposed}  first\nsecond\n🔥 last`)
    expect(normalized).not.toContain("é")
  })

  it("caps un-targeted content at 280 Unicode code points", () => {
    const atLimit = "a".repeat(280)
    const overLimit = `${atLimit}b`

    expect(buildZapRequestContent({ note: atLimit })).toBe(atLimit)
    expect(buildZapRequestContent({ note: overLimit })).toBe(atLimit)
    expect(countZapContentCodePoints(atLimit)).toBe(ZAP_NOTE_MAX_CODE_POINTS)
  })

  it("preserves the complete note budget alongside the product suffix", () => {
    const content = buildZapRequestContent({
      note: `${"a".repeat(ZAP_NOTE_MAX_CODE_POINTS)}b`,
      productAddress: PRODUCT_ADDRESS,
    })
    const parsed = parseZapRequestContent(content, PRODUCT_ADDRESS)

    expect(parsed.note).toBe("a".repeat(ZAP_NOTE_MAX_CODE_POINTS))
    expect(parsed.productAddress).toBe(CANONICAL_PRODUCT_ADDRESS)
    expect(countZapContentCodePoints(content)).toBeGreaterThan(
      ZAP_NOTE_MAX_CODE_POINTS
    )
    expect(countZapContentCodePoints(content)).toBeLessThanOrEqual(
      ZAP_REQUEST_CONTENT_MAX_CODE_POINTS
    )
  })

  it("never splits a surrogate pair at the code-point boundary", () => {
    const note = `${"a".repeat(279)}🔥b`
    const truncated = buildZapRequestContent({ note })

    expect(countZapContentCodePoints(truncated)).toBe(280)
    expect(truncated).toBe(`${"a".repeat(279)}🔥`)
    expect(truncated.endsWith("\ud83d")).toBe(false)
  })

  it("is idempotent for already-composed matching content", () => {
    const first = buildZapRequestContent({
      note: "sick shirt 🔥",
      productAddress: PRODUCT_ADDRESS,
    })
    const second = buildZapRequestContent({
      note: first,
      productAddress: PRODUCT_ADDRESS,
    })

    expect(second).toBe(first)
  })

  it("does not associate a suffix with a different expected product", () => {
    const content = buildZapRequestContent({
      note: "sick shirt 🔥",
      productAddress: PRODUCT_ADDRESS,
    })

    expect(
      parseZapRequestContent(
        content,
        `30402:${MERCHANT_PUBKEY}:different-shirt`
      )
    ).toEqual({
      note: content,
      productAddress: null,
      productNaddr: null,
    })
  })

  it("builds only canonical a and k target tags", () => {
    expect(buildProductZapTargetTags(PRODUCT_ADDRESS)).toEqual([
      ["a", CANONICAL_PRODUCT_ADDRESS],
      ["k", "30402"],
    ])
  })

  it("fails explicitly for invalid or unrepresentable product references", () => {
    const invalidAddresses = [
      `1:${MERCHANT_PUBKEY}:sick-shirt`,
      "30402:not-a-pubkey:sick-shirt",
      `30402:${MERCHANT_PUBKEY}:`,
      `30402:${MERCHANT_PUBKEY}:bad\nidentifier`,
      `30402:${MERCHANT_PUBKEY}:bad\ud800identifier`,
      `30402:${MERCHANT_PUBKEY}:${"🔥".repeat(64)}`,
    ]

    for (const productAddress of invalidAddresses) {
      expect(() => getProductZapNaddr(productAddress)).toThrow()
      expect(() =>
        buildZapRequestContent({ note: "hello", productAddress })
      ).toThrow()
      expect(() => buildProductZapTargetTags(productAddress)).toThrow()
    }
  })

  it("retains the 280-point note budget for long interoperable product identifiers", () => {
    for (const identifierLength of [128, 255]) {
      const productAddress = `30402:${MERCHANT_PUBKEY}:${"a".repeat(identifierLength)}`
      const content = buildZapRequestContent({
        note: "n".repeat(281),
        productAddress,
      })
      const parsed = parseZapRequestContent(content, productAddress)

      expect(parsed.note).toBe("n".repeat(ZAP_NOTE_MAX_CODE_POINTS))
      expect(parsed.productAddress).toBe(productAddress.toLowerCase())
      expect(countZapContentCodePoints(content)).toBeLessThanOrEqual(
        ZAP_REQUEST_CONTENT_MAX_CODE_POINTS
      )
    }
  })
})

describe("anonymous zap request content validation", () => {
  function draft(content: string, extraTags: string[][] = []) {
    return {
      kind: 9734,
      createdAt: 1_800_000_000,
      content,
      tags: [
        ["p", MERCHANT_PUBKEY.toLowerCase()],
        ["amount", "21000"],
        ["lnurl", "lnurl1test"],
        ["relays", "wss://relay.example"],
        ...extraTags,
      ],
    }
  }

  it("counts emoji as one code point at the shared 280-point boundary", () => {
    expect(validateAnonZapRequestDraft(draft("🔥".repeat(280)))).toEqual({
      ok: true,
    })
    expect(validateAnonZapRequestDraft(draft("🔥".repeat(281)))).toEqual({
      ok: false,
      reason: "Public zap comment is too long.",
    })
  })

  it("continues to reject product targeting tags in the anonymous flow", () => {
    expect(
      validateAnonZapRequestDraft(
        draft("anonymous", buildProductZapTargetTags(PRODUCT_ADDRESS))
      )
    ).toEqual({ ok: false, reason: "Zap request contains private tags." })
  })
})
