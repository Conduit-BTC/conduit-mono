import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useWalletBalanceUpdates } from "@conduit/core/hooks/useWallets"
import { useAuth } from "@conduit/core"
import {
  useWalletAddress,
  type WalletAddressSuggestion,
} from "@conduit/core/hooks/useWalletAddress"
import { Wallets, Button } from "@conduit/ui"
import { useMerchantPaymentAutomation } from "../hooks/useMerchantPaymentAutomation"
export const Route = createFileRoute("/wallet")({ component: WalletsPage })
function WalletsPage() {
  const auth = useAuth()
  const automation = useMerchantPaymentAutomation()
  const wallets = automation.wallets
  useWalletBalanceUpdates(wallets)
  const [suggestion, setSuggestion] = useState<WalletAddressSuggestion | null>(
    null
  )
  const addressController = useWalletAddress({
    suggestion,
    onDismiss: () => setSuggestion(null),
    appId: "merchant",
  })
  return (
    <Wallets
      auth={auth}
      wallets={wallets}
      footer={
        <div
          className="space-y-2 text-sm text-[var(--text-secondary)]"
          role="status"
        >
          <p>
            {auth.signerReadiness !== "ready"
              ? "Connect your Nostr signer to check order payments automatically."
              : automation.canVerifyPayments
                ? "Payments are checked automatically against the original invoice in its receiving wallet."
                : "Open or reconnect the original receiving wallet to check order payments automatically."}{" "}
            Keep Merchant open for checks. Changing your public address leaves
            existing invoices unchanged.
          </p>
          {automation.migrationFailed && (
            <p>
              The saved external wallet could not be added to Wallets. Its
              existing connection is retained.
            </p>
          )}
          {automation.run.message && <p>{automation.run.message}</p>}
          {(automation.migrationFailed ||
            automation.run.status === "error") && (
            <Button variant="outline" onClick={automation.retry}>
              {automation.migrationFailed
                ? "Retry wallet setup"
                : "Retry payment checks"}
            </Button>
          )}
        </div>
      }
      addressController={addressController}
      onSuggestAddress={setSuggestion}
    />
  )
}
