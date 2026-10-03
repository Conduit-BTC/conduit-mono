import { useId, type ReactNode } from "react"
import type {
  CheckoutSparkMerchantSettlementProjection,
  MerchantCheckoutSparkReconciliationStatus,
} from "@conduit/core"
import { Button } from "@conduit/ui"

interface CheckoutSparkMerchantPaymentCardProps {
  projection: CheckoutSparkMerchantSettlementProjection | null
  outcome?: MerchantCheckoutSparkReconciliationStatus
  recoveryLookupIncomplete?: boolean
  settlementRefreshing?: boolean
  settlementReadUnavailable?: boolean
  checking: boolean
  paused: boolean
  canContinue: boolean
  transitioning: boolean
  handoffAt: number
  nowMs: number
  notice?: string | null
  onRetry: () => void
  onPause: () => void
  onContinue: () => void
  children?: ReactNode
}

/** Presentation only. Provider evidence and the frozen plan still own payment authority. */
export function CheckoutSparkMerchantPaymentCard({
  projection,
  outcome,
  recoveryLookupIncomplete = false,
  settlementRefreshing = false,
  settlementReadUnavailable = false,
  checking,
  paused,
  canContinue,
  transitioning,
  handoffAt,
  nowMs,
  notice,
  onRetry,
  onPause,
  onContinue,
  children,
}: CheckoutSparkMerchantPaymentCardProps) {
  const processingScopeId = useId()
  const hasSavedResult = projection !== null || outcome !== undefined
  const renewalExplanation =
    "The saved payout invoice has expired. A replacement is allowed only after the exact previous attempt is closed and its funds are confirmed returned and spendable. Do not request another buyer payment."
  const paid = projection?.commerceVerified === true
  // A terminal invoice payment can still lack independent recipient attribution.
  // Keep that fee-only exception visible without revoking verified commerce.
  const coordinationFeeUnresolved =
    paid &&
    (projection?.feePending === true ||
      projection?.recipientUnverified === true)
  const attention =
    (!paid || coordinationFeeUnresolved) &&
    (settlementReadUnavailable ||
      recoveryLookupIncomplete ||
      outcome === "needs_attention" ||
      outcome === "renewal_wait" ||
      outcome === "recipient_unverified" ||
      outcome === "unbound" ||
      outcome === "unavailable" ||
      projection?.recipientUnverified === true)
  const showPaymentDetails = attention || (coordinationFeeUnresolved && paused)
  const waitingForHandoff = nowMs < handoffAt
  const label = paid
    ? "Payment verified"
    : attention
      ? "Payment needs attention"
      : projection?.creditVerified
        ? "Processing payment"
        : outcome === "pending"
          ? "Awaiting payment"
          : "Checking payment"
  const description = paid
    ? "The required order payments are verified. Continue with fulfillment."
    : settlementReadUnavailable && !projection && !outcome
      ? "Saved payment status is temporarily unavailable. Check again when local history is available. This does not mean payment failed. Do not request another payment."
      : recoveryLookupIncomplete
        ? "This order's saved payment details have not been found in the checked history yet. Check again when your inbox is available. Do not request another payment."
        : outcome === "recipient_unverified" || projection?.recipientUnverified
          ? "The recipient for a saved payment could not be verified. Review the saved payment details before continuing. Do not request another payment."
          : outcome === "unbound"
            ? "We need the original order before payment processing can continue. Check again when your order history is available."
            : outcome === "unavailable"
              ? "The payment check could not finish. Your saved progress is kept and checks will retry. Do not request another payment."
              : outcome === "needs_attention"
                ? "Payment processing needs a closer look. Check the saved payment before taking another action."
                : outcome === "renewal_wait"
                  ? renewalExplanation
                  : projection?.creditVerified
                    ? "The buyer's payment has arrived. We are finishing this order's payments automatically."
                    : "We are checking for the buyer's payment. Funding and recipient payments are verified separately."

  return (
    <section
      aria-label="Order payment"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            {label}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-[var(--text-secondary)]">
            {description}
          </p>
        </div>
        {(!paid || coordinationFeeUnresolved) && canContinue && (
          <Button
            type="button"
            variant="outline"
            aria-describedby={processingScopeId}
            disabled={transitioning}
            onClick={paused ? onContinue : onPause}
          >
            {transitioning
              ? "Finishing current check…"
              : paused
                ? coordinationFeeUnresolved
                  ? "Resume coordination fee"
                  : "Resume payment processing"
                : coordinationFeeUnresolved
                  ? "Pause coordination fee"
                  : "Pause"}
          </Button>
        )}
      </div>
      {(!paid || coordinationFeeUnresolved) && canContinue && (
        <p
          id={processingScopeId}
          className="mt-3 text-sm text-[var(--text-muted)]"
        >
          Pause and Resume affect automatic payment processing for all loaded
          orders.
        </p>
      )}
      {!paid && waitingForHandoff && (
        <p className="mt-3 text-sm text-[var(--text-muted)]">
          If the buyer leaves, automatic recovery can continue after{" "}
          <time dateTime={new Date(handoffAt).toISOString()}>
            {new Date(handoffAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          . This is the recovery start time, not the payment time.
        </p>
      )}
      {!paid && ((checking && !hasSavedResult) || paused || transitioning) && (
        <p role="status" className="mt-3 text-sm text-[var(--text-secondary)]">
          {transitioning
            ? "Waiting for the current operation to finish safely."
            : paused
              ? "Automatic payments are paused. A payment already sent may still finish."
              : "Checking this order's payment…"}
        </p>
      )}
      {coordinationFeeUnresolved && (
        <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">
          {attention
            ? "The coordination fee needs attention. This order remains paid and fulfillment can continue."
            : paused
              ? "Coordination fee processing is paused. This order remains paid."
              : "The coordination fee is still processing. This order remains paid."}
        </p>
      )}
      {coordinationFeeUnresolved && outcome === "renewal_wait" && (
        <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">
          {renewalExplanation}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-[var(--text-secondary)]">
          {notice}
        </p>
      )}
      {settlementRefreshing && !hasSavedResult && (
        <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">
          Refreshing saved payment status…
        </p>
      )}
      {settlementReadUnavailable && (projection || outcome) && (
        <p role="status" className="mt-3 text-sm text-[var(--text-muted)]">
          Saved payment status is temporarily unavailable. Previously verified
          results remain saved; do not request another payment.
        </p>
      )}
      {showPaymentDetails && (
        <div className="mt-4 space-y-3">
          {attention && (
            <Button
              type="button"
              disabled={transitioning || checking}
              onClick={onRetry}
            >
              {coordinationFeeUnresolved
                ? "Check coordination fee again"
                : "Check payment again"}
            </Button>
          )}
          {children && (
            <details className="text-sm text-[var(--text-secondary)]">
              <summary className="cursor-pointer rounded-sm py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
                {coordinationFeeUnresolved
                  ? "Coordination fee details"
                  : "Payment details"}
              </summary>
              <div className="mt-2 space-y-3">{children}</div>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
