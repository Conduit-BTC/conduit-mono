export type RelayNetworkBudgetClass =
  | "critical_order_write"
  | "critical_order_read"
  | "interactive_detail"
  | "interactive_search"
  | "visible_marketplace_read"
  | "zap_receipt_wait"
  | "background_hydration"
  | "capability_scan"
  | "prefetch"

export interface RelayNetworkBudgetOptions {
  budgetClass?: RelayNetworkBudgetClass
  relayUrl?: string
  signal?: AbortSignal
}

export interface RelayNetworkBudgetSnapshot {
  activeGlobal: number
  queued: number
  activeByClass: Record<RelayNetworkBudgetClass, number>
  activeByRelay: Record<string, number>
}

interface BudgetClassConfig {
  priority: number
  maxActive: number
}

interface QueuedJob<T> {
  id: number
  budgetClass: RelayNetworkBudgetClass
  relayUrl: string | null
  signal?: AbortSignal
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const DEFAULT_BUDGET_CLASS: RelayNetworkBudgetClass = "visible_marketplace_read"
const DEFAULT_GLOBAL_ACTIVE_LIMIT = 8
const CRITICAL_ORDER_WRITE_GLOBAL_LIMIT = 10
const PER_RELAY_ACTIVE_LIMIT = 1

const BUDGET_CLASS_CONFIG: Record<RelayNetworkBudgetClass, BudgetClassConfig> =
  {
    critical_order_write: { priority: 900, maxActive: 4 },
    critical_order_read: { priority: 850, maxActive: 6 },
    interactive_detail: { priority: 700, maxActive: 6 },
    interactive_search: { priority: 650, maxActive: 2 },
    visible_marketplace_read: { priority: 600, maxActive: 5 },
    zap_receipt_wait: { priority: 500, maxActive: 4 },
    background_hydration: { priority: 300, maxActive: 3 },
    capability_scan: { priority: 200, maxActive: 2 },
    prefetch: { priority: 100, maxActive: 2 },
  }

let nextJobId = 1
let activeGlobal = 0
const activeByClass = new Map<RelayNetworkBudgetClass, number>()
const activeByRelay = new Map<string, number>()
const queue: QueuedJob<unknown>[] = []

function getActiveByClass(budgetClass: RelayNetworkBudgetClass): number {
  return activeByClass.get(budgetClass) ?? 0
}

function getActiveByRelay(relayUrl: string | null): number {
  return relayUrl ? (activeByRelay.get(relayUrl) ?? 0) : 0
}

function hasCriticalOrderWritePressure(): boolean {
  if (getActiveByClass("critical_order_write") > 0) return true
  return queue.some((job) => job.budgetClass === "critical_order_write")
}

function getGlobalActiveLimit(): number {
  return hasCriticalOrderWritePressure()
    ? CRITICAL_ORDER_WRITE_GLOBAL_LIMIT
    : DEFAULT_GLOBAL_ACTIVE_LIMIT
}

function normalizeRelayUrlForBudget(
  relayUrl: string | undefined
): string | null {
  const trimmed = relayUrl?.trim()
  return trimmed ? trimmed : null
}

function canStart(job: QueuedJob<unknown>): boolean {
  if (job.signal?.aborted) return true
  const classConfig = BUDGET_CLASS_CONFIG[job.budgetClass]
  if (activeGlobal >= getGlobalActiveLimit()) return false
  if (getActiveByClass(job.budgetClass) >= classConfig.maxActive) return false
  if (
    job.relayUrl &&
    getActiveByRelay(job.relayUrl) >= PER_RELAY_ACTIVE_LIMIT
  ) {
    return false
  }
  return true
}

function sortQueue(): void {
  queue.sort((a, b) => {
    const priorityDelta =
      BUDGET_CLASS_CONFIG[b.budgetClass].priority -
      BUDGET_CLASS_CONFIG[a.budgetClass].priority
    return priorityDelta || a.id - b.id
  })
}

function increment(job: QueuedJob<unknown>): void {
  activeGlobal += 1
  activeByClass.set(job.budgetClass, getActiveByClass(job.budgetClass) + 1)
  if (job.relayUrl) {
    activeByRelay.set(job.relayUrl, getActiveByRelay(job.relayUrl) + 1)
  }
}

function decrement(job: QueuedJob<unknown>): void {
  activeGlobal = Math.max(0, activeGlobal - 1)
  const nextClassCount = Math.max(0, getActiveByClass(job.budgetClass) - 1)
  if (nextClassCount === 0) activeByClass.delete(job.budgetClass)
  else activeByClass.set(job.budgetClass, nextClassCount)

  if (job.relayUrl) {
    const nextRelayCount = Math.max(0, getActiveByRelay(job.relayUrl) - 1)
    if (nextRelayCount === 0) activeByRelay.delete(job.relayUrl)
    else activeByRelay.set(job.relayUrl, nextRelayCount)
  }
}

function removeQueuedJob(job: QueuedJob<unknown>): void {
  const index = queue.indexOf(job)
  if (index >= 0) queue.splice(index, 1)
}

function drainQueue(): void {
  sortQueue()

  let started = true
  while (started) {
    started = false
    for (const job of [...queue]) {
      if (!canStart(job)) continue
      removeQueuedJob(job)
      if (job.signal?.aborted) {
        job.reject(new DOMException("Relay network task aborted", "AbortError"))
        started = true
        continue
      }

      increment(job)
      started = true
      void job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          decrement(job)
          drainQueue()
        })
    }
  }
}

export function runWithRelayNetworkBudget<T>(
  run: () => Promise<T>,
  options: RelayNetworkBudgetOptions = {}
): Promise<T> {
  const budgetClass = options.budgetClass ?? DEFAULT_BUDGET_CLASS
  const relayUrl = normalizeRelayUrlForBudget(options.relayUrl)

  if (options.signal?.aborted) {
    return Promise.reject(
      new DOMException("Relay network task aborted", "AbortError")
    )
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", abort)
    }
    const settleResolve = (value: T): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const job: QueuedJob<T> = {
      id: nextJobId++,
      budgetClass,
      relayUrl,
      signal: options.signal,
      run,
      resolve: settleResolve,
      reject: settleReject,
    }

    const abort = (): void => {
      removeQueuedJob(job as QueuedJob<unknown>)
      settleReject(new DOMException("Relay network task aborted", "AbortError"))
    }

    options.signal?.addEventListener("abort", abort, { once: true })

    queue.push(job as QueuedJob<unknown>)
    drainQueue()
  })
}

export function snapshotRelayNetworkBudget(): RelayNetworkBudgetSnapshot {
  const activeByClassRecord = Object.fromEntries(
    Object.keys(BUDGET_CLASS_CONFIG).map((key) => [
      key,
      getActiveByClass(key as RelayNetworkBudgetClass),
    ])
  ) as Record<RelayNetworkBudgetClass, number>

  return {
    activeGlobal,
    queued: queue.length,
    activeByClass: activeByClassRecord,
    activeByRelay: Object.fromEntries(activeByRelay),
  }
}

export function __resetRelayNetworkBudget(): void {
  queue.splice(0, queue.length)
  activeGlobal = 0
  activeByClass.clear()
  activeByRelay.clear()
  nextJobId = 1
}
