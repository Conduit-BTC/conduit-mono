import {
  futureMarketReadyReceiptSchema,
  type FutureMarketReadyReceiptSchema,
} from "../schemas"
import {
  getEventMarketReceiptMerchandise,
  resolveEventMarketReceiptMerchandiseEvidence,
  type EventMarketReceiptMerchandiseItem,
  type EventMarketReceiptMerchandiseResolution,
  type GetEventMarketReceiptMerchandiseInput,
  type ResolveEventMarketReceiptMerchandiseEvidenceInput,
} from "./event-market-merchandise"

export interface FutureMarketReceiptMerchandiseItem extends EventMarketReceiptMerchandiseItem {
  selectedSpecifications?: FutureMarketReadyReceiptSchema["items"][number]["selectedSpecifications"]
}

export interface FutureMarketReceiptMerchandiseResolution extends Omit<
  EventMarketReceiptMerchandiseResolution,
  "items"
> {
  items: FutureMarketReceiptMerchandiseItem[]
}

function includeReceiptSpecifications(
  resolution: EventMarketReceiptMerchandiseResolution,
  receipt: FutureMarketReadyReceiptSchema
): FutureMarketReceiptMerchandiseResolution {
  // Keep the shared reader's authenticated object and its WeakSet certificate.
  const projected: FutureMarketReceiptMerchandiseResolution = resolution
  for (const [index, item] of projected.items.entries()) {
    const specifications = receipt.items[index]?.selectedSpecifications
    if (specifications) {
      item.selectedSpecifications = specifications.map((entry) => ({
        ...entry,
      }))
    }
  }
  return projected
}

/** Resolve exact signed revisions; newer coordinate revisions never substitute. */
export function resolveFutureMarketReceiptMerchandiseEvidence(
  input: Omit<
    ResolveEventMarketReceiptMerchandiseEvidenceInput,
    "receipt" | "receiptRevisionPolicy"
  > & {
    receipt: FutureMarketReadyReceiptSchema
  }
): FutureMarketReceiptMerchandiseResolution {
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  return includeReceiptSpecifications(
    resolveEventMarketReceiptMerchandiseEvidence({
      ...input,
      receipt,
      receiptRevisionPolicy: "historical_physical_receipt",
    }),
    receipt
  )
}

export interface GetFutureMarketReceiptMerchandiseInput extends Omit<
  GetEventMarketReceiptMerchandiseInput,
  "receipt" | "receiptRevisionPolicy"
> {
  receipt: FutureMarketReadyReceiptSchema
}

/** The shared reader owns bounded product and NIP-09 reads and relay planning. */
export async function getFutureMarketReceiptMerchandise(
  input: GetFutureMarketReceiptMerchandiseInput
): Promise<FutureMarketReceiptMerchandiseResolution> {
  const assertCurrent = () => {
    if (input.signal?.aborted || input.shouldContinue?.() === false) {
      throw new DOMException(
        "Receipt merchandise read was cancelled.",
        "AbortError"
      )
    }
  }
  assertCurrent()
  const receipt = futureMarketReadyReceiptSchema.parse(input.receipt)
  const resolution = await getEventMarketReceiptMerchandise({
    ...input,
    receipt,
    receiptRevisionPolicy: "historical_physical_receipt",
  })
  assertCurrent()
  return includeReceiptSpecifications(resolution, receipt)
}
