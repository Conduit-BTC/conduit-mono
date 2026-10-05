import type { Filter } from "nostr-tools"
import type { FutureMarketReadyReceiptSchema } from "../schemas"
import { EVENT_KINDS } from "./kinds"
import { filterEligibleAccountRelayUrls } from "./account-network-local-state"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import {
  fetchSignedEventsFanoutDetailed,
  getEventSourceRelayUrls,
  type PublicRelayReadOptions,
  type PublicRelayReadResult,
} from "./relay-reader"
import {
  isProductDeletedByNip09,
  parseProductAddressCoordinate,
  validateProductDeletionEvent,
  type ProductDeletionEvidence,
} from "./product-deletion"
import { parseProductEvent } from "./products"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import { normalizeOwnerSelectedRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

// Client execution budget; this is not a protocol receipt item limit.
const MAX_RECEIPT_ITEMS = 64
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
  product: FutureMarketReadyReceiptSchema["items"][number]["product"]
  quantity: number
  title?: string
  /** Parsed from the exact authenticated product revision. */
  signedProduct?: Pick<
    ReturnType<typeof parseProductEvent>,
    "type" | "specifications"
  >
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

/** Only receipt identity and exact item snapshots are needed for this read. */
export type EventMarketReceiptMerchandiseEvidence = Pick<
  FutureMarketReadyReceiptSchema,
  "claimRef" | "merchantPubkey" | "organizerPubkey"
> & {
  items: readonly Pick<
    FutureMarketReadyReceiptSchema["items"][number],
    "product" | "quantity"
  >[]
}

export interface ResolveEventMarketReceiptMerchandiseEvidenceInput {
  receipt: EventMarketReceiptMerchandiseEvidence
  /** Future physical release terms remain pinned despite later listing deletion. */
  receiptRevisionPolicy?: "current_product" | "historical_physical_receipt"
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
      input.receiptRevisionPolicy !== "historical_physical_receipt" &&
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
      const parsed = parseProductEvent(event)
      if (
        parsed.id !== expectedAddress.addressId ||
        parsed.pubkey.toLowerCase() !== receipt.merchantPubkey.toLowerCase() ||
        parsed.createdAt !== receiptItem.product.createdAt ||
        parsed.priceEvidenceMalformed ||
        (input.receiptRevisionPolicy === "historical_physical_receipt" &&
          (parsed.format !== "physical" || parsed.visibility !== "public"))
      ) {
        throw new Error("Exact receipt product metadata is invalid.")
      }
      return {
        state: "verified",
        product: receiptItem.product,
        quantity: receiptItem.quantity,
        title: parsed.title,
        signedProduct: {
          type: parsed.type,
          specifications: parsed.specifications,
        },
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
  fetchSignedEventsFanoutDetailed?: typeof fetchSignedEventsFanoutDetailed
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
  results: readonly PublicRelayReadResult[]
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

function rawEvents(result: PublicRelayReadResult): {
  events: SignedPublicNostrEvent[]
  sourceRelayUrlsById: Map<string, string[]>
} {
  const events: SignedPublicNostrEvent[] = []
  const sourceRelayUrlsById = new Map<string, string[]>()
  for (const event of result.events) {
    const raw = event
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
  receipt: EventMarketReceiptMerchandiseEvidence
  /** Future physical release terms remain pinned despite later listing deletion. */
  receiptRevisionPolicy?: "current_product" | "historical_physical_receipt"
  authenticatedPubkey?: string | null
  accountNetworkLocalStateRepository?: PublicRelayReadOptions["accountNetworkLocalStateRepository"]
  readAccountRelaySettingsPlanningSnapshot?: typeof readDurableAccountRelaySettingsPlanningSnapshot
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
  signal?: AbortSignal
}

/** Bounded exact-id public read for organizer handoff merchandise. */
export async function getEventMarketReceiptMerchandise(
  input: GetEventMarketReceiptMerchandiseInput
): Promise<EventMarketReceiptMerchandiseResolution> {
  if (input.receipt.items.length > MAX_RECEIPT_ITEMS) {
    throw new Error("Receipt merchandise exceeds the bounded read budget.")
  }
  const merchant = input.receipt.merchantPubkey.toLowerCase()
  const authenticatedPubkey = input.authenticatedPubkey?.trim().toLowerCase()
  const hasAuthenticatedOwner = Boolean(
    authenticatedPubkey && /^[0-9a-f]{64}$/.test(authenticatedPubkey)
  )
  let ownerSettingsSnapshot: Awaited<
    ReturnType<typeof readDurableAccountRelaySettingsPlanningSnapshot>
  > | null = null
  if (hasAuthenticatedOwner) {
    try {
      ownerSettingsSnapshot = await (
        input.readAccountRelaySettingsPlanningSnapshot ??
        readDurableAccountRelaySettingsPlanningSnapshot
      )(authenticatedPubkey!)
    } catch {
      // Missing durable owner evidence grants no ws:// transport authority.
    }
  }
  const ownerSelectedRelayUrls = normalizeOwnerSelectedRelayUrls(
    ownerSettingsSnapshot?.settings.entries.flatMap((entry) =>
      entry.readEnabled ||
      (merchant === authenticatedPubkey && entry.writeEnabled)
        ? [entry.url]
        : []
    ) ?? []
  )
  const lookup = testOverrides.getRelayLists ?? getRelayLists
  const relayListReadPlan = planRelayReads({
    intent: "relay_lists",
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    settings: ownerSettingsSnapshot?.settings,
    signedRelayListAuthoritative:
      ownerSettingsSnapshot?.signedRelayListAuthoritative,
  })
  const relayLists = await lookup([merchant], {
    signal: input.signal,
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    relayUrls: relayListReadPlan.candidateRelayUrls,
    maxRelayAttempts: relayListReadPlan.maxRelayAttempts,
    ownerSelectedRelayUrls: relayListReadPlan.ownerSelectedRelayUrls,
    appRelayUrls: relayListReadPlan.appRelayUrls,
    personalRelayUrls: relayListReadPlan.personalRelayUrls,
    independentRelayUrls: relayListReadPlan.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
  })
  const plan = planRelayReads({
    intent: "author_products",
    authors: [merchant],
    relayLists,
    authenticatedPubkey,
    ownerSelectedRelayUrls,
    maxRelays: MAX_RECEIPT_READ_RELAYS,
    settings: ownerSettingsSnapshot?.settings,
    signedRelayListAuthoritative:
      ownerSettingsSnapshot?.signedRelayListAuthoritative,
  })
  const admittedRelayUrls = authenticatedPubkey
    ? await filterEligibleAccountRelayUrls({
        accountPubkey: authenticatedPubkey,
        authenticatedPubkey,
        candidateRelayUrls: plan.candidateRelayUrls,
        ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls,
        appRelayUrls: plan.appRelayUrls,
        personalRelayUrls: plan.personalRelayUrls,
        independentRelayUrls: plan.independentRelayUrls,
        repository: input.accountNetworkLocalStateRepository,
      })
    : plan.candidateRelayUrls
  const relayUrls = admittedRelayUrls.slice(0, MAX_RECEIPT_READ_RELAYS)
  const productIds = Array.from(
    new Set(input.receipt.items.map((item) => item.product.eventId))
  )
  const addresses = Array.from(
    new Set(input.receipt.items.map((item) => item.product.coordinate))
  )
  const filters: Filter[] = [
    {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [merchant],
      ids: productIds,
      limit: MAX_RECEIPT_ITEMS,
    },
    ...productIds.map((eventId): Filter => ({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchant],
      "#e": [eventId],
      limit: RECEIPT_DELETION_REVISIONS_PER_TARGET,
    })),
    ...addresses.map((address): Filter => ({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchant],
      "#a": [address],
      limit: RECEIPT_DELETION_REVISIONS_PER_TARGET,
    })),
  ]
  const fetch =
    testOverrides.fetchSignedEventsFanoutDetailed ??
    fetchSignedEventsFanoutDetailed
  const results: PublicRelayReadResult[] = []
  let remainingRelayUrls = [...relayUrls]
  for (
    let index = 0;
    index < filters.length && remainingRelayUrls.length > 0;
    index += RECEIPT_READ_CONCURRENCY
  ) {
    const batch = filters.slice(index, index + RECEIPT_READ_CONCURRENCY)
    const remainingRelayUrlSet = new Set(remainingRelayUrls)
    const batchResults = await Promise.all(
      batch.map((filter) =>
        fetch(filter, {
          relayUrls: remainingRelayUrls,
          accountPubkey: authenticatedPubkey,
          authenticatedPubkey,
          ownerSelectedRelayUrls: (plan.ownerSelectedRelayUrls ?? []).filter(
            (relayUrl) => remainingRelayUrlSet.has(relayUrl)
          ),
          appRelayUrls: (plan.appRelayUrls ?? []).filter((relayUrl) =>
            remainingRelayUrlSet.has(relayUrl)
          ),
          personalRelayUrls: (plan.personalRelayUrls ?? []).filter((relayUrl) =>
            remainingRelayUrlSet.has(relayUrl)
          ),
          independentRelayUrls: (plan.independentRelayUrls ?? []).filter(
            (relayUrl) => remainingRelayUrlSet.has(relayUrl)
          ),
          accountNetworkLocalStateRepository:
            input.accountNetworkLocalStateRepository,
          shouldContinue: input.shouldContinue,
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
    receiptRevisionPolicy: input.receiptRevisionPolicy,
    events: Array.from(events.values()),
    sourceRelayUrlsById,
    coverage: combineCoverage(relayUrls, results),
  })
}
