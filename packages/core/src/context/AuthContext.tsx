import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { NDKNip07Signer } from "@nostr-dev-kit/ndk"
import { setSigner, removeSigner } from "../protocol/ndk"
import {
  forgetAuthSession,
  forgetRemoteSignerKey,
  bumpAuthRevision,
  logoutRemoteSigner,
  pairRemoteSigner,
  persistRemoteSignerSession,
  readAuthSession,
  readAuthRevision,
  restoreRemoteSigner,
  rollbackNewRemoteSignerSession,
  writeAuthSession,
  type AuthSession,
  type RemoteSignerConnection,
  RemoteSignerError,
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
} from "../protocol/remote-signer"
import { withBrowserAuthOperationLock } from "../protocol/remote-signer-vault"
import { isTransientNip07BridgeError } from "../protocol/signing-retry"

export type AuthStatus =
  | "disconnected"
  | "restoring"
  | "connecting"
  | "connected"
  | "error"

export interface AuthContextValue {
  pubkey: string | null
  method: AuthMethod | null
  rememberedMethod: AuthMethod | null
  status: AuthStatus
  error: string | null
  authUrl: string | null
  dismissAuthUrl: () => void
  capabilities: AuthSignerCapabilities
  connect: (options?: AuthConnectOptions) => Promise<void>
  disconnect: () => Promise<void>
}

export type AuthMethod = "nip07" | "nip46"
export interface AuthSignerCapabilities {
  signEvent: boolean
  nip44: boolean
  nip04: boolean
}
export type AuthConnectMode = "interactive" | "restore"

export interface AuthConnectOptions {
  mode?: AuthConnectMode
  method?: AuthMethod
  bunkerUri?: string
}

const INTERACTIVE_INJECTION_WAIT_MS = 2_000
const RESTORE_INJECTION_WAIT_MS = 1_000
const INTERACTIVE_SIGNER_APPROVAL_TIMEOUT_MS = 30_000
const RESTORE_SIGNER_APPROVAL_TIMEOUT_MS = 4_000
const INTERACTIVE_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [250, 750] as const
const RESTORE_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [250] as const

const AuthContext = createContext<AuthContextValue | null>(null)
const NO_SIGNER_CAPABILITIES: AuthSignerCapabilities = {
  signEvent: false,
  nip44: false,
  nip04: false,
}

export function hasNip07(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.nostr?.getPublicKey === "function" &&
    typeof window.nostr?.signEvent === "function"
  )
}

export function getNip07Capabilities(): AuthSignerCapabilities {
  return {
    signEvent: hasNip07(),
    nip44:
      typeof window !== "undefined" &&
      typeof window.nostr?.nip44?.encrypt === "function" &&
      typeof window.nostr?.nip44?.decrypt === "function",
    nip04:
      typeof window !== "undefined" &&
      typeof window.nostr?.nip04?.encrypt === "function" &&
      typeof window.nostr?.nip04?.decrypt === "function",
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForNip07(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!hasNip07() && Date.now() < deadline) {
    await sleep(200)
  }

  return hasNip07()
}

function getMissingSignerMessage(mode: AuthConnectMode): string {
  if (mode === "restore") {
    return "Reconnect your signer to continue. Conduit could not find a complete NIP-07 signer in this browser."
  }

  return "No complete NIP-07 signer found. Install or unlock a Nostr signer, then try again."
}

function getSignerTimeoutMessage(mode: AuthConnectMode): string {
  if (mode === "restore") {
    return "Reconnect your signer to continue. Your browser signer may require a fresh button click before it shows an approval prompt."
  }

  return "Signer approval timed out. Unlock your signer, check for an extension approval prompt, then try again."
}

function getSignerBridgeReadyMessage(mode: AuthConnectMode): string {
  if (mode === "restore") {
    return "Reconnect your signer to continue. Your browser signer extension was not ready yet."
  }

  return "Your signer extension was not ready yet. Unlock or reopen your signer, then try again."
}

export function isTransientNip07ConnectError(error: unknown): boolean {
  return isTransientNip07BridgeError(error)
}

function normalizeSignerConnectError(
  error: unknown,
  mode: AuthConnectMode
): Error {
  if (!(error instanceof Error)) {
    return new Error("Failed to connect signer")
  }

  if (/timed out/i.test(error.message)) {
    return new Error(getSignerTimeoutMessage(mode))
  }

  if (isTransientNip07ConnectError(error)) {
    return new Error(getSignerBridgeReadyMessage(mode))
  }

  if (/not available|not found/i.test(error.message)) {
    return new Error(getMissingSignerMessage(mode))
  }

  return error
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function connectNip07SignerForAuth(
  mode: AuthConnectMode,
  options: {
    approvalTimeoutMs?: number
    retryDelaysMs?: readonly number[]
  } = {}
): Promise<{
  signer: NDKNip07Signer
  user: Awaited<ReturnType<NDKNip07Signer["user"]>>
}> {
  const retryDelays =
    options.retryDelaysMs ??
    (mode === "restore"
      ? RESTORE_TRANSIENT_CONNECT_RETRY_DELAYS_MS
      : INTERACTIVE_TRANSIENT_CONNECT_RETRY_DELAYS_MS)
  const approvalTimeoutMs =
    options.approvalTimeoutMs ??
    (mode === "restore"
      ? RESTORE_SIGNER_APPROVAL_TIMEOUT_MS
      : INTERACTIVE_SIGNER_APPROVAL_TIMEOUT_MS)
  let lastError: unknown

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const signer = new NDKNip07Signer()

    try {
      const user = await withTimeout(
        signer.user(),
        approvalTimeoutMs,
        getSignerTimeoutMessage(mode)
      )
      return { signer, user }
    } catch (error) {
      lastError = error

      const retryDelay = retryDelays[attempt]
      if (!isTransientNip07ConnectError(error) || retryDelay === undefined) {
        break
      }

      await sleep(retryDelay)
    }
  }

  throw normalizeSignerConnectError(lastError, mode)
}

function abandonRemoteConnection(connection: RemoteSignerConnection): void {
  connection.signer.invalidate()
  if (connection.clientKeyAlreadyPersisted) {
    void connection.bunkerSigner.close()
    return
  }
  void logoutRemoteSigner(connection.bunkerSigner)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initialSessionRef = useRef<AuthSession | null>(readAuthSession())
  const [pubkey, setPubkey] = useState<string | null>(
    () => initialSessionRef.current?.userPubkey ?? null
  )
  const [method, setMethod] = useState<AuthMethod | null>(
    () => initialSessionRef.current?.type ?? null
  )
  const [rememberedMethod, setRememberedMethod] = useState<AuthMethod | null>(
    () => initialSessionRef.current?.type ?? null
  )
  const [status, setStatus] = useState<AuthStatus>(() =>
    initialSessionRef.current ? "restoring" : "disconnected"
  )
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<AuthSignerCapabilities>(
    NO_SIGNER_CAPABILITIES
  )
  const connecting = useRef(false)
  const connected = useRef(false)
  const authEpoch = useRef(0)
  const remoteConnection = useRef<RemoteSignerConnection | null>(null)
  const activeSession = useRef<AuthSession | null>(null)

  const deactivateLocalSigner = useCallback(() => {
    authEpoch.current += 1
    connecting.current = false
    connected.current = false
    const connection = remoteConnection.current
    remoteConnection.current = null
    activeSession.current = null
    connection?.signer.invalidate()
    removeSigner()
    setPubkey(null)
    setMethod(null)
    setRememberedMethod(null)
    setStatus("disconnected")
    setError(null)
    setAuthUrl(null)
    setCapabilities(NO_SIGNER_CAPABILITIES)
    return connection
  }, [])

  const connectWithoutLock = useCallback(async (options: AuthConnectOptions = {}) => {
    const mode = options.mode ?? "interactive"
    const storedSession = readAuthSession()
    const requestedMethod =
      options.method ?? (mode === "restore" ? storedSession?.type : "nip07")
    if (connecting.current) return
    if (connected.current) {
      throw new Error("Disconnect the current signer before connecting another.")
    }
    if (!requestedMethod) {
      const missingSessionError = new Error(
        mode === "restore"
          ? "The saved signer session is no longer available. Connect again."
          : "Choose a signer connection method and try again."
      )
      setMethod(null)
      setStatus("error")
      setError(missingSessionError.message)
      setAuthUrl(null)
      throw missingSessionError
    }
    connecting.current = true
    const epoch = authEpoch.current + 1
    authEpoch.current = epoch
    let authRevision = readAuthRevision()
    const attemptIsCurrent = () =>
      epoch === authEpoch.current && authRevision === readAuthRevision()
    let uncommittedRemote: RemoteSignerConnection | null = null

    setStatus(mode === "restore" ? "restoring" : "connecting")
    setMethod(requestedMethod)
    setError(null)
    setAuthUrl(null)

    try {
      let session: AuthSession
      let signer: NDKNip07Signer | RemoteSignerConnection["signer"]
      let connectedRemote: RemoteSignerConnection | null = null

      if (requestedMethod === "nip07") {
        const hasSigner = await waitForNip07(
          mode === "restore"
            ? RESTORE_INJECTION_WAIT_MS
            : INTERACTIVE_INJECTION_WAIT_MS
        )
        if (!hasSigner) throw new Error(getMissingSignerMessage(mode))

        const result = await connectNip07SignerForAuth(mode)
        signer = result.signer
        session = {
          version: 1,
          type: "nip07",
          userPubkey: result.user.pubkey,
        }
      } else {
        const onAuthUrl = (url: string) => {
          if (!attemptIsCurrent()) return
          try {
            const parsed = new URL(url)
            if (parsed.protocol === "https:" || parsed.protocol === "http:") {
              setAuthUrl(parsed.toString())
            }
          } catch {
            // Invalid remote URLs are not exposed to the browser UI.
          }
        }
        const connection =
          mode === "restore"
            ? storedSession?.type === "nip46"
              ? await restoreRemoteSigner(storedSession, { onAuthUrl })
              : null
            : options.bunkerUri
              ? await pairRemoteSigner(options.bunkerUri, {
                   onAuthUrl,
                  clientMetadata: {
                    name: "Conduit",
                    url:
                      typeof window === "undefined"
                        ? undefined
                        : window.location.origin,
                  },
                })
              : null
        if (!connection) {
          throw new Error(
            mode === "restore"
              ? "The saved remote signer session is unavailable. Connect it again."
              : "Paste a bunker:// connection URI from your remote signer."
          )
        }
        connectedRemote = connection
        uncommittedRemote = connection
        signer = connection.signer
        session = connection.session
      }

      const pk = session.userPubkey
      if (!attemptIsCurrent()) {
        if (connectedRemote) {
          abandonRemoteConnection(connectedRemote)
          uncommittedRemote = null
        }
        return
      }

      if (
        mode === "restore" &&
        JSON.stringify(readAuthSession()) !== JSON.stringify(storedSession)
      ) {
        if (connectedRemote) {
          abandonRemoteConnection(connectedRemote)
          uncommittedRemote = null
        }
        return
      }

      authRevision = bumpAuthRevision()
      if (!attemptIsCurrent()) {
        if (connectedRemote) {
          abandonRemoteConnection(connectedRemote)
          uncommittedRemote = null
        }
        return
      }
      session = { ...session, authClaim: authRevision }
      if (connectedRemote && session.type === "nip46") {
        connectedRemote.session = session
      }

      if (session.type === "nip46") {
        const persisted = connectedRemote
          ? await persistRemoteSignerSession(
              connectedRemote,
              undefined,
              undefined,
              attemptIsCurrent
            )
          : false
        if (!attemptIsCurrent()) {
          if (connectedRemote) {
            if (persisted) {
              await rollbackNewRemoteSignerSession(connectedRemote)
            }
            abandonRemoteConnection(connectedRemote)
            uncommittedRemote = null
          }
          return
        }
        if (!persisted || !connectedRemote) {
          if (connectedRemote) {
            abandonRemoteConnection(connectedRemote)
            uncommittedRemote = null
          }
          throw new Error(
            "This browser could not save the remote signer session. Check site storage permissions and try again."
          )
        }
      } else if (!writeAuthSession(session)) {
        // NIP-07 remains usable for the current tab when storage is restricted.
      }

      remoteConnection.current = connectedRemote
      uncommittedRemote = null
      activeSession.current = session
      setSigner(signer)
      setPubkey(pk)
      setMethod(session.type)
      setRememberedMethod(session.type)
      setStatus("connected")
      connected.current = true
      setCapabilities(
        session.type === "nip46"
          ? { signEvent: true, nip44: true, nip04: true }
          : getNip07Capabilities()
      )
      setAuthUrl(null)
    } catch (err) {
      if (uncommittedRemote) {
        abandonRemoteConnection(uncommittedRemote)
        uncommittedRemote = null
      }
      if (!attemptIsCurrent()) {
        if (
          err instanceof RemoteSignerError &&
          (err.operation === "rollback session" ||
            err.operation === "persist session")
        ) {
          setStatus("error")
          setError(
            "This browser could not erase a stale remote signer connection. Clear this site's storage before reconnecting."
          )
        }
        return
      }
      const normalizedError =
        requestedMethod === "nip07"
          ? normalizeSignerConnectError(err, mode)
          : err instanceof Error
            ? err
            : new Error("Failed to connect remote signer")
      const msg = normalizedError.message
      setStatus("error")
      setError(msg)
      throw normalizedError
    } finally {
      if (attemptIsCurrent()) connecting.current = false
    }
  }, [])

  const connect = useCallback(
    async (options: AuthConnectOptions = {}) => {
      if (connected.current) {
        throw new Error("Disconnect the current signer before connecting another.")
      }
      const mode = options.mode ?? "interactive"
      const requestedMethod =
        options.method ??
        (mode === "restore" ? readAuthSession()?.type ?? null : "nip07")
      if (!requestedMethod) {
        const missingSessionError = new Error(
          "The saved signer session is no longer available. Connect again."
        )
        setMethod(null)
        setStatus("error")
        setError(missingSessionError.message)
        setAuthUrl(null)
        throw missingSessionError
      }
      setMethod(requestedMethod)
      setStatus(mode === "restore" ? "restoring" : "connecting")
      setError(null)
      setAuthUrl(null)

      let operationStarted = false
      try {
        await withBrowserAuthOperationLock(() => {
          operationStarted = true
          return connectWithoutLock(options)
        })
      } catch (cause) {
        if (operationStarted) throw cause

        const lockError = new Error(
          cause instanceof Error &&
          cause.message ===
            "Another signer operation is still active in this browser. Try again shortly."
            ? cause.message
            : "This browser could not start the signer connection. Check site storage permissions, then try again."
        )
        setStatus("error")
        setError(lockError.message)
        setAuthUrl(null)
        throw lockError
      }
    },
    [connectWithoutLock]
  )

  const disconnectWithoutLock = useCallback(async (broadcast = true) => {
    if (broadcast) bumpAuthRevision()
    const storedSession = readAuthSession()
    const connection = deactivateLocalSigner()
    let cleanupFailed = !forgetAuthSession()
    const remoteSessions = [
      storedSession?.type === "nip46" ? storedSession : null,
      connection?.session ?? null,
    ]
      .filter((session): session is NonNullable<typeof session> => !!session)
      .filter(
      (session, index, sessions) =>
        sessions.findIndex(
          (candidate) => candidate.clientKeyId === session.clientKeyId
        ) === index
      )
    for (const session of remoteSessions) {
      try {
        await forgetRemoteSignerKey(session)
      } catch {
        cleanupFailed = true
      }
    }
    if (connection) await logoutRemoteSigner(connection.bunkerSigner)
    if (cleanupFailed) {
      setStatus("error")
      setError(
        "Disconnected, but this browser could not erase the saved remote signer connection. Clear this site's storage before reconnecting."
      )
    }
  }, [deactivateLocalSigner])

  const disconnect = useCallback(
    () => withBrowserAuthOperationLock(() => disconnectWithoutLock(true)),
    [disconnectWithoutLock]
  )

  const dismissAuthUrl = useCallback(() => setAuthUrl(null), [])

  useEffect(() => {
    const stored = initialSessionRef.current
    if (!stored) return

    let cancelled = false

    async function reconnectIfPossible() {
      if (cancelled) return

      // Don't crash the app on auto-reconnect failure; surface state via `error`.
      void connect({ mode: "restore" }).catch(() => {
        if (cancelled) return
        removeSigner()
      })
    }

    void reconnectIfPossible()

    return () => {
      cancelled = true
    }
  }, [connect])

  useEffect(
    () => () => {
      const connection = deactivateLocalSigner()
      if (connection) {
        void connection.bunkerSigner.close()
      }
    },
    [deactivateLocalSigner]
  )

  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (
        event.key === AUTH_REVISION_STORAGE_KEY &&
        connecting.current
      ) {
        const connection = deactivateLocalSigner()
        if (connection) void connection.bunkerSigner.close()
        return
      }
      if (event.key !== AUTH_STORAGE_KEY) return
      const replacement = readAuthSession()
      const previous = activeSession.current
      if (
        JSON.stringify(replacement) === JSON.stringify(previous) ||
        (!connected.current && !connecting.current)
      ) {
        return
      }
      const currentConnection = deactivateLocalSigner()
      if (!currentConnection) return
      if (
        replacement?.type === "nip46" &&
        replacement.clientKeyId === currentConnection.session.clientKeyId
      ) {
        void currentConnection.bunkerSigner.close()
        return
      }
      void (async () => {
        let cleanupFailed = false
        try {
          await forgetRemoteSignerKey(currentConnection.session)
        } catch {
          cleanupFailed = true
        } finally {
          await logoutRemoteSigner(currentConnection.bunkerSigner)
        }
        if (cleanupFailed) {
          setStatus("error")
          setError(
            "This tab disconnected, but could not erase its previous remote signer connection. Clear this site's storage before reconnecting."
          )
        }
      })()
    }
    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [deactivateLocalSigner])

  return (
    <AuthContext.Provider
      value={{
        pubkey,
        method,
        rememberedMethod,
        status,
        error,
        authUrl,
        dismissAuthUrl,
        capabilities,
        connect,
        disconnect,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return ctx
}
