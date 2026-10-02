import type { Page, Request } from "@playwright/test"

/**
 * Drain already-admitted local page work before a persistence-only reload.
 * Historical networkidle state is not proof that later SPA module work finished.
 * This never permits transport, suppresses route errors, or locks future work.
 * Install before navigation; do not use in intentional interruption scenarios.
 */
export function installPersistenceReloadBarrier(page: Page, appUrl: string) {
  let app: URL
  try {
    app = new URL(appUrl)
  } catch {
    throw new Error("Persistence reload requires an isolated app origin.")
  }
  if (
    app.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(app.hostname) ||
    !app.port ||
    ["3000", "3001", "3002"].includes(app.port) ||
    app.username ||
    app.password ||
    app.pathname !== "/" ||
    app.search ||
    app.hash
  )
    throw new Error("Persistence reload requires an isolated app origin.")

  const pending = new Set<Request>()
  const waiters = new Set<(error?: Error) => void>()
  let failed = false
  let disposed = false
  const notify = (error?: Error) => {
    for (const settle of [...waiters]) settle(error)
  }
  const onRequest = (request: Request) => {
    try {
      if (new URL(request.url()).origin === app.origin) pending.add(request)
    } catch {
      // A denied malformed/public request gains no transport permission here.
    }
  }
  const onFinished = (request: Request) => {
    if (pending.delete(request) && pending.size === 0) notify()
  }
  const onFailed = (request: Request) => {
    if (!pending.delete(request)) return
    failed = true
    notify(new Error("Persistence reload local request failed."))
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    page.off("request", onRequest)
    page.off("requestfinished", onFinished)
    page.off("requestfailed", onFailed)
    page.off("close", dispose)
    pending.clear()
    notify(new Error("Persistence reload barrier was disposed."))
  }
  page.on("request", onRequest)
  page.on("requestfinished", onFinished)
  page.on("requestfailed", onFailed)
  page.on("close", dispose)
  const barrier = {
    dispose,
    async wait(timeoutMs = 10_000): Promise<void> {
      if (disposed) throw new Error("Persistence reload barrier was disposed.")
      if (failed) throw new Error("Persistence reload local request failed.")
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 60_000
      ) {
        throw new Error("Persistence reload requires a bounded timeout.")
      }
      if (pending.size === 0) return
      await new Promise<void>((resolve, reject) => {
        const settle = (error?: Error) => {
          waiters.delete(settle)
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => {
          settle(new Error("Persistence reload work did not settle."))
        }, timeoutMs)
        waiters.add(settle)
      })
    },
    async reload() {
      for (;;) {
        await barrier.wait()
        // Even an idle wait yields: new work or failure may arrive before this
        // continuation. Recheck synchronously before replacing the document.
        if (disposed)
          throw new Error("Persistence reload barrier was disposed.")
        if (failed) throw new Error("Persistence reload local request failed.")
        if (pending.size === 0) return page.reload()
      }
    },
  }
  return barrier
}
