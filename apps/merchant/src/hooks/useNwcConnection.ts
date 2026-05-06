import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@conduit/core"
import {
  NWC_URI_STORAGE_KEY,
  getNwcUriStorageKey,
  notifyMerchantReadinessStorageChange,
  parseStoredNwcConnection,
  type StoredNwcConnection,
} from "../lib/readiness"

interface UseNwcConnectionResult {
  connection: StoredNwcConnection | null
  rawUri: string
  error: string | null
  setUri: (uri: string) => void
  disconnect: () => void
}

function readStoredUri(storageKey: string | null): string {
  if (!storageKey || typeof localStorage === "undefined") return ""

  try {
    return localStorage.getItem(storageKey) ?? ""
  } catch {
    return ""
  }
}

export function useNwcConnection(): UseNwcConnectionResult {
  const { pubkey } = useAuth()
  const storageKey = useMemo(() => getNwcUriStorageKey(pubkey), [pubkey])
  const [rawUri, setRawUri] = useState(() => readStoredUri(storageKey))
  const [connection, setConnection] = useState<StoredNwcConnection | null>(() =>
    parseStoredNwcConnection(readStoredUri(storageKey))
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const storedUri = readStoredUri(storageKey)
    setRawUri(storedUri)
    setConnection(parseStoredNwcConnection(storedUri))
    setError(null)
  }, [storageKey])

  const setUri = useCallback(
    (uri: string) => {
      setError(null)
      setRawUri(uri)
      try {
        const trimmed = uri.trim()
        if (!storageKey) {
          throw new Error("Connect a signer before adding an NWC URI")
        }

        if (!trimmed) {
          localStorage.removeItem(storageKey)
          setConnection(null)
          notifyMerchantReadinessStorageChange()
          return
        }

        const parsed = parseStoredNwcConnection(trimmed)
        if (!parsed) throw new Error("Invalid NWC URI")

        localStorage.setItem(storageKey, trimmed)
        localStorage.removeItem(NWC_URI_STORAGE_KEY)
        setConnection(parsed)
        notifyMerchantReadinessStorageChange()
      } catch (err) {
        setConnection(null)
        setError(err instanceof Error ? err.message : "Invalid NWC URI")
      }
    },
    [storageKey]
  )

  const disconnect = useCallback(() => {
    if (storageKey) localStorage.removeItem(storageKey)
    localStorage.removeItem(NWC_URI_STORAGE_KEY)
    setRawUri("")
    setConnection(null)
    setError(null)
    notifyMerchantReadinessStorageChange()
  }, [storageKey])

  return { connection, rawUri, error, setUri, disconnect }
}
