import { type ReactNode } from "react"
import { useRouterState } from "@tanstack/react-router"
import { useAuth, useNip07Availability } from "@conduit/core"
import { SignInProvider, type SignerConnectPanelProps } from "@conduit/ui"

export function AppSignIn({
  children,
  gate,
  renderGate,
}: {
  children: ReactNode
  gate?: boolean
  renderGate?: (props: SignerConnectPanelProps) => ReactNode
}) {
  const navigationKey = useRouterState({
    select: (state) => state.location.href,
  })
  const auth = useAuth()
  const extensionAvailable = useNip07Availability()
  return (
    <SignInProvider
      navigationKey={navigationKey}
      onFocusFallback={() =>
        document
          .querySelector<HTMLElement>("main")
          ?.focus({ preventScroll: true })
      }
      status={auth.status}
      accountPresent={!!auth.accountPubkey}
      error={auth.error}
      authUrl={auth.authUrl}
      onDismissAuthUrl={auth.dismissAuthUrl}
      nostrConnectUri={auth.nostrConnectUri}
      signerMethod={auth.method}
      rememberedMethod={auth.rememberedMethod}
      extensionAvailable={extensionAvailable}
      connectDescription="Use your Nostr account to shop and stay in touch."
      unlockItems={[
        "Send orders tied to your pubkey.",
        "See merchant replies and order updates later.",
      ]}
      onConnectExtension={() => auth.connect({ method: "nip07" })}
      onConnectNostrConnect={() =>
        auth.connect({ method: "nip46", nip46Flow: "nostrconnect" })
      }
      onConnectRemote={(bunkerUri) =>
        auth.connect({ method: "nip46", nip46Flow: "bunker", bunkerUri })
      }
      onCancelConnect={auth.cancelConnect}
      onReconnect={() => auth.connect({ mode: "restore" })}
      onDisconnect={auth.disconnect}
      gate={gate}
      renderGate={renderGate}
    >
      {children}
    </SignInProvider>
  )
}
