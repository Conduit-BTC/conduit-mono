import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "@conduit/core"
import {
  MERCHANT_READINESS_STORAGE_EVENT,
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
  readCurrentConnection: () => StoredNwcConnection | null
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

  const readCurrentConnection = useCallback(
    () => parseStoredNwcConnection(readStoredUri(storageKey)),
    [storageKey]
  )

  useEffect(() => {
    const syncFromStorage = () => {
      const storedUri = readStoredUri(storageKey)
      setRawUri(storedUri)
      setConnection(parseStoredNwcConnection(storedUri))
      setError(null)
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== storageKey) return
      syncFromStorage()
    }

    syncFromStorage()
    if (typeof window === "undefined") return
    window.addEventListener("storage", handleStorage)
    window.addEventListener(MERCHANT_READINESS_STORAGE_EVENT, syncFromStorage)
    return () => {
      window.removeEventListener("storage", handleStorage)
      window.removeEventListener(
        MERCHANT_READINESS_STORAGE_EVENT,
        syncFromStorage
      )
    }
  }, [storageKey])

  const setUri = useCallback(
    (uri: string) => {
      setError(null)
      try {
        const trimmed = uri.trim()
        if (!storageKey) {
          throw new Error("Connect a signer before adding an NWC URI")
        }

        if (!trimmed) {
          localStorage.removeItem(storageKey)
          setRawUri("")
          setConnection(null)
          notifyMerchantReadinessStorageChange()
          return
        }

        const parsed = parseStoredNwcConnection(trimmed)
        if (!parsed) throw new Error("Invalid NWC URI")

        localStorage.setItem(storageKey, trimmed)
        localStorage.removeItem(NWC_URI_STORAGE_KEY)
        setRawUri(trimmed)
        setConnection(parsed)
        notifyMerchantReadinessStorageChange()
      } catch (err) {
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

  return {
    connection,
    rawUri,
    error,
    setUri,
    disconnect,
    readCurrentConnection,
  }
}
