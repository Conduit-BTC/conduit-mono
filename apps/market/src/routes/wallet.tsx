import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useAuth } from "@conduit/core"
import {
  useWallets,
  useWalletBalanceUpdates,
} from "@conduit/core/hooks/useWallets"
import {
  useWalletAddress,
  type WalletAddressSuggestion,
} from "@conduit/core/hooks/useWalletAddress"
import { Wallets } from "@conduit/ui"
export const Route = createFileRoute("/wallet")({ component: WalletsPage })
function WalletsPage() {
  const auth = useAuth()
  const wallets = useWallets()
  useWalletBalanceUpdates(wallets)
  const [suggestion, setSuggestion] = useState<WalletAddressSuggestion | null>(
    null
  )
  const addressController = useWalletAddress({
    suggestion,
    onDismiss: () => setSuggestion(null),
    appId: "market",
  })
  return (
    <Wallets
      auth={auth}
      wallets={wallets}
      addressController={addressController}
      onSuggestAddress={setSuggestion}
    />
  )
}
