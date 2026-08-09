import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS } from "../config"
import {
  getNdk,
  setSigner,
  removeSigner,
  type SignerLease,
} from "../protocol/ndk"
import {
  Nip07SessionSigner,
  type Nip07SessionSignerError,
} from "../protocol/nip07-signer"
import {
  SessionSigner,
  SessionSignerError,
} from "../protocol/session-signer"
import {
  abandonRemoteSignerConnection,
  forgetAuthSession,
  forgetRemoteSignerKey,
  bumpAuthRevision,
  claimAuthRevision,
  logoutRemoteSigner,
  pairRemoteSigner,
  pairRemoteSignerFromNostrConnect,
  persistRemoteSignerSession,
  readAuthSession,
  readAuthRevision,
  restoreRemoteSigner,
  rollbackAndAbandonRemoteSignerConnection,
  writeAuthSession,
  type AuthSession,
  type RemoteSignerConnection,
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
  nostrConnectUri: string | null
  dismissAuthUrl: () => void
  cancelConnect: () => void
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
  nip46Flow?: "bunker" | "nostrconnect"
  bunkerUri?: string
}

type AuthConnectAttemptOptions = AuthConnectOptions & {
  pairingSignal?: AbortSignal
}

const INTERACTIVE_INJECTION_WAIT_MS = 2_000
const RESTORE_INJECTION_WAIT_MS = 1_000
const INTERACTIVE_SIGNER_APPROVAL_TIMEOUT_MS = 30_000
const RESTORE_SIGNER_APPROVAL_TIMEOUT_MS = 4_000
const INTERACTIVE_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [250, 750] as const
const RESTORE_TRANSIENT_CONNECT_RETRY_DELAYS_MS = [250] as const

const AuthContext = createContext<AuthContextValue | null>(null)
const NOSTR_CONNECT_RELAYS = CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS.slice(0, 3)
const NO_SIGNER_CAPABILITIES: AuthSignerCapabilities = {
  signEvent: false,
  nip44: false,
  nip04: false,
}
const SIGNER_AUTHORITY_RETRY_MESSAGE =
  "This browser lost signer authority or could not read site storage. Check site storage permissions and reconnect."
const REMOTE_SIGNER_CLEANUP_MESSAGE =
  "This browser could not erase a stale remote signer connection. Clear this site's storage before reconnecting."

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
    onSessionInvalidated?: (error: Nip07SessionSignerError) => void
  } = {}
): Promise<{
  signer: Nip07SessionSigner
  user: Awaited<ReturnType<Nip07SessionSigner["user"]>>
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
    const signer = new Nip07SessionSigner({
      onInvalidated: options.onSessionInvalidated,
    })

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

export type FailedAuthAttemptResolution =
  | { kind: "continue"; failure: unknown }
  | { kind: "ignore" }
  | {
      kind: "authority-retry"
      message: string
      reject: boolean
    }
  | {
      kind: "cleanup-error"
      message: string
      reject: boolean
    }

export async function resolveFailedAuthAttempt(options: {
  failure: unknown
  uncommittedRemote: RemoteSignerConnection | null
  remotePersistenceStarted: boolean
  getAttemptState: () => {
    attemptIsCurrent: boolean
    attemptOwnsEpoch: boolean
    replacementActive: boolean
  }
  rollbackAndAbandon?: (
    connection: RemoteSignerConnection
  ) => Promise<void>
  abandon?: (connection: RemoteSignerConnection) => void
}): Promise<FailedAuthAttemptResolution> {
  let failure = options.failure
  let cleanupFailed = false

  if (options.uncommittedRemote) {
    if (options.remotePersistenceStarted) {
      try {
        await (
          options.rollbackAndAbandon ??
          rollbackAndAbandonRemoteSignerConnection
        )(options.uncommittedRemote)
      } catch (cleanupError) {
        failure = cleanupError
        cleanupFailed = true
      }
    } else {
      const abandon = options.abandon ?? abandonRemoteSignerConnection
      abandon(options.uncommittedRemote)
    }
  }

  const attemptState = options.getAttemptState()
  if (cleanupFailed) {
    if (
      attemptState.attemptOwnsEpoch ||
      !attemptState.replacementActive
    ) {
      return {
        kind: "cleanup-error",
        message: REMOTE_SIGNER_CLEANUP_MESSAGE,
        reject: attemptState.attemptOwnsEpoch,
      }
    }
    return { kind: "ignore" }
  }

  if (!attemptState.attemptIsCurrent) {
    if (attemptState.attemptOwnsEpoch) {
      return {
        kind: "authority-retry",
        message: SIGNER_AUTHORITY_RETRY_MESSAGE,
        reject: true,
      }
    }
    return { kind: "ignore" }
  }

  return { kind: "continue", failure }
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
  const [nostrConnectUri, setNostrConnectUri] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<AuthSignerCapabilities>(
    NO_SIGNER_CAPABILITIES
  )
  const connecting = useRef(false)
  const connected = useRef(false)
  const authEpoch = useRef(0)
  const remoteConnection = useRef<RemoteSignerConnection | null>(null)
  const activeSignerLease = useRef<SignerLease | null>(null)
  const activeSessionSigner = useRef<SessionSigner | null>(null)
  const activeSession = useRef<AuthSession | null>(null)
  const activePairing = useRef<AbortController | null>(null)

  const deactivateLocalSigner = useCallback(() => {
    activePairing.current?.abort()
    activePairing.current = null
    authEpoch.current += 1
    connecting.current = false
    connected.current = false
    const connection = remoteConnection.current
    const signerLease = activeSignerLease.current
    const sessionSigner = activeSessionSigner.current
    remoteConnection.current = null
    activeSignerLease.current = null
    activeSessionSigner.current = null
    activeSession.current = null
    sessionSigner?.invalidateLocal()
    connection?.signer.invalidate()
    if (signerLease) removeSigner(signerLease)
    setPubkey(null)
    setMethod(null)
    setRememberedMethod(null)
    setStatus("disconnected")
    setError(null)
    setAuthUrl(null)
    setNostrConnectUri(null)
    setCapabilities(NO_SIGNER_CAPABILITIES)
    return connection
  }, [])

  const handleSignerSessionInvalidated = useCallback(
    (sessionError: Nip07SessionSignerError | SessionSignerError) => {
      const invalidatedSession = activeSession.current
      const connection = deactivateLocalSigner()
      if (connection) void connection.bunkerSigner.close()
      setStatus("error")
      setError(sessionError.message)

      if (
        !invalidatedSession ||
        (sessionError instanceof SessionSignerError &&
          sessionError.code === "authority_changed")
      ) {
        return
      }

      void withBrowserAuthOperationLock(async () => {
        if (
          JSON.stringify(readAuthSession()) !==
          JSON.stringify(invalidatedSession)
        ) {
          return
        }
        bumpAuthRevision()
        forgetAuthSession()
        if (invalidatedSession.type === "nip46") {
          try {
            await forgetRemoteSignerKey(invalidatedSession)
          } catch {
            // The signer is already invalidated locally. Existing disconnect
            // copy explains how to clear storage if vault cleanup is blocked.
          }
        }
      }).catch(() => undefined)
    },
    [deactivateLocalSigner]
  )

  const connectWithoutLock = useCallback(async (options: AuthConnectAttemptOptions = {}) => {
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
    const attemptOwnsEpoch = () => epoch === authEpoch.current
    const attemptIsCurrent = () =>
      attemptOwnsEpoch() && authRevision === readAuthRevision()
    let uncommittedRemote: RemoteSignerConnection | null = null
    let remotePersistenceStarted = false
    let sessionPersisted = false

    setStatus(mode === "restore" ? "restoring" : "connecting")
    setMethod(requestedMethod)
    setError(null)
    setAuthUrl(null)
    setNostrConnectUri(null)

    try {
      let session: AuthSession
      let signer: Nip07SessionSigner | RemoteSignerConnection["signer"]
      let connectedRemote: RemoteSignerConnection | null = null

      if (requestedMethod === "nip07") {
        const hasSigner = await waitForNip07(
          mode === "restore"
            ? RESTORE_INJECTION_WAIT_MS
            : INTERACTIVE_INJECTION_WAIT_MS
        )
        if (!hasSigner) throw new Error(getMissingSignerMessage(mode))

        const result = await connectNip07SignerForAuth(mode, {
          onSessionInvalidated: handleSignerSessionInvalidated,
        })
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
        const nip46Flow = options.nip46Flow ?? "bunker"
        const connection =
          mode === "restore"
            ? storedSession?.type === "nip46"
              ? await restoreRemoteSigner(storedSession, { onAuthUrl })
              : null
            : nip46Flow === "nostrconnect"
              ? await pairRemoteSignerFromNostrConnect(NOSTR_CONNECT_RELAYS, {
                  signal: options.pairingSignal,
                  onNostrConnectUri: (uri) => {
                    if (attemptIsCurrent()) setNostrConnectUri(uri)
                  },
                  onAuthUrl,
                  clientMetadata: {
                    name: "Conduit",
                    url:
                      typeof window === "undefined"
                        ? undefined
                        : window.location.origin,
                  },
                })
              : options.bunkerUri
                ? await pairRemoteSigner(options.bunkerUri, {
                    signal: options.pairingSignal,
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
              : nip46Flow === "nostrconnect"
                ? "Start a new Nostr Connect pairing attempt."
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
        throw new Error(SIGNER_AUTHORITY_RETRY_MESSAGE)
      }

      if (
        mode === "restore" &&
        JSON.stringify(readAuthSession()) !== JSON.stringify(storedSession)
      ) {
        throw new Error(SIGNER_AUTHORITY_RETRY_MESSAGE)
      }

      const authClaim = claimAuthRevision()
      if (!authClaim.persisted) {
        if (connectedRemote) {
          abandonRemoteSignerConnection(connectedRemote)
          uncommittedRemote = null
        }
        throw new Error(
          "This browser could not establish exclusive signer authority. Check site storage permissions, clear the saved session if needed, and reconnect."
        )
      }
      authRevision = authClaim.revision
      if (!attemptIsCurrent()) {
        throw new Error(SIGNER_AUTHORITY_RETRY_MESSAGE)
      }
      session = { ...session, authClaim: authRevision }
      if (connectedRemote && session.type === "nip46") {
        connectedRemote.session = session
      }

      // Initialize the shared client before persistence without exposing the
      // uncommitted signer to background work.
      getNdk()

      if (session.type === "nip46") {
        remotePersistenceStarted = true
        const persisted = connectedRemote
          ? await persistRemoteSignerSession(
              connectedRemote,
              undefined,
              undefined,
              attemptIsCurrent
            )
          : false
        if (!attemptIsCurrent()) {
          throw new Error(SIGNER_AUTHORITY_RETRY_MESSAGE)
        }
        if (!persisted || !connectedRemote) {
          if (connectedRemote) {
            abandonRemoteSignerConnection(connectedRemote)
            uncommittedRemote = null
          }
          throw new Error(
            "This browser could not save the remote signer session. Check site storage permissions and try again."
          )
        }
        sessionPersisted = true
      } else {
        sessionPersisted = writeAuthSession(session)
        // The persisted revision remains the authority fence even when saving
        // optional NIP-07 reconnect metadata is blocked.
      }

      if (!attemptIsCurrent()) {
        throw new Error(SIGNER_AUTHORITY_RETRY_MESSAGE)
      }

      const boundSession = session
      const sessionSigner = new SessionSigner(signer, {
        expectedPubkey: pk,
        hasAuthority: () => {
          if (readAuthRevision() !== boundSession.authClaim) return false
          if (!sessionPersisted) return true
          return (
            JSON.stringify(readAuthSession()) === JSON.stringify(boundSession)
          )
        },
        onInvalidated: handleSignerSessionInvalidated,
      })
      const signerLease = setSigner(sessionSigner)
      activeSignerLease.current = signerLease
      activeSessionSigner.current = sessionSigner
      remoteConnection.current = connectedRemote
      uncommittedRemote = null
      activeSession.current = session
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
      setNostrConnectUri(null)
    } catch (err) {
      const resolution = await resolveFailedAuthAttempt({
        failure: err,
        uncommittedRemote,
        remotePersistenceStarted,
        getAttemptState: () => {
          const ownsEpoch = attemptOwnsEpoch()
          return {
            attemptIsCurrent:
              ownsEpoch && authRevision === readAuthRevision(),
            attemptOwnsEpoch: ownsEpoch,
            replacementActive:
              !ownsEpoch &&
              (connecting.current ||
                connected.current ||
                activePairing.current !== null),
          }
        },
      })
      if (resolution.kind === "ignore") return
      if (
        resolution.kind === "authority-retry" ||
        resolution.kind === "cleanup-error"
      ) {
        setStatus("error")
        setError(resolution.message)
        setNostrConnectUri(null)
        if (resolution.reject) {
          throw new Error(resolution.message, { cause: err })
        }
        return
      }
      const failure = resolution.failure
      const normalizedError =
        requestedMethod === "nip07"
          ? normalizeSignerConnectError(failure, mode)
          : failure instanceof Error
            ? failure
            : new Error("Failed to connect remote signer")
      const msg = normalizedError.message
      setStatus("error")
      setError(msg)
      setNostrConnectUri(null)
      throw normalizedError
    } finally {
      if (attemptOwnsEpoch()) {
        activePairing.current = null
        setNostrConnectUri(null)
        connecting.current = false
      }
    }
  }, [handleSignerSessionInvalidated])

  const connect = useCallback(
    async (options: AuthConnectOptions = {}) => {
      activePairing.current?.abort()
      activePairing.current = null
      setNostrConnectUri(null)
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
        setNostrConnectUri(null)
        throw missingSessionError
      }
      setMethod(requestedMethod)
      setStatus(mode === "restore" ? "restoring" : "connecting")
      setError(null)
      setAuthUrl(null)
      setNostrConnectUri(null)

      const pairingController =
        mode === "interactive" && requestedMethod === "nip46"
          ? new AbortController()
          : null
      activePairing.current = pairingController
      const attemptOptions: AuthConnectAttemptOptions = pairingController
        ? { ...options, pairingSignal: pairingController.signal }
        : options

      let operationStarted = false
      try {
        await withBrowserAuthOperationLock(
          () => {
            operationStarted = true
            return connectWithoutLock(attemptOptions)
          },
          pairingController?.signal
        )
      } catch (cause) {
        if (pairingController?.signal.aborted) return
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
        setNostrConnectUri(null)
        throw lockError
      } finally {
        if (activePairing.current === pairingController) {
          activePairing.current = null
        }
      }
    },
    [connectWithoutLock]
  )

  const cancelConnect = useCallback(() => {
    if (!activePairing.current) return
    authEpoch.current += 1
    activePairing.current.abort()
    activePairing.current = null
    connecting.current = false
    setMethod(null)
    setStatus("disconnected")
    setError(null)
    setAuthUrl(null)
    setNostrConnectUri(null)
  }, [])

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
    () => {
      activePairing.current?.abort()
      activePairing.current = null
      setNostrConnectUri(null)
      return withBrowserAuthOperationLock(() => disconnectWithoutLock(true))
    },
    [disconnectWithoutLock]
  )

  const dismissAuthUrl = useCallback(() => setAuthUrl(null), [])

  useEffect(() => {
    const stored = initialSessionRef.current
    if (!stored) return

    // Don't crash the app on auto-reconnect failure; surface state via `error`.
    void connect({ mode: "restore" }).catch(() => undefined)
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
        event.key === AUTH_REVISION_STORAGE_KEY ||
        event.key === null
      ) {
        if (!connected.current && !connecting.current) return
        if (
          event.key === AUTH_REVISION_STORAGE_KEY &&
          event.newValue === activeSession.current?.authClaim
        ) {
          return
        }
        const connection = deactivateLocalSigner()
        if (connection) void connection.bunkerSigner.close()
        setStatus("error")
        setError(
          "This signer session changed in another tab. Reconnect the intended account to continue."
        )
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
        nostrConnectUri,
        dismissAuthUrl,
        cancelConnect,
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
