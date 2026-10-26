import { createMerchantCheckoutSparkRecoveryDiscovery } from "@conduit/core"

const NEXT_PAGE_DELAY_MS = 750

type DiscoverySession = Awaited<
  ReturnType<typeof createMerchantCheckoutSparkRecoveryDiscovery>
>
export type MerchantCheckoutDiscoveryPage = Awaited<
  ReturnType<DiscoverySession["nextPage"]>
>

export type MerchantCheckoutDiscoveryStatus =
  "checking" | "waiting" | "paused" | "finished" | "unavailable"

interface DiscoveryOptions {
  principalPubkey: string
  onPage(page: MerchantCheckoutDiscoveryPage): void
  onStatus(status: MerchantCheckoutDiscoveryStatus): void
  active?: boolean
  createSession?: typeof createMerchantCheckoutSparkRecoveryDiscovery
  /** Bounds signer/declaration setup before the per-page read budgets apply. */
  openingTimeoutMs?: number
  /** A cancelable timer seam; callbacks never overlap a page already in flight. */
  schedule?: (callback: () => void, delayMs: number) => () => void
}

/**
 * Bounded active-page discovery only. This controller has no wallet/provider,
 * invoice, send, or fulfillment capability. Secrets stay in the Core session.
 */
export function startMerchantCheckoutSparkDiscovery(options: DiscoveryOptions) {
  const createSession =
    options.createSession ?? createMerchantCheckoutSparkRecoveryDiscovery
  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    })
  let active = options.active ?? true
  let disposed = false
  let finished = false
  let inFlight = false
  let session: DiscoverySession | null = null
  let cancelTimer: (() => void) | null = null
  let retryCount = 0
  let exhausted = false
  let rescanRequested = false
  let degradedSweeps = 0
  let currentStep: Promise<void> = Promise.resolve()
  const lifecycle = new AbortController()

  const openSession = () =>
    new Promise<DiscoverySession>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        lifecycle.signal.removeEventListener("abort", cancelled)
      }
      const cancelled = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error("Recovery discovery setup was stopped."))
      }
      const timer = setTimeout(
        () => lifecycle.abort(),
        options.openingTimeoutMs ?? 15_000
      )
      lifecycle.signal.addEventListener("abort", cancelled, { once: true })
      void Promise.resolve()
        .then(() =>
          createSession(options.principalPubkey, {
            signal: lifecycle.signal,
          })
        )
        .then(
          (opened) => {
            if (settled || lifecycle.signal.aborted) {
              opened.dispose()
              return
            }
            settled = true
            cleanup()
            resolve(opened)
          },
          (error: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
          }
        )
    })

  const report = (status: MerchantCheckoutDiscoveryStatus) => {
    if (!disposed) options.onStatus(status)
  }
  const releaseSession = () => {
    session?.dispose()
    session = null
  }
  const queue = (delayMs: number) => {
    cancelTimer?.()
    cancelTimer = null
    if (disposed || finished || !active) return
    cancelTimer = schedule(() => {
      cancelTimer = null
      currentStep = step()
    }, delayMs)
  }

  async function step(): Promise<void> {
    if (disposed || finished || !active || inFlight) return
    inFlight = true
    report("checking")
    let nextDelay = NEXT_PAGE_DELAY_MS
    try {
      if (!session) {
        const opened = await openSession()
        if (disposed) {
          opened.dispose()
          return
        }
        session = opened
      }
      // Visibility can change while signer/session creation is pending.
      if (!active || disposed) return
      if (exhausted) {
        session.restartScan()
        exhausted = false
        rescanRequested = false
      }
      const page = await session.nextPage()
      if (disposed) return
      options.onPage(page)
      if (page.history.retentionLimitReached) {
        // Keep only the already-published coarse rows. Continuing a saturated
        // session must not silently drop prior conflicting private evidence.
        finished = true
        releaseSession()
        report("unavailable")
        return
      }
      if (!page.history.hasMore) {
        exhausted = true
        const degraded = ["partial", "unavailable", "capped"].includes(
          page.history.pageStatus
        )
        degradedSweeps = degraded ? Math.min(degradedSweeps + 1, 4) : 0
        nextDelay = degraded
          ? Math.min(60_000 * 2 ** (degradedSweeps - 1), 300_000)
          : 60_000
        report("finished")
        return
      }
      const degraded = ["partial", "unavailable", "capped"].includes(
        page.history.pageStatus
      )
      retryCount = degraded ? Math.min(retryCount + 1, 5) : 0
      nextDelay = degraded
        ? Math.min(5_000 * 2 ** (retryCount - 1), 60_000)
        : NEXT_PAGE_DELAY_MS
      report(active ? "waiting" : "paused")
    } catch {
      if (!disposed) {
        // Authority/decryption errors do not justify silently reopening another
        // signer session. Core bounds source retries; the owner can refresh.
        finished = true
        releaseSession()
        report("unavailable")
      }
    } finally {
      inFlight = false
      if (!disposed && !finished) {
        if (active) queue(rescanRequested ? NEXT_PAGE_DELAY_MS : nextDelay)
        else report("paused")
      }
    }
  }

  if (active) queue(0)
  else report("paused")

  const dispose = () => {
    if (disposed) return
    disposed = true
    lifecycle.abort()
    cancelTimer?.()
    cancelTimer = null
    releaseSession()
  }

  return {
    setActive(next: boolean) {
      if (disposed || finished || active === next) return
      active = next
      cancelTimer?.()
      cancelTimer = null
      if (!active) report("paused")
      else if (!inFlight)
        queue(session || rescanRequested ? NEXT_PAGE_DELAY_MS : 0)
    },
    /** Request a fresh bounded sweep without draining the caller's own work. */
    requestRescan() {
      if (disposed || finished || rescanRequested) return
      rescanRequested = true
      // Core retains private evidence and only permits restart after all sources
      // finish. First drain remaining pages serially, then restart in step().
      if (active && !inFlight) queue(NEXT_PAGE_DELAY_MS)
    },
    dispose,
    /** Stop new work and drain the bounded logical read before a manual action. */
    async stopAndDrain() {
      dispose()
      await currentStep
    },
  }
}
