export const MERCHANT_EVENT_RELATIONSHIP_HYDRATION_CONCURRENCY = 4
export const MERCHANT_EVENT_RELATIONSHIP_HYDRATION_TARGET_LIMIT = 64
export const MERCHANT_EVENT_RELATIONSHIP_HYDRATION_DEADLINE_MS = 20_000

export interface MerchantEventRelationshipReference {
  coordinate: string
  reference: string
}

export interface MerchantEventRelationshipReferenceGroups {
  current?: MerchantEventRelationshipReference
  products: readonly MerchantEventRelationshipReference[]
  saved: readonly MerchantEventRelationshipReference[]
}

export type MerchantEventRelationshipDeadlineScheduler = (
  onDeadline: () => void,
  deadlineMs: number
) => () => void

interface HydrateMerchantEventRelationshipsInput<T> {
  references: readonly string[]
  resolve: (reference: string, signal: AbortSignal) => Promise<T>
  signal?: AbortSignal
  shouldContinue?: () => boolean
  concurrency?: number
  targetLimit?: number
  deadlineMs?: number
  scheduleDeadline?: MerchantEventRelationshipDeadlineScheduler
}

export interface MerchantEventRelationshipHydrationResult<T> {
  values: T[]
  failedCount: number
}

/**
 * Orders exact relationship reads by immediate user value. A saved naddr may
 * enrich the opened or product coordinate with relay hints without changing
 * its priority, while the currently opened coordinate always remains first.
 */
export function prioritizeMerchantEventRelationshipReferences(
  groups: MerchantEventRelationshipReferenceGroups
): string[] {
  const ordered: Array<
    MerchantEventRelationshipReference & {
      source: "current" | "product" | "saved"
    }
  > = []
  const indexByCoordinate = new Map<string, number>()

  const add = (
    candidate: MerchantEventRelationshipReference,
    source: "current" | "product" | "saved"
  ) => {
    const existingIndex = indexByCoordinate.get(candidate.coordinate)
    if (existingIndex !== undefined) {
      const existing = ordered[existingIndex]
      if (source === "saved" && existing.source !== "saved") {
        existing.reference = candidate.reference
      }
      return
    }
    indexByCoordinate.set(candidate.coordinate, ordered.length)
    ordered.push({ ...candidate, source })
  }

  if (groups.current) add(groups.current, "current")
  for (const product of groups.products) add(product, "product")
  for (const saved of groups.saved) add(saved, "saved")

  return ordered.map(({ reference }) => reference)
}

/**
 * Hydrates a bounded prefix without allowing a held relay read to block the
 * entire timeline. Completed values retain input order; rejected, timed-out,
 * in-flight, never-started, and over-limit references are all reported as
 * incomplete through failedCount.
 */
export async function hydrateMerchantEventRelationships<T>(
  input: HydrateMerchantEventRelationshipsInput<T>
): Promise<MerchantEventRelationshipHydrationResult<T>> {
  throwIfCallerStopped(input.signal, input.shouldContinue)

  const targetLimit = boundedPositiveInteger(
    input.targetLimit,
    MERCHANT_EVENT_RELATIONSHIP_HYDRATION_TARGET_LIMIT
  )
  const concurrency = boundedPositiveInteger(
    input.concurrency,
    MERCHANT_EVENT_RELATIONSHIP_HYDRATION_CONCURRENCY
  )
  const deadlineMs = boundedPositiveInteger(
    input.deadlineMs,
    MERCHANT_EVENT_RELATIONSHIP_HYDRATION_DEADLINE_MS
  )
  const scheduledReferences = input.references.slice(0, targetLimit)
  if (scheduledReferences.length === 0) {
    return { values: [], failedCount: 0 }
  }

  const controller = new AbortController()
  const completed = new Map<number, T>()
  let nextIndex = 0
  let stopReason: "caller" | "deadline" | undefined
  let resolveStopped: (reason: "caller" | "deadline") => void = () => undefined
  const stopped = new Promise<"caller" | "deadline">((resolve) => {
    resolveStopped = resolve
  })
  const stop = (reason: "caller" | "deadline") => {
    if (stopReason) return
    stopReason = reason
    controller.abort()
    resolveStopped(reason)
  }
  const stopForCaller = () => stop("caller")
  input.signal?.addEventListener("abort", stopForCaller, { once: true })

  const scheduleDeadline =
    input.scheduleDeadline ??
    ((onDeadline: () => void, delayMs: number) => {
      const timeout = setTimeout(onDeadline, delayMs)
      return () => clearTimeout(timeout)
    })
  const cancelDeadline = scheduleDeadline(() => stop("deadline"), deadlineMs)
  const authorityCheck = input.shouldContinue
    ? setInterval(() => {
        if (input.shouldContinue?.() === false) stop("caller")
      }, 25)
    : undefined

  const worker = async () => {
    while (!stopReason) {
      if (input.signal?.aborted || input.shouldContinue?.() === false) {
        stop("caller")
        return
      }
      const index = nextIndex
      if (index >= scheduledReferences.length) return
      nextIndex += 1
      try {
        const value = await input.resolve(
          scheduledReferences[index],
          controller.signal
        )
        if (!stopReason) completed.set(index, value)
      } catch {
        // A rejected read remains incomplete; another worker can continue.
      }
    }
  }

  try {
    const workers = Array.from(
      {
        length: Math.min(concurrency, scheduledReferences.length),
      },
      () => worker()
    )
    const outcome = await Promise.race([
      Promise.all(workers).then(() => "complete" as const),
      stopped,
    ])
    if (outcome === "caller") {
      throwIfCallerStopped(input.signal, input.shouldContinue)
      throw abortError()
    }
    throwIfCallerStopped(input.signal, input.shouldContinue)
  } finally {
    cancelDeadline()
    if (authorityCheck !== undefined) clearInterval(authorityCheck)
    input.signal?.removeEventListener("abort", stopForCaller)
    controller.abort()
  }

  const values = Array.from(completed.entries())
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value)
  return {
    values,
    failedCount: input.references.length - values.length,
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number
): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value as number))
    : fallback
}

function throwIfCallerStopped(
  signal?: AbortSignal,
  shouldContinue?: () => boolean
): void {
  if (signal?.aborted || shouldContinue?.() === false) throw abortError()
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError")
}
