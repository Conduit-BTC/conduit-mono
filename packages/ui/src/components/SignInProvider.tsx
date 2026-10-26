import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Button } from "./Button"
import {
  SignInDialog,
  type SignInDialogProps,
  type SignerConnectPanelProps,
} from "./SignInDialog"
import { SignerAuthUrlNotice } from "./SignerAuthUrlNotice"
import { getSignerPlatform } from "./signer-platform"
import { useSignerPairing } from "./use-signer-pairing"

type SignInRequest = {
  requestSignIn: (onConnected?: () => void) => void
  disconnectAccount: () => Promise<void>
}
const SignInContext = createContext<SignInRequest | null>(null)

export function useSignIn(): SignInRequest {
  const context = useContext(SignInContext)
  if (!context) throw new Error("useSignIn requires an app SignInProvider")
  return context
}

type Props = Omit<SignInDialogProps, "open" | "onOpenChange"> & {
  children: ReactNode
  onDismissAuthUrl: () => void
  onFocusFallback?: () => void
  /** Navigation only. Signed actions must always be explicitly retried. */
  navigationKey?: string
  accountPresent: boolean
  gate?: boolean
  renderGate?: (props: SignerConnectPanelProps) => ReactNode
}

/** One UI owner per product shell. AuthContext remains the account authority. */
export function SignInProvider({
  children,
  gate = false,
  renderGate,
  accountPresent,
  navigationKey,
  onDismissAuthUrl,
  onFocusFallback,
  ...props
}: Props) {
  const [open, setOpen] = useState(false)
  const [disconnectError, setDisconnectError] = useState(false)
  const [disconnectPending, setDisconnectPending] = useState(false)
  const disconnectLock = useRef(false)
  const { onDisconnect } = props
  const disconnectAccount = useCallback(async () => {
    if (disconnectLock.current) return
    disconnectLock.current = true
    setDisconnectPending(true)
    setDisconnectError(false)
    try {
      await onDisconnect()
    } catch (error) {
      setDisconnectError(true)
      throw error
    } finally {
      disconnectLock.current = false
      setDisconnectPending(false)
    }
  }, [onDisconnect])
  const continuation = useRef<{ action: () => void; key?: string } | undefined>(
    undefined
  )
  const trigger = useRef<HTMLElement | null>(null)
  const requestSignIn = useCallback(
    (onConnected?: () => void) => {
      if (accountPresent || disconnectLock.current) return
      trigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      continuation.current = onConnected
        ? { action: onConnected, key: navigationKey }
        : undefined
      setOpen(true)
    },
    [accountPresent, navigationKey]
  )
  const contextValue = useMemo(
    () => ({ requestSignIn, disconnectAccount }),
    [requestSignIn, disconnectAccount]
  )
  const finish = useEffectEvent(() => {
    const next = continuation.current
    continuation.current = undefined
    setOpen(false)
    if (next && next.key === navigationKey) next.action()
  })
  useEffect(() => {
    if (open && props.status === "connected") finish()
  }, [open, props.status])
  const restoreFocus = () => {
    if (trigger.current?.isConnected)
      trigger.current.focus({ preventScroll: true })
    else onFocusFallback?.()
  }
  const close = () => {
    continuation.current = undefined
    setOpen(false)
  }
  // Once a full-page gate starts connecting, retain the session if navigation
  // changes it into a modal (for example, opening the device-owned wallet).
  const begin = (action: () => Promise<void> | void) => {
    setOpen(true)
    return action()
  }
  const active =
    !disconnectPending && (gate || open) && props.status !== "connected"
  return (
    <SignInContext.Provider value={contextValue}>
      {children}
      {disconnectPending && (
        <p
          role="status"
          className="fixed inset-x-4 top-4 z-50 rounded-lg bg-[var(--surface-dialog)] p-4 text-center"
        >
          Finishing sign-out…
        </p>
      )}
      {disconnectError && (
        <div
          role="alert"
          className="fixed inset-x-4 top-4 z-50 mx-auto max-w-lg rounded-lg border border-error bg-[var(--surface-dialog)] p-4 text-[var(--error-text)]"
        >
          <p>
            Could not finish disconnecting. Retry to clear the saved connection.
          </p>
          <Button
            disabled={disconnectPending}
            onClick={() => void disconnectAccount().catch(() => undefined)}
          >
            Retry disconnect
          </Button>
        </div>
      )}
      {active && (
        <SignInSession
          {...props}
          onConnectExtension={() => begin(props.onConnectExtension)}
          onConnectNostrConnect={() => begin(props.onConnectNostrConnect)}
          onConnectRemote={(uri) => begin(() => props.onConnectRemote(uri))}
          onReconnect={
            props.onReconnect ? () => begin(props.onReconnect!) : undefined
          }
          onDisconnect={disconnectAccount}
          gate={gate}
          renderGate={renderGate}
          onReturnFocus={restoreFocus}
          onClose={close}
        />
      )}
      {!active && props.authUrl && (
        <SignerAuthUrlNotice
          authUrl={props.authUrl}
          onDismiss={onDismissAuthUrl}
        />
      )}
    </SignInContext.Provider>
  )
}

/** Keep pairing ownership above both modal/full-page presentation and routes. */
function SignInSession({
  gate,
  renderGate,
  onClose,
  ...props
}: Omit<Props, "children" | "accountPresent" | "onDismissAuthUrl"> & {
  onClose: () => void
}) {
  const platform = getSignerPlatform()
  const pending = props.status === "connecting" || props.status === "restoring"
  const pairing = useSignerPairing({
    autoPrepare: platform === "ios" || platform === "android",
    connectPending: pending,
    connectDisabled: pending,
    rememberedMethod: props.rememberedMethod,
    nostrConnectUri: props.nostrConnectUri,
    error: props.error,
    onConnect: props.onConnectNostrConnect,
    onCancel: props.onCancelConnect,
  })
  if (gate && renderGate)
    return renderGate({
      ...props,
      pairing,
      description: props.connectDescription,
      helperText: "Choose a browser extension or remote signer.",
      connectingMethod:
        props.status === "restoring" ? null : props.signerMethod,
      connectPending: pending,
      connectDisabled: pending,
      extensionNotice:
        !props.extensionAvailable && platform === "desktop"
          ? "No complete NIP-07 signer detected yet. Install or unlock a signer such as Alby or nos2x, then try Connect signer again."
          : null,
      onForget: props.onDisconnect,
    })
  return (
    <SignInDialog
      {...props}
      pairing={pairing}
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    />
  )
}
