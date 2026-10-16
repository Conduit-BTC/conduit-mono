import { expect, it } from "bun:test"
import { observeInbox } from "../packages/core/src/hooks/useCommerceInbox"
import type { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"

it.each([false, true])(
  "honors automatic sync=%s on browser wakeup",
  async (sync) => {
    const browser = new EventTarget()
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
    const document = { visibilityState: "visible" }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: browser,
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: document,
    })
    let reads = 0
    let paints = 0
    let unsubscribed = false
    const owner = {
      initialize: async () => {},
      getSnapshot: () => ({}),
      subscribe: () => () => {
        unsubscribed = true
      },
      syncRecent: async () => {
        reads++
      },
    } as unknown as CommerceInbox
    const stop = observeInbox(
      owner,
      sync,
      () => {
        paints++
      },
      (error) => {
        throw error
      }
    )
    try {
      await Promise.resolve()
      expect(paints).toBe(1)
      expect(reads).toBe(sync ? 1 : 0)
      browser.dispatchEvent(new Event("focus"))
      browser.dispatchEvent(new Event("online"))
      expect(reads).toBe(sync ? 3 : 0)
      document.visibilityState = "hidden"
      browser.dispatchEvent(new Event("focus"))
      browser.dispatchEvent(new Event("online"))
      expect(reads).toBe(sync ? 3 : 0)
      stop()
      document.visibilityState = "visible"
      browser.dispatchEvent(new Event("focus"))
      browser.dispatchEvent(new Event("online"))
      expect(reads).toBe(sync ? 3 : 0)
      expect(unsubscribed).toBe(true)
    } finally {
      stop()
      if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow)
      else Reflect.deleteProperty(globalThis, "window")
      if (oldDocument)
        Object.defineProperty(globalThis, "document", oldDocument)
      else Reflect.deleteProperty(globalThis, "document")
    }
  }
)
