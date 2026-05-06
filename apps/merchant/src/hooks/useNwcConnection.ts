import { useState, useCallback } from "react"
import {
  NWC_URI_STORAGE_KEY,
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

function readStoredUri(): string {
  if (typeof localStorage === "undefined") return ""

  try {
    return localStorage.getItem(NWC_URI_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

export function useNwcConnection(): UseNwcConnectionResult {
  const [rawUri, setRawUri] = useState(readStoredUri)
  const [connection, setConnection] = useState<StoredNwcConnection | null>(() =>
    parseStoredNwcConnection(readStoredUri())
  )
  const [error, setError] = useState<string | null>(null)

  const setUri = useCallback((uri: string) => {
    setError(null)
    setRawUri(uri)
    try {
      const trimmed = uri.trim()
      if (!trimmed) {
        localStorage.removeItem(NWC_URI_STORAGE_KEY)
        setConnection(null)
        notifyMerchantReadinessStorageChange()
        return
      }

      const parsed = parseStoredNwcConnection(trimmed)
      if (!parsed) throw new Error("Invalid NWC URI")

      localStorage.setItem(NWC_URI_STORAGE_KEY, trimmed)
      setConnection(parsed)
      notifyMerchantReadinessStorageChange()
    } catch (err) {
      setConnection(null)
      setError(err instanceof Error ? err.message : "Invalid NWC URI")
    }
  }, [])

  const disconnect = useCallback(() => {
    localStorage.removeItem(NWC_URI_STORAGE_KEY)
    setRawUri("")
    setConnection(null)
    setError(null)
    notifyMerchantReadinessStorageChange()
  }, [])

  return { connection, rawUri, error, setUri, disconnect }
}
