import type { StoredMessage } from "../db"
import { getCommerceInbox } from "./commerce-inbox"

/** Legacy migration predicate; unread authority comes from encrypted projections. */
export function isUnreadInboundDirectMessage(row: StoredMessage): boolean {
  return row.read === 0 && (row.kind === 14 || row.kind === 4)
}
export async function countUnreadDirectMessages(
  principalPubkey: string
): Promise<number> {
  const owner = getCommerceInbox(principalPubkey)
  await owner.initialize()
  const snapshot = owner.getSnapshot()
  return snapshot.directMessages.filter(
    (message) =>
      message.senderPubkey !== principalPubkey &&
      snapshot.unreadIds.has(message.id)
  ).length
}
export function subscribeUnreadDirectMessageCount(
  principalPubkey: string,
  observer: { onChange(count: number): void; onError(error: unknown): void }
): () => void {
  try {
    const owner = getCommerceInbox(principalPubkey)
    const changed = () => {
      const snapshot = owner.getSnapshot()
      observer.onChange(
        snapshot.directMessages.filter(
          (message) =>
            message.senderPubkey !== principalPubkey &&
            snapshot.unreadIds.has(message.id)
        ).length
      )
    }
    const stop = owner.subscribe(changed)
    void owner.initialize().then(changed, observer.onError)
    return stop
  } catch (error) {
    observer.onError(error)
    return () => {}
  }
}
