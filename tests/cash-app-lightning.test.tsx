import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  type BtcUsdRateQuote,
} from "@conduit/core"
import { config } from "../packages/core/src/config"
import { InvoicePayment } from "../apps/market/src/components/InvoicePayment"
import { getCashAppLightningUrl } from "../apps/market/src/lib/cash-app-lightning"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const previousNetwork = config.lightningNetwork
const NOW_SECONDS = 1_800_000_000

function invoice({
  hrp = "lnbc400u",
  createdAt = NOW_SECONDS,
  paymentHash = true,
}: {
  hrp?: string
  createdAt?: number
  paymentHash?: boolean
} = {}) {
  return makeBolt11Fixture({
    hrp,
    createdAt,
    fields: [
      ...(paymentHash ? [bolt11PaymentHashField()] : []),
      bolt11PlainDescriptionField("Cash App checkout fixture"),
    ],
  })
}

beforeEach(() => {
  config.lightningNetwork = "mainnet"
})

afterEach(() => {
  config.lightningNetwork = previousNetwork
})

describe("Cash App Lightning handoff", () => {
  it("hands off the normalized invoice without another amount or payment request", () => {
    const bolt11 = invoice()
    expect(
      getCashAppLightningUrl(`  LIGHTNING:${bolt11}  `, 40_000, NOW_SECONDS)
    ).toBe(`https://cash.app/launch/lightning/${bolt11}`)
    expect(
      getCashAppLightningUrl(bolt11.toUpperCase(), 40_000, NOW_SECONDS)
    ).toBe(`https://cash.app/launch/lightning/${bolt11.toUpperCase()}`)
  })

  it("requires mainnet and the configured payment network", () => {
    for (const hrp of ["lntb400u", "lntbs400u", "lnbcrt400u"]) {
      expect(
        getCashAppLightningUrl(invoice({ hrp }), 40_000, NOW_SECONDS)
      ).toBeNull()
    }
    config.lightningNetwork = "mock"
    expect(getCashAppLightningUrl(invoice(), 40_000, NOW_SECONDS)).toBeNull()
  })

  it("rejects malformed, amountless, mismatched, expired, and unbound invoices", () => {
    const bolt11 = invoice()
    const corrupted = `${bolt11.slice(0, -1)}${bolt11.endsWith("q") ? "p" : "q"}`
    for (const invalid of [
      "lnbc1not-an-invoice",
      corrupted,
      invoice({ hrp: "lnbc" }),
      invoice({ paymentHash: false }),
      invoice({ createdAt: NOW_SECONDS - 3600 }),
    ]) {
      expect(getCashAppLightningUrl(invalid, 40_000, NOW_SECONDS)).toBeNull()
    }
    for (const expected of [null, 0, -1, 40_001, Number.NaN, Infinity]) {
      expect(getCashAppLightningUrl(bolt11, expected, NOW_SECONDS)).toBeNull()
    }
    expect(
      getCashAppLightningUrl(bolt11, 40_000, NOW_SECONDS + 3599)
    ).not.toBeNull()
    expect(
      getCashAppLightningUrl(bolt11, 40_000, NOW_SECONDS + 3600)
    ).toBeNull()
  })
})

describe("buyer invoice presentation", () => {
  function renderPayment({
    quote = { rate: 120_000, fetchedAt: Date.now(), source: "mempool" },
    guestSession = true,
    onBeforeInvoiceUse = () => true,
    bolt11 = invoice({ createdAt: Math.floor(Date.now() / 1000) }),
  }: {
    quote?: BtcUsdRateQuote | null
    guestSession?: boolean
    onBeforeInvoiceUse?: () => boolean
    bolt11?: string
  } = {}) {
    return renderToStaticMarkup(
      <InvoicePayment
        invoice={bolt11}
        expectedAmountSats={40_000}
        preference={{ currency: "BITCOIN", bitcoinUnit: "sats" }}
        quote={quote}
        guestSession={guestSession}
        onBeforeInvoiceUse={onBeforeInvoiceUse}
      />
    )
  }

  it("shows guests an estimated dollar amount and retains exact sats in details", () => {
    const markup = renderPayment()
    expect(markup).toContain("Estimated payment")
    expect(markup).toContain("$48.00")
    expect(markup).toContain("Invoice amount: 40,000 sats")
    expect(markup).toContain("Payment details")
    expect(markup).toContain("available for eligible accounts")
  })

  it("falls back to exact sats when the quote is missing or stale", () => {
    for (const quote of [
      null,
      {
        rate: 120_000,
        fetchedAt: Date.now() - DEFAULT_PRICING_RATE_MAX_AGE_MS - 60_000,
        source: "mempool" as const,
      },
    ]) {
      const markup = renderPayment({ quote })
      expect(markup).toContain("Amount to pay")
      expect(markup).toContain("40,000 sats")
      expect(markup).not.toContain("Estimated payment")
      expect(markup).not.toContain("$48.00")
    }
  })

  it("respects a signed-in shopper's explicit sats preference", () => {
    const markup = renderPayment({ guestSession: false })
    expect(markup).toContain("Amount to pay")
    expect(markup).toContain("40,000 sats")
    expect(markup).not.toContain("$48.00")
  })

  it("renders one shared invoice QR and branded guarded links without starting payment", () => {
    const bolt11 = invoice({ createdAt: Math.floor(Date.now() / 1000) })
    let guardCalls = 0
    const markup = renderPayment({
      bolt11: ` lightning:${bolt11} `,
      onBeforeInvoiceUse: () => {
        guardCalls += 1
        return true
      },
    })
    expect(markup.split("<title>Lightning invoice</title>").length - 1).toBe(1)
    expect(markup).toContain(
      `href="https://cash.app/launch/lightning/${bolt11}"`
    )
    expect(markup).toContain(`href="lightning:${bolt11}"`)
    expect(markup).toContain('referrerPolicy="no-referrer"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain("Pay with Cash App")
    expect(markup).toContain("var(--cash-app-green)")
    expect(markup).toContain("Copy invoice")
    expect(markup).toContain("Cash App didn’t open?")
    expect(guardCalls).toBe(0)
  })

  it("keeps the general wallet fallback without Cash App branding for ineligible invoices", () => {
    const markup = renderPayment({ bolt11: invoice({ hrp: "lntb400u" }) })
    expect(markup).toContain("Open Lightning wallet")
    expect(markup).toContain("Copy invoice")
    expect(markup).not.toContain("Pay with Cash App")
    expect(markup).not.toContain("https://cash.app/")
  })
})
