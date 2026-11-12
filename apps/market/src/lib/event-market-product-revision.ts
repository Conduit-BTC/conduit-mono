import {
  cacheSignedProductListingEvent,
  type SignedPublicNostrEvent,
} from "@conduit/core"

/** An authority-observed revision must be reviewed before an item is added. */
export async function assertReviewedEventMarketProductRevision(
  displayedEventId: string | undefined,
  currentRevision: SignedPublicNostrEvent
): Promise<void> {
  if (currentRevision.id === displayedEventId) return
  // Shared custody lets the next configured-feed view retain stronger signed
  // terms learned during this explicit action, even if peers still serve old data.
  await cacheSignedProductListingEvent(currentRevision)
  throw new Error(
    "Product details changed. Review the refreshed item before adding it."
  )
}
