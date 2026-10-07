import type { Filter } from "nostr-tools"
import type {
  ConduitDB,
  MerchantInventoryAssignment,
  MerchantInventoryProduct,
} from "../db"
import {
  isEventMarketAddressableRevisionDeleted,
  getEventMarketReadPlan,
  parseEventMarketCalendarEvent,
  parseAddressableCoordinate,
  type EventMarketReadPlan,
} from "./event-market"
import {
  parseEventMarketAssignmentEvent,
  type ParsedEventMarketAssignment,
} from "./event-market-assignment"
import { readEventMarketAssignment } from "./event-market-roster-read"
import { parseProductEvent } from "./products"
import {
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadOptions,
} from "./relay-reader"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

type Coverage = "complete" | "partial" | "unavailable"
type ReadResult = {
  events: SignedPublicNostrEvent[]
  relays: Array<{ relayUrl: string; status: "success" | "partial" | "failed" }>
}
type ReadDependencies = {
  plan: typeof getEventMarketReadPlan
  fetch(filter: Filter, options: PublicRelayReadOptions): Promise<ReadResult>
}
const defaultDependencies: ReadDependencies = {
  plan: getEventMarketReadPlan,
  fetch: async (filter, options) => {
    const result = await fetchSignedEventsFanoutDetailed(filter, options)
    return { events: result.events, relays: result.relays }
  },
}
const MAX_CANDIDATES = 128
const MAX_RETAINED = 2_048
const MAX_OCCURRENCE_REVISIONS = 64

function options(
  plan: EventMarketReadPlan,
  input: {
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  }
): PublicRelayReadOptions {
  return {
    relayUrls: plan.candidateRelayUrls,
    maxRelayAttempts: plan.maxRelayAttempts,
    accountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls,
    appRelayUrls: plan.appRelayUrls,
    personalRelayUrls: plan.personalRelayUrls,
    independentRelayUrls: plan.independentRelayUrls,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  }
}

function coverageOf(
  plan: EventMarketReadPlan | undefined,
  reads: readonly ReadResult[],
  truncated = false
): Coverage {
  const statuses = reads.flatMap((read) =>
    read.relays.map((relay) => relay.status)
  )
  if (!statuses.length || statuses.every((status) => status === "failed"))
    return "unavailable"
  return truncated ||
    plan?.relayHintTruncated ||
    statuses.some((status) => status !== "success")
    ? "partial"
    : "complete"
}

function mergeCoverage(a: Coverage, b: Coverage): Coverage {
  if (a === "unavailable" || b === "unavailable") return "unavailable"
  if (a === "partial" || b === "partial") return "partial"
  return "complete"
}

function coordinateOf(event: SignedPublicNostrEvent): string | undefined {
  const dTags = event.tags.filter((tag) => tag[0] === "d")
  if (dTags.length !== 1 || dTags[0]?.length !== 2) return undefined
  return `${event.kind}:${event.pubkey}:${dTags[0][1]}`
}

function cancellation(event: SignedPublicNostrEvent): boolean {
  const lifecycle = event.tags.filter((tag) => tag[0] === "event_occurrence")
  return (
    lifecycle.length === 1 &&
    lifecycle[0]?.length === 3 &&
    lifecycle[0][1] === "1" &&
    lifecycle[0][2] === "cancelled"
  )
}

async function occurrenceState(
  input: {
    db: ConduitDB
    assignment: ParsedEventMarketAssignment
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: ReadDependencies
): Promise<{
  endMs: number
  terminal: boolean
  coverage: Coverage
}> {
  const { assignment, db } = input
  const parsed = parseAddressableCoordinate(
    assignment.occurrenceCoordinate,
    [31922, 31923]
  )
  if (!parsed || parsed.coordinate !== assignment.occurrenceCoordinate)
    return {
      endMs: Number.MAX_SAFE_INTEGER,
      terminal: false,
      coverage: "unavailable",
    }
  const retained = (
    await db.eventMarketRosterEvidence
      .where("marketCoordinate")
      .equals(assignment.marketCoordinate)
      .toArray()
  ).map((row) => row.signedEvent)
  let plan: EventMarketReadPlan | undefined
  const reads: ReadResult[] = []
  try {
    plan = await dependencies.plan({
      organizerPubkey: parsed.authorPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
    const readOptions = options(plan, input)
    reads.push(
      await dependencies.fetch(
        {
          kinds: [parsed.kind],
          authors: [parsed.authorPubkey],
          "#d": [parsed.dTag],
          limit: MAX_OCCURRENCE_REVISIONS,
        },
        readOptions
      )
    )
    reads.push(
      await dependencies.fetch(
        {
          kinds: [5],
          authors: [parsed.authorPubkey],
          "#a": [assignment.occurrenceCoordinate],
          limit: MAX_OCCURRENCE_REVISIONS,
        },
        readOptions
      )
    )
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
  }
  let all = [
    ...new Map(
      [...retained, ...reads.flatMap((read) => read.events)]
        .filter((event) => isValidSignedPublicNostrEvent(event))
        .map((event) => [event.id, event])
    ).values(),
  ]
  const revisions = all
    .filter((event) => coordinateOf(event) === assignment.occurrenceCoordinate)
    .sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )
  const current = revisions[0]
  let idReadFailed = false
  if (current && plan) {
    try {
      reads.push(
        await dependencies.fetch(
          {
            kinds: [5],
            authors: [parsed.authorPubkey],
            "#e": [current.id],
            limit: MAX_OCCURRENCE_REVISIONS,
          },
          options(plan, input)
        )
      )
      all = [
        ...new Map(
          [...all, ...reads.at(-1)!.events]
            .filter((event) => isValidSignedPublicNostrEvent(event))
            .map((event) => [event.id, event])
        ).values(),
      ]
    } catch (error) {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw error
      idReadFailed = true
    }
  }
  const parsedCurrent = current ? parseEventMarketCalendarEvent(current) : null
  let coverage = coverageOf(
    plan,
    reads,
    idReadFailed ||
      reads.some((read) => read.events.length >= MAX_OCCURRENCE_REVISIONS)
  )
  if (
    !current ||
    !parsedCurrent ||
    (current.kind === 31923 && !current.tags.some((tag) => tag[0] === "end"))
  ) {
    // Missing or malformed lifecycle cannot establish expiry or release.
    coverage = mergeCoverage(coverage, "partial")
    return { endMs: Number.MAX_SAFE_INTEGER, terminal: false, coverage }
  }
  const deleted = isEventMarketAddressableRevisionDeleted(
    {
      coordinate: assignment.occurrenceCoordinate,
      eventId: current.id,
      createdAt: current.created_at * 1_000,
    },
    all.filter(
      (event) => event.kind === 5 && event.pubkey === parsed.authorPubkey
    )
  )
  const relevant = all.filter(
    (event) =>
      coordinateOf(event) === assignment.occurrenceCoordinate ||
      (event.kind === 5 &&
        event.pubkey === parsed.authorPubkey &&
        event.tags.some(
          (tag) =>
            (tag[0] === "a" && tag[1] === assignment.occurrenceCoordinate) ||
            (tag[0] === "e" && tag[1] === current.id)
        ))
  )
  if (relevant.length)
    await db.eventMarketRosterEvidence.bulkPut(
      relevant.map((event) => ({
        id: `${assignment.marketCoordinate}:${event.id}`,
        marketCoordinate: assignment.marketCoordinate,
        signedEvent: event,
        cachedAt: Date.now(),
      }))
    )
  return {
    endMs: parsedCurrent.end,
    terminal: deleted || revisions.some(cancellation),
    coverage,
  }
}

export type MerchantInventoryRecoveryResult =
  | {
      state: "ready"
      coverage: Coverage
      product: MerchantInventoryProduct
      recoveredAssignments: number
      alreadyCommitted: boolean
    }
  | {
      state: "unsafe_conflict"
      coverage: Coverage
      reason:
        | "invalid_product"
        | "malformed_assignment"
        | "assignment_conflict"
        | "tracking_mismatch"
        | "overallocated"
    }

/**
 * First-use recovery from bounded signed observations. Coverage describes the
 * queried relays only; it never proves global absence of assignments or orders.
 * Existing committed inventory bypasses reads and remains the writer's truth.
 */
export async function recoverMerchantInventoryProduct(
  input: {
    db: ConduitDB
    merchantPubkey: string
    productCoordinate: string
    signedProductEvent: SignedPublicNostrEvent
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  },
  dependencies: ReadDependencies = defaultDependencies
): Promise<MerchantInventoryRecoveryResult> {
  const { db, merchantPubkey, productCoordinate, signedProductEvent } = input
  const existing = await db.merchantInventoryProducts.get(productCoordinate)
  if (existing)
    return {
      state: "ready",
      coverage: "complete",
      product: existing,
      recoveredAssignments: 0,
      alreadyCommitted: true,
    }
  if (
    input.signal?.aborted ||
    input.shouldContinue?.() === false ||
    (input.authenticatedPubkey && input.authenticatedPubkey !== merchantPubkey)
  )
    throw new Error("Merchant recovery session changed")
  if (!isValidSignedPublicNostrEvent(signedProductEvent))
    return {
      state: "unsafe_conflict",
      coverage: "unavailable",
      reason: "invalid_product",
    }
  let source: ReturnType<typeof parseProductEvent>
  try {
    source = parseProductEvent(signedProductEvent)
  } catch {
    return {
      state: "unsafe_conflict",
      coverage: "unavailable",
      reason: "invalid_product",
    }
  }
  const stockTags = signedProductEvent.tags.filter((tag) => tag[0] === "stock")
  if (
    source.id !== productCoordinate ||
    source.pubkey !== merchantPubkey ||
    source.type === "variable" ||
    stockTags.length > 1 ||
    (source.stock === undefined
      ? stockTags.length !== 0
      : stockTags.length !== 1 ||
        stockTags[0]?.length !== 2 ||
        stockTags[0][1] !== String(source.stock))
  )
    return {
      state: "unsafe_conflict",
      coverage: "unavailable",
      reason: "invalid_product",
    }
  let plan: EventMarketReadPlan | undefined
  let candidateRead: ReadResult = { events: [], relays: [] }
  try {
    plan = await dependencies.plan({
      organizerPubkey: merchantPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
      signal: input.signal,
    })
    candidateRead = await dependencies.fetch(
      {
        kinds: [30410],
        authors: [merchantPubkey],
        "#a": [productCoordinate],
        limit: MAX_CANDIDATES,
      },
      options(plan, input)
    )
  } catch (error) {
    if (input.signal?.aborted || input.shouldContinue?.() === false) throw error
  }
  const retainedRowsWithLimit = await db.eventMarketRosterEvidence
    .limit(MAX_RETAINED + 1)
    .toArray()
  const retainedRows = retainedRowsWithLimit.slice(0, MAX_RETAINED)
  let coverage = coverageOf(
    plan,
    [candidateRead],
    candidateRead.events.length >= MAX_CANDIDATES ||
      retainedRowsWithLimit.length > MAX_RETAINED
  )
  const candidates = [
    ...new Map(
      [...retainedRows.map((row) => row.signedEvent), ...candidateRead.events]
        .filter(
          (event) =>
            event.kind === 30410 &&
            event.pubkey === merchantPubkey &&
            event.tags.some(
              (tag) => tag[0] === "a" && tag[1] === productCoordinate
            ) &&
            isValidSignedPublicNostrEvent(event)
        )
        .map((event) => [event.id, event])
    ).values(),
  ]
  if (candidates.length > MAX_CANDIDATES)
    coverage = mergeCoverage(coverage, "partial")
  const byCoordinate = new Map<string, SignedPublicNostrEvent[]>()
  for (const event of candidates.slice(0, MAX_CANDIDATES)) {
    const coordinate = coordinateOf(event)
    if (!coordinate)
      return {
        state: "unsafe_conflict",
        coverage,
        reason: "malformed_assignment",
      }
    const revisions = byCoordinate.get(coordinate) ?? []
    revisions.push(event)
    byCoordinate.set(coordinate, revisions)
  }
  const tupleCandidates = new Map<string, ParsedEventMarketAssignment>()
  for (const [coordinate, revisions] of byCoordinate) {
    revisions.sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )
    const current = parseEventMarketAssignmentEvent(revisions[0])
    if (!current || current.coordinate !== coordinate)
      return {
        state: "unsafe_conflict",
        coverage,
        reason: "malformed_assignment",
      }
    tupleCandidates.set(coordinate, current)
  }
  const scopedCache = new Map<string, SignedPublicNostrEvent[]>()
  for (const row of retainedRows) {
    const entries = scopedCache.get(row.marketCoordinate) ?? []
    entries.push(row.signedEvent)
    scopedCache.set(row.marketCoordinate, entries)
  }
  for (const [coordinate, assignment] of tupleCandidates) {
    const entries = scopedCache.get(assignment.marketCoordinate) ?? []
    entries.push(...(byCoordinate.get(coordinate) ?? []))
    scopedCache.set(assignment.marketCoordinate, entries)
  }
  const resolverDependencies = {
    plan: dependencies.plan,
    fetch: dependencies.fetch,
    load: async (marketCoordinate: string) =>
      scopedCache.get(marketCoordinate) ?? [],
    retain: async (
      marketCoordinate: string,
      events: readonly SignedPublicNostrEvent[]
    ) => {
      if (!events.length) return
      await db.eventMarketRosterEvidence.bulkPut(
        events.map((event) => ({
          id: `${marketCoordinate}:${event.id}`,
          marketCoordinate,
          signedEvent: event,
          cachedAt: Date.now(),
        }))
      )
    },
  }
  const recovered: MerchantInventoryAssignment[] = []
  for (const candidate of tupleCandidates.values()) {
    const resolved = await readEventMarketAssignment(
      {
        marketCoordinate: candidate.marketCoordinate,
        occurrenceCoordinate: candidate.occurrenceCoordinate,
        productCoordinate,
        authenticatedPubkey: input.authenticatedPubkey,
        shouldContinue: input.shouldContinue,
        signal: input.signal,
      },
      resolverDependencies
    )
    coverage = mergeCoverage(
      coverage,
      resolved.coverage === "stale" ? "partial" : resolved.coverage
    )
    if (
      ["conflicting", "malformed", "incomplete", "missing"].includes(
        resolved.state
      )
    )
      return {
        state: "unsafe_conflict",
        coverage,
        reason: "assignment_conflict",
      }
    if (!resolved.assignment) continue
    const assignment = resolved.assignment
    const lifecycle =
      assignment.state === "removed"
        ? {
            endMs: Number.MAX_SAFE_INTEGER,
            terminal: false,
            coverage: "complete" as Coverage,
          }
        : await occurrenceState(
            {
              db,
              assignment,
              authenticatedPubkey: input.authenticatedPubkey,
              shouldContinue: input.shouldContinue,
              signal: input.signal,
            },
            dependencies
          )
    coverage = mergeCoverage(coverage, lifecycle.coverage)
    recovered.push({
      coordinate: assignment.coordinate,
      merchantPubkey,
      productCoordinate,
      marketCoordinate: assignment.marketCoordinate,
      occurrenceCoordinate: assignment.occurrenceCoordinate,
      inventory: assignment.inventory,
      state: assignment.state,
      fulfillmentMethods: assignment.fulfillmentMethods,
      occurrenceEndMs: lifecycle.endMs,
      terminal: lifecycle.terminal,
      revision: 0,
      signedAssignmentEvent: assignment.signedEvent,
      publicationJobs: [],
    })
  }
  const active = recovered.filter((assignment) => assignment.state === "active")
  if (
    active.some(
      (assignment) =>
        (assignment.inventory.mode === "tracked") !==
        (source.stock !== undefined)
    )
  )
    return { state: "unsafe_conflict", coverage, reason: "tracking_mismatch" }
  const reserved = active.reduce(
    (sum, assignment) =>
      sum +
      (!assignment.terminal &&
      Date.now() < assignment.occurrenceEndMs &&
      assignment.inventory.mode === "tracked"
        ? assignment.inventory.quantity
        : 0),
    0
  )
  if (source.stock !== undefined && reserved > source.stock)
    return { state: "unsafe_conflict", coverage, reason: "overallocated" }
  if (
    input.signal?.aborted ||
    input.shouldContinue?.() === false ||
    (input.authenticatedPubkey && input.authenticatedPubkey !== merchantPubkey)
  )
    throw new Error("Merchant recovery session changed")
  return db.transaction(
    "rw",
    db.merchantInventoryProducts,
    db.merchantInventoryAssignments,
    async () => {
      if (input.signal?.aborted || input.shouldContinue?.() === false)
        throw new Error("Merchant recovery session changed")
      const current = await db.merchantInventoryProducts.get(productCoordinate)
      if (current)
        return {
          state: "ready" as const,
          coverage,
          product: current,
          recoveredAssignments: 0,
          alreadyCommitted: true,
        }
      const product: MerchantInventoryProduct = {
        coordinate: productCoordinate,
        merchantPubkey,
        stock: source.stock,
        revision: 0,
        sourceProductEvent: signedProductEvent,
        signedProductEvent,
        publicationJobs: [],
      }
      await db.merchantInventoryProducts.add(product)
      for (const assignment of recovered)
        await db.merchantInventoryAssignments.add(assignment)
      return {
        state: "ready" as const,
        coverage,
        product,
        recoveredAssignments: recovered.length,
        alreadyCommitted: false,
      }
    }
  )
}
