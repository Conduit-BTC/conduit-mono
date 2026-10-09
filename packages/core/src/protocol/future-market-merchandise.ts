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
import { hasExactSelectedProductSpecifications } from "./event-market-order-evidence"
import { admitPublicEvent, isVerifiedNostrEvent } from "./verified-public-event"

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
  let invalidSelection = false
  const items = resolution.items.map((item, index) => {
    const specifications = receipt.items[index]?.selectedSpecifications
    if (item.state !== "verified") return item
    if (
      !item.signedProduct ||
      !hasExactSelectedProductSpecifications(item.signedProduct, specifications)
    ) {
      invalidSelection = true
      return { ...item, state: "malformed" as const, signedProduct: undefined }
    }
    return specifications
      ? {
          ...item,
          selectedSpecifications: specifications.map((entry) => ({ ...entry })),
        }
      : item
  })
  if (invalidSelection) {
    // A copied certificate cannot authenticate changed buyer labels.
    return { ...resolution, state: "malformed", items }
  }
  // Keep the shared reader's authenticated object and its WeakSet certificate.
  resolution.items = items
  return resolution
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
  const embedded = input.receipt.items.flatMap((item) =>
    item.product.signedEvent && isVerifiedNostrEvent(item.product.signedEvent)
      ? [item.product.signedEvent]
      : []
  )
  const embeddedIds = new Set(embedded.map((event) => event.id))
  return includeReceiptSpecifications(
    resolveEventMarketReceiptMerchandiseEvidence({
      ...input,
      receipt,
      // The authenticated receipt's pinned bytes take priority over relay copies.
      events: [
        ...embedded,
        ...input.events.filter((event) => !embeddedIds.has(event.id)),
      ],
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

/** Embedded public revisions need no relay retention; legacy refs use the shared reader. */
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
  const admittedEmbedded = await Promise.all(
    receipt.items.map(async (item) => {
      const raw = item.product.signedEvent
      if (!raw) return undefined
      const admission = await admitPublicEvent(raw, { signal: input.signal })
      if (admission.status === "cancelled") {
        throw new DOMException(
          "Receipt merchandise read was cancelled.",
          "AbortError"
        )
      }
      if (admission.status === "unavailable") {
        throw new Error("Receipt merchandise verification is unavailable.")
      }
      // Keep invalid bytes as evidence of a malformed carried item; the
      // synchronous resolver will not treat them as verified merchandise.
      return admission.status === "verified" ? admission.event : raw
    })
  )
  assertCurrent()
  const local = resolveFutureMarketReceiptMerchandiseEvidence({
    receipt,
    events: admittedEmbedded.filter((event) => event !== undefined),
    coverage: {
      attemptedRelayCount: 0,
      completeRelayCount: 0,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  })
  const missingItems = receipt.items.filter((item) => !item.product.signedEvent)
  if (
    missingItems.length === 0 ||
    local.items.some(
      (item, index) =>
        receipt.items[index]!.product.signedEvent && item.state !== "verified"
    )
  ) {
    // Invalid supplied evidence never falls back to a different relay revision.
    assertCurrent()
    return local
  }
  const resolution = await getEventMarketReceiptMerchandise({
    ...input,
    receipt: { ...receipt, items: missingItems },
    receiptRevisionPolicy: "historical_physical_receipt",
  })
  assertCurrent()
  const fetchedById = new Map(
    resolution.items.map((item) => [item.product.eventId, item])
  )
  // Preserve the shared reader's certificate: every added embedded item was
  // independently authenticated above; the fallback covers only absent bytes.
  resolution.items = receipt.items.map((item, index) =>
    item.product.signedEvent
      ? local.items[index]!
      : fetchedById.get(item.product.eventId)!
  )
  return includeReceiptSpecifications(resolution, receipt)
}
