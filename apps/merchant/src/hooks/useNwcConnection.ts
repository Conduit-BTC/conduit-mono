import { useState, useCallback } from "react"

const STORAGE_KEY_NWC = "conduit:merchant:nwc_uri"

export interface NwcConnection {
  walletPubkey: string
  relays: string[]
  secret: string
  uri: string
}

interface UseNwcConnectionResult {
  connection: NwcConnection | null
  error: string | null
  setUri: (uri: string) => void
  disconnect: () => void
}

function parseNwcUri(uri: string): NwcConnection {
  const withoutScheme = uri.replace("nostr+walletconnect://", "")
  const [walletPubkey, rest] = withoutScheme.split("?", 2)
  const params = new URLSearchParams(rest ?? "")
  const relay = params.get("relay") ?? ""
  const secret = params.get("secret") ?? ""
  return {
    walletPubkey,
    relays: relay ? [relay] : [],
    secret,
    uri,
  }
}

function loadConnection(): NwcConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_NWC)
    if (!raw?.startsWith("nostr+walletconnect://")) return null
    return parseNwcUri(raw)
  } catch {
    return null
  }
}

export function useNwcConnection(): UseNwcConnectionResult {
  const [connection, setConnection] = useState<NwcConnection | null>(
    loadConnection
  )
  const [error, setError] = useState<string | null>(null)

  const setUri = useCallback((uri: string) => {
    setError(null)
    try {
      if (!uri.startsWith("nostr+walletconnect://")) {
        throw new Error("Invalid NWC URI format")
      }
      const parsed = parseNwcUri(uri)
      localStorage.setItem(STORAGE_KEY_NWC, uri)
      setConnection(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid NWC URI")
    }
  }, [])

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY_NWC)
    setConnection(null)
    setError(null)
  }, [])

  return { connection, error, setUri, disconnect }
}
