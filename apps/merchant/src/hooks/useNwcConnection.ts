import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useAuth } from "@conduit/core"
import {
  NWC_URI_STORAGE_KEY,
  MERCHANT_READINESS_STORAGE_EVENT,
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
  retireMigratedUri: (expectedUri: string) => boolean
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
  const currentKey = useRef(storageKey)
  useLayoutEffect(() => {
    currentKey.current = storageKey
  }, [storageKey])
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (!event.key || event.key === storageKey) onChange()
      }
      window.addEventListener("storage", onStorage)
      window.addEventListener(MERCHANT_READINESS_STORAGE_EVENT, onChange)
      return () => {
        window.removeEventListener("storage", onStorage)
        window.removeEventListener(MERCHANT_READINESS_STORAGE_EVENT, onChange)
      }
    },
    [storageKey]
  )
  const getSnapshot = useCallback(() => readStoredUri(storageKey), [storageKey])
  const rawUri = useSyncExternalStore(subscribe, getSnapshot, () => "")
  const connection = useMemo(() => parseStoredNwcConnection(rawUri), [rawUri])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
  }, [storageKey, rawUri])

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
          notifyMerchantReadinessStorageChange()
          return
        }

        const parsed = parseStoredNwcConnection(trimmed)
        if (!parsed) throw new Error("Invalid NWC URI")

        localStorage.setItem(storageKey, trimmed)
        localStorage.removeItem(NWC_URI_STORAGE_KEY)
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
    setError(null)
    notifyMerchantReadinessStorageChange()
  }, [storageKey])

  const retireMigratedUri = useCallback(
    (expectedUri: string) => {
      if (
        !storageKey ||
        currentKey.current !== storageKey ||
        readStoredUri(storageKey) !== expectedUri
      )
        return false
      localStorage.removeItem(storageKey)
      if (localStorage.getItem(NWC_URI_STORAGE_KEY) === expectedUri)
        localStorage.removeItem(NWC_URI_STORAGE_KEY)
      setError(null)
      notifyMerchantReadinessStorageChange()
      return true
    },
    [storageKey]
  )

  return { connection, rawUri, error, setUri, disconnect, retireMigratedUri }
}
