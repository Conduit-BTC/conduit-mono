import { formatNpub, useAuth, useNip07Availability } from "@conduit/core"
import { SignerSwitch as SharedSignerSwitch } from "@conduit/ui"

type SignerSwitchProps = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

export function SignerSwitch(props: SignerSwitchProps = {}) {
  const { pubkey, status, error, connect, disconnect } = useAuth()
  const extensionAvailable = useNip07Availability()

  return (
    <SharedSignerSwitch
      {...props}
      status={status}
      pubkeyLabel={pubkey ? formatNpub(pubkey) : null}
      pubkeyDetailLabel={pubkey ? formatNpub(pubkey, 12) : null}
      error={error}
      extensionAvailable={extensionAvailable}
      connectedDescription="Your merchant workspace is ready."
      connectDescription="Use your Nostr signer to open your merchant workspace."
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
