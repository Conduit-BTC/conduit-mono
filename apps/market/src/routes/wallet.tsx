import { createFileRoute } from "@tanstack/react-router"
import { useAuth } from "@conduit/core"
import { useWallets } from "@conduit/core/hooks/useWallets"
import { Wallets } from "@conduit/ui"
import { ProfileLightningAddressEditor } from "../components/ProfileLightningAddressEditor"
export const Route = createFileRoute("/wallet")({ component: WalletsPage })
function WalletsPage() {
  const auth = useAuth()
  const wallets = useWallets()
  return (
    <Wallets
      auth={auth}
      wallets={wallets}
      renderAddressEditor={(suggestion, onDismiss) => (
        <ProfileLightningAddressEditor
          key={`${auth.accountPubkey}:${auth.authGeneration}`}
          suggestion={suggestion}
          onDismiss={onDismiss}
        />
      )}
    />
  )
}
