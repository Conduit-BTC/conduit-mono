/** Conduit opt-in paired with Open Markets hidden visibility, not admission. */
export const PRODUCT_EVENT_ONLY_TAG = "conduit_event_only"

interface ProductEventVisibility {
  visibility: "public" | "private"
  format: "physical" | "digital"
  eventOnly?: boolean
  eventOnlyMalformed?: boolean
}

export function parseProductEventOnlyTags(
  tags: readonly (readonly string[])[]
): { eventOnly: boolean; eventOnlyMalformed: boolean } {
  const markers = tags.filter(([name]) => name === PRODUCT_EVENT_ONLY_TAG)
  if (markers.length === 0)
    return { eventOnly: false, eventOnlyMalformed: false }
  const visibility = tags.filter(([name]) => name === "visibility")
  const types = tags.filter(([name]) => name === "type")
  const valid =
    markers.length === 1 &&
    markers[0]!.length === 2 &&
    markers[0]![1] === "1" &&
    visibility.length === 1 &&
    visibility[0]!.length === 2 &&
    visibility[0]![1] === "hidden" &&
    types.length === 1 &&
    types[0]![2] === "physical" &&
    ["simple", "variable", "variation"].includes(types[0]![1] ?? "")
  return { eventOnly: valid, eventOnlyMalformed: !valid }
}

/** Eligibility only: callers still verify the exact signed occurrence assignment. */
export function hasEventMarketListingVisibility(
  product: ProductEventVisibility
): boolean {
  if (product.eventOnlyMalformed) return false
  return product.eventOnly === true
    ? product.visibility === "private" && product.format === "physical"
    : product.visibility === "public"
}
