import type { PublishWithPlannerResult } from "@conduit/core"

export type ProductWriteAction = "publish" | "delete"

export type ProductDeliveryNotice = {
  action: ProductWriteAction
  state: "delivering" | "delivered" | "partial" | "retry_needed"
  title: string
  detail: string
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
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
  delivery: Pick<
    PublishWithPlannerResult,
    "successfulRelayUrls" | "failedRelayUrls"
  >
): ProductDeliveryNotice["state"] {
  if (delivery.failedRelayUrls.length > 0) {
    return delivery.successfulRelayUrls.length > 0 ? "partial" : "retry_needed"
  }
  return "delivered"
}

function mergeRelayUrls(...groups: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(groups.flat()))
}

export function buildProductDeliveryNotice(
  action: ProductWriteAction,
  delivery: PublishWithPlannerResult,
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
  const state = getDeliveryState({
    successfulRelayUrls,
    failedRelayUrls,
  })
  const attemptedCount =
    attemptedRelayUrls.length ||
    successfulRelayUrls.length + failedRelayUrls.length
  const actionLabel = action === "delete" ? "Delete" : "Publish"
  const localEffect =
    action === "delete"
      ? "The listing is hidden locally by a signed tombstone."
      : "The signed listing is visible locally."
  const relaySummary =
    attemptedCount > 0
      ? `ACKed ${successfulRelayUrls.length} of ${getRelayCountLabel(attemptedCount)}.`
      : "Relay delivery completed without per-relay ACK details."
  const retrySummary =
    failedRelayUrls.length > 0
      ? `Use Retry delivery for ${getRelayCountLabel(failedRelayUrls.length)}.`
      : "No relay retry needed."

  return {
    action,
    state,
    title:
      state === "delivered"
        ? `${actionLabel} delivered`
        : state === "partial"
          ? `${actionLabel} partially delivered`
          : `${actionLabel} saved locally`,
    detail: `${localEffect} ${relaySummary} ${retrySummary}`,
    attemptedRelayUrls,
    successfulRelayUrls,
    failedRelayUrls,
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
