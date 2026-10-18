/** Reserved Conduit-private machine traffic, never a human conversation. */
export const EVENT_MARKET_STOCK_AUTHORITY_SUBJECT = "conduit-event-stock"
export const EVENT_MARKET_STOCK_AUTHORITY_MARKER = [
  "conduit",
  "event-stock",
  "1",
] as const

/** Quarantine reserved markers even when the message kind or version is invalid. */
export function isEventMarketStockAuthorityRumor(rumor: {
  readonly tags: unknown
}): boolean {
  return (
    Array.isArray(rumor.tags) &&
    rumor.tags.some(
      (tag) =>
        Array.isArray(tag) &&
        ((tag[0] === "subject" &&
          (tag[1] === EVENT_MARKET_STOCK_AUTHORITY_SUBJECT ||
            tag[1] === "conduit-event-stock-handover" ||
            tag[1] === "conduit-event-stock-checkpoint")) ||
          (tag[0] === EVENT_MARKET_STOCK_AUTHORITY_MARKER[0] &&
            (tag[1] === EVENT_MARKET_STOCK_AUTHORITY_MARKER[1] ||
              tag[1] === "event-stock-handover" ||
              tag[1] === "event-stock-checkpoint")))
    )
  )
}
