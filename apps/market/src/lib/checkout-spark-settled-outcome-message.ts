import type {
  CheckoutSparkSettledShopperPauseReason,
  CheckoutSparkSettledShopperRunResult,
} from "./checkout-spark-settled-shopper-runner"

const genericPause =
  "Payment paused. Resume checks its saved status before continuing; do not pay separately."

// Only fixed copy derived from finite runner outcomes. No provider errors,
// saved wallet contents, or inferred causes enter this presentation boundary.
const pauseMessages: Record<CheckoutSparkSettledShopperPauseReason, string> = {
  paused:
    "Payment paused because this order’s active buyer session stopped. Keep this order visible and resume to check its saved status; do not pay again.",
  busy: "Another payment check is already running. Let it finish; do not pay again.",
  authorization_changed:
    "The saved payment approval no longer matches the current checkout. Refresh saved status; do not pay separately.",
  unavailable:
    "The required payment check could not finish. Resume checks the saved payment first; do not pay again.",
  funding_action_stopped:
    "The funding action stopped before confirmation. Check the same saved payment; do not pay again.",
  step_limit:
    "Payment paused after its bounded checks. Resume checks saved progress before continuing; do not pay again.",
  authority_not_started:
    "Payment authority is not active yet. Keep the saved recovery details; do not pay separately.",
  authority_transferred:
    "Payment authority has moved to merchant recovery. Do not resume from this buyer session or pay separately.",
  fee_over_cap:
    "The payout fee exceeds its approved limit. Payment stays paused; do not pay separately.",
  insufficient_funds:
    "Verified funds do not cover the approved payout and fee limit. Keep the saved recovery details; do not pay separately.",
  fee_unavailable:
    "The payout fee could not be checked. Payment stays paused; do not pay separately.",
  recipient_unverified:
    "The saved payout’s recipient evidence could not be verified. Keep the saved recovery details; do not pay separately.",
  invoice_window_insufficient:
    "The saved invoice no longer has a safe payout window. Keep the saved recovery details; do not pay this invoice separately.",
  inspection_only:
    "The saved payout was checked without sending. Keep the existing payout; do not pay separately.",
  prior_possible_send:
    "A previous payment may have been submitted. Resume checks the existing attempt before continuing; no second payment is sent while its status is uncertain.",
  provider_evidence_unavailable:
    "The saved payment’s provider evidence could not be checked. Resume checks the existing attempt first; do not pay again.",
  provider_evidence_conflicting:
    "The payment evidence conflicts with the saved payout. Keep the saved recovery details; do not retry or pay separately.",
  recovery_handoff_unavailable:
    "The saved recovery handoff could not be confirmed. Payment stays paused; do not pay separately.",
  terminal_failure:
    "The saved payout cannot continue automatically. Keep its recovery details for manual recovery; do not pay separately.",
  sibling_possible_send:
    "An earlier payment may have been submitted. Resume checks the existing attempt before continuing; no second payment is sent while its status is uncertain.",
  prerequisite_unpaid:
    "An earlier recipient payout has not been verified. The final payment stays paused; do not pay separately.",
  renewal_return_unavailable:
    "The previous payout’s returned funds could not be verified. No replacement is authorized; keep the saved recovery details and do not pay separately.",
  zero_remainder:
    "No approved checkout credit remains for the final Conduit payment. No additional payment was sent; merchant recovery is required.",
}

/** Buyer-local presentation only; this message never grants payment authority. */
export function getCheckoutSparkSettledOutcomeMessage(
  result: CheckoutSparkSettledShopperRunResult
): string {
  if (result.status === "complete")
    return "Your payment is recorded. Check the order status for confirmation."
  if (result.status === "funding_pending")
    return "Waiting for payment confirmation. Keep this order; resume to check the same payment, never pay it again."
  return Object.hasOwn(pauseMessages, result.reason)
    ? pauseMessages[result.reason]
    : genericPause
}
