import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutSparkExternalFunding } from "../apps/market/src/components/CheckoutSparkExternalFunding"
import {
  applyCheckoutSparkFundingChoice,
  resolveCheckoutSparkFundingSelection,
} from "../apps/market/src/components/checkout-spark-funding-selection"
import { performExternalInvoicePaymentAction } from "../apps/market/src/components/invoice-payment-action"
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
  preparation,
  actionResult,
}: {
  externalInvoice?: CheckoutSparkExternalFundingInvoice | null
  enabled?: boolean
  now?: () => number
  onBeforeInvoiceUse?: () => boolean
  actionResult?:
    | "qr_ready"
    | "copied"
    | "copy_failed"
    | "wallet_requested"
    | "wallet_request_failed"
    | "unavailable"
  preparation?: {
    amountSats: number
    cashAppAvailable: boolean
    disabled: boolean
    onApprove: (action: "cash_app" | "lightning" | "copy" | "qr") => void
  }
} = {}) {
  return renderToStaticMarkup(
    <CheckoutSparkExternalFunding
      externalInvoice={externalInvoice}
      enabled={enabled}
      now={now}
      onBeforeInvoiceUse={onBeforeInvoiceUse}
      preparation={preparation}
      actionResult={actionResult}
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
  it("shows the requested QR only for an already-authorized ready invoice without a mount action", () => {
    let guardCalls = 0
    const markup = renderFunding({
      actionResult: "qr_ready",
      onBeforeInvoiceUse: () => {
        guardCalls += 1
        return true
      },
    })
    expect(markup).toContain("Hide QR code")
    expect(markup).toContain("Lightning invoice</title>")
    expect(guardCalls).toBe(0)
    expectNoInvoice(renderFunding({ enabled: false, actionResult: "qr_ready" }))
  })

  it.each(["cash_app", "lightning", "copy", "qr"] as const)(
    "never performs the %s action after the current-use guard refuses",
    async (action) => {
      let browserCalls = 0
      expect(
        await performExternalInvoicePaymentAction({
          action,
          invoice: INVOICE,
          expectedAmountSats: RESERVED.amountSats,
          now: () => NOW,
          onBeforeInvoiceUse: () => false,
          browser: {
            open: () => {
              browserCalls += 1
            },
            copy: async () => {
              browserCalls += 1
            },
          },
        })
      ).toBe("unavailable")
      expect(browserCalls).toBe(0)
    }
  )

  it("rejects changed amounts and expired invoices without handing off", async () => {
    let browserCalls = 0
    for (const fixture of [
      { invoice: INVOICE, expectedAmountSats: RESERVED.amountSats - 1 },
      {
        invoice: makeSignedBolt11Fixture({ createdAt: NOW / 1_000 - 4_000 }),
        expectedAmountSats: RESERVED.amountSats,
      },
      { invoice: "invalid", expectedAmountSats: RESERVED.amountSats },
    ]) {
      expect(
        await performExternalInvoicePaymentAction({
          action: "lightning",
          ...fixture,
          now: () => NOW,
          onBeforeInvoiceUse: () => true,
          browser: {
            open: () => {
              browserCalls += 1
            },
            copy: async () => {
              browserCalls += 1
            },
          },
        })
      ).toBe("unavailable")
    }
    expect(browserCalls).toBe(0)
  })

  it("copies only the exact approved invoice and reports a browser failure without claiming payment", async () => {
    let copied = ""
    const input = {
      action: "copy" as const,
      invoice: INVOICE,
      expectedAmountSats: RESERVED.amountSats,
      now: () => NOW,
      onBeforeInvoiceUse: () => true,
      browser: {
        open: () => {
          throw new Error("Unexpected open")
        },
        copy: async (value: string) => {
          copied = value
        },
      },
    }
    expect(await performExternalInvoicePaymentAction(input)).toBe("copied")
    expect(copied).toBe(INVOICE)
    expect(
      await performExternalInvoicePaymentAction({
        ...input,
        browser: {
          ...input.browser,
          copy: async () => {
            throw new Error("Browser refused")
          },
        },
      })
    ).toBe("copy_failed")
    const markup = renderFunding({ actionResult: "wallet_requested" })
    expect(markup).toContain("If the wallet didn’t open, use the link above.")
    expect(markup).not.toContain("Payment confirmed")
  })

  it("hands the approved exact invoice to Cash App only after the current-use guard", async () => {
    const calls: string[] = []
    const result = await performExternalInvoicePaymentAction({
      action: "cash_app",
      invoice: INVOICE,
      expectedAmountSats: RESERVED.amountSats,
      now: () => NOW,
      onBeforeInvoiceUse: () => {
        calls.push("guard")
        return true
      },
      browser: {
        open: (url, target) => {
          calls.push("open")
          expect(url).toContain("https://cash.app/")
          expect(target).toBe("_blank")
        },
        copy: async () => {
          throw new Error("Unexpected copy")
        },
      },
    })
    expect(calls).toEqual(["guard", "open"])
    expect(result).toBe("wallet_requested")
  })

  it("offers named external choices before disclosure without exposing an invoice or approving on mount", () => {
    let approvals = 0
    const markup = renderFunding({
      externalInvoice: null,
      preparation: {
        amountSats: RESERVED.amountSats,
        cashAppAvailable: true,
        disabled: false,
        onApprove: () => {
          approvals += 1
        },
      },
    })
    for (const label of [
      "Pay with Cash App",
      "Open Lightning wallet",
      "Copy invoice",
      "Show QR code",
    ])
      expect(markup).toContain(label)
    expect(markup).toContain("External wallet")
    expect(markup).not.toContain(INVOICE)
    expect(markup).not.toContain('href="lightning:')
    expect(markup).not.toContain('href="https://cash.app/')
    expect(markup).not.toContain("Payment details")
    expect(approvals).toBe(0)
  })

  it("keeps all pending controls disabled during approval and omits unsupported Cash App without hiding other options", () => {
    const markup = renderFunding({
      externalInvoice: null,
      preparation: {
        amountSats: RESERVED.amountSats,
        cashAppAvailable: false,
        disabled: true,
        onApprove: () => {
          throw new Error("No mount approval")
        },
      },
    })
    expect(markup).not.toContain("Pay with Cash App")
    expect(markup.match(/disabled=""/g)).toHaveLength(3)
    expect(markup).toContain("Open Lightning wallet")
    expect(markup).not.toContain(INVOICE)
  })

  it("keeps the reserved links available after a blocked wallet handoff and treats a throwing authority guard as unavailable", async () => {
    const input = {
      action: "cash_app" as const,
      invoice: INVOICE,
      expectedAmountSats: RESERVED.amountSats,
      now: () => NOW,
      onBeforeInvoiceUse: () => true,
      browser: {
        open: () => {
          throw new Error("Browser refused")
        },
        copy: async () => {
          throw new Error("Unexpected copy")
        },
      },
    }
    expect(await performExternalInvoicePaymentAction(input)).toBe(
      "wallet_request_failed"
    )
    const markup = renderFunding({ actionResult: "wallet_request_failed" })
    expect(markup).toContain("Pay with Cash App")
    expect(markup).toContain("If the wallet didn’t open, use the link above.")
    expect(markup).toContain(`href="lightning:${INVOICE}"`)
    expect(
      await performExternalInvoicePaymentAction({
        ...input,
        onBeforeInvoiceUse: () => {
          throw new Error("Session unavailable")
        },
      })
    ).toBe("unavailable")
  })

  it.each([0, -1, Number.NaN, Infinity])(
    "omits pending funding controls for an invalid approved amount: %s",
    (amountSats) => {
      expectNoInvoice(
        renderFunding({
          externalInvoice: null,
          preparation: {
            amountSats,
            cashAppAvailable: true,
            disabled: false,
            onApprove: () => {
              throw new Error("Invalid approval")
            },
          },
        })
      )
    }
  )

  it("makes external-only funding the common payment choice without a wallet selector", () => {
    const manual = { target: { type: "manual" as const }, value: "manual" }
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: null,
        options: [manual],
        guestSession: false,
      })
    ).toEqual({ selectedOption: manual, showSelector: false })
  })

  it("keeps guests on manual funding without exposing device-wallet choices", () => {
    const manual = { target: { type: "manual" as const }, value: "manual" }
    const wallet = {
      target: {
        type: "wallet" as const,
        providerId: "spark" as const,
        walletId: "payer-fixture",
      },
      value: "wallet:spark:payer-fixture",
    }
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: wallet.target,
        options: [wallet, manual],
        guestSession: true,
      })
    ).toEqual({ selectedOption: manual, showSelector: false })
  })

  it("preselects the ready connected-wallet default without choosing manual instead", () => {
    const manual = { target: { type: "manual" as const }, value: "manual" }
    const wallet = {
      target: {
        type: "wallet" as const,
        providerId: "nwc" as const,
        walletId: "default-payer-fixture",
      },
      value: "wallet:nwc:default-payer-fixture",
    }
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: null,
        defaultTarget: wallet.target,
        options: [wallet, manual],
        guestSession: false,
      })
    ).toEqual({ selectedOption: wallet, showSelector: true })
  })

  it("preserves an explicit signed-in wallet choice alongside manual funding", () => {
    const manual = { target: { type: "manual" as const }, value: "manual" }
    const browserWallet = { target: { type: "webln" as const }, value: "webln" }
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: browserWallet.target,
        options: [browserWallet, manual],
        guestSession: false,
      })
    ).toEqual({ selectedOption: browserWallet, showSelector: true })
  })

  it("does not replace an unavailable explicit wallet with manual funding", () => {
    const manual = { target: { type: "manual" as const }, value: "manual" }
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: {
          type: "wallet",
          providerId: "spark",
          walletId: "unavailable-fixture",
        },
        options: [manual],
        guestSession: false,
      })
    ).toEqual({ selectedOption: null, showSelector: true })
  })

  it("updates a known payer choice but ignores a stale picker event without restoring a different default", () => {
    const selected = {
      type: "wallet" as const,
      providerId: "nwc" as const,
      walletId: "selected-payer-fixture",
    }
    const manual = { target: { type: "manual" as const }, value: "manual" }
    expect(
      applyCheckoutSparkFundingChoice({
        selection: selected,
        value: "manual",
        options: [manual],
      })
    ).toBe(manual.target)
    const unchanged = applyCheckoutSparkFundingChoice({
      selection: selected,
      value: "wallet:nwc:stale-picker-fixture",
      options: [manual],
    })
    expect(unchanged).toBe(selected)
    expect(
      resolveCheckoutSparkFundingSelection({
        selection: unchanged,
        defaultTarget: manual.target,
        options: [manual],
        guestSession: false,
      }).selectedOption
    ).toBeNull()
  })

  it("uses the approved common payment action for the manual choice without a second external-wallet gate", async () => {
    const source = await Bun.file("apps/market/src/routes/orders.tsx").text()
    expect(source).not.toContain('"Use external wallet"')
    expect(source).toContain(
      "const routerFundingSelection = resolveCheckoutSparkFundingSelection({"
    )
    expect(source).toContain("routerFundingSelection.showSelector")
    expect(source).toContain("setRouterTarget((selection) =>")
    expect(source).toContain("applyCheckoutSparkFundingChoice({")
    expect(source).toMatch(
      /external:\s*settledRouterControl.status === "pay_funding" &&\s*routerSelectedOption\?\.target.type === "manual"/
    )
    expect(source).toContain("confirmation.externalAction !== undefined")
    expect(source).toContain('confirmation.payerValue === "manual"')
    expect(source).toContain('option.target.type === "manual"')
    expect(source).toContain("onApprove: (externalAction) =>")
    expect(source).toContain('payerValue: "manual",')
    expect(source).toContain("performExternalInvoicePaymentAction({")
    expect(source).toContain("if (externalActionHandled) return")
    expect(source).toContain("externalActionHandled = true")
    const handoff = source.slice(
      source.indexOf("if (externalActionHandled) return"),
      source.indexOf(
        "fundingPayment: {",
        source.indexOf("if (externalActionHandled) return")
      )
    )
    const readyView = handoff.indexOf(
      "setExternalFundingInvoice({ ...invoice, authGeneration })"
    )
    expect(readyView).toBeGreaterThanOrEqual(0)
    expect(readyView).toBeLessThan(
      handoff.indexOf("performExternalInvoicePaymentAction({")
    )
    expect(source).toContain("canUseRouterExternalInvoice(invoice)")
    expect(source).toMatch(
      /cashAppAvailable:\s*settledRouterControl.network === "mainnet"/
    )
    const choices = source.slice(
      source.indexOf("const routerPayerOptions ="),
      source.indexOf("const routerTargetValue =")
    )
    expect(choices).not.toContain(
      '.filter((option) => option.target.type !== "manual")'
    )
    const reopen = source.slice(
      source.indexOf('{settledRouterControl.status === "check_funding" &&'),
      source.indexOf("<CheckoutSparkExternalFunding")
    )
    expect(reopen).toContain("!externalFundingInvoice")
    expect(reopen).toContain("Reopen external invoice")
  })

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
    expect(markup).toContain("Pay with Cash App")
    expect(markup).toContain("Open Lightning wallet")
    expect(markup).toContain("Copy invoice")
    expect(markup).toContain("Show QR code")
    expect(markup).toContain("Payment details")
    expect(markup).toContain(
      "Pay once, then return here to finish; if paused, choose Resume payment."
    )
    expect(markup).not.toContain(
      "Opening a wallet is not payment confirmation."
    )
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
