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
    nostrConnectUri,
    connect,
    localKeyEnabled,
    pasteLocalKey,
    cancelConnect,
    disconnect,
  } = useAuth()
  const extensionAvailable = useNip07Availability()

  return (
    <SharedSignerSwitch
      {...props}
      logoSrc="/images/logo/merchant-logo-full.svg"
      status={status}
      pubkeyLabel={pubkey ? formatNpub(pubkey) : null}
      pubkeyDetailLabel={pubkey ? formatNpub(pubkey, 12) : null}
      error={error}
      authUrl={authUrl}
      nostrConnectUri={nostrConnectUri}
      signerMethod={method}
      rememberedMethod={rememberedMethod}
      localKeyEnabled={localKeyEnabled}
      onPasteLocalKey={pasteLocalKey}
      onImportLocalKey={(localKeyInput) =>
        connect({ method: "local", localKeyInput })
      }
      extensionAvailable={extensionAvailable}
      connectedDescription="Your merchant workspace is ready."
      connectDescription="Open your merchant workspace."
      connectedUseDescription="This signer will be used for listings, orders, and merchant messages."
      unlockItems={[
        "Create your store and start publishing products.",
        "Handle orders, customer messages, and product comments in one place.",
        "Sell through Conduit, your own storefront, and beyond.",
      ]}
      onConnectExtension={() => connect({ method: "nip07" })}
      onConnectNostrConnect={() =>
        connect({ method: "nip46", nip46Flow: "nostrconnect" })
      }
      onConnectRemote={(bunkerUri) =>
        connect({ method: "nip46", nip46Flow: "bunker", bunkerUri })
      }
      onCancelConnect={cancelConnect}
      onReconnect={() => connect({ mode: "restore" })}
      onDisconnect={disconnect}
    />
  )
}
