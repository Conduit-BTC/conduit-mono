import {
  db,
  EVENT_KINDS,
  retireSupersededStagedProductWriteFromLocalEvidence,
} from "@conduit/core"
import {
  PendingProductStockDeliveryStore,
  withMerchantStockLock,
} from "./productStock"

/** Products' explicit local-only repair, ordered with merchant stock writes. */
export async function repairSupersededStagedProductWrite(input: {
  merchantPubkey: string
  listingJobId: string
  shouldContinue?: () => boolean
}): Promise<void> {
  await withMerchantStockLock(input.merchantPubkey, async () => {
    const job = await db.productListingOutbox.get(input.listingJobId)
    if (!job || job.merchantPubkey !== input.merchantPubkey) {
      throw new Error("Staged product delivery was not found for this merchant")
    }
    const affected = new Set(
      job.signedEvents.flatMap((event) =>
        event.tags
          .filter(([name]) => name === "d")
          .map(
            ([, value]) =>
              `${EVENT_KINDS.PRODUCT}:${input.merchantPubkey}:${value}`
          )
      )
    )
    const deletion = job.companionDeletionJobId
      ? await db.productDeletionOutbox.get(job.companionDeletionJobId)
      : undefined
    for (const [, addressId] of deletion?.signedEvent.tags.filter(
      ([name]) => name === "a"
    ) ?? []) {
      affected.add(addressId)
    }
    if (
      new PendingProductStockDeliveryStore()
        .getPersistedForMerchant(input.merchantPubkey)
        .some((pending) => affected.has(pending.adjustment.addressId))
    ) {
      throw new Error("A signed stock update still needs reconciliation")
    }
    await retireSupersededStagedProductWriteFromLocalEvidence(input)
  })
}
