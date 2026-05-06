/**
 * Unit tests for buyer checkout validation, fast-checkout eligibility,
 * LNURL helpers, and NWC URI parsing.
 */
import { describe, expect, it, mock, afterEach } from "bun:test"
import {
  validateShippingFields,
  isFastCheckoutEligible,
  type ShippingFormState,
} from "../apps/market/src/lib/checkout-validation"
import {
  fetchLnurlPayMetadata,
  fetchZapInvoice,
} from "../packages/core/src/protocol/lightning"
import { parseNwcUri } from "../packages/core/src/protocol/nwc"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validShipping(
  overrides: Partial<ShippingFormState> = {}
): ShippingFormState {
  return {
    firstName: "Alice",
    lastName: "Smith",
    street: "123 Main St",
    line2: "",
    city: "Springfield",
    state: "IL",
    postalCode: "62701",
    country: "US",
    name: "Alice Smith",
    phone: "",
    email: "",
    ...overrides,
  }
}

// ─── validateShippingFields ───────────────────────────────────────────────────

describe("validateShippingFields", () => {
  it("returns no errors for a fully valid form", () => {
    expect(validateShippingFields(validShipping())).toEqual([])
  })

  it("requires firstName", () => {
    const errors = validateShippingFields(validShipping({ firstName: "" }))
    expect(errors.some((e) => e.field === "firstName")).toBe(true)
  })

  it("rejects firstName longer than 50 chars", () => {
    const errors = validateShippingFields(
      validShipping({ firstName: "A".repeat(51) })
    )
    expect(errors.some((e) => e.field === "firstName")).toBe(true)
  })

  it("requires lastName", () => {
    const errors = validateShippingFields(validShipping({ lastName: "" }))
    expect(errors.some((e) => e.field === "lastName")).toBe(true)
  })

  it("rejects lastName longer than 50 chars", () => {
    const errors = validateShippingFields(
      validShipping({ lastName: "B".repeat(51) })
    )
    expect(errors.some((e) => e.field === "lastName")).toBe(true)
  })

  it("requires street", () => {
    const errors = validateShippingFields(validShipping({ street: "  " }))
    expect(errors.some((e) => e.field === "street")).toBe(true)
  })

  it("requires city", () => {
    const errors = validateShippingFields(validShipping({ city: "" }))
    expect(errors.some((e) => e.field === "city")).toBe(true)
  })

  it("requires postalCode", () => {
    const errors = validateShippingFields(validShipping({ postalCode: "" }))
    expect(errors.some((e) => e.field === "postalCode")).toBe(true)
  })

  it("rejects invalid country code", () => {
    const errors = validateShippingFields(validShipping({ country: "USA" }))
    expect(errors.some((e) => e.field === "country")).toBe(true)
  })

  it("accepts lowercase country code (normalised internally)", () => {
    const errors = validateShippingFields(validShipping({ country: "gb" }))
    expect(errors.some((e) => e.field === "country")).toBe(false)
  })

  it("rejects malformed email when provided", () => {
    const errors = validateShippingFields(
      validShipping({ email: "not-an-email" })
    )
    expect(errors.some((e) => e.field === "email")).toBe(true)
  })

  it("accepts valid email", () => {
    const errors = validateShippingFields(
      validShipping({ email: "alice@example.com" })
    )
    expect(errors.some((e) => e.field === "email")).toBe(false)
  })

  it("allows blank email (optional field)", () => {
    expect(validateShippingFields(validShipping({ email: "" }))).toEqual([])
  })

  it("rejects malformed phone when provided", () => {
    const errors = validateShippingFields(validShipping({ phone: "abc" }))
    expect(errors.some((e) => e.field === "phone")).toBe(true)
  })

  it("accepts valid phone", () => {
    const errors = validateShippingFields(
      validShipping({ phone: "+1 800 555-1234" })
    )
    expect(errors.some((e) => e.field === "phone")).toBe(false)
  })

  it("allows blank phone (optional field)", () => {
    expect(validateShippingFields(validShipping({ phone: "" }))).toEqual([])
  })

  it("accumulates multiple errors at once", () => {
    const errors = validateShippingFields(
      validShipping({ firstName: "", lastName: "", city: "" })
    )
    expect(errors.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── isFastCheckoutEligible ───────────────────────────────────────────────────

describe("isFastCheckoutEligible", () => {
  it("returns true when all conditions met", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
      })
    ).toBe(true)
  })

  it("returns false when wallet is not pay-capable", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: false,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when merchantLud16 is missing", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: undefined,
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when merchantLud16 is empty string", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "",
        lnurlAllowsNostr: true,
      })
    ).toBe(false)
  })

  it("returns false when LNURL does not allow Nostr", () => {
    expect(
      isFastCheckoutEligible({
        walletPayCapable: true,
        merchantLud16: "merchant@wallet.example",
        lnurlAllowsNostr: false,
      })
    ).toBe(false)
  })
})

// ─── parseNwcUri ──────────────────────────────────────────────────────────────

const FAKE_PUBKEY = "a".repeat(64)
const FAKE_SECRET = "b".repeat(64)
const VALID_NWC_URI = `nostr+walletconnect://${FAKE_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com&secret=${FAKE_SECRET}`

describe("parseNwcUri", () => {
  it("parses a valid NWC URI", () => {
    const conn = parseNwcUri(VALID_NWC_URI)
    expect(conn.walletPubkey).toBe(FAKE_PUBKEY)
    expect(conn.secret).toBe(FAKE_SECRET)
    expect(conn.relays).toEqual(["wss://relay.example.com"])
  })

  it("parses multiple relays", () => {
    const uri = `${VALID_NWC_URI}&relay=wss%3A%2F%2Frelay2.example.com`
    const conn = parseNwcUri(uri)
    expect(conn.relays.length).toBe(2)
  })

  it("parses optional lud16", () => {
    const uri = `${VALID_NWC_URI}&lud16=user%40wallet.example`
    const conn = parseNwcUri(uri)
    expect(conn.lud16).toBe("user@wallet.example")
  })

  it("throws on wrong scheme", () => {
    expect(() => parseNwcUri("https://example.com")).toThrow()
  })

  it("throws on missing secret", () => {
    const uri = `nostr+walletconnect://${FAKE_PUBKEY}?relay=wss%3A%2F%2Frelay.example.com`
    expect(() => parseNwcUri(uri)).toThrow(/secret/)
  })

  it("throws on missing relay", () => {
    const uri = `nostr+walletconnect://${FAKE_PUBKEY}?secret=${FAKE_SECRET}`
    expect(() => parseNwcUri(uri)).toThrow(/relay/)
  })

  it("throws on short pubkey", () => {
    const uri = `nostr+walletconnect://tooshort?relay=wss%3A%2F%2Fr.example.com&secret=${FAKE_SECRET}`
    expect(() => parseNwcUri(uri)).toThrow(/pubkey/)
  })
})

// ─── fetchLnurlPayMetadata ────────────────────────────────────────────────────

describe("fetchLnurlPayMetadata", () => {
  afterEach(() => {
    // restore global fetch after each test
    globalThis.fetch = originalFetch
  })

  const originalFetch = globalThis.fetch

  function mockFetch(response: unknown, ok = true) {
    globalThis.fetch = mock(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
    })) as unknown as typeof fetch
  }

  it("resolves a valid payRequest response", async () => {
    mockFetch({
      tag: "payRequest",
      callback: "https://wallet.example/lnurlp/callback",
      minSendable: 1000,
      maxSendable: 100_000_000,
      metadata: "[]",
      allowsNostr: true,
      nostrPubkey: FAKE_PUBKEY,
    })

    const result = await fetchLnurlPayMetadata("user@wallet.example")
    expect(result.callback).toBe("https://wallet.example/lnurlp/callback")
    expect(result.allowsNostr).toBe(true)
    expect(result.nostrPubkey).toBe(FAKE_PUBKEY)
    expect(result.minSendable).toBe(1000)
  })

  it("throws when tag is not payRequest", async () => {
    mockFetch({ tag: "withdrawRequest" })
    await expect(fetchLnurlPayMetadata("user@wallet.example")).rejects.toThrow(
      /LNURL-pay endpoint/
    )
  })

  it("throws on HTTP error", async () => {
    mockFetch({}, false)
    await expect(fetchLnurlPayMetadata("user@wallet.example")).rejects.toThrow()
  })

  it("throws on malformed lud16 (no @)", async () => {
    await expect(fetchLnurlPayMetadata("invalidemail")).rejects.toThrow(
      /Invalid lud16/
    )
  })

  it("sets allowsNostr false when not declared", async () => {
    mockFetch({
      tag: "payRequest",
      callback: "https://wallet.example/cb",
      minSendable: 1000,
      maxSendable: 1_000_000,
      metadata: "[]",
    })
    const result = await fetchLnurlPayMetadata("user@wallet.example")
    expect(result.allowsNostr).toBe(false)
  })
})

// ─── fetchZapInvoice ──────────────────────────────────────────────────────────

describe("fetchZapInvoice", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: unknown, ok = true) {
    globalThis.fetch = mock(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
    })) as unknown as typeof fetch
  }

  const FAKE_INVOICE = "lnbc100n1pjtest..."
  const FAKE_ZAP_REQUEST = JSON.stringify({ kind: 9734, content: "" })

  it("returns invoice on success", async () => {
    mockFetch({ pr: FAKE_INVOICE })
    const result = await fetchZapInvoice(
      "https://wallet.example/lnurlp/callback",
      100_000,
      FAKE_ZAP_REQUEST
    )
    expect(result.invoice).toBe(FAKE_INVOICE)
  })

  it("throws on LNURL ERROR status", async () => {
    mockFetch({ status: "ERROR", reason: "Amount too low" })
    await expect(
      fetchZapInvoice(
        "https://wallet.example/lnurlp/callback",
        1,
        FAKE_ZAP_REQUEST
      )
    ).rejects.toThrow(/Amount too low/)
  })

  it("throws when pr field is missing", async () => {
    mockFetch({ status: "OK" })
    await expect(
      fetchZapInvoice(
        "https://wallet.example/lnurlp/callback",
        100_000,
        FAKE_ZAP_REQUEST
      )
    ).rejects.toThrow(/BOLT11/)
  })

  it("appends amount and nostr params to callback URL", async () => {
    let capturedUrl = ""
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return { ok: true, status: 200, json: async () => ({ pr: FAKE_INVOICE }) }
    }) as unknown as typeof fetch

    await fetchZapInvoice("https://wallet.example/cb", 50_000, FAKE_ZAP_REQUEST)

    expect(capturedUrl).toContain("amount=50000")
    expect(capturedUrl).toContain("nostr=")
  })
})
