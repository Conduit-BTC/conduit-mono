import { conduitBuildInfo } from "@conduit/core"
import { useEffect, useMemo, useState } from "react"
import {
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
  pageType: LivePresencePageType
  serviceUrl?: string | null
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
  pageType,
  serviceUrl,
}: UseLivePresenceCountOptions): number | null {
  const endpoint = useMemo(
    () => resolveLivePresenceWebSocketUrl(serviceUrl ?? undefined),
    [serviceUrl]
  )
  const normalizedCanonicalId = canonicalId?.trim() || null
  const permitted = isLivePresencePermitted({
    featureEnabled: isLivePresenceFeatureEnabled(),
    globalPrivacyControl: getGlobalPrivacyControl(),
  })
  const requestKey =
    permitted && endpoint && normalizedCanonicalId
      ? JSON.stringify([endpoint, pageType, normalizedCanonicalId])
      : null
  const [snapshot, setSnapshot] = useState<{
    count: number | null
    requestKey: string | null
  }>({ count: null, requestKey: null })

  useEffect(() => {
    if (!requestKey || !endpoint || !normalizedCanonicalId) return

    const runtime = getBrowserRuntime()
    if (!runtime) return

    let disposed = false
    let stopSession: (() => void) | null = null

    void hashLivePresenceScope({
      canonicalId: normalizedCanonicalId,
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
            setSnapshot({ count, requestKey })
          },
        })
      })
      .catch(() => {
        // Browsers without Web Crypto do not participate in live presence.
      })

    return () => {
      disposed = true
      stopSession?.()
    }
  }, [endpoint, normalizedCanonicalId, pageType, requestKey])

  return snapshot.requestKey === requestKey ? snapshot.count : null
}
