import { describe, expect, it } from "bun:test"
import {
  getCheckoutOrderPaymentTarget,
  getCheckoutPaymentTargetOptions,
} from "../apps/market/src/lib/checkout-payment-target"

const checkout = await Bun.file("apps/market/src/routes/checkout.tsx").text()
const orders = await Bun.file("apps/market/src/routes/orders.tsx").text()

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe("settled router guest UI contracts", () => {
  it("admits guests through an enabled same-merchant SAT supported router target", () => {
    const target = section(
      checkout,
      "const routerBranchTargetCheckout =",
      "const paymentRequired ="
    )
    expect(target).toContain("isQuantumRouterEnabled()")
    expect(target).toContain("isCheckoutSparkSettledCart(rawCheckoutItems)")
    expect(target).toContain("!verifiedZeroCostPickup")
    expect(target).not.toContain("!isGuestCheckout")
    expect(checkout).not.toContain("canUseCheckoutSparkLocalRouterCanary()")
    expect(orders).not.toContain("canUseCheckoutSparkLocalRouterCanary()")
  })

  it("composes hosted pricing and approval without a local test destination claim", () => {
    expect(checkout).not.toContain("configured test fee destination")
    expect(checkout).not.toContain("local router rehearsal")
    expect(checkout).toContain("<CheckoutCoordinationSummary")
    expect(checkout).toContain("price={routerPrice}")
    expect(checkout).toContain("<CheckoutSparkNativeTreasuryNotice")
    expect(checkout).toContain("fixedCheckoutTotalSats={routerPrice.totalSats}")
  })

  it("uses one same-tab order identity and structured private guest contact", () => {
    const preparation = section(
      checkout,
      "async function prepareSettledRouterOrder()",
      "async function placeOrder()"
    )
    expect(preparation).toContain("validateCheckoutDetailsForSubmit()")
    expect(preparation).toContain("const guestContact = buildGuestContact()")
    expect(preparation).toContain(
      "createSessionGuestOrderSigningIdentity(orderId, selectedMerchant)"
    )
    expect(preparation).toContain(
      "const buyer = guestIdentity ?? signedIdentity"
    )
    expect(preparation).toContain(
      "getSessionGuestOrderSigningIdentity(orderId)"
    )
    expect(preparation).toContain(
      "isCurrentGuestOrderSigningIdentity(currentGuestIdentity"
    )
    expect(preparation).toContain(
      "currentGuestIdentity.createdAt === guestIdentity.createdAt"
    )
    expect(preparation).toContain(
      "currentGuestIdentity.expiresAt === guestIdentity.expiresAt"
    )
    expect(preparation).toContain("note: submittedNote")
    expect(preparation).toMatch(
      /const submittedNote = isGuestCheckout\s*\? buildBuyerNote\(\)\s*: buildContactNote\(\)/
    )
    expect(
      preparation.indexOf("const shippingAddress = buildShippingAddress()")
    ).toBeLessThan(preparation.indexOf("await assertCheckoutItemsAvailable("))
    expect(preparation.indexOf("const submittedNote =")).toBeLessThan(
      preparation.indexOf("await assertCheckoutItemsAvailable(")
    )
    expect(preparation).toContain("guestContact,")
    expect(preparation).toMatch(
      /relayAuthMethod: guestIdentity\s*\? undefined\s*: \(authMethod \?\? undefined\)/
    )
    expect(preparation).not.toContain("authenticatedPubkey:")
  })

  it("hides legacy guest send and signer actions beside router preparation", () => {
    const actions = checkout.slice(checkout.indexOf("{/* Action buttons */}"))
    expect(actions).toMatch(
      /\{!routerBranchTargetCheckout\s*&&\s*isGuestCheckout\s*&&\s*!fastEligible\s*&&\s*manualInvoiceEligible\s*&&/
    )
    expect(actions).toMatch(
      /\{!routerBranchTargetCheckout\s*&&\s*isGuestCheckout\s*&&\s*!fastEligible\s*&&\s*\(verifiedZeroCostPickup\s*\?/
    )
    expect(actions).toContain("Continue to payment")
    expect(actions).toContain(
      "onClick={() => void prepareSettledRouterOrder()}"
    )
    expect(actions).toContain("Connect signer to send order")
    expect(actions).toContain("onClick={() => void payNow()}")
    expect(actions).toContain("onClick={placeOrder}")
  })

  it("clears contact after acceptance but retains the guest key for ambiguous recovery", () => {
    const preparation = section(
      checkout,
      "async function prepareSettledRouterOrder()",
      "async function placeOrder()"
    )
    expect(
      preparation.indexOf("clearCheckoutShippingSession()")
    ).toBeGreaterThan(preparation.indexOf("published = true"))
    expect(
      preparation.match(/clearSessionGuestOrderSigningIdentity\(/g)
    ).toHaveLength(1)
    const safeFailure = section(
      preparation,
      "canRetryCheckoutSparkSettledPreparation({",
      "setError("
    )
    expect(safeFailure).toContain("recoveryState,")
    expect(safeFailure).toContain(
      "clearSessionGuestOrderSigningIdentity(orderId)"
    )
    expect(preparation).toContain("paymentInFlightRef.current")
    expect(preparation).toContain("routerPreparedOrderRef.current = orderId")
  })

  it("revalidates the guest generation and exact same-tab identity for every router action", () => {
    const identity = section(
      orders,
      "function getCurrentRouterGuestIdentity()",
      "const actionsReady ="
    )
    expect(identity).toContain("isGuestGenerationCurrent(authGeneration)")
    expect(identity).toContain(
      "isCurrentGuestOrderSigningIdentity(currentIdentity"
    )
    expect(identity).toContain(
      "currentIdentity.pubkey !== guestIdentity.pubkey"
    )
    expect(identity).toContain(
      "currentIdentity.createdAt !== guestIdentity.createdAt"
    )
    expect(identity).toContain(
      "currentIdentity.expiresAt !== guestIdentity.expiresAt"
    )
    expect(identity).toContain("orderId: vm.orderId")
    expect(identity).toContain("merchantPubkey: row.merchantPubkey")
    expect(identity).toContain("pubkey: buyerPubkey")
    expect(identity).toContain(
      "getSessionGuestOrderSigningIdentity(vm.orderId)"
    )
    const continuation = section(
      orders,
      "async function continueSettledRouterCheckout(",
      "function buildServiceCtx()"
    )
    expect(continuation).toContain(
      "currentGuestIdentity?.signer ?? getAccountSigner()"
    )
    expect(continuation).toContain("guestIdentity: currentGuestIdentity")
    expect(continuation).toContain(
      "currentGuestIdentity: getCurrentRouterGuestIdentity"
    )
    expect(continuation).toContain("identity: currentGuestIdentity ?? {")
    expect(continuation).toContain("shouldContinue: approvedSessionIsCurrent")
    expect(continuation).toContain(
      "approvalGeneration === routerApprovalGenerationRef.current"
    )
    expect(continuation).toContain("routerActionInFlightRef.current")
  })

  it("resumes signed-in router recovery through account authority, never the relay-client signer", () => {
    const continuation = section(
      orders,
      "async function continueSettledRouterCheckout(",
      "function buildServiceCtx()"
    )
    expect(continuation).toContain(
      "currentGuestIdentity?.signer ?? getAccountSigner()"
    )
    expect(continuation).not.toContain("getNdk().signer")
    expect(continuation).toMatch(
      /identity: currentGuestIdentity \?\? \{\s*kind: "signed_in",\s*pubkey: buyerPubkey,\s*signer,/
    )
    expect(continuation).toContain(
      "transport: { shouldContinue: approvedSessionIsCurrent }"
    )
    expect(continuation).toContain(
      'throw new Error("Buyer session changed before recovery handoff.")'
    )
    expect(continuation).toContain(
      'throw new Error("Buyer session changed during recovery handoff.")'
    )
  })

  it("keeps guest funding separate from account auth and old direct wallet payment", () => {
    const funding = section(
      orders,
      "fundingPayment: {",
      "acknowledgeRecoverySnapshot:"
    )
    expect(funding).toContain("buyerPubkey,")
    expect(funding).not.toContain("authenticatedPubkey")
    const legacyWallets = section(
      orders,
      "const canTryNwc =",
      "const routerBinding ="
    )
    expect(legacyWallets).toMatch(/const canTryNwc =\s*!guestIdentity/)
    expect(legacyWallets).toMatch(/const canTrySpark =\s*!guestIdentity/)
    const routerWallets = section(
      orders,
      "const routerPayerWallets =",
      "const routerFundingSelection ="
    )
    expect(routerWallets).not.toContain("!guestIdentity")
    expect(routerWallets).toContain("candidate.id === fundingWalletId")
  })

  it("retains available WebLN in the router funding choices without legacy guest auto-payment", () => {
    const routerOptions = section(
      orders,
      "const routerPayerOptions =",
      "const routerFundingSelection ="
    )
    expect(routerOptions).toContain("weblnAvailable: hasWebLN()")
    expect(routerOptions).not.toContain("!guestIdentity")
    expect(orders).toContain(
      "const weblnAvailable = !guestIdentity && hasWebLN()"
    )
    for (const weblnAvailable of [true, false]) {
      const choices = getCheckoutPaymentTargetOptions({
        eligibleWallets: [],
        selectedTarget: { type: "manual" },
        weblnAvailable,
      }).filter((option) => option.target.type !== "manual")
      expect(choices.some((choice) => choice.target.type === "webln")).toBe(
        weblnAvailable
      )
    }
    expect(
      getCheckoutOrderPaymentTarget({
        selectedTarget: { type: "webln" },
        canAutoPay: true,
        isGuest: true,
      })
    ).toEqual({ type: "manual" })
  })

  it("retains live invoice-use guards and guest expiry without opening a guest inbox", () => {
    const disclosure = section(
      orders,
      "<CheckoutSparkExternalFunding",
      "preference={shopperPricing.preference}"
    )
    expect(disclosure).toContain(
      "externalFundingInvoice.authGeneration === authGeneration"
    )
    expect(disclosure).toContain("onBeforeInvoiceUse={() =>")
    expect(disclosure).toContain(
      "canUseRouterExternalInvoice(externalFundingInvoice)"
    )
    const invoiceUseGuard = section(
      orders,
      "function canUseRouterExternalInvoice(",
      "async function continueSettledRouterCheckout("
    )
    expect(invoiceUseGuard).toContain("!canContinueRouterSession()")
    expect(invoiceUseGuard).toContain(
      'saved.fundingSubmissionState === "provisional"'
    )
    expect(invoiceUseGuard).toContain(
      "saved.externalFundingExposedAt === invoice.exposedAt"
    )
    expect(invoiceUseGuard).toContain("invoice.buyerPubkey !== buyerPubkey")
    expect(invoiceUseGuard).toContain("invoice.orderId !== vm.orderId")
    expect(invoiceUseGuard).toContain(
      "invoice.checkoutId !== routerBinding?.checkoutId"
    )
    expect(invoiceUseGuard).toContain(
      "invoice.planDigest !== routerBinding.planDigest"
    )
    const messages = section(
      orders,
      "const messagesQuery =",
      "const cachedMessagesQuery ="
    )
    expect(messages).toContain("enabled: signerConnected")
    expect(orders).toContain("guestIdentity.expiresAt - Date.now()")
    expect(orders).toContain("pruneExpiredGuestOrderData()")
    expect(orders).toContain(
      'if (guestIdentity) throw new Error("Guest orders cannot send messages")'
    )
  })

  it("shows only current same-tab local settlement evidence for a guest", () => {
    const settlement = section(
      orders,
      "function getCurrentSettlementGuestIdentity()",
      "const nextLeaseExpiry ="
    )
    expect(settlement).toContain(
      "getSessionGuestOrderSigningIdentity(guestIdentity.orderId)"
    )
    expect(settlement).toContain("isGuestGenerationCurrent(authGeneration)")
    expect(settlement).toContain(
      "currentIdentity.pubkey !== guestIdentity.pubkey"
    )
    expect(settlement).toContain(
      "currentIdentity.createdAt !== guestIdentity.createdAt"
    )
    expect(settlement).toContain(
      "currentIdentity.expiresAt !== guestIdentity.expiresAt"
    )
    expect(settlement).toContain(
      "isCurrentGuestOrderSigningIdentity(currentIdentity"
    )
    expect(settlement).toContain("buyerPubkey: activeBuyerPubkey")
    expect(settlement).toContain(
      "currentGuestIdentity: getCurrentSettlementGuestIdentity"
    )
    expect(settlement).toMatch(
      /isAuthGenerationCurrent: guestIdentity\s*\? isGuestGenerationCurrent\s*: isAuthGenerationCurrent/
    )
    expect(settlement).toContain(
      "const buyerSettlements = canReadRouterSettlement"
    )
    expect(settlement).toContain(": NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS")
    const expiry = section(
      orders,
      "const delayMs = Math.max(0, guestIdentity.expiresAt",
      "const lifecyclesQuery ="
    )
    expect(expiry.indexOf("setGuestSessionEpoch")).toBeLessThan(
      expiry.indexOf("pruneExpiredGuestOrderData")
    )
  })
})
