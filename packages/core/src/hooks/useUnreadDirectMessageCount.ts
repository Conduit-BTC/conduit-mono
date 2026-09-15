import { useEffect, useState } from "react"
import { subscribeUnreadDirectMessageCount } from "../protocol/direct-message-unread"

export interface UnreadDirectMessageCountState {
  /** Unread cached direct messages; 0 without a pubkey or while unavailable. */
  count: number
  /** Set when the local observation failed; the count is then not trusted. */
  error: unknown
}

/**
 * Unread cached direct messages for the signed-in account. The value tracks
 * the local cache, so it updates when the inbox sync stores new messages or a
 * thread is marked read. It never reads relays.
 */
export function useUnreadDirectMessageCount(
  principalPubkey: string | null | undefined
): UnreadDirectMessageCountState {
  const [state, setState] = useState<UnreadDirectMessageCountState>({
    count: 0,
    error: null,
  })

  useEffect(() => {
    setState({ count: 0, error: null })
    if (!principalPubkey) return
    return subscribeUnreadDirectMessageCount(principalPubkey, {
      onChange: (count) => setState({ count, error: null }),
      onError: (error) => setState({ count: 0, error }),
    })
  }, [principalPubkey])

  return principalPubkey ? state : { count: 0, error: null }
}
