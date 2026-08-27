import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import type { EventMarketReadyReceiptSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanoutDetailed,
  getEventSourceRelayUrls,
  type FetchEventsFanoutResult,
} from "./ndk"
import {
  isProductDeletedByNip09,
  parseProductAddressCoordinate,
  validateProductDeletionEvent,
  type ProductDeletionEvidence,
} from "./product-deletion"
import { parseProductEvent } from "./products"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import { EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT } from "./event-market"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const MAX_RECEIPT_READ_RELAYS = 8
const RECEIPT_DELETION_REVISIONS_PER_TARGET = 4
const RECEIPT_READ_CONCURRENCY = 4

export interface EventMarketReceiptMerchandiseCoverage {
  attemptedRelayCount: number
  completeRelayCount: number
  partialRelayCount: number
  failedRelayCount: number
}

export type EventMarketReceiptMerchandiseItemState =
  | "verified"
  | "missing"
  | "unavailable"
  | "malformed"
  | "deleted"
  | "conflicting"

export interface EventMarketReceiptMerchandiseItem {
  state: EventMarketReceiptMerchandiseItemState
  product: EventMarketReadyReceiptSchema["items"][number]["product"]
  quantity: number
  title?: string
  sourceRelayUrls: string[]
}

export interface EventMarketReceiptMerchandiseResolution {
  state: EventMarketReceiptMerchandiseItemState
  claimRef: string
  merchantPubkey: string
  organizerPubkey: string
  items: EventMarketReceiptMerchandiseItem[]
  coverage: EventMarketReceiptMerchandiseCoverage
}

const verifiedMerchandiseResolutions =
  new WeakSet<EventMarketReceiptMerchandiseResolution>()

export function isVerifiedEventMarketReceiptMerchandiseResolution(
  resolution: EventMarketReceiptMerchandiseResolution
): boolean {
  return (
    resolution.state === "verified" &&
    verifiedMerchandiseResolutions.has(resolution)
  )
}

export interface ResolveEventMarketReceiptMerchandiseEvidenceInput {
  receipt: EventMarketReadyReceiptSchema
  events: readonly SignedPublicNostrEvent[]
  coverage: EventMarketReceiptMerchandiseCoverage
  sourceRelayUrlsById?: ReadonlyMap<string, readonly string[]>
}

function aggregateState(
  items: readonly EventMarketReceiptMerchandiseItem[]
): EventMarketReceiptMerchandiseItemState {
  for (const state of [
    "conflicting",
    "malformed",
    "deleted",
    "unavailable",
    "missing",
  ] as const) {
    if (items.some((item) => item.state === state)) return state
  }
  return "verified"
}

function eventCoordinate(event: SignedPublicNostrEvent): string | null {
  const dTags = event.tags.filter(
    (tag) => tag[0] === "d" && typeof tag[1] === "string"
  )
  return dTags.length === 1
    ? `${EVENT_KINDS.PRODUCT}:${event.pubkey.toLowerCase()}:${dTags[0]![1]}`
    : null
}

/** Resolve already-fetched exact receipt merchandise without trusting metadata. */
export function resolveEventMarketReceiptMerchandiseEvidence(
  input: ResolveEventMarketReceiptMerchandiseEvidenceInput
): EventMarketReceiptMerchandiseResolution {
  const receipt = input.receipt
  const deletionEvidence: ProductDeletionEvidence[] = []
  for (const event of input.events) {
    const validated = validateProductDeletionEvent(event)
    if (validated) deletionEvidence.push(...validated.evidence)
  }

  const items = receipt.items.map((receiptItem) => {
    const expectedId = receiptItem.product.eventId.toLowerCase()
    const candidates = new Map<string, SignedPublicNostrEvent>()
    for (const event of input.events) {
      if (
        event.kind === EVENT_KINDS.PRODUCT &&
        event.id.toLowerCase() === expectedId
      ) {
        candidates.set(JSON.stringify(event), event)
      }
    }
    const sourceRelayUrls = Array.from(
      new Set(input.sourceRelayUrlsById?.get(expectedId) ?? [])
    )
    if (candidates.size === 0) {
      return {
        state:
          input.coverage.completeRelayCount > 0 ? "missing" : "unavailable",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    }
    if (candidates.size > 1) {
      return {
        state: "conflicting",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    }

    const event = Array.from(candidates.values())[0]!
    const expectedAddress = parseProductAddressCoordinate(
      receiptItem.product.coordinate
    )
    const actualAddress = eventCoordinate(event)
    const validEnvelope =
      expectedAddress !== null &&
      event.kind === EVENT_KINDS.PRODUCT &&
      event.pubkey.toLowerCase() === receipt.merchantPubkey.toLowerCase() &&
      event.pubkey.toLowerCase() === expectedAddress.authorPubkey &&
      actualAddress === expectedAddress.addressId &&
      event.created_at * 1_000 === receiptItem.product.createdAt &&
      isValidSignedPublicNostrEvent(event)
    if (!validEnvelope) {
      return {
        state: "malformed",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    }
    if (
      isProductDeletedByNip09(
        {
          authorPubkey: event.pubkey,
          eventId: event.id,
          addressId: expectedAddress.addressId,
          createdAt: event.created_at,
        },
        deletionEvidence
      )
    ) {
      return {
        state: "deleted",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    }

    try {
      const parsed = parseProductEvent(new NDKEvent(undefined, event))
      if (
        parsed.id !== expectedAddress.addressId ||
        parsed.pubkey.toLowerCase() !== receipt.merchantPubkey.toLowerCase() ||
        parsed.createdAt !== receiptItem.product.createdAt ||
        parsed.priceEvidenceMalformed
      ) {
        throw new Error("Exact receipt product metadata is invalid.")
      }
      return {
        state: "verified",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        title: parsed.title,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    } catch {
      return {
        state: "malformed",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        sourceRelayUrls,
      } satisfies EventMarketReceiptMerchandiseItem
    }
  })

  const resolution: EventMarketReceiptMerchandiseResolution = {
    state: aggregateState(items),
    claimRef: receipt.claimRef,
    merchantPubkey: receipt.merchantPubkey,
    organizerPubkey: receipt.organizerPubkey,
    items,
    coverage: input.coverage,
  }
  if (resolution.state === "verified") {
    verifiedMerchandiseResolutions.add(resolution)
  }
  return resolution
}

interface EventMarketMerchandiseTestOverrides {
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  getRelayLists?: typeof getRelayLists
}

let testOverrides: EventMarketMerchandiseTestOverrides = {}

export function __setEventMarketMerchandiseTestOverrides(
  overrides: EventMarketMerchandiseTestOverrides
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetEventMarketMerchandiseTestOverrides(): void {
  testOverrides = {}
}

function combineCoverage(
  relayUrls: readonly string[],
  results: readonly FetchEventsFanoutResult[]
): EventMarketReceiptMerchandiseCoverage {
  let completeRelayCount = 0
  let partialRelayCount = 0
  let failedRelayCount = 0
  for (const relayUrl of relayUrls) {
    const statuses = results.map(
      (result) =>
        result.relays.find((relay) => relay.relayUrl === relayUrl)?.status ??
        "failed"
    )
    if (statuses.every((status) => status === "success")) {
      completeRelayCount += 1
    } else if (statuses.every((status) => status === "failed")) {
      failedRelayCount += 1
    } else {
      partialRelayCount += 1
    }
  }
  return {
    attemptedRelayCount: relayUrls.length,
    completeRelayCount,
    partialRelayCount,
    failedRelayCount,
  }
}

function rawEvents(result: FetchEventsFanoutResult): {
  events: SignedPublicNostrEvent[]
  sourceRelayUrlsById: Map<string, string[]>
} {
  const events: SignedPublicNostrEvent[] = []
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const event of result.events) {
    const raw = event.rawEvent() as SignedPublicNostrEvent
    events.push(raw)
    const id = raw.id.toLowerCase()
    sourceRelayUrlsById.set(id, [
      ...new Set([
        ...(sourceRelayUrlsById.get(id) ?? []),
        ...getEventSourceRelayUrls(event),
      ]),
    ])
  }
  return { events, sourceRelayUrlsById }
}

export interface GetEventMarketReceiptMerchandiseInput {
  receipt: EventMarketReadyReceiptSchema
  authenticatedPubkey?: string | null
  signal?: AbortSignal
}

/** Bounded exact-id public read for organizer handoff merchandise. */
export async function getEventMarketReceiptMerchandise(
  input: GetEventMarketReceiptMerchandiseInput
): Promise<EventMarketReceiptMerchandiseResolution> {
  if (
    input.receipt.items.length >
    EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT
  ) {
    throw new Error("Receipt merchandise exceeds the bounded read budget.")
  }
  const merchant = input.receipt.merchantPubkey.toLowerCase()
  const lookup = testOverrides.getRelayLists ?? getRelayLists
  const relayLists = await lookup([merchant], {
    signal: input.signal,
    allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
  })
  const plan = planRelayReads({
    intent: "author_products",
    authors: [merchant],
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
    maxRelays: MAX_RECEIPT_READ_RELAYS,
  })
  const relayUrls = plan.relayUrls.slice(0, MAX_RECEIPT_READ_RELAYS)
  const productIds = Array.from(
    new Set(input.receipt.items.map((item) => item.product.eventId))
  )
  const addresses = Array.from(
    new Set(input.receipt.items.map((item) => item.product.coordinate))
  )
  const filters: NDKFilter[] = [
    {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [merchant],
      ids: productIds,
      limit: EVENT_MARKET_PARTICIPATION_FRONTIER_TARGET_LIMIT,
    },
    ...productIds.map((eventId): NDKFilter => ({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchant],
      "#e": [eventId],
      limit: RECEIPT_DELETION_REVISIONS_PER_TARGET,
    })),
    ...addresses.map((address): NDKFilter => ({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchant],
      "#a": [address],
      limit: RECEIPT_DELETION_REVISIONS_PER_TARGET,
    })),
  ]
  const fetch =
    testOverrides.fetchEventsFanoutDetailed ?? fetchEventsFanoutDetailed
  const results: FetchEventsFanoutResult[] = []
  let remainingRelayUrls = [...relayUrls]
  for (
    let index = 0;
    index < filters.length && remainingRelayUrls.length > 0;
    index += RECEIPT_READ_CONCURRENCY
  ) {
    const batch = filters.slice(index, index + RECEIPT_READ_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((filter) =>
        fetch(filter, {
          relayUrls: remainingRelayUrls,
          signal: input.signal,
          reuseRelayConnections: true,
        })
      )
    )
    results.push(...batchResults)
    const incomplete = new Set(
      batchResults.flatMap((result) =>
        result.relays
          .filter((relay) => relay.status !== "success")
          .map((relay) => relay.relayUrl.toLowerCase())
      )
    )
    remainingRelayUrls = remainingRelayUrls.filter(
      (relayUrl) => !incomplete.has(relayUrl.toLowerCase())
    )
  }
  const groups = results.map(rawEvents)
  const events = new Map<string, SignedPublicNostrEvent>()
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const group of groups) {
    for (const event of group.events) events.set(event.id.toLowerCase(), event)
    for (const [id, urls] of group.sourceRelayUrlsById) {
      sourceRelayUrlsById.set(id, [
        ...new Set([...(sourceRelayUrlsById.get(id) ?? []), ...urls]),
      ])
    }
  }
  return resolveEventMarketReceiptMerchandiseEvidence({
    receipt: input.receipt,
    events: Array.from(events.values()),
    sourceRelayUrlsById,
    coverage: combineCoverage(relayUrls, results),
  })
}
