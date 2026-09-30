import { describe, expect, it } from "bun:test"
import {
  buildMarketCheckoutBuyUrl,
  buildMarketCheckoutCartUrl,
  encodeProductNaddr,
  normalizeCheckoutSourceDomain,
  parseCheckoutIntentFragment,
  resolveCheckoutAttribution,
  resolveCheckoutPartnerDomain,
  type CheckoutPartnerRegistration,
} from "@conduit/core"

const product = encodeProductNaddr(`30402:${"a".repeat(64)}:source-test`)
const cart = JSON.stringify({ v: 1, items: [{ product, quantity: 2 }] })
// Assertion diagnostics contain only attribution and content-free purchase checks.
const sourceEvidence = (
  result: ReturnType<typeof parseCheckoutIntentFragment>
) =>
  result.status === "valid"
    ? {
        status: result.status,
        source: result.intent.source,
        quantities: result.intent.items.map((item) => item.quantity),
        exactProduct: result.intent.items.every(
          (item) => item.product === product
        ),
      }
    : { status: result.status }
const registry: CheckoutPartnerRegistration[] = [
  {
    code: "project_a",
    account: "public-project-a",
    active: true,
    domains: ["example.co.uk", "project.github.io"],
  },
]

describe("public checkout source domains", () => {
  it.each([
    [" Foo.Example.CO.UK. ", "example.co.uk"],
    ["user123.example.com", "example.com"],
    ["shop.project.github.io", "project.github.io"],
    ["user123.project.pages.dev", "project.pages.dev"],
    ["shop.project.vercel.app", "project.vercel.app"],
    ["a.bucket.s3.amazonaws.com", "bucket.s3.amazonaws.com"],
    ["a.b.ck", "a.b.ck"], // PSL wildcard
    ["x.www.ck", "www.ck"], // PSL exception
    ["www.bücher.de", "xn--bcher-kva.de"],
    ["WWW.XN--BCHER-KVA.DE", "xn--bcher-kva.de"],
    ["www.食狮.com.cn", "xn--85x722f.com.cn"],
    ["shop。example.com", "example.com"],
  ])("normalizes public suffix and IDNA input", (input, expected) => {
    expect(normalizeCheckoutSourceDomain(input)).toBe(expected)
    expect(normalizeCheckoutSourceDomain(expected)).toBe(expected)
  })

  it.each([
    "https://example.com",
    "https://example.com/path",
    "//example.com",
    "example.com/",
    "example.com/path",
    "user:pass@example.com",
    "user@example.com",
    "example.com:443",
    "example.com?token=x",
    "example.com#token=x",
    "example.com\\path",
    "example%2ecom",
    "example..com",
    ".example.com",
    "example.com..",
    "bad_label.com",
    "-bad.com",
    "bad-.com",
    "xn--.com",
    "bad\nexample.com",
    "127.0.0.1",
    "192.168.1.1",
    "10.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "[::1]",
    "::1",
    "2001:db8::1",
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "localhost",
    "shop.localhost",
    "printer.local",
    "project.test",
    "project.invalid",
    "router.internal",
    "shop.home.arpa",
    "x.onion",
    "x.alt",
    "x.example",
    "intranet",
    "project.corp",
    "com",
    "co.uk",
    "github.io",
    "pages.dev",
    "vercel.app",
    "s3.amazonaws.com",
    "a".repeat(64) + ".com",
    "x".repeat(513),
    "",
  ])("rejects non-public or URL-shaped input", (input) => {
    expect(normalizeCheckoutSourceDomain(input)).toBeNull()
  })

  it("accepts unregistered buy and cart sources without changing quantities", () => {
    for (const fields of [{ buy: product, qty: "3" }, { cart }]) {
      const result = parseCheckoutIntentFragment(
        new URLSearchParams({
          ...fields,
          source: "user123.example.com",
        }).toString()
      )
      expect(sourceEvidence(result)).toEqual({
        status: "valid",
        source: { domain: "example.com", method: "claimed" },
        quantities: ["buy" in fields ? 3 : 2],
        exactProduct: true,
      })
    }
    const buy = buildMarketCheckoutBuyUrl(
      "https://shop.conduit.market",
      product,
      1,
      undefined,
      "www.bücher.de"
    )
    const cartUrl = buildMarketCheckoutCartUrl(
      "https://shop.conduit.market",
      [{ product, quantity: 2 }],
      undefined,
      "foo.example.co.uk"
    )
    expect(new URL(buy).hash.includes("xn--bcher-kva.de")).toBe(true)
    expect(
      sourceEvidence(parseCheckoutIntentFragment(new URL(cartUrl).hash))
    ).toMatchObject({
      status: "valid",
      source: { domain: "example.co.uk", method: "claimed" },
      exactProduct: true,
    })
    expect(() =>
      buildMarketCheckoutBuyUrl(
        "https://shop.conduit.market",
        product,
        1,
        undefined,
        "https://example.com/path"
      )
    ).toThrow()
  })

  it("observes referrer only when source is absent and ignores malformed explicit sources", () => {
    const referrer =
      "https://shop.project.github.io/private?token=secret#fragment"
    expect(
      sourceEvidence(parseCheckoutIntentFragment(`buy=${product}`, referrer))
    ).toMatchObject({
      status: "valid",
      source: { domain: "project.github.io", method: "referrer" },
    })
    expect(
      sourceEvidence(
        parseCheckoutIntentFragment(
          `buy=${product}&source=example.com`,
          referrer
        )
      )
    ).toMatchObject({
      status: "valid",
      source: { domain: "example.com", method: "claimed" },
    })
    for (const source of [
      "",
      "%ZZ",
      "https%3A%2F%2Fexample.com%2Fpath",
      "127.0.0.1",
      "example.com&source=another.com",
    ]) {
      const result = parseCheckoutIntentFragment(
        `buy=${product}&source=${source}`,
        referrer
      )
      expect(result.status).toBe("valid")
      if (result.status === "valid")
        expect(result.intent.source).toBeUndefined()
    }
    const credentialReferrer = new URL("https://example.com/private")
    credentialReferrer.username = crypto.randomUUID()
    credentialReferrer.password = crypto.randomUUID()
    for (const referrer of [
      "",
      "file:///private",
      "http://localhost/path",
      credentialReferrer.toString(),
    ]) {
      const result = parseCheckoutIntentFragment(`buy=${product}`, referrer)
      expect(result.status).toBe("valid")
      if (result.status === "valid")
        expect(result.intent.source).toBeUndefined()
    }
  })

  it("maps only a unique reviewed active domain and retains legacy partner links", () => {
    expect(
      resolveCheckoutAttribution(
        {
          source: { domain: "example.co.uk", method: "claimed" },
          partner: "other_code",
        },
        registry
      )
    ).toEqual({
      sourceDomain: "example.co.uk",
      sourceMethod: "claimed",
      partnerCode: "project_a",
    })
    expect(
      resolveCheckoutAttribution({ partner: "project_a" }, registry)
    ).toEqual({ sourceMethod: "partner", partnerCode: "project_a" })
    expect(
      resolveCheckoutAttribution(
        {
          source: { domain: "unknown.com", method: "referrer" },
          partner: "project_a",
        },
        registry
      )
    ).toEqual({ sourceDomain: "unknown.com", sourceMethod: "referrer" })
    expect(
      resolveCheckoutPartnerDomain("example.co.uk", [
        { ...registry[0]!, active: false },
      ])
    ).toBeNull()
    expect(
      resolveCheckoutPartnerDomain("example.co.uk", [
        ...registry,
        {
          code: "project_b",
          account: "public-b",
          active: true,
          domains: ["example.co.uk"],
        },
      ])
    ).toBeNull()
    expect(resolveCheckoutPartnerDomain("github.io", registry)).toBeNull()
    expect(resolveCheckoutPartnerDomain("other.github.io", registry)).toBeNull()
    expect(
      resolveCheckoutPartnerDomain("example.co.uk", [
        { ...registry[0]!, domains: ["www.example.co.uk"] },
      ])
    ).toBeNull()
  })
})
