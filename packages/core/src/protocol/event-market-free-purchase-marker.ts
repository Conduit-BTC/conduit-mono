export const EVENT_MARKET_FREE_PURCHASE_TYPE = "event_market_free_purchase"

/** Reserved machine traffic remains quarantined even when malformed or version-unknown. */
export function isEventMarketFreePurchaseRumor(value: {
  tags?: readonly (readonly string[])[]
  content?: string
}): boolean {
  if (
    value.tags?.some(
      (tag) => tag[0] === "type" && tag[1] === EVENT_MARKET_FREE_PURCHASE_TYPE
    )
  )
    return true
  try {
    const body: unknown = JSON.parse(value.content ?? "")
    return (
      !!body &&
      typeof body === "object" &&
      "type" in body &&
      body.type === EVENT_MARKET_FREE_PURCHASE_TYPE
    )
  } catch {
    return false
  }
}
