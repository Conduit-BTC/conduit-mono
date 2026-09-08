import { useCallback, useEffect, useRef, useState } from "react"
import { subscribeToAccountNetworkPreferenceRuntimeState } from "../protocol/network-preference-update-state"
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
  const runtimeRecordRef = useRef<{
    contextKey: string
    record: AccountNetworkPreferencesReconciliation["pendingUpdate"]
  } | null>(null)
  const [state, setState] = useState<AccountNetworkPreferencesState>({
    contextKey: null,
    status: "idle",
    localReady: false,
    reconciliation: null,
    error: null,
  })

  useEffect(() => {
    if (!contextKey) {
      runtimeRecordRef.current = null
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
    runtimeRecordRef.current = null
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
        const observedRuntimeRecord =
          runtimeRecordRef.current?.contextKey === contextKey
            ? runtimeRecordRef.current.record
            : undefined
        setState({
          contextKey,
          status: "reconciling",
          localReady: true,
          reconciliation:
            observedRuntimeRecord === undefined
              ? hydration
              : {
                  ...hydration,
                  pendingUpdate: observedRuntimeRecord,
                  pendingUpdateStatus: observedRuntimeRecord ? "ready" : "none",
                },
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
    if (!contextKey) return
    let active = true
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = subscribeToAccountNetworkPreferenceRuntimeState(
        contextKey,
        {
          onChange({ record }) {
            if (!active) return
            runtimeRecordRef.current = { contextKey, record }
            setState((current) => {
              if (
                current.contextKey !== contextKey ||
                !current.reconciliation
              ) {
                return current
              }
              return {
                ...current,
                reconciliation: {
                  ...current.reconciliation,
                  pendingUpdate: record,
                  pendingUpdateStatus: record ? "ready" : "none",
                },
              }
            })
          },
          onError(error) {
            if (!active) return
            setState((current) => {
              if (current.contextKey !== contextKey) return current
              return {
                ...current,
                status: "error",
                reconciliation: current.reconciliation
                  ? {
                      ...current.reconciliation,
                      pendingUpdateStatus: "unavailable",
                    }
                  : null,
                error:
                  error instanceof Error
                    ? error.message
                    : "Unable to synchronize Network preferences",
              }
            })
          },
        }
      )
    } catch (error) {
      if (active) {
        setState((current) => ({
          ...current,
          contextKey,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Unable to synchronize Network preferences",
        }))
      }
    }
    return () => {
      active = false
      unsubscribe()
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
        const observedRuntimeRecord =
          runtimeRecordRef.current?.contextKey === contextKey
            ? runtimeRecordRef.current.record
            : undefined
        setState({
          contextKey,
          status: "ready",
          localReady: true,
          reconciliation:
            observedRuntimeRecord === undefined
              ? reconciliation
              : {
                  ...reconciliation,
                  pendingUpdate: observedRuntimeRecord,
                  pendingUpdateStatus: observedRuntimeRecord ? "ready" : "none",
                },
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
