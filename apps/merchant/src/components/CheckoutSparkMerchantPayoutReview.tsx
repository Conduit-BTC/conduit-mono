import { checkoutSparkProviderSendWindowEndsAt } from "@conduit/core/protocol"
import type { MerchantCheckoutSparkPayoutReview } from "../lib/checkout-spark-settled-continuation"

const recipientEvidenceLabels = {
  local_origin: "Matching local invoice origin found",
  recipient_verified: "Saved recipient evidence found",
  missing:
    "No matching recipient evidence found in this device’s saved records",
  unavailable: "Saved recipient evidence could not be checked",
}

const savedStatusLabels = {
  unprepared: "No prepared intent recorded",
  prepared: "Prepared; no submission recorded here",
  submitted: "Submission recorded; final outcome not established here",
  ambiguous: "Outcome uncertain",
  lookup_unavailable: "Prior lookup unavailable; outcome uncertain",
  conflicting_evidence: "Saved observations conflict; outcome uncertain",
  terminal_failure:
    "Failure recorded; reconcile the original attempt before retrying",
  paid: "Payment recorded; not a fresh provider check",
}

const budgetLabels = {
  fits: "Saved invoice plus fee cap fits this recipient’s allocation",
  exceeds: "Saved invoice plus fee cap exceeds this recipient’s allocation",
  unavailable: "Saved allocation budget could not be checked",
}

function formatTimeRemaining(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

export function CheckoutSparkMerchantPayoutReview({
  review,
  nowMs,
}: {
  review: MerchantCheckoutSparkPayoutReview
  nowMs: number
}) {
  const sendWindowEndsAt = checkoutSparkProviderSendWindowEndsAt(
    review.intent.paymentRequest
  )
  const sendWindowDate =
    sendWindowEndsAt !== null ? new Date(sendWindowEndsAt) : null
  const validSendWindowDate =
    sendWindowDate !== null && Number.isFinite(sendWindowDate.getTime())
  const validClock = Number.isSafeInteger(nowMs) && nowMs >= 0
  const remainingMs =
    validClock && validSendWindowDate && sendWindowEndsAt !== null
      ? sendWindowEndsAt - nowMs
      : null

  return (
    <div className="space-y-3 text-sm text-[var(--text-secondary)]">
      <p>This resumes one saved payout, not a new buyer payment.</p>
      <dl className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
        <div>
          <dt>Frozen Lightning destination</dt>
          <dd className="break-all font-medium text-[var(--text-primary)]">
            {review.destination}
          </dd>
        </div>
        <div>
          <dt>Invoice amount</dt>
          <dd className="text-[var(--text-primary)]">
            {review.intent.invoiceAmountSats.toLocaleString()} sats
          </dd>
        </div>
        <div>
          <dt>Maximum outgoing fee</dt>
          <dd className="text-[var(--text-primary)]">
            {review.intent.maxFeeSats.toLocaleString()} sats
          </dd>
        </div>
        <div>
          <dt>Maximum total from this recipient’s allocation</dt>
          <dd className="text-[var(--text-primary)]">
            {review.allocationSats.toLocaleString()} sats
          </dd>
        </div>
      </dl>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
        <p className="font-medium text-[var(--text-primary)]">
          Saved payout checks
        </p>
        <dl className="mt-2 space-y-2">
          <div>
            <dt>Recipient evidence</dt>
            <dd>
              {
                recipientEvidenceLabels[
                  review.inspection?.recipientAttribution ?? "unavailable"
                ]
              }
            </dd>
          </div>
          <div>
            <dt>Saved payment status</dt>
            <dd>
              {review.inspection
                ? savedStatusLabels[review.inspection.savedStatus]
                : "Saved payment status unavailable"}
            </dd>
          </div>
          <div>
            <dt>Saved amount and fee budget</dt>
            <dd>
              {
                budgetLabels[
                  review.inspection?.allocationBudget ?? "unavailable"
                ]
              }
            </dd>
          </div>
        </dl>
        <p className="mt-2">
          Saved-state snapshot only. Live wallet balance and provider history
          were not checked. These labels do not authorize a payout; fresh checks
          still run before sending.
        </p>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
        <p className="font-medium text-[var(--text-primary)]">
          Payout send cutoff
        </p>
        {validSendWindowDate && sendWindowDate !== null && validClock ? (
          <>
            <time dateTime={sendWindowDate.toISOString()}>
              {sendWindowDate.toLocaleString()}
            </time>
            {remainingMs !== null && remainingMs > 0 ? (
              <p className="mt-1">
                Time remaining: {formatTimeRemaining(remainingMs)}
              </p>
            ) : null}
          </>
        ) : null}
        {remainingMs === null ? (
          <p className="mt-1" role="alert">
            This saved invoice’s safe payout deadline cannot be verified. Do not
            continue this payout.
          </p>
        ) : remainingMs <= 0 ? (
          <p className="mt-1" role="alert">
            The saved invoice’s safe payout window has ended. This exact payout
            cannot be sent or replaced here.
          </p>
        ) : remainingMs < 2 * 60_000 ? (
          <p className="mt-1" role="status">
            Less than two minutes remain before the safe send cutoff. There may
            not be enough time to review and complete this payout.
          </p>
        ) : null}
        <p className="mt-1">
          The order and recovery record remain saved. Check funding and payout
          history separately before retrying.
        </p>
      </div>
      <p>
        The saved invoice and payment ID stay unchanged. Funding and payout
        history will be checked again before sending. If the invoice has expired
        or a prior attempt is uncertain, this payout stays paused. Sending also
        requires this device’s saved evidence that the invoice came from the
        frozen recipient; a recovery message alone does not establish that.
        Opening Spark may claim pending inbound funds.
      </p>
    </div>
  )
}
