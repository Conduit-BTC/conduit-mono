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

export type AuthStatus = "disconnected" | "connecting" | "connected" | "error"

export interface AuthContextValue {
  pubkey: string | null
  status: AuthStatus
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

const AUTH_STORAGE_KEY = "conduit:auth"

const AuthContext = createContext<AuthContextValue | null>(null)

export function hasNip07(): boolean {
  return typeof window !== "undefined" && !!window.nostr
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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
  const [pubkey, setPubkey] = useState<string | null>(
    () => localStorage.getItem(AUTH_STORAGE_KEY)
  )
  const [status, setStatus] = useState<AuthStatus>(
    () => localStorage.getItem(AUTH_STORAGE_KEY) ? "connecting" : "disconnected"
  )
  const [error, setError] = useState<string | null>(null)
  const connecting = useRef(false)

  const connect = useCallback(async () => {
    if (connecting.current) return
    connecting.current = true

    setStatus("connecting")
    setError(null)

    // Extensions inject window.nostr asynchronously - wait briefly
    for (let i = 0; i < 10 && !hasNip07(); i++) {
      await new Promise((r) => setTimeout(r, 200))
    }
    if (!hasNip07()) {
      const msg = "No NIP-07 extension found. Install a Nostr signer extension."
      setStatus("error")
      setError(msg)
      connecting.current = false
      throw new Error(msg)
    }

    try {
      const signer = new NDKNip07Signer()
      const user = await withTimeout(
        signer.user(),
        30_000,
        "Signer connection timed out. Unlock/approve your NIP-07 extension (e.g., Alby) and retry."
      )
      const pk = user.pubkey

      setSigner(signer)
      setPubkey(pk)
      setStatus("connected")
      localStorage.setItem(AUTH_STORAGE_KEY, pk)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect signer"
      setStatus("error")
      setError(msg)
      throw err instanceof Error ? err : new Error(msg)
    } finally {
      connecting.current = false
    }
  }, [])

  const disconnect = useCallback(() => {
    removeSigner()
    setPubkey(null)
    setStatus("disconnected")
    setError(null)
    localStorage.removeItem(AUTH_STORAGE_KEY)
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY)
    if (stored && hasNip07()) {
      // Don't crash the app on auto-reconnect failure; surface state via `error`.
      void connect().catch(() => undefined)
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
