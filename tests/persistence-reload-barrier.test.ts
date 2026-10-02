import { describe, expect, it } from "bun:test"
import type { Page, Request } from "@playwright/test"
import { installPersistenceReloadBarrier } from "../e2e/helpers/persistence-reload-barrier"

function fixturePage() {
  const listeners = new Map<string, Set<(request: Request) => void>>()
  return {
    page: {
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
  }
}
const localRequest = () =>
  ({ url: () => "http://127.0.0.1:5173/module.js" }) as Request

describe("persistence reload barrier", () => {
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
