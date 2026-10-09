import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
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
  refetch: () => Promise<AccountNetworkPreferencesReconciliation | null>
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
  freshEnabled = enabled,
  authGeneration = 0
): UseAccountNetworkPreferencesResult {
  const contextKey = enabled ? pubkey?.trim().toLowerCase() || null : null
  const authGenerationRef = useRef(authGeneration)
  const reconciliationControllerRef = useRef<AbortController | null>(null)
  const contextKeyRef = useRef(contextKey)
  const reconciliationRevisionRef = useRef(0)
  const [state, setState] = useState<AccountNetworkPreferencesState>({
    contextKey: null,
    status: "idle",
    localReady: false,
    reconciliation: null,
    error: null,
  })

  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
    contextKeyRef.current = contextKey
    reconciliationRevisionRef.current += 1
    return () => {
      reconciliationControllerRef.current?.abort()
      reconciliationControllerRef.current = null
    }
  }, [authGeneration, contextKey])

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

  const refetch =
    useCallback(async (): Promise<AccountNetworkPreferencesReconciliation | null> => {
      if (!contextKey || !freshEnabled) return null
      reconciliationControllerRef.current?.abort()
      const controller = new AbortController()
      const revision = ++reconciliationRevisionRef.current
      reconciliationControllerRef.current = controller
      const shouldContinue = () =>
        !controller.signal.aborted &&
        contextKeyRef.current === contextKey &&
        authGenerationRef.current === authGeneration &&
        reconciliationRevisionRef.current === revision
      setState((current) => ({
        ...current,
        status: "reconciling",
        error: null,
      }))
      try {
        const reconciliation = await reconcileAccountNetworkPreferences(
          contextKey,
          {
            requestingAccountPubkey: contextKey,
            authenticatedPubkey: contextKey,
            signal: controller.signal,
            shouldContinue,
          }
        )
        if (!shouldContinue()) return null
        setState({
          contextKey,
          status: "ready",
          localReady: true,
          reconciliation,
          error: null,
        })
        return reconciliation
      } catch (error) {
        if (shouldContinue())
          setState((current) => ({
            ...current,
            contextKey,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Unable to reconcile Network preferences",
          }))
        return null
      } finally {
        if (reconciliationControllerRef.current === controller)
          reconciliationControllerRef.current = null
      }
    }, [authGeneration, contextKey, freshEnabled])

  useEffect(() => {
    if (
      !contextKey ||
      !freshEnabled ||
      state.contextKey !== contextKey ||
      !state.localReady
    )
      return
    void refetch()
    return () => {
      reconciliationControllerRef.current?.abort()
    }
  }, [contextKey, freshEnabled, refetch, state.contextKey, state.localReady])

  // Effects run after render. Never expose account A's ready state while the
  // render has already switched to account B (or disconnected).
  return {
    ...prepareAccountNetworkPreferencesPresentation(contextKey, state),
    refetch,
  }
}
