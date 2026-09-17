import {
  getMerchantConversationList,
  getProductsByIds,
  hasExactLiveProductAvailabilityEvidence,
  isCommerceReadIncomplete,
  productSchema,
} from "@conduit/core"
import {
  resolveOrganizerEventMarket,
  type MerchantOrganizerEventMarket,
} from "./event-market"
import type {
  MerchantEventHandoffAffectedListing,
  MerchantEventHandoffChangeSourceRead,
} from "./merchant-event-handoff-change"
import { getMerchantOrderSummary } from "./order-phase"
import { verifyAndCheckpointMerchantPickupOrderAuthorization } from "./order-pickup-authority-checkpoint"

export interface MerchantEventHandoffChangeRuntimeDependencies {
  resolveMarket: typeof resolveOrganizerEventMarket
  getProducts: typeof getProductsByIds
  getConversations: typeof getMerchantConversationList
  checkpointOrder: typeof verifyAndCheckpointMerchantPickupOrderAuthorization
}

const runtimeDependencies: MerchantEventHandoffChangeRuntimeDependencies = {
  resolveMarket: resolveOrganizerEventMarket,
  getProducts: getProductsByIds,
  getConversations: getMerchantConversationList,
  checkpointOrder: verifyAndCheckpointMerchantPickupOrderAuthorization,
}

function merchantParticipationCoordinates(
  market: MerchantOrganizerEventMarket,
  merchantPubkey: string
): string[] {
  const normalizedMerchant = merchantPubkey.toLowerCase()
  return Array.from(
    new Set(
      market.participation.flatMap((item) => {
        if (item.status === "organizer_only") return []
        const author = item.productCoordinate.split(":", 3)[1]?.toLowerCase()
        return author === normalizedMerchant ? [item.productCoordinate] : []
      })
    )
  ).sort()
}

/**
 * Read one complete current event/listing source for an arrangement-wide
 * mutation. Cached-only or partial product evidence is not sufficient.
 */
export async function readMerchantEventHandoffChangeSource(
  input: {
    merchantPubkey: string
    marketReference: string
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
  },
  dependencies = runtimeDependencies
): Promise<MerchantEventHandoffChangeSourceRead> {
  const market = await dependencies.resolveMarket(
    input.marketReference,
    undefined,
    input.authenticatedPubkey,
    undefined,
    input.shouldContinue
  )
  if (market.state !== "active") {
    throw new Error(
      "A complete active event read is required before changing its handoff arrangement."
    )
  }
  const coordinates = merchantParticipationCoordinates(
    market,
    input.merchantPubkey
  )
  if (coordinates.length === 0) {
    throw new Error("This merchant has no current event listings to change.")
  }
  const result = await dependencies.getProducts(coordinates, {
    includeMarketHidden: true,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (isCommerceReadIncomplete(result.meta)) {
    throw new Error(
      "Complete current product evidence is required before changing this event arrangement."
    )
  }

  const listings = coordinates.map((coordinate) => {
    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.addressId === coordinate
    )
    const record = result.data.find(
      (candidate) => candidate.addressId === coordinate
    )
    const participation = market.participation.find(
      (candidate) =>
        candidate.status !== "organizer_only" &&
        candidate.productCoordinate === coordinate
    )
    const participationCreatedAt =
      typeof participation?.createdAt === "number" &&
      participation.createdAt >= 1_000_000_000_000
        ? Math.floor(participation.createdAt / 1_000)
        : participation?.createdAt
    if (
      !record ||
      !participation ||
      !participation.eventId ||
      participationCreatedAt === undefined ||
      !hasExactLiveProductAvailabilityEvidence(diagnostic, coordinate) ||
      record.eventId.toLowerCase() !== participation.eventId.toLowerCase() ||
      record.eventCreatedAt !== participationCreatedAt
    ) {
      throw new Error(
        "The event and product reads disagree on an affected listing revision. Refresh before changing the arrangement."
      )
    }
    return {
      eventId: record.eventId.toLowerCase(),
      createdAt: record.eventCreatedAt,
      product: productSchema.parse(record.product),
    }
  })

  return { market, listings }
}

/**
 * Preserve exact existing-order authority before product revisions move. This
 * scans a complete private inbox and never changes order recipients or content.
 */
export async function checkpointMerchantEventHandoffOrders(
  input: {
    merchantPubkey: string
    authenticatedPubkey: string | null
    shouldContinue?: () => boolean
    affectedListings: readonly MerchantEventHandoffAffectedListing[]
  },
  dependencies = runtimeDependencies
): Promise<{ affectedOrderCount: number }> {
  const conversations = await dependencies.getConversations({
    principalPubkey: input.merchantPubkey,
    // The protected inbox read is already bounded and reports incomplete
    // coverage. Do not truncate the verified conversation projection again:
    // every affected historical order must be checkpointed before revisions
    // move.
    limit: Number.MAX_SAFE_INTEGER,
  })
  if (
    isCommerceReadIncomplete(conversations.meta) ||
    conversations.meta.inbox?.declarationState !== "declared" ||
    conversations.meta.inbox.coverage !== "complete"
  ) {
    throw new Error(
      "A complete merchant order inbox read is required before changing this arrangement."
    )
  }
  if (
    conversations.data.some(
      (conversation) => conversation.context !== "complete"
    )
  ) {
    throw new Error(
      "An existing order is missing its original encrypted order message. Recover it before changing this arrangement."
    )
  }

  const affectedCoordinates = new Set(
    input.affectedListings.map((listing) => listing.productCoordinate)
  )
  const affectedOrders = conversations.data.flatMap((conversation) => {
    const summary = getMerchantOrderSummary(conversation)
    return summary.items.some((item) => affectedCoordinates.has(item.productId))
      ? [{ conversation, summary }]
      : []
  })
  for (const { conversation, summary } of affectedOrders) {
    const result = await dependencies.checkpointOrder(
      {
        orderId: conversation.orderId,
        items: summary.items,
        merchantPubkey: input.merchantPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
      },
      undefined,
      { requireDurableCheckpoint: true }
    )
    if (result.status !== "verified" && result.status !== "not_required") {
      throw new Error(
        `Existing order ${conversation.orderId} could not retain its original handoff authority.`
      )
    }
  }
  return { affectedOrderCount: affectedOrders.length }
}
