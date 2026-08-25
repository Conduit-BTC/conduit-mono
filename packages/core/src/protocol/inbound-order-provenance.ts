import type { CachedOrderMessage } from "../db"
import { parseCachedOrderMessage, type ParsedOrderMessage } from "./orders"

export interface ValidatedInboundOrderLifecycleAnchor {
  readonly eventId: string
  readonly orderId: string
  readonly buyerPubkey: string
  readonly merchantPubkey: string
}

/**
 * Parse a durable cache row after its storage envelope matches.
 *
 * Cache self-consistency is sufficient for display projection, but it is not
 * authenticated NIP-59 provenance and must never mint lifecycle write
 * authority. A live authenticated unwrap replaces this projection before an
 * order can authorize a merchant self-record.
 */
export function parseValidatedCachedOrderMessageEnvelope(
  row: CachedOrderMessage
): ParsedOrderMessage | null {
  try {
    const message = parseCachedOrderMessage(JSON.parse(row.rawContent))
    if (
      message.id !== row.id ||
      message.orderId !== row.orderId ||
      message.type !== row.type ||
      message.senderPubkey !== row.senderPubkey ||
      message.recipientPubkey !== row.recipientPubkey ||
      message.createdAt !== row.createdAt
    ) {
      return null
    }
    return message
  } catch {
    return null
  }
}
