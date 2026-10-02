import type { MerchantCheckoutSparkRecoveryCandidate } from "./commerce"

export type MerchantCheckoutSparkReconciliationStatus =
  | "verified"
  | "pending"
  | "progress_pending"
  | "retirement_pending"
  | "needs_attention"
  | "recipient_unverified"
  | "unavailable"
  | "unbound"
  | "retired"

const STATUSES: readonly MerchantCheckoutSparkReconciliationStatus[] = [
  "verified",
  "pending",
  "progress_pending",
  "retirement_pending",
  "needs_attention",
  "recipient_unverified",
  "unavailable",
  "unbound",
  "retired",
]
const MAX_CANDIDATES = 512
// Browsers clamp longer setTimeout delays to a near-immediate callback.
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MIN_STEP_GAP_MS = 750
const MIN_RETRY_MS = 30_000
const MAX_RETRY_MS = 300_000

export interface MerchantCheckoutSparkReconciliationSummary {
  readonly counts: Readonly<
    Record<MerchantCheckoutSparkReconciliationStatus, number>
  >
  readonly checking: boolean
  readonly paused: boolean
  readonly lastCheckedAt: number | null
  readonly capacityReached: boolean
  readonly selectionConflictCount: number
}

interface ReconciliationOptions {
  /**
   * Read/attest, or perform one explicitly authorized guarded advancement
   * phase. The app adapter owns fresh authority and provider seams; scheduling
   * itself never grants authority to send funds or advance another phase.
   */
  reconcile: (
    candidate: MerchantCheckoutSparkRecoveryCandidate,
    assertCurrent: () => void
  ) => Promise<MerchantCheckoutSparkReconciliationStatus>
  /** Aggregate only: no candidate IDs, wallet data, or private order content. */
  onUpdate: (summary: MerchantCheckoutSparkReconciliationSummary) => void
  active?: boolean
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}

interface Entry {
  candidate: MerchantCheckoutSparkRecoveryCandidate
  identity: string
  status: MerchantCheckoutSparkReconciliationStatus
  retryCount: number
  nextAt: number
}

function identity(candidate: MerchantCheckoutSparkRecoveryCandidate): string {
  return JSON.stringify([
    candidate.wrapId,
    candidate.schemaVersion,
    candidate.checkoutId,
    candidate.orderId,
    candidate.planDigest,
    candidate.takeoverAt,
    candidate.preparedAt,
    candidate.initialWrapId ?? null,
    candidate.initialHandoffId ?? null,
    candidate.merchantProgress?.wrapId ?? null,
    candidate.merchantProgress?.snapshotId ?? null,
    candidate.merchantProgress?.recordedAt ?? null,
  ])
}

function isTerminal(
  status: MerchantCheckoutSparkReconciliationStatus
): boolean {
  // Missing local origin evidence is not a relay/provider state that polling
  // can repair. Pause this exact candidate until a manual restart or a new
  // signed candidate, without labeling its commerce or wallet verified.
  return (
    status === "verified" ||
    status === "retired" ||
    status === "recipient_unverified"
  )
}

function isStatus(
  value: unknown
): value is MerchantCheckoutSparkReconciliationStatus {
  return STATUSES.includes(value as MerchantCheckoutSparkReconciliationStatus)
}

/**
 * Serial, bounded scheduling for merchant-side reconciliation or explicitly
 * authorized, guarded one-phase advancement through the app adapter.
 * This scheduler does not provide a generic payment/send operation.
 * Cancellation invalidates the result guard but never releases an in-flight
 * provider operation or starts another one until that operation settles.
 */
export function startMerchantCheckoutSparkReconciliation(
  options: ReconciliationOptions
) {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  let entries = new Map<string, Entry>()
  let active = options.active ?? true
  let disposed = false
  let capacityReached = false
  let selectionConflictCount = 0
  let lastCheckedAt: number | null = null
  let lastStartedAt: number | null = null
  let epoch = 0
  let currentWork: Promise<void> | null = null
  let cancelTimer: (() => void) | null = null

  const summary = (): MerchantCheckoutSparkReconciliationSummary => {
    const counts: Record<MerchantCheckoutSparkReconciliationStatus, number> = {
      verified: 0,
      pending: 0,
      progress_pending: 0,
      retirement_pending: 0,
      needs_attention: 0,
      recipient_unverified: 0,
      unavailable: 0,
      unbound: 0,
      retired: 0,
    }
    for (const entry of entries.values()) counts[entry.status] += 1
    return {
      counts,
      checking: active && currentWork !== null,
      paused: !active,
      lastCheckedAt,
      capacityReached,
      selectionConflictCount,
    }
  }

  const emit = () => {
    if (!disposed) options.onUpdate(summary())
  }

  const clearTimer = () => {
    cancelTimer?.()
    cancelTimer = null
  }

  const chooseNext = (): Entry | null => {
    let selected: Entry | null = null
    for (const entry of entries.values()) {
      if (isTerminal(entry.status) || !Number.isFinite(entry.nextAt)) continue
      if (
        !selected ||
        entry.nextAt < selected.nextAt ||
        (entry.nextAt === selected.nextAt &&
          entry.candidate.checkoutId < selected.candidate.checkoutId)
      ) {
        selected = entry
      }
    }
    return selected
  }

  function queue(): void {
    clearTimer()
    if (disposed || !active || currentWork) return
    const next = chooseNext()
    if (!next) return
    const earliest = Math.max(
      next.nextAt,
      lastStartedAt === null ? now() : lastStartedAt + MIN_STEP_GAP_MS
    )
    cancelTimer = schedule(
      () => {
        cancelTimer = null
        if (disposed || !active || currentWork) return
        const selected = chooseNext()
        if (!selected || selected.nextAt > now()) {
          queue()
          return
        }
        const work = run(selected)
        currentWork = work
        emit()
        void work.finally(() => {
          if (currentWork === work) currentWork = null
          if (!disposed) {
            emit()
            queue()
          }
        })
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - now()))
    )
  }

  async function run(entry: Entry): Promise<void> {
    lastStartedAt = now()
    const currentEpoch = epoch
    const assertCurrent = () => {
      if (
        disposed ||
        !active ||
        epoch !== currentEpoch ||
        entries.get(entry.candidate.checkoutId) !== entry
      ) {
        throw new Error("Merchant checkout reconciliation candidate changed.")
      }
    }
    let outcome: MerchantCheckoutSparkReconciliationStatus
    try {
      assertCurrent()
      const result = await options.reconcile(entry.candidate, assertCurrent)
      outcome = isStatus(result) ? result : "unavailable"
    } catch {
      outcome = "unavailable"
    }
    try {
      assertCurrent()
    } catch {
      return
    }
    const checkedAt = now()
    entry.status = outcome
    lastCheckedAt = checkedAt
    if (isTerminal(outcome)) {
      entry.nextAt = Number.POSITIVE_INFINITY
      entry.retryCount = 0
    } else {
      entry.retryCount = Math.min(entry.retryCount + 1, 5)
      entry.nextAt = Math.max(
        entry.candidate.takeoverAt,
        checkedAt +
          Math.min(MIN_RETRY_MS * 2 ** (entry.retryCount - 1), MAX_RETRY_MS)
      )
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    epoch += 1
    clearTimer()
    entries.clear()
  }

  emit()
  return {
    replaceCandidates(
      candidates: readonly MerchantCheckoutSparkRecoveryCandidate[]
    ) {
      if (disposed) return
      const next = new Map<string, Entry>()
      const seen = new Set<string>()
      capacityReached = candidates.length > MAX_CANDIDATES
      selectionConflictCount = 0
      for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
        if (seen.has(candidate.checkoutId)) {
          // A same-checkout conflict must not pick an arbitrary recovery wrap.
          if (next.delete(candidate.checkoutId)) selectionConflictCount += 1
          continue
        }
        seen.add(candidate.checkoutId)
        const version = identity(candidate)
        const previous = entries.get(candidate.checkoutId)
        const validTakeover =
          Number.isSafeInteger(candidate.takeoverAt) &&
          candidate.takeoverAt >= 0
        next.set(
          candidate.checkoutId,
          previous?.identity === version
            ? previous
            : {
                candidate: { ...candidate },
                identity: version,
                // Malformed timing is visible as unavailable but never sent to
                // an authority/provider adapter or scheduled in a tight loop.
                status: validTakeover ? "pending" : "unavailable",
                retryCount: 0,
                nextAt: validTakeover
                  ? candidate.takeoverAt
                  : Number.POSITIVE_INFINITY,
              }
        )
      }
      // An overflowed page may repeat a retained checkout after the cap. Do
      // not reconcile that arbitrarily selected wrap as though it were unique.
      for (let index = MAX_CANDIDATES; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        if (!candidate) continue
        if (next.delete(candidate.checkoutId)) selectionConflictCount += 1
      }
      entries = next
      emit()
      queue()
    },
    setActive(next: boolean) {
      if (disposed || active === next) return
      active = next
      epoch += 1
      clearTimer()
      emit()
      queue()
    },
    dispose,
    async stopAndDrain() {
      dispose()
      await currentWork
    },
  }
}
