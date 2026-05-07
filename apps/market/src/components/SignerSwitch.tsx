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
      connectedDescription="Checkout, orders, and follow-up are ready."
      connectDescription="Use your Nostr signer to continue with Conduit."
      connectedUseDescription="This signer will be used for buyer actions in Conduit."
      unlockItems={[
        "Send orders tied to your pubkey.",
        "See merchant replies and order updates later.",
      ]}
      onConnect={connect}
      onDisconnect={disconnect}
    />
  )
}
