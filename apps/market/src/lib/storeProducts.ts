import {
  EVENT_KINDS,
  fetchEventsFanout,
  parseProductEvent,
  type Product,
} from "@conduit/core"
import type { NDKEvent, NDKFilter } from "@nostr-dev-kit/ndk"

export async function fetchStoreProducts(pubkey: string): Promise<Product[]> {
  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.PRODUCT],
    authors: [pubkey],
    limit: 50,
  }

  const events = await fetchEventsFanout(filter, {
    connectTimeoutMs: 4_000,
    fetchTimeoutMs: 8_000,
  }) as NDKEvent[]

  return events
    .map((event) => {
      try {
        return parseProductEvent(event)
      } catch {
        return null
      }
    })
    .filter(Boolean) as Product[]
}
