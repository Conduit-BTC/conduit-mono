import {
  Button,
  StatusPill,
  StatusStepper,
  type StatusStepperRow,
} from "@conduit/ui"
import { Link } from "@tanstack/react-router"
import { ArrowLeft, ExternalLink, RefreshCw, Send, Zap } from "lucide-react"
import {
  PAYMENT_TRACKER_ROW_COPY,
  getPaymentTrackerHeadline,
  getPaymentTrackerOutcome,
  getPaymentTrackerRows,
  parseRelayFailureMessage,
  type PaymentTrackerInput,
  type PaymentTrackerRowKey,
} from "../lib/checkout-payment"

const ROW_ORDER: readonly PaymentTrackerRowKey[] = [
  "order_delivered",
  "wallet_connecting",
  "payment_confirmation",
  "receipt_sent",
] as const

export interface PaymentTrackerProps {
  input: PaymentTrackerInput
  /** Optional sat amount to surface in the header subline. */
  amountLabel?: string
  /** Try the payment again. Hidden when funds have moved. */
  onTryAgain?: () => void
  /** Switch to the order-first / pay-later fallback. Hidden when funds have moved. */
  onPayLater?: () => void
  /** Resend payment proof / receipt. Shown only when proof delivery needs retry. */
  onResendReceipt?: () => void
  /** Optional handler for the "Back to checkout" recovery action when in a failure state. */
  onBackToCheckout?: () => void
  /** Whether a recovery action is currently submitting. Disables buttons. */
  busy?: boolean
  /**
   * Hide the recovery action footer entirely. Useful when the tracker is
   * rendered in a context that already provides equivalent navigation
   * (e.g. the orders page, where "View order" would be redundant).
   */
  hideRecoveryActions?: boolean
}

function pillVariantForOutcome(
  outcome: ReturnType<typeof getPaymentTrackerOutcome>
): React.ComponentProps<typeof StatusPill>["variant"] {
  switch (outcome) {
    case "succeeded":
      return "success"
    case "in_progress":
      return "info"
    case "proof_retry_needed":
      return "warning"
    case "failed_pre_delivery":
    case "failed_pre_payment":
    default:
      return "error"
  }
}

function pillCopyForOutcome(
  outcome: ReturnType<typeof getPaymentTrackerOutcome>
): string {
  switch (outcome) {
    case "succeeded":
      return "Complete"
    case "in_progress":
      return "In progress"
    case "proof_retry_needed":
      return "Retry needed"
    case "failed_pre_delivery":
    case "failed_pre_payment":
    default:
      return "Failed"
  }
}

/**
 * PaymentTracker -- the in-page replacement for the old purple full-screen
 * "Lightning payment started" interrupt.
 *
 * Renders a header (lightning icon + headline + status pill), a 4-row
 * StatusStepper of the buyer-facing payment lifecycle, and a footer of
 * recovery actions whose visibility depends on the tracker outcome (per
 * CND-2A: "Try payment again" must not duplicate an already-paid attempt;
 * "Send order / pay later" only when funds have not moved).
 */
export function PaymentTracker({
  input,
  amountLabel,
  onTryAgain,
  onPayLater,
  onResendReceipt,
  onBackToCheckout,
  busy = false,
  hideRecoveryActions = false,
}: PaymentTrackerProps) {
  const rows = getPaymentTrackerRows(input)
  const outcome = getPaymentTrackerOutcome(input)
  const headline = getPaymentTrackerHeadline(input)

  const stepperRows: StatusStepperRow[] = ROW_ORDER.map((key) => {
    const copy = PAYMENT_TRACKER_ROW_COPY[key]
    return {
      key,
      title: copy.title,
      subtitle: copy.subtitle,
      status: rows[key],
    }
  })

  const showTryAgain = !input.paymentMoved && outcome !== "in_progress"
  const showPayLater =
    !input.paymentMoved && outcome !== "in_progress" && Boolean(onPayLater)
  const showResendReceipt =
    outcome === "proof_retry_needed" && Boolean(onResendReceipt)
  const showBackToCheckout =
    !input.paymentMoved &&
    (outcome === "failed_pre_delivery" || outcome === "failed_pre_payment") &&
    Boolean(onBackToCheckout)

  return (
    <section
      aria-label="Lightning payment status"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-6 shadow-[var(--shadow-md)]"
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--secondary-400)_45%,transparent)] bg-[color-mix(in_srgb,var(--secondary-500)_14%,transparent)] text-[var(--secondary-400)]"
          >
            <Zap className="h-5 w-5 fill-current" strokeWidth={1.5} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-6 text-[var(--text-primary)]">
              {headline}
            </h2>
            {amountLabel && (
              <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
                {amountLabel}
              </p>
            )}
          </div>
        </div>
        <StatusPill variant={pillVariantForOutcome(outcome)}>
          {pillCopyForOutcome(outcome)}
        </StatusPill>
      </header>

      {/* Stepper */}
      <div className="mt-6">
        <StatusStepper
          rows={stepperRows}
          ariaLabel="Lightning payment progress"
        />
      </div>

      {/* Inline error -- shown only on failure outcomes */}
      {input.errorMessage &&
        (outcome === "failed_pre_delivery" ||
          outcome === "failed_pre_payment" ||
          outcome === "proof_retry_needed") &&
        (() => {
          const parsed = parseRelayFailureMessage(input.errorMessage)
          if (parsed) {
            return (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] px-3 py-3 text-sm text-[var(--text-primary)]"
              >
                <p className="font-medium">{parsed.summary}</p>
                <ul className="mt-2 space-y-1">
                  {parsed.failures.map(({ url, reason }) => (
                    <li
                      key={url}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="font-mono text-xs text-[var(--text-secondary)] break-all">
                        {url}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--text-muted)]">
                        {reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
          return (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              {input.errorMessage}
            </div>
          )
        })()}

      {/* Recovery actions */}
      {!hideRecoveryActions &&
        (showTryAgain ||
          showPayLater ||
          showResendReceipt ||
          showBackToCheckout ||
          outcome === "succeeded" ||
          outcome === "proof_retry_needed") && (
          <footer className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
            {showTryAgain && onTryAgain && (
              <Button
                type="button"
                variant="primary"
                onClick={onTryAgain}
                disabled={busy}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Try payment again
              </Button>
            )}
            {showResendReceipt && onResendReceipt && (
              <Button
                type="button"
                variant="primary"
                onClick={onResendReceipt}
                disabled={busy}
              >
                <Send className="mr-2 h-4 w-4" />
                Resend receipt
              </Button>
            )}
            {showPayLater && onPayLater && (
              <Button
                type="button"
                variant="outline"
                onClick={onPayLater}
                disabled={busy}
              >
                <Send className="mr-2 h-4 w-4" />
                Send order, pay later
              </Button>
            )}
            {(outcome === "succeeded" || outcome === "proof_retry_needed") && (
              // NOTE(CND-2A follow-up): no /orders/$orderId route yet, so we
              // route to the flat order list. Replace once order detail lands.
              <Button asChild variant="outline">
                <Link to="/orders">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View order
                </Link>
              </Button>
            )}
            {showBackToCheckout && onBackToCheckout && (
              <Button
                type="button"
                variant="ghost"
                onClick={onBackToCheckout}
                disabled={busy}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to checkout
              </Button>
            )}
          </footer>
        )}
    </section>
  )
}
