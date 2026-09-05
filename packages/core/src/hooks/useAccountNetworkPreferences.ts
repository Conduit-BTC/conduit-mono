import { useCallback, useEffect, useState } from "react"
import {
  reconcileAccountNetworkPreferences,
  type AccountNetworkPreferencesReconciliation,
} from "../protocol/network-preferences"

export type AccountNetworkPreferencesStatus =
  "idle" | "reconciling" | "ready" | "error"

export interface UseAccountNetworkPreferencesResult {
  status: AccountNetworkPreferencesStatus
  reconciliation: AccountNetworkPreferencesReconciliation | null
  error: string | null
  refetch: () => void
}

export interface AccountNetworkPreferencesState {
  contextKey: string | null
  status: AccountNetworkPreferencesStatus
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
      reconciliation: null,
      error: null,
    }
  }
  return {
    status: state.status,
    reconciliation: state.reconciliation,
    error: state.error,
  }
}

/** Reconcile both signed Network frontiers once per fresh signer connection. */
export function useAccountNetworkPreferences(
  pubkey: string | null,
  enabled: boolean
): UseAccountNetworkPreferencesResult {
  const contextKey = enabled ? pubkey?.trim().toLowerCase() || null : null
  const [retryRevision, setRetryRevision] = useState(0)
  const [state, setState] = useState<AccountNetworkPreferencesState>({
    contextKey: null,
    status: "idle",
    reconciliation: null,
    error: null,
  })

  useEffect(() => {
    if (!contextKey) {
      setState({
        contextKey: null,
        status: "idle",
        reconciliation: null,
        error: null,
      })
      return
    }

    let cancelled = false
    setState({
      contextKey,
      status: "reconciling",
      reconciliation: null,
      error: null,
    })
    void reconcileAccountNetworkPreferences(contextKey)
      .then((reconciliation) => {
        if (cancelled) return
        setState({
          contextKey,
          status: "ready",
          reconciliation,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          contextKey,
          status: "error",
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
  }, [contextKey, retryRevision])

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
