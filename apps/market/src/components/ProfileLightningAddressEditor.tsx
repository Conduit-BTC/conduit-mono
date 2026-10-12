import {
  useWalletAddress,
  type WalletAddressSuggestion,
} from "@conduit/core/hooks/useWalletAddress"
import { ProfileLightningAddressEditor as Editor } from "@conduit/ui"
export type { WalletAddressSuggestion } from "@conduit/core/hooks/useWalletAddress"
export function ProfileLightningAddressEditor(props: {
  suggestion: WalletAddressSuggestion | null
  onDismiss(): void
}) {
  const controller = useWalletAddress({ ...props, appId: "market" })
  return <Editor controller={controller} />
}
