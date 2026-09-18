import { liveQuery } from "dexie"
import { db, type StoredMessage } from "../db"
import { EVENT_KINDS } from "./kinds"

/** Cached row that counts toward the unread badge: an unopened kind-14 or legacy kind-4 message. */
export function isUnreadInboundDirectMessage(row: StoredMessage): boolean {
  return (
    row.read === 0 &&
    (row.kind === EVENT_KINDS.DIRECT_MESSAGE ||
      row.kind === EVENT_KINDS.DM_LEGACY)
  )
}

/**
 * Counts locally cached direct messages addressed to `principalPubkey` that
 * the account has not opened yet. This is a local-cache observation only: it
 * covers messages the inbox sync already stored and never reads relays.
 */
export async function countUnreadDirectMessages(
  principalPubkey: string
): Promise<number> {
  return await db.messages
    .where("recipientPubkey")
    .equals(principalPubkey)
    .filter(isUnreadInboundDirectMessage)
    .count()
}

/** Observe committed unread-count changes in this and other browser contexts. */
export function subscribeUnreadDirectMessageCount(
  principalPubkey: string,
  observer: {
    onChange(count: number): void
    onError(error: unknown): void
  }
): () => void {
  const subscription = liveQuery(() =>
    countUnreadDirectMessages(principalPubkey)
  ).subscribe({
    next: (count) => observer.onChange(count),
    error: (error) => observer.onError(error),
  })
  return () => subscription.unsubscribe()
}
