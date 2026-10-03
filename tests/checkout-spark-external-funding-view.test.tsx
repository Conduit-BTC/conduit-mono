import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutSparkExternalFunding } from "../apps/market/src/components/CheckoutSparkExternalFunding"
import type { CheckoutSparkExternalFundingInvoice } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const INVOICE = makeSignedBolt11Fixture({ createdAt: NOW / 1_000 })
const RESERVED: CheckoutSparkExternalFundingInvoice = {
  checkoutId: "checkout-fixture",
  planDigest: "plan-fixture",
  orderId: "order-fixture",
  buyerPubkey: "a".repeat(64),
  invoice: INVOICE,
  amountSats: 40_000,
  exposedAt: NOW,
  expiresAt: NOW + 60_000,
  takeoverAt: NOW + 120_000,
}

function renderFunding({
  externalInvoice = RESERVED,
  enabled = true,
  now = () => NOW,
  onBeforeInvoiceUse = () => true,
}: {
  externalInvoice?: CheckoutSparkExternalFundingInvoice | null
  enabled?: boolean
  now?: () => number
  onBeforeInvoiceUse?: () => boolean
} = {}) {
  return renderToStaticMarkup(
    <CheckoutSparkExternalFunding
      externalInvoice={externalInvoice}
      enabled={enabled}
      now={now}
      onBeforeInvoiceUse={onBeforeInvoiceUse}
      preference={{ currency: "BITCOIN", bitcoinUnit: "sats" }}
      quote={null}
    />
  )
}

function expectNoInvoice(markup: string) {
  expect(markup).toBe("")
  for (const disclosure of [
    INVOICE,
    "lightning:",
    "https://cash.app/",
    "Open Lightning wallet",
    "Copy invoice",
    "Show QR code",
    "Payment details",
  ]) {
    expect(markup).not.toContain(disclosure)
  }
}

describe("checkout Spark external funding presentation", () => {
  it("displays only the exact reserved invoice without claiming payment", () => {
    let guardCalls = 0
    const markup = renderFunding({
      onBeforeInvoiceUse: () => {
        guardCalls += 1
        return true
      },
    })
    expect(markup).toContain(`href="lightning:${INVOICE}"`)
    expect(markup).toContain(`>${INVOICE}</p>`)
    expect(markup).toContain("40,000 sats")
    expect(markup).toContain("Copy invoice")
    expect(markup).toContain("Show QR code")
    expect(markup).toContain("Payment details")
    expect(markup).toContain("Pay this invoice only once")
    expect(markup).toContain("finish your order")
    expect(markup).toContain(
      "Your payment is checked while this order is visible"
    )
    expect(markup).toContain("if paused, choose Resume payment")
    expect(markup).toContain("Opening a wallet is not payment confirmation.")
    expect(markup).not.toContain(RESERVED.buyerPubkey)
    expect(markup).not.toContain(RESERVED.planDigest)
    expect(markup).not.toContain("Payment confirmed")
    expect(guardCalls).toBe(0)
  })

  it("hides all invoice controls when absent or disabled", () => {
    expectNoInvoice(renderFunding({ externalInvoice: null }))
    expectNoInvoice(renderFunding({ enabled: false }))
  })

  it.each([undefined, null, 0, -1, Number.NaN, Infinity, NOW + 0.5])(
    "hides an invoice without a valid reservation timestamp: %s",
    (exposedAt) => {
      expectNoInvoice(
        renderFunding({
          externalInvoice: {
            ...RESERVED,
            exposedAt: exposedAt as number,
          },
        })
      )
    }
  )

  it.each([NOW - 1, Number.NaN, Infinity, -Infinity, NOW + 0.5])(
    "hides all disclosures when the current clock is invalid or predates exposure: %s",
    (currentTime) => {
      expectNoInvoice(renderFunding({ now: () => currentTime }))
    }
  )

  it.each(["expiresAt", "takeoverAt"] as const)(
    "hides the whole subtree at and after %s, even if the other cutoff is later",
    (boundary) => {
      const externalInvoice = { ...RESERVED, [boundary]: NOW + 30_000 }
      expect(
        renderFunding({ externalInvoice, now: () => NOW + 29_999 })
      ).toContain(`href="lightning:${INVOICE}"`)
      expectNoInvoice(
        renderFunding({ externalInvoice, now: () => NOW + 30_000 })
      )
      expectNoInvoice(
        renderFunding({ externalInvoice, now: () => NOW + 30_001 })
      )
    }
  )

  it.each(["expiresAt", "takeoverAt"] as const)(
    "hides invalid or already-closed %s windows",
    (boundary) => {
      for (const value of [Number.NaN, Infinity, NOW + 0.5, NOW, NOW - 1]) {
        expectNoInvoice(
          renderFunding({ externalInvoice: { ...RESERVED, [boundary]: value } })
        )
      }
    }
  )

  it("uses boundary-driven unmounting and guards disclosure clicks before child actions", async () => {
    const source = await Bun.file(
      "apps/market/src/components/CheckoutSparkExternalFunding.tsx"
    ).text()
    expect(source).toContain("subscribeToTimeBoundaries({")
    expect(source).toContain("boundaries: [exposedAt, cutoff]")
    expect(source).toContain("onBoundary: setBoundaryNow")
    expect(source).toContain(
      "const allowed = isCurrent() && onBeforeInvoiceUse()"
    )
    expect(source).toContain("onClickCapture={(event) => {")
    expect(source).toContain("event.preventDefault()")
    expect(source).toContain("event.stopPropagation()")
    expect(source).toContain("onBeforeInvoiceUse={canUseInvoice}")
    expect(source).not.toContain("ExternalWalletPanel")
    expect(source).not.toContain("payCheckoutInvoice")
    expect(source).not.toContain("getSparkWalletManager")
    expect(source).not.toContain("fetch(")
  })

  it("revokes the exact view after a rejected guard without waiting for time or resetting in an effect", async () => {
    const source = await Bun.file(
      "apps/market/src/components/CheckoutSparkExternalFunding.tsx"
    ).text()
    expect(source).toContain("const [revokedInvoice, setRevokedInvoice]")
    expect(source).toContain("externalInvoice !== revokedInvoice")
    expect(source).toContain("if (!allowed) setRevokedInvoice(externalInvoice)")
    expect(source.match(/setRevokedInvoice\(/g)).toHaveLength(1)
    const effect = source.slice(
      source.indexOf("useEffect(() => {"),
      source.indexOf("function isCurrent()")
    )
    expect(effect).not.toContain("setRevokedInvoice")
    expect(source).not.toContain("setBoundaryNow(now())")
  })
})
