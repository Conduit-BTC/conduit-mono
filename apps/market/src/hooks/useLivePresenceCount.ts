import { useEffect, useRef, useState } from "react"
import { conduitBuildInfo, normalizePubkey } from "@conduit/core"
import {
  advanceLivePresenceRequestRevision,
  getLivePresenceCanonicalId,
  hashLivePresenceScope,
  isLivePresencePermitted,
  resolveLivePresenceWebSocketUrl,
  startLivePresenceSession,
  type LivePresencePageType,
  type LivePresenceRuntime,
} from "../lib/live-presence"

type NavigatorWithGlobalPrivacyControl = Navigator & {
  globalPrivacyControl?: boolean
}

export interface UseLivePresenceCountOptions {
  canonicalId: string | null | undefined
  observeCount?: boolean
  pageType: LivePresencePageType
}

export interface UseProductLivePresenceCountOptions {
  merchantPubkey: string | null | undefined
  productCanonicalId: string | null | undefined
}

export function getProductLivePresenceRooms({
  merchantPubkey,
  productCanonicalId,
}: UseProductLivePresenceCountOptions): {
  product: UseLivePresenceCountOptions
  store: UseLivePresenceCountOptions
} {
  return {
    product: {
      canonicalId: productCanonicalId,
      pageType: "product",
    },
    store: {
      canonicalId: normalizePubkey(merchantPubkey),
      observeCount: false,
      pageType: "store",
    },
  }
}

function getBrowserRuntime(): LivePresenceRuntime | null {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof WebSocket === "undefined"
  ) {
    return null
  }

  return {
    createSocket: (url) => new WebSocket(url),
    isOnline: () => navigator.onLine !== false,
    isVisible: () => document.visibilityState === "visible",
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle),
    subscribeActivity: (listener) => {
      document.addEventListener("visibilitychange", listener)
      window.addEventListener("online", listener)
      window.addEventListener("offline", listener)

      return () => {
        document.removeEventListener("visibilitychange", listener)
        window.removeEventListener("online", listener)
        window.removeEventListener("offline", listener)
      }
    },
  }
}

function getGlobalPrivacyControl(): boolean {
  if (typeof navigator === "undefined") return false
  return (
    (navigator as NavigatorWithGlobalPrivacyControl).globalPrivacyControl ===
    true
  )
}

function isLivePresenceFeatureEnabled(): boolean {
  return conduitBuildInfo.publicFeatures.livePresenceEnabled === true
}

export function useLivePresenceCount({
  canonicalId,
  observeCount = true,
  pageType,
}: UseLivePresenceCountOptions): number | null | undefined {
  const endpoint = resolveLivePresenceWebSocketUrl(
    import.meta.env.VITE_PRESENCE_WS_URL,
    conduitBuildInfo.deploymentProfile
  )
  const exactCanonicalId = getLivePresenceCanonicalId(canonicalId)
  const permitted = isLivePresencePermitted({
    featureEnabled: isLivePresenceFeatureEnabled(),
    globalPrivacyControl: getGlobalPrivacyControl(),
  })
  const requestKey =
    permitted && endpoint && exactCanonicalId
      ? JSON.stringify([endpoint, pageType, exactCanonicalId, observeCount])
      : null
  const requestRevisionRef = useRef({ requestKey, revision: 0 })
  requestRevisionRef.current = advanceLivePresenceRequestRevision(
    requestRevisionRef.current,
    requestKey
  )
  const requestRevision = requestRevisionRef.current.revision
  const [snapshot, setSnapshot] = useState<{
    count: number | null
    requestKey: string | null
    requestRevision: number
  }>({ count: null, requestKey: null, requestRevision: -1 })

  useEffect(() => {
    if (!requestKey || !endpoint || !exactCanonicalId) return

    const runtime = getBrowserRuntime()
    if (!runtime) return

    let disposed = false
    let stopSession: (() => void) | null = null

    void hashLivePresenceScope({
      canonicalId: exactCanonicalId,
      hostname: window.location.hostname,
      pageType,
    })
      .then((scopeHash) => {
        if (disposed) return
        stopSession = startLivePresenceSession({
          endpoint,
          scopeHash,
          runtime,
          onCount: (count) => {
            if (observeCount) {
              setSnapshot({ count, requestKey, requestRevision })
            }
          },
        })
      })
      .catch(() => {
        // Browsers without Web Crypto do not participate in live presence.
        if (!disposed && observeCount) {
          setSnapshot({ count: null, requestKey, requestRevision })
        }
      })

    return () => {
      disposed = true
      stopSession?.()
    }
  }, [
    endpoint,
    exactCanonicalId,
    observeCount,
    pageType,
    requestKey,
    requestRevision,
  ])

  if (!requestKey || !observeCount) return undefined

  return snapshot.requestKey === requestKey &&
    snapshot.requestRevision === requestRevision
    ? snapshot.count
    : null
}

export function useProductLivePresenceCount(
  options: UseProductLivePresenceCountOptions
): number | null | undefined {
  const rooms = getProductLivePresenceRooms(options)
  const productCount = useLivePresenceCount(rooms.product)

  // Storefront presence includes visible product sessions for this merchant.
  useLivePresenceCount(rooms.store)

  return productCount
}
