import { Link } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"
import { isCommerceReadIncomplete, useProfile } from "@conduit/core"
import { Button } from "@conduit/ui"
import { getProductPaymentSetupState } from "../lib/product-payment-setup"

export function ProductPaymentSetupNotice({
  merchantPubkey,
  enabled = true,
}: {
  merchantPubkey: string
  enabled?: boolean
}) {
  const profileQuery = useProfile(merchantPubkey, {
    authenticatedPubkey: merchantPubkey,
    enabled,
    // Product authoring must eventually settle when the merchant has no
    // profile metadata; the default visible-profile query retries forever.
    maxUnresolvedRefetches: 2,
    requireCompleteEvidence: true,
  })
  const state = getProductPaymentSetupState({
    lud16: profileQuery.evidenceData?.lud16,
    lookupSettled: profileQuery.lookupSettled,
    evidenceIncomplete: isCommerceReadIncomplete(profileQuery.meta),
    error: profileQuery.error,
  })

  if (!enabled || state !== "missing") return null

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Lightning payments are not set up
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
            You can still publish and arrange payment manually, but shoppers
            cannot pay your profile Lightning Address until you add one.
          </p>
        </div>
      </div>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to="/payments">Set up payments</Link>
      </Button>
    </div>
  )
}
