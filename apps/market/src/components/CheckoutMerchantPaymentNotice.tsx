import { AlertTriangle, LoaderCircle } from "lucide-react"
import type { MerchantPaymentReadiness } from "../lib/merchant-payment-readiness"

export function CheckoutMerchantPaymentNotice({
  state,
  isGuestCheckout,
}: {
  state: MerchantPaymentReadiness
  isGuestCheckout: boolean
}) {
  if (state === "not_required" || state === "ready") return null

  const checking = state === "checking_profile" || state === "checking_endpoint"
  const title =
    state === "checking_profile"
      ? "Checking merchant payment setup"
      : state === "checking_endpoint"
        ? "Checking merchant Lightning endpoint"
        : state === "missing_address"
          ? "Merchant Lightning payments are not set up"
          : state === "profile_unavailable"
            ? "Merchant payment setup could not be confirmed"
            : "Merchant Lightning endpoint could not be reached"
  const description = checking
    ? state === "checking_profile"
      ? "This profile lookup is separate from the product and pickup checks."
      : "The profile has a Lightning Address, but direct payment is not ready until its endpoint responds."
    : isGuestCheckout
      ? "Connect a signer to send the order and arrange payment with the merchant."
      : "You can still send the order first and arrange payment with the merchant."

  return (
    <div
      role="status"
      className="rounded-2xl border border-warning/35 bg-warning/10 p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        {checking ? (
          <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        )}
        <div>
          <div className="font-medium text-[var(--text-primary)]">{title}</div>
          <p className="mt-1 leading-6 text-[var(--text-secondary)]">
            {description}
          </p>
        </div>
      </div>
    </div>
  )
}
