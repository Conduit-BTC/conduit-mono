import { useCallback, useEffect, useState } from "react"
import {
  hydrateAccountNetworkPreferences,
  reconcileAccountNetworkPreferences,
  type AccountNetworkPreferencesReconciliation,
} from "../protocol/network-preferences"

export type AccountNetworkPreferencesStatus =
  "idle" | "reconciling" | "ready" | "error"

export interface UseAccountNetworkPreferencesResult {
  status: AccountNetworkPreferencesStatus
  /** Validated local authority is installed; fresh relay I/O may still run. */
  localReady: boolean
  reconciliation: AccountNetworkPreferencesReconciliation | null
  error: string | null
  refetch: () => void
}

export interface AccountNetworkPreferencesState {
  contextKey: string | null
  status: AccountNetworkPreferencesStatus
  localReady: boolean
  reconciliation: AccountNetworkPreferencesReconciliation | null
  error: string | null
}

export function prepareAccountNetworkPreferencesPresentation(
  currentContextKey: string | null,
  state: AccountNetworkPreferencesState
): Omit<UseAccountNetworkPreferencesResult, "refetch"> {
  if (state.contextKey !== currentContextKey) {
    return {
      status: currentContextKey ? "reconciling" : "idle",
      localReady: false,
      reconciliation: null,
      error: null,
    }
  }
  return {
    status: state.status,
    localReady: state.localReady,
    reconciliation: state.reconciliation,
    error: state.error,
  }
}

/** Hydrate local authority, then reconcile both frontiers in the background. */
export function useAccountNetworkPreferences(
  pubkey: string | null,
  enabled: boolean,
  freshEnabled = enabled
): UseAccountNetworkPreferencesResult {
  const contextKey = enabled ? pubkey?.trim().toLowerCase() || null : null
  const [retryRevision, setRetryRevision] = useState(0)
  const [state, setState] = useState<AccountNetworkPreferencesState>({
    contextKey: null,
    status: "idle",
    localReady: false,
    reconciliation: null,
    error: null,
  })

  useEffect(() => {
    if (!contextKey) {
      setState({
        contextKey: null,
        status: "idle",
        localReady: false,
        reconciliation: null,
        error: null,
      })
      return
    }

    let cancelled = false
    setState({
      contextKey,
      status: "reconciling",
      localReady: false,
      reconciliation: null,
      error: null,
    })
    void hydrateAccountNetworkPreferences(contextKey)
      .then((hydration) => {
        if (cancelled) return
        setState({
          contextKey,
          status: "reconciling",
          localReady: true,
          reconciliation: hydration,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          contextKey,
          status: "error",
          localReady: false,
          reconciliation: null,
          error:
            error instanceof Error
              ? error.message
              : "Unable to reconcile Network preferences",
        })
      })

    return () => {
      cancelled = true
    }
  }, [contextKey])

  useEffect(() => {
    if (
      !contextKey ||
      !freshEnabled ||
      state.contextKey !== contextKey ||
      !state.localReady
    ) {
      return
    }

    let cancelled = false
    setState((current) => ({
      ...current,
      status: "reconciling",
      error: null,
    }))
    void reconcileAccountNetworkPreferences(contextKey)
      .then((reconciliation) => {
        if (cancelled) return
        setState({
          contextKey,
          status: "ready",
          localReady: true,
          reconciliation,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState((current) => ({
          ...current,
          contextKey,
          status: "error",
          localReady: true,
          error:
            error instanceof Error
              ? error.message
              : "Unable to reconcile Network preferences",
        }))
      })

    return () => {
      cancelled = true
    }
  }, [
    contextKey,
    freshEnabled,
    retryRevision,
    state.contextKey,
    state.localReady,
  ])

  const refetch = useCallback(() => {
    setRetryRevision((current) => current + 1)
  }, [])

  // Effects run after render. Never expose account A's ready state while the
  // render has already switched to account B (or disconnected).
  return {
    ...prepareAccountNetworkPreferencesPresentation(contextKey, state),
    refetch,
  }
}
