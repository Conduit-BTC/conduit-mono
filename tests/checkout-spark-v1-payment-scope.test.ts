import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const entry = source("apps/market/src/lib/checkout-spark-settled-entry.ts")
const preparation = source(
  "apps/market/src/lib/checkout-spark-settled-preparation.ts"
)
const outgoing = source(
  "apps/market/src/lib/checkout-spark-settled-leg-preparation.ts"
)
const checkout = source("apps/market/src/routes/checkout.tsx")
const cartHud = source("apps/market/src/components/MarketCartHud.tsx")
const cart = source("apps/market/src/routes/cart.tsx")
const merchantOutgoing = source(
  "apps/merchant/src/lib/checkout-spark-settled-leg-preparation.ts"
)
const router = source(
  "packages/core/src/protocol/checkout-spark-settled-router.ts"
)

describe("Quantum Router V1 ordinary payment scope", () => {
  it("offers ordinary routed checkout without public visibility controls", () => {
    expect(checkout).not.toContain("CheckoutSparkZapVisibility")
    expect(checkout).not.toContain("routerZapSelection")
    expect(checkout).not.toContain("setRouterZapSelection")
    expect(checkout).not.toContain("anonymousPublicZap: true")
    expect(checkout).toContain("prepareCheckoutSparkSettledOrder({")
    expect(checkout).toContain("createSessionGuestOrderSigningIdentity")
    expect(checkout).toContain("const buyer = guestIdentity ?? signedIdentity")
  })

  it("keeps unrelated direct-payment public zap controls", () => {
    expect(checkout).toContain("!routerBranchTargetCheckout")
    expect(checkout).toContain('selectZapMode("anonymous_public_zap")')
    expect(checkout).toContain('selectZapMode("public_zap_as_shopper")')
  })

  it("shows ordinary cart checkout instead of arming routed public Zap Out", () => {
    expect(cartHud).toContain("isQuantumRouterEnabled,")
    expect(cartHud).toContain(
      '!isQuantumRouterEnabled() && checkoutCapability.outcome === "zap_candidate"'
    )
    expect(cartHud).toContain("armHudZapIntent")
  })

  it("keeps full-cart routed labels and actions ordinary", () => {
    expect(cart).toContain("isQuantumRouterEnabled,")
    const eligibility = cart.slice(
      cart.indexOf("const canZapOut ="),
      cart.indexOf("// Only the initial no-evidence read")
    )
    expect(eligibility).toContain("!isQuantumRouterEnabled()")
    expect(eligibility).toContain('capability.outcome === "zap_candidate"')
    expect(cart).toContain("{canZapOut ? (")
  })

  it("admits only ordinary modes before new order preparation", () => {
    const body = entry.slice(
      entry.indexOf("export async function prepareCheckoutSparkSettledOrder(")
    )
    const guard = body.indexOf("input.merchantPublicZapPolicy !== undefined")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(body.indexOf("const buyer ="))
    expect(entry).not.toContain("authorizeCheckoutSparkAnonymousZap")
    expect(entry).not.toContain("rememberCheckoutSparkPublicZapSigner")
  })

  it("keeps low-level preparation ordinary before wallet material exists", () => {
    const body = preparation.slice(
      preparation.indexOf(
        "export async function prepareCheckoutSparkSettledFunding("
      )
    )
    const guard = body.indexOf(
      "if (input.merchantPublicZapPolicy !== undefined)"
    )
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(body.indexOf("const {"))
    expect(body).toContain('mode: "private"')
    expect(body).not.toContain("freezeCheckoutSparkMerchantPublicZapPolicy")
  })

  it("keeps V1 writers ordinary without changing the historical restore path", () => {
    const writers = router.slice(
      router.indexOf("export function freezeCheckoutSparkSettledPlan("),
      router.indexOf("export function restoreCheckoutSparkSettledPlan(")
    )
    expect(
      writers.match(/assertPrivateCheckoutSparkSettledPlanInput\(input\)/g)
    ).toHaveLength(2)
    expect(writers).toContain("input.merchantPublicZapPolicy !== undefined")
    const restore = router.slice(
      router.indexOf("export function restoreCheckoutSparkSettledPlan("),
      router.indexOf(
        "export function createCheckoutSparkSettledReconciliation("
      )
    )
    expect(restore).not.toContain("assertPrivateCheckoutSparkSettledPlanInput")
    expect(restore).toContain("freezeCheckoutSparkSettledPlanInternal(")
    expect(restore).toContain(
      "merchantPublicZapPolicy: plan.merchantPublicZapPolicy"
    )
  })

  it("requests ordinary invoices while preserving exact historical attempts", () => {
    expect(outgoing).toContain("resolveCheckoutSparkLnurlInvoice")
    expect(outgoing).not.toContain("resolveCheckoutSparkPublicZapInvoice")
    expect(outgoing).not.toContain("signEvent")
    expect(outgoing).toContain("context.state.plan.merchantPublicZapPolicy")
    expect(outgoing).toContain(
      "Historical public routed payments require exact-attempt recovery."
    )
    expect(outgoing).toContain("acknowledgeRecoverySnapshot:")
    expect(router).toContain("restoreCheckoutSparkSettledPlan(")
    expect(router).toContain(
      "merchantPublicZapPolicy: plan.merchantPublicZapPolicy"
    )
    expect(router).toContain("leg.intent.publicZap && !input.intent.publicZap")
  })

  it("keeps Merchant new-invoice preparation under the same historical guard", () => {
    const resolver = merchantOutgoing.slice(
      merchantOutgoing.indexOf("async resolveInvoice(request, context)"),
      merchantOutgoing.indexOf("estimateFee: ({ paymentRequest })")
    )
    expect(resolver).toContain("context.state.plan.merchantPublicZapPolicy")
    expect(resolver).toContain('context.recipient.kind === "merchant"')
    expect(resolver).toContain(
      "Historical public routed payments require exact-attempt recovery."
    )
    expect(resolver.indexOf("throw new Error(")).toBeLessThan(
      resolver.indexOf("dependencies.resolveInvoice(request, context)")
    )
    expect(merchantOutgoing.indexOf("await retainExisting()")).toBeLessThan(
      merchantOutgoing.indexOf("async resolveInvoice(request, context)")
    )
  })
})
