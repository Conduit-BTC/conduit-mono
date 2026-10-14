import { parsePrivateOrderProductFields } from "./products"
import { parseProductSupplierAllocationTags } from "./product-supplier-allocation"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/** Private immutable checkout evidence, not public catalog admission. */
export function parseCheckoutSparkSignedProductFields(
  event: SignedPublicNostrEvent
) {
  if (event.kind !== 30_402 || !isValidSignedPublicNostrEvent(event)) {
    throw new Error("Checkout Spark signed product evidence is invalid.")
  }
  const fields = parsePrivateOrderProductFields(event)
  return {
    ...fields,
    supplierAllocation: parseProductSupplierAllocationTags({
      tags: event.tags,
      merchantPubkey: event.pubkey,
      signedRevisionEvent: event,
    }),
  }
}
