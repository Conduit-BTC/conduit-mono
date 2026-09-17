import { useEffect, useState } from "react"
import { subscribeUnreadDirectMessageCount } from "../protocol/direct-message-unread"

export interface UnreadDirectMessageCountState {
  /** Unread cached direct messages; 0 without a pubkey or while unavailable. */
  count: number
  /** Set when the local observation failed; the count is then not trusted. */
  error: unknown
}

interface UnreadDirectMessageCountSnapshot extends UnreadDirectMessageCountState {
  principalPubkey: string
}

const EMPTY_UNREAD_DIRECT_MESSAGE_COUNT: UnreadDirectMessageCountState = {
  count: 0,
  error: null,
}

/**
 * Unread cached direct messages for the signed-in account. The value tracks
 * the local cache, so it updates when the inbox sync stores new messages or a
 * thread is marked read. It never reads relays.
 */
export function useUnreadDirectMessageCount(
  principalPubkey: string | null | undefined
): UnreadDirectMessageCountState {
  const [snapshot, setSnapshot] =
    useState<UnreadDirectMessageCountSnapshot | null>(null)

  useEffect(() => {
    if (!principalPubkey) return
    return subscribeUnreadDirectMessageCount(principalPubkey, {
      onChange: (count) => setSnapshot({ principalPubkey, count, error: null }),
      onError: (error) => setSnapshot({ principalPubkey, count: 0, error }),
    })
  }, [principalPubkey])

  if (!principalPubkey || snapshot?.principalPubkey !== principalPubkey) {
    return EMPTY_UNREAD_DIRECT_MESSAGE_COUNT
  }
  return snapshot
}
