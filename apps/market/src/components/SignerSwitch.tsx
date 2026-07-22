import { formatNpub, useAuth, useNip07Availability } from "@conduit/core"
import { SignerSwitch as SharedSignerSwitch } from "@conduit/ui"

type SignerSwitchProps = {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
}

export function SignerSwitch(props: SignerSwitchProps = {}) {
  const {
    pubkey,
    method,
    rememberedMethod,
    status,
    error,
    authUrl,
    connect,
    disconnect,
  } = useAuth()
  const extensionAvailable = useNip07Availability()

  return (
    <SharedSignerSwitch
      {...props}
      status={status}
      pubkeyLabel={pubkey ? formatNpub(pubkey) : null}
      pubkeyDetailLabel={pubkey ? formatNpub(pubkey, 12) : null}
      error={error}
      authUrl={authUrl}
      signerMethod={method}
      rememberedMethod={rememberedMethod}
      extensionAvailable={extensionAvailable}
      connectedDescription="Orders, zap out, and follow-up are ready."
      connectDescription="Use your Nostr signer to continue with Conduit."
      connectedUseDescription="This signer will be used for buyer actions in Conduit."
      unlockItems={[
        "Send orders tied to your pubkey.",
        "See merchant replies and order updates later.",
      ]}
      onConnectExtension={() => connect({ method: "nip07" })}
      onConnectRemote={(bunkerUri) => connect({ method: "nip46", bunkerUri })}
      onReconnect={() => connect({ mode: "restore" })}
      onDisconnect={disconnect}
    />
  )
}
