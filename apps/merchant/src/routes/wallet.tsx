import { createFileRoute } from "@tanstack/react-router"
import { useAuth } from "@conduit/core"
import {
  useWalletAddress,
  type WalletAddressSuggestion,
} from "@conduit/core/hooks/useWalletAddress"
import { Wallets, ProfileLightningAddressEditor, Button } from "@conduit/ui"
import { useMerchantPaymentAutomation } from "../hooks/useMerchantPaymentAutomation"
export const Route = createFileRoute("/wallet")({ component: WalletsPage })
function AddressEditor(props: {
  suggestion: WalletAddressSuggestion | null
  onDismiss(): void
}) {
  const controller = useWalletAddress({ ...props, appId: "merchant" })
  return <ProfileLightningAddressEditor controller={controller} />
}
function WalletsPage() {
  const auth = useAuth()
  const automation = useMerchantPaymentAutomation()
  const wallets = automation.wallets
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
            {automation.canVerifyPayments
              ? "Payments are checked automatically against the original invoice in its receiving wallet."
              : "Open or reconnect the original receiving wallet to check order payments automatically."}{" "}
            Keep Merchant open for checks. Changing your public address leaves
            existing invoices unchanged.
          </p>
          {automation.run.message && <p>{automation.run.message}</p>}
          {automation.run.status === "error" && (
            <Button variant="outline" onClick={automation.retry}>
              Retry payment checks
            </Button>
          )}
        </div>
      }
      formatSats={(sats) => `${sats.toLocaleString()} sats`}
      renderAddressEditor={(suggestion, onDismiss) => (
        <AddressEditor
          key={`${auth.accountPubkey}:${auth.authGeneration}`}
          suggestion={suggestion}
          onDismiss={onDismiss}
        />
      )}
    />
  )
}
