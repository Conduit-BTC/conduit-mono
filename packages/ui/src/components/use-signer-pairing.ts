import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

export interface UseSignerPairingOptions {
  autoPrepare: boolean
  connectPending?: boolean
  connectDisabled?: boolean
  rememberedMethod?: "nip07" | "nip46" | null
  nostrConnectUri?: string | null
  error?: string | null
  onConnect: () => Promise<void> | void
  onCancel: () => Promise<void> | void
}

/** Owns preparation for one visible sign-in surface, without interpreting its
 * promise as sign-in success. Auth state remains the source of truth.
 */
export function useSignerPairing(options: UseSignerPairingOptions): {
  start: () => Promise<void>
  run: (connect: () => Promise<void> | void) => Promise<void>
  cancel: () => void
} {
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  }, [options])
  const ownedAttempt = useRef<object | null>(null)
  const prepareOnMount = useRef(
    options.autoPrepare &&
      !options.connectPending &&
      !options.connectDisabled &&
      !options.rememberedMethod &&
      !options.nostrConnectUri &&
      !options.error
  )

  const begin = useCallback(
    async (connect = latest.current.onConnect): Promise<void> => {
      if (ownedAttempt.current) return
      const attempt = {}
      ownedAttempt.current = attempt
      try {
        await connect()
      } finally {
        // A canceled promise can settle after the next attempt has started.
        if (ownedAttempt.current === attempt) ownedAttempt.current = null
      }
    },
    []
  )

  const run = useCallback(
    async (connect: () => Promise<void> | void): Promise<void> => {
      if (latest.current.connectPending || latest.current.connectDisabled)
        return
      await begin(connect)
    },
    [begin]
  )

  const start = useCallback(() => run(latest.current.onConnect), [run])

  const cancel = useCallback((): void => {
    if (!ownedAttempt.current) return
    ownedAttempt.current = null
    // Invoke synchronously: a deferred generic cancel could abort a newer
    // signer operation. The auth callback owns any actionable failure state.
    void Promise.resolve(latest.current.onCancel()).catch(() => undefined)
  }, [])

  useEffect(() => {
    // The initial decision must not follow URI/pending/error updates: those
    // are results of preparation, not reasons to restart it. StrictMode can
    // cancel and prepare again while retaining this mount's initial decision.
    if (prepareOnMount.current) void begin().catch(() => undefined)
    return cancel
  }, [begin, cancel])

  return { start, run, cancel }
}
