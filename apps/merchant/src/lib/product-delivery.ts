import {
  EVENT_KINDS,
  isTerminalRecoverableProductListingJob,
  productDeletionEvidenceFromSignedEvent,
  type ProductDeletionDeliveryJob,
  type ProductListingDeliveryJob,
  type PublishWithPlannerResult,
} from "@conduit/core"
import type { ProductWriteDeliveryResult } from "./product-publishing"

type ProductFamilyRecoveryRecord = {
  eventId: string
  dTag: string | null
  product: { pubkey: string }
}

export function getRejectedMixedDeletionRecoveryTargets(
  job: ProductDeletionDeliveryJob,
  merchantPubkey: string
): { eventId: string; addressId: string; sourceRelayUrls: string[] }[] | null {
  if (job.signedEvent.pubkey !== merchantPubkey) return null
  const eventIds = job.signedEvent.tags
    .filter(([name]) => name === "e")
    .map(([, eventId]) => eventId)
  const addresses = job.signedEvent.tags
    .filter(([name]) => name === "a")
    .map(([, addressId]) => addressId)
  const evidence = productDeletionEvidenceFromSignedEvent(job.signedEvent)
  if (
    !eventIds.length ||
    eventIds.length !== addresses.length ||
    new Set(eventIds).size !== eventIds.length ||
    new Set(addresses).size !== addresses.length ||
    evidence?.length !== eventIds.length + addresses.length ||
    eventIds.some((id) => !/^[0-9a-f]{64}$/.test(id ?? "")) ||
    addresses.some(
      (address) =>
        !address?.startsWith(`${EVENT_KINDS.PRODUCT}:${merchantPubkey}:`)
    )
  ) {
    return null
  }
  const sourceRelayUrls = job.relayPlan
    .filter((target) => target.roles.includes("source"))
    .map((target) => target.relayUrl)
  return eventIds.map((eventId, index) => ({
    eventId: eventId!,
    addressId: addresses[index]!,
    sourceRelayUrls,
  }))
}

/**
 * A failed outbox row is historical evidence, not permission to re-sign a
 * stale product. Only the current, same-author local revision may be
 * explicitly restarted against a new relay plan.
 */
export function getTerminalRejectedListingRecoveryDTags(
  job: ProductListingDeliveryJob,
  family: ProductFamilyRecoveryRecord & {
    variations: readonly ProductFamilyRecoveryRecord[]
  },
  companionDeletion?: ProductDeletionDeliveryJob
): string[] | null {
  if (!isTerminalRecoverableProductListingJob(job)) {
    return null
  }
  if (job.companionDeletionJobId) {
    // A failed mixed family must restart both signed intents together. Its
    // original deletion is still queued, never independently actionable.
    if (
      !companionDeletion ||
      companionDeletion.id !== job.companionDeletionJobId ||
      companionDeletion.companionListingJobId !== job.id ||
      companionDeletion.signedEvent.id !== companionDeletion.id ||
      companionDeletion.signedEvent.pubkey !== job.merchantPubkey ||
      companionDeletion.state !== "pending" ||
      companionDeletion.deliveryAttemptCount !== 0 ||
      companionDeletion.relayDelivery.some(
        (delivery) =>
          delivery.status !== "pending" || delivery.attemptCount !== 0
      ) ||
      !getRejectedMixedDeletionRecoveryTargets(
        companionDeletion,
        job.merchantPubkey
      )
    ) {
      return null
    }
  } else if (companionDeletion) {
    return null
  }
  const records = [family, ...family.variations]
  if (records.some((record) => record.product.pubkey !== job.merchantPubkey)) {
    return null
  }
  const byDTag = new Map(records.map((record) => [record.dTag, record]))
  const dTags: string[] = []
  for (const event of job.signedEvents) {
    if (
      event.kind !== EVENT_KINDS.PRODUCT ||
      event.pubkey !== job.merchantPubkey
    ) {
      return null
    }
    const dTagsInEvent = event.tags.filter(([name]) => name === "d")
    const dTag = dTagsInEvent.length === 1 ? dTagsInEvent[0]?.[1] : undefined
    if (
      !dTag ||
      dTags.includes(dTag) ||
      byDTag.get(dTag)?.eventId !== event.id
    ) {
      return null
    }
    dTags.push(dTag)
  }
  return dTags
}

export type ProductWriteAction = "publish" | "delete"

export function reconcilePendingProductDeletionRetry<
  TState extends { action: ProductWriteAction },
>(current: TState | null, pendingDeletionRetry: TState): TState {
  return current?.action === "publish" ? current : pendingDeletionRetry
}

export type ProductDeliveryNotice = {
  action: ProductWriteAction
  state:
    | "delivering"
    | "delivered"
    | "partial"
    | "retry_needed"
    | "rejected"
    | "failed"
  title: string
  detail: string
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  rejectedRelayUrls: string[]
}

function getRelayCountLabel(count: number): string {
  return `${count} relay${count === 1 ? "" : "s"}`
}

export function formatProductRelayUrls(urls: readonly string[]): string {
  if (urls.length === 0) return "none"
  const visible = urls.slice(0, 4)
  const suffix =
    urls.length > visible.length
      ? `, +${urls.length - visible.length} more`
      : ""
  return `${visible.join(", ")}${suffix}`
}

function getDeliveryState(
  action: ProductWriteAction,
  delivery: Pick<
    PublishWithPlannerResult,
    "successfulRelayUrls" | "failedRelayUrls" | "rejectedRelayUrls"
  >,
  hasOutstandingDeletion = false
): ProductDeliveryNotice["state"] {
  if (delivery.failedRelayUrls.length > 0) {
    // A NIP-09 deletion is converged only when every planned target ACKs.
    // Unlike a listing family, even an explicit relay rejection remains in
    // the exact signed deletion's durable retry lane.
    if (action === "delete" || hasOutstandingDeletion) {
      return delivery.successfulRelayUrls.length > 0
        ? "partial"
        : "retry_needed"
    }
    const rejectedRelayUrls = new Set(delivery.rejectedRelayUrls ?? [])
    if (delivery.failedRelayUrls.every((url) => rejectedRelayUrls.has(url))) {
      return delivery.successfulRelayUrls.length > 0 ? "delivered" : "rejected"
    }
    return delivery.successfulRelayUrls.length > 0 ? "partial" : "retry_needed"
  }
  return "delivered"
}

function mergeRelayUrls(...groups: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(groups.flat()))
}

export function buildProductDeliveryNotice(
  action: ProductWriteAction,
  delivery: ProductWriteDeliveryResult,
  previous?: ProductDeliveryNotice
): ProductDeliveryNotice {
  const attemptedRelayUrls = previous
    ? mergeRelayUrls(
        previous.attemptedRelayUrls,
        previous.successfulRelayUrls,
        previous.failedRelayUrls,
        delivery.attemptedRelayUrls,
        delivery.successfulRelayUrls,
        delivery.failedRelayUrls
      )
    : delivery.attemptedRelayUrls
  const successfulRelayUrls = previous
    ? mergeRelayUrls(previous.successfulRelayUrls, delivery.successfulRelayUrls)
    : delivery.successfulRelayUrls
  const successfulRelaySet = new Set(successfulRelayUrls)
  const failedRelayUrls = previous
    ? attemptedRelayUrls.filter((url) => !successfulRelaySet.has(url))
    : delivery.failedRelayUrls
  const rejectedRelayUrls = failedRelayUrls.filter((url) =>
    mergeRelayUrls(
      previous?.rejectedRelayUrls ?? [],
      delivery.rejectedRelayUrls ?? []
    ).includes(url)
  )
  const state = getDeliveryState(
    action,
    {
      successfulRelayUrls,
      failedRelayUrls,
      rejectedRelayUrls,
    },
    !!delivery.outstandingDeletion
  )
  const totalRelayCount = mergeRelayUrls(
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls
  ).length
  const actionLabel = action === "delete" ? "Delete" : "Publish"
  const localEffect =
    action === "delete"
      ? "The listing is hidden locally by a signed tombstone."
      : "The signed listing is visible locally."
  const relaySummary =
    totalRelayCount > 0
      ? `ACKed ${successfulRelayUrls.length} of ${getRelayCountLabel(totalRelayCount)}.`
      : "Relay delivery completed without per-relay ACK details."
  const retryableRelayUrls = failedRelayUrls.filter(
    (url) =>
      action === "delete" ||
      !!delivery.outstandingDeletion ||
      !rejectedRelayUrls.includes(url)
  )
  const retrySummary =
    retryableRelayUrls.length > 0
      ? `${(action === "delete" || delivery.outstandingDeletion) && rejectedRelayUrls.length > 0 ? `${getRelayCountLabel(rejectedRelayUrls.length)} rejected the signed deletion. ` : ""}Use Retry delivery for ${getRelayCountLabel(retryableRelayUrls.length)}.`
      : rejectedRelayUrls.length > 0
        ? state === "rejected"
          ? `${getRelayCountLabel(rejectedRelayUrls.length)} rejected the signed event; there is nothing left to retry. Repair Network Settings, then sign a new delivery.`
          : `${getRelayCountLabel(rejectedRelayUrls.length)} rejected the signed event; there is nothing left to retry.`
        : "No relay retry needed."

  return {
    action,
    state,
    title:
      state === "delivered"
        ? `${actionLabel} delivered`
        : state === "partial"
          ? `${actionLabel} partially delivered`
          : state === "rejected"
            ? `${actionLabel} rejected`
            : `${actionLabel} saved locally`,
    detail: `${localEffect} ${relaySummary} ${retrySummary}`,
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
    rejectedRelayUrls,
  }
}

/** Choose the actionable signed job, without mixing listing ACKs into deletion truth. */
export function resolveProductWriteDeliveryNotice(
  delivery: ProductWriteDeliveryResult,
  previous?: ProductDeliveryNotice
): { notice: ProductDeliveryNotice; retryDeletionJobId?: string } {
  if (delivery.outstandingDeletion) {
    // This is the first notice for this job. Exact deletion retries merge their
    // own prior delete notice through the deletion mutation instead.
    return {
      notice: buildProductDeliveryNotice(
        "delete",
        delivery.outstandingDeletion.delivery
      ),
      retryDeletionJobId: delivery.outstandingDeletion.jobId,
    }
  }
  return {
    notice: buildProductDeliveryNotice(
      "publish",
      delivery,
      previous?.action === "publish" ? previous : undefined
    ),
  }
}

export function buildLocalProductDeliveryNotice(
  action: ProductWriteAction
): ProductDeliveryNotice {
  return {
    action,
    state: "delivering",
    title:
      action === "delete" ? "Delete signed locally" : "Publish signed locally",
    detail:
      action === "delete"
        ? "The listing is hidden locally by a signed tombstone. Relay delivery is in progress."
        : "The signed listing is visible locally. Relay delivery is in progress.",
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    rejectedRelayUrls: [],
  }
}

export function buildLocalProductRetryNotice(
  action: ProductWriteAction
): ProductDeliveryNotice {
  return {
    action,
    state: "retry_needed",
    title:
      action === "delete" ? "Delete saved locally" : "Publish saved locally",
    detail:
      action === "delete"
        ? "The listing remains hidden locally. Use Retry delivery to try the relays again."
        : "The signed listing remains visible locally. Use Retry delivery to try the relays again.",
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    rejectedRelayUrls: [],
  }
}

export function buildLocalProductQueueFailureNotice(
  action: ProductWriteAction
): ProductDeliveryNotice {
  return {
    action,
    state: "failed",
    title:
      action === "delete"
        ? "Delete delivery was not queued"
        : "Publish delivery was not queued",
    detail:
      action === "delete"
        ? "The local delete could not be saved for safe relay delivery. No relay delivery was attempted. Start the delete again."
        : "The signed listing could not be saved for safe relay delivery. No relay delivery was attempted. Open the listing and publish it again.",
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    rejectedRelayUrls: [],
  }
}

export function buildQueuedProductDeletionNotice(
  state: "delivering" | "retry_needed"
): ProductDeliveryNotice {
  const retryNeeded = state === "retry_needed"
  return {
    action: "delete",
    state,
    title: retryNeeded ? "Delete needs local retry" : "Restoring signed delete",
    detail: retryNeeded
      ? "The signed deletion is saved, but its local tombstone could not be confirmed. Use Retry delivery to restore it before contacting relays."
      : "The signed deletion is saved. Confirming its local tombstone before contacting relays.",
    attemptedRelayUrls: [],
    successfulRelayUrls: [],
    failedRelayUrls: [],
    rejectedRelayUrls: [],
  }
}

export function getProductDeliveryNoticeVariant(
  state: ProductDeliveryNotice["state"]
): "success" | "warning" | "error" | "info" {
  if (state === "delivering") return "info"
  if (state === "delivered") return "success"
  if (state === "partial") return "warning"
  return "error"
}
