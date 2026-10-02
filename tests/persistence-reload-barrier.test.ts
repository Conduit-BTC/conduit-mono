import { describe, expect, it } from "bun:test"
import type { Page, Request } from "@playwright/test"
import { installPersistenceReloadBarrier } from "../e2e/helpers/persistence-reload-barrier"

function fixturePage() {
  const listeners = new Map<string, Set<(request: Request) => void>>()
  let reloadCalls = 0
  return {
    page: {
      async reload() {
        reloadCalls += 1
        return null
      },
      on(event: string, listener: (request: Request) => void) {
        const registered = listeners.get(event) ?? new Set()
        registered.add(listener)
        listeners.set(event, registered)
      },
      off(event: string, listener: (request: Request) => void) {
        listeners.get(event)?.delete(listener)
      },
    } as unknown as Page,
    emit(event: string, request: Request) {
      for (const listener of listeners.get(event) ?? []) listener(request)
    },
    reloadCalls: () => reloadCalls,
  }
}
const localRequest = () =>
  ({ url: () => "http://127.0.0.1:5173/module.js" }) as Request

describe("persistence reload barrier", () => {
  it("also drains local work admitted after an idle reload starts", async () => {
    const { page, emit, reloadCalls } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    const reload = barrier.reload()
    const request = localRequest()
    emit("request", request)
    await Promise.resolve()
    expect(reloadCalls()).toBe(0)
    emit("requestfinished", request)
    await reload
    expect(reloadCalls()).toBe(1)
    barrier.dispose()
  })

  it("a persistence-only reload preserves admitted local work before replacing the document", async () => {
    const { page, emit, reloadCalls } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    await barrier.wait()
    const request = localRequest()
    emit("request", request)
    const reload = barrier.reload()
    await Promise.resolve()
    expect(reloadCalls()).toBe(0)
    emit("requestfinished", request)
    await reload
    expect(reloadCalls()).toBe(1)
    barrier.dispose()
  })

  it("does not reload after an admitted local request fails", async () => {
    const { page, emit, reloadCalls } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    const request = localRequest()
    emit("request", request)
    const reload = barrier.reload()
    emit("requestfailed", request)
    await expect(reload).rejects.toThrow(
      "Persistence reload local request failed."
    )
    await expect(barrier.reload()).rejects.toThrow(
      "Persistence reload local request failed."
    )
    expect(reloadCalls()).toBe(0)
    barrier.dispose()
  })

  it("does not reload when the barrier is disposed while waiting", async () => {
    const { page, emit, reloadCalls } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    emit("request", localRequest())
    const reload = barrier.reload()
    barrier.dispose()
    await expect(reload).rejects.toThrow(
      "Persistence reload barrier was disposed."
    )
    expect(reloadCalls()).toBe(0)
  })

  it.each(["failed", "disposed"] as const)(
    "rechecks %s state after an initially idle reload yields",
    async (state) => {
      const { page, emit, reloadCalls } = fixturePage()
      const barrier = installPersistenceReloadBarrier(
        page,
        "http://127.0.0.1:5173"
      )
      const reload = barrier.reload()
      if (state === "failed") {
        const request = localRequest()
        emit("request", request)
        emit("requestfailed", request)
      } else {
        barrier.dispose()
      }
      await expect(reload).rejects.toThrow(
        state === "failed"
          ? "Persistence reload local request failed."
          : "Persistence reload barrier was disposed."
      )
      expect(reloadCalls()).toBe(0)
      barrier.dispose()
    }
  )

  it("waits for newly admitted local work, including after an earlier idle period", async () => {
    const { page, emit } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    await barrier.wait()
    const first = localRequest()
    const second = localRequest()
    emit("request", first)
    emit("request", second)
    let admitted = false
    const wait = barrier.wait().then(() => {
      admitted = true
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    emit("requestfinished", first)
    await Promise.resolve()
    expect(admitted).toBe(false)
    emit("requestfinished", second)
    await wait
    expect(admitted).toBe(true)
    barrier.dispose()
  })

  it("times out without admitting reload or clearing the outstanding work", async () => {
    const { page, emit } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    const request = localRequest()
    emit("request", request)
    let admitted = false
    await expect(
      barrier.wait(5).then(() => {
        admitted = true
      })
    ).rejects.toThrow("Persistence reload work did not settle.")
    expect(admitted).toBe(false)
    await expect(barrier.wait(5)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    emit("requestfinished", request)
    await barrier.wait()
    barrier.dispose()
  })

  it("keeps a current local request failure fatal for active and subsequent waits", async () => {
    const { page, emit } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    const request = localRequest()
    emit("request", request)
    const waiting = barrier.wait()
    emit("requestfailed", request)
    await expect(waiting).rejects.toThrow(
      "Persistence reload local request failed."
    )
    await expect(barrier.wait()).rejects.toThrow(
      "Persistence reload local request failed."
    )
    barrier.dispose()
  })

  it("ignores denied public work without allowing it or granting reload authority", async () => {
    const { page, emit } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    const denied = { url: () => "https://fixture.invalid/denied.js" } as Request
    emit("request", denied)
    emit("requestfailed", denied)
    await barrier.wait()
    barrier.dispose()
    await expect(barrier.wait()).rejects.toThrow(
      "Persistence reload barrier was disposed."
    )
  })

  it("disposal rejects an outstanding wait instead of allowing reload", async () => {
    const { page, emit } = fixturePage()
    const barrier = installPersistenceReloadBarrier(
      page,
      "http://127.0.0.1:5173"
    )
    emit("request", localRequest())
    const waiting = barrier.wait()
    barrier.dispose()
    await expect(waiting).rejects.toThrow(
      "Persistence reload barrier was disposed."
    )
  })
})
