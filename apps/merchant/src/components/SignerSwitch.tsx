import { formatPubkey, hasNip07, useAuth } from "@conduit/core"
import { SignerSwitch as SharedSignerSwitch } from "@conduit/ui"

type SignerSwitchProps = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

export function SignerSwitch(props: SignerSwitchProps = {}) {
  const { pubkey, status, error, connect, disconnect } = useAuth()

  return (
    <SharedSignerSwitch
      {...props}
      status={status}
      pubkeyLabel={pubkey ? formatPubkey(pubkey) : null}
      pubkeyDetailLabel={pubkey ? formatPubkey(pubkey, 12) : null}
      error={error}
      extensionAvailable={hasNip07()}
      connectedDescription="Your merchant workspace is ready."
      connectDescription="Use your Nostr signer to open the merchant workspace."
      connectedUseDescription="This signer will be used for listings, orders, and merchant messages."
      unlockItems={[
        "Publish listings tied to your pubkey.",
        "Manage orders and buyer messages in one place.",
      ]}
      onConnect={connect}
      onDisconnect={disconnect}
    />
  )
}
