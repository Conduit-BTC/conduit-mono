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

export type AuthStatus =
  | "disconnected"
  | "restoring"
  | "connecting"
  | "connected"
  | "error"

export interface AuthContextValue {
  pubkey: string | null
  status: AuthStatus
  error: string | null
  connect: (options?: AuthConnectOptions) => Promise<void>
  disconnect: () => void
}

export type AuthConnectMode = "interactive" | "restore"

export interface AuthConnectOptions {
  mode?: AuthConnectMode
}

const AUTH_STORAGE_KEY = "conduit:auth"
const INTERACTIVE_INJECTION_WAIT_MS = 2_000
const RESTORE_INJECTION_WAIT_MS = 1_000
const INTERACTIVE_SIGNER_APPROVAL_TIMEOUT_MS = 30_000
const RESTORE_SIGNER_APPROVAL_TIMEOUT_MS = 4_000

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredAuth(): string | null {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage.getItem(AUTH_STORAGE_KEY)
  } catch {
    return null
  }
}

function rememberAuth(pubkey: string): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, pubkey)
  } catch {
    // Storage can fail in restricted browser contexts; active signer state still works.
  }
}

function forgetAuth(): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    // Best effort only; disconnect still clears in-memory signer state.
  }
}

export function hasNip07(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.nostr?.getPublicKey === "function" &&
    typeof window.nostr?.signEvent === "function"
  )
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(() => readStoredAuth())
  const [status, setStatus] = useState<AuthStatus>(() =>
    readStoredAuth() ? "restoring" : "disconnected"
  )
  const [error, setError] = useState<string | null>(null)
  const connecting = useRef(false)
  const authEpoch = useRef(0)

  const connect = useCallback(async (options: AuthConnectOptions = {}) => {
    const mode = options.mode ?? "interactive"
    if (connecting.current) return
    connecting.current = true
    const epoch = authEpoch.current

    setStatus(mode === "restore" ? "restoring" : "connecting")
    setError(null)

    const hasSigner = await waitForNip07(
      mode === "restore"
        ? RESTORE_INJECTION_WAIT_MS
        : INTERACTIVE_INJECTION_WAIT_MS
    )
    if (!hasSigner) {
      const msg = getMissingSignerMessage(mode)
      setStatus("error")
      setError(msg)
      connecting.current = false
      throw new Error(msg)
    }

    try {
      const signer = new NDKNip07Signer()
      const user = await withTimeout(
        signer.user(),
        mode === "restore"
          ? RESTORE_SIGNER_APPROVAL_TIMEOUT_MS
          : INTERACTIVE_SIGNER_APPROVAL_TIMEOUT_MS,
        getSignerTimeoutMessage(mode)
      )
      const pk = user.pubkey
      if (epoch !== authEpoch.current) return

      setSigner(signer)
      setPubkey(pk)
      setStatus("connected")
      rememberAuth(pk)
    } catch (err) {
      const normalizedError = normalizeSignerConnectError(err, mode)
      const msg = normalizedError.message
      setStatus("error")
      setError(msg)
      throw normalizedError
    } finally {
      connecting.current = false
    }
  }, [])

  const disconnect = useCallback(() => {
    authEpoch.current += 1
    connecting.current = false
    removeSigner()
    setPubkey(null)
    setStatus("disconnected")
    setError(null)
    forgetAuth()
  }, [])

  useEffect(() => {
    const stored = readStoredAuth()
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

  return (
    <AuthContext.Provider value={{ pubkey, status, error, connect, disconnect }}>
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
