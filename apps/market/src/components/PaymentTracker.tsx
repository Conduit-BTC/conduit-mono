import { Button, StatusStepper, type StatusStepperRow } from "@conduit/ui"
import { Link } from "@tanstack/react-router"
import {
  AlertCircle,
  ArrowLeft,
  Check,
  RefreshCw,
  Send,
  ShoppingBag,
  Zap,
} from "lucide-react"
import type { CSSProperties } from "react"
import {
  getPaymentTrackerHeadline,
  getPaymentTrackerOutcome,
  getPaymentTrackerRowCopy,
  getPaymentTrackerRows,
  parseRelayFailureMessage,
  type PaymentTrackerInput,
  type PaymentTrackerOutcome,
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
  /**
   * Called when the buyer leaves the completed tracker via one of the
   * completion actions (View orders / Keep shopping / Back to carts). Lets the
   * host commit any deferred side effects (e.g. clearing the merchant cart)
   * right before navigation, so the completed view holds until the buyer acts.
   */
  onLeaveCompleted?: () => void
  /** Whether a recovery action is currently submitting. Disables buttons. */
  busy?: boolean
  /**
   * Hide the recovery action footer entirely. Useful when the tracker is
   * rendered in a context that already provides equivalent navigation
   * (e.g. the orders page, where "View order" would be redundant).
   */
  hideRecoveryActions?: boolean
}

/** Token-based accent color for the header, keyed off the coarse outcome. */
function toneForOutcome(outcome: PaymentTrackerOutcome): string {
  switch (outcome) {
    case "succeeded":
      return "var(--success)"
    case "in_progress":
      return "var(--secondary-500)"
    case "proof_retry_needed":
      return "var(--warning)"
    case "failed_pre_delivery":
    case "failed_pre_payment":
    default:
      return "var(--error)"
  }
}

function HeaderIcon({ outcome }: { outcome: PaymentTrackerOutcome }) {
  if (outcome === "succeeded")
    return <Check className="h-5 w-5" strokeWidth={3} />
  if (outcome === "in_progress")
    return <Zap className="h-5 w-5 fill-current" strokeWidth={1.5} />
  return <AlertCircle className="h-5 w-5" />
}

/**
 * PaymentTracker -- the in-page replacement for the old purple full-screen
 * "Lightning payment started" interrupt.
 *
 * Renders a tonal header card (lightning/check/alert + headline + sats) that
 * reads as a distinct element from the steps below, a 4-row StatusStepper of
 * the buyer-facing payment lifecycle with tense-consistent copy, and a footer
 * of actions: completion navigation when the order is complete, or recovery
 * actions whose visibility depends on the outcome (per CND-89: "Try payment
 * again" must not duplicate an already-paid attempt; "Send order / pay later"
 * only when funds have not moved).
 */
export function PaymentTracker({
  input,
  amountLabel,
  onTryAgain,
  onPayLater,
  onResendReceipt,
  onBackToCheckout,
  onLeaveCompleted,
  busy = false,
  hideRecoveryActions = false,
}: PaymentTrackerProps) {
  const rows = getPaymentTrackerRows(input)
  const outcome = getPaymentTrackerOutcome(input)
  const headline = getPaymentTrackerHeadline(input)
  const tone = toneForOutcome(outcome)

  const stepperRows: StatusStepperRow[] = ROW_ORDER.map((key) => {
    const status = rows[key]
    const copy = getPaymentTrackerRowCopy(key, status)
    return {
      key,
      title: copy.title,
      subtitle: copy.subtitle,
      status,
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

  const headerStyle: CSSProperties = {
    borderColor: `color-mix(in srgb, ${tone} 55%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${tone} 8%, var(--surface))`,
    boxShadow: `0 0 24px color-mix(in srgb, ${tone} 22%, transparent)`,
  }
  const headerIconStyle: CSSProperties = {
    borderColor: `color-mix(in srgb, ${tone} 55%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${tone} 16%, transparent)`,
    color: tone,
  }

  return (
    <section
      aria-label="Lightning payment status"
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-6 shadow-[var(--shadow-md)]"
    >
      {/* Header -- a distinct tonal card so it doesn't read like a step. */}
      <header
        style={headerStyle}
        className="flex items-center gap-4 rounded-xl border p-4"
      >
        <span
          aria-hidden="true"
          style={headerIconStyle}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border"
        >
          <HeaderIcon outcome={outcome} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-6 text-[var(--text-primary)]">
            {headline}
          </h2>
          {amountLabel && (
            <p className="mt-0.5 text-sm font-semibold text-[var(--text-secondary)]">
              {amountLabel}
            </p>
          )}
        </div>
      </header>

      {/* Stepper */}
      <div className="mt-6">
        <p className="mb-4 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Transaction steps
        </p>
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

      {/* Completion actions -- held here until the buyer chooses where to go. */}
      {!hideRecoveryActions && outcome === "succeeded" && (
        <footer className="mt-6 grid grid-cols-1 gap-2 border-t border-[var(--border)] pt-4 sm:grid-cols-3">
          <Button asChild variant="outline">
            <Link to="/orders" onClick={onLeaveCompleted}>
              View orders
            </Link>
          </Button>
          <Button asChild variant="primary">
            <Link to="/products" onClick={onLeaveCompleted}>
              <ShoppingBag className="mr-2 h-4 w-4" />
              Keep shopping
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/cart" onClick={onLeaveCompleted}>
              Back to carts
            </Link>
          </Button>
        </footer>
      )}

      {/* Recovery actions -- failure / retry states only. */}
      {!hideRecoveryActions &&
        outcome !== "succeeded" &&
        (showTryAgain ||
          showPayLater ||
          showResendReceipt ||
          showBackToCheckout ||
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
            {outcome === "proof_retry_needed" && (
              <Button asChild variant="outline">
                <Link to="/orders" onClick={onLeaveCompleted}>
                  View orders
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
