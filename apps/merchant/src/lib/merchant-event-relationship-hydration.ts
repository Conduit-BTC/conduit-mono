import {
  compareReplaceableEventFrontiers,
  decodeEventMarketReference,
  type EventMarketRosterReadResult,
  type ProductSchema,
} from "@conduit/core"

export const MERCHANT_EVENT_RELATIONSHIP_TARGET_LIMIT = 64
const CONCURRENCY = 4
const DEADLINE_MS = 20_000

/** Product revisions are already reconciled by the merchant storefront read. */
export function getMerchantProductMarketReferences(
  products: readonly Pick<ProductSchema, "eventMarketRefs">[]
): string[] {
  const references = new Set<string>()
  for (const product of products) {
    for (const reference of product.eventMarketRefs ?? []) {
      const decoded = decodeEventMarketReference(reference, [30409])
      if (decoded) references.add(decoded.coordinate)
    }
  }
  return [...references]
}

export async function hydrateMerchantProductMarkets(input: {
  references: readonly string[]
  read: (
    reference: string,
    signal: AbortSignal
  ) => Promise<EventMarketRosterReadResult>
  signal?: AbortSignal
  shouldContinue?: () => boolean
  targetLimit?: number
  concurrency?: number
  deadlineMs?: number
}): Promise<{
  markets: EventMarketRosterReadResult[]
  failedCount: number
}> {
  const abortError = () =>
    new DOMException("Market read cancelled.", "AbortError")
  if (input.signal?.aborted || input.shouldContinue?.() === false)
    throw abortError()
  const limit = Math.max(
    1,
    Math.floor(input.targetLimit ?? MERCHANT_EVENT_RELATIONSHIP_TARGET_LIMIT)
  )
  const references = input.references.slice(0, limit)
  if (!references.length) return { markets: [], failedCount: 0 }

  const controller = new AbortController()
  const completed = new Map<number, EventMarketRosterReadResult>()
  let next = 0
  let stop: "deadline" | "caller" | undefined
  let notifyStop: (reason: "deadline" | "caller") => void = () => undefined
  const stopped = new Promise<"deadline" | "caller">((resolve) => {
    notifyStop = resolve
  })
  const halt = (reason: "deadline" | "caller") => {
    if (stop) return
    stop = reason
    controller.abort()
    notifyStop(reason)
  }
  const onAbort = () => halt("caller")
  input.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(
    () => halt("deadline"),
    input.deadlineMs ?? DEADLINE_MS
  )
  const authorityTimer = input.shouldContinue
    ? setInterval(() => {
        if (input.shouldContinue?.() === false) halt("caller")
      }, 50)
    : undefined

  const worker = async () => {
    while (!stop) {
      if (input.signal?.aborted || input.shouldContinue?.() === false) {
        halt("caller")
        return
      }
      const index = next++
      if (index >= references.length) return
      try {
        const market = await input.read(references[index]!, controller.signal)
        if (!stop) completed.set(index, market)
      } catch {
        // One failed market does not suppress other exact relationships.
      }
    }
  }
  try {
    const workers = Array.from(
      { length: Math.min(input.concurrency ?? CONCURRENCY, references.length) },
      () => worker()
    )
    const outcome = await Promise.race([
      Promise.all(workers).then(() => "complete" as const),
      stopped,
    ])
    if (
      outcome === "caller" ||
      input.signal?.aborted ||
      input.shouldContinue?.() === false
    )
      throw abortError()
  } finally {
    clearTimeout(timer)
    if (authorityTimer !== undefined) clearInterval(authorityTimer)
    input.signal?.removeEventListener("abort", onAbort)
    controller.abort()
  }
  return {
    markets: [...completed.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, market]) => market),
    failedCount: input.references.length - completed.size,
  }
}

const knownNegative = (read: EventMarketRosterReadResult) =>
  read.resolution.state === "deleted" ||
  read.resolution.state === "malformed" ||
  read.resolution.state === "conflicting"

function chooseMarketRead(
  existing: EventMarketRosterReadResult,
  next: EventMarketRosterReadResult
): EventMarketRosterReadResult {
  if (knownNegative(next)) return next
  if (knownNegative(existing)) return existing
  if (existing.resolution.state !== "current") return next
  if (next.resolution.state !== "current") return existing
  const left = existing.resolution.market.signedEvent
  const right = next.resolution.market.signedEvent
  const frontier = compareReplaceableEventFrontiers(
    { createdAt: right.created_at, eventId: right.id },
    { createdAt: left.created_at, eventId: left.id }
  )
  if (frontier !== 0) return frontier > 0 ? next : existing

  // The market revision can stay fixed while the linked schedule or date is
  // replaced. Compare that signed frontier before read completeness.
  const linkedEvent = (read: EventMarketRosterReadResult) =>
    read.schedule?.kind === "series"
      ? read.schedule.series.signedEvent
      : read.schedule?.kind === "single"
        ? read.schedule.occurrenceEvent
        : (read.calendarSignedEvent ?? read.calendar?.signedEvent)
  const previousLinked = linkedEvent(existing)
  const nextLinked = linkedEvent(next)
  if (previousLinked && nextLinked) {
    const linkedFrontier = compareReplaceableEventFrontiers(
      { createdAt: nextLinked.created_at, eventId: nextLinked.id },
      { createdAt: previousLinked.created_at, eventId: previousLinked.id }
    )
    if (linkedFrontier !== 0) return linkedFrontier > 0 ? next : existing
  } else if (previousLinked || nextLinked) {
    return nextLinked ? next : existing
  }

  const coverageRank = (coverage: string | undefined) =>
    coverage === "complete"
      ? 3
      : coverage === "partial"
        ? 2
        : coverage === "stale"
          ? 1
          : 0
  const coverageOrder = (read: EventMarketRosterReadResult) => [
    coverageRank(read.calendarCoverage),
    coverageRank(read.scheduleCoverage),
    coverageRank(read.coverage),
    Number(read.retained),
  ]
  const previousCoverage = coverageOrder(existing)
  const nextCoverage = coverageOrder(next)
  for (let index = 0; index < previousCoverage.length; index++) {
    const difference = nextCoverage[index]! - previousCoverage[index]!
    if (difference !== 0) return difference > 0 ? next : existing
  }
  return existing
}

/** Exact product relationships fill discovery gaps without duplicating markets. */
export function mergeMerchantTimelineMarketReads(
  perspective: readonly EventMarketRosterReadResult[],
  exact: readonly EventMarketRosterReadResult[]
): EventMarketRosterReadResult[] {
  const byCoordinate = new Map<string, EventMarketRosterReadResult>()
  for (const read of [...perspective, ...exact]) {
    const prior = byCoordinate.get(read.coordinate)
    byCoordinate.set(
      read.coordinate,
      prior ? chooseMarketRead(prior, read) : read
    )
  }
  return [...byCoordinate.values()]
}
