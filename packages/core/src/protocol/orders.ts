import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { orderSchema, type OrderSchema } from "../schemas"

/**
 * Parse a Conduit MVP order rumor event (kind 16) from its JSON content.
 */
export function parseOrderRumorEvent(event: Pick<NDKEvent, "content">): OrderSchema {
  const parsed = JSON.parse(event.content || "{}") as unknown
  return orderSchema.parse(parsed)
}

