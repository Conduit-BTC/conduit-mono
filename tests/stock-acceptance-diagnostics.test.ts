import { expect, it } from "bun:test"
import type { Page, TestInfo } from "@playwright/test"
import { IDBFactory } from "fake-indexeddb"
import { observeStockAcceptanceStart } from "../e2e/helpers/stock-acceptance-diagnostics"

// Ordinary observer unit control, not browser/stock-authority qualification.
class Button {
  disabled = false
  hidden = false
  constructor(public textContent: string) {}
  getAttribute() {
    return null
  }
  getClientRects() {
    return this.hidden ? [] : [{}]
  }
}

async function withObserver(
  run: (fixture: {
    document: EventTarget & { buttons: Button[]; alerts: Button[] }
    factory: IDBFactory
    info: TestInfo
    observer: Awaited<ReturnType<typeof observeStockAcceptanceStart>>
    disposed: () => boolean
  }) => Promise<void>
) {
  const document = Object.assign(new EventTarget(), {
    buttons: [new Button("Accept order")],
    alerts: [] as Button[],
    querySelectorAll(selector: string) {
      return selector === "button" ? this.buttons : this.alerts
    },
  })
  const factory = new IDBFactory()
  const replacements = {
    document,
    indexedDB: factory,
    HTMLButtonElement: Button,
    getComputedStyle: () => ({ visibility: "visible" }),
  }
  const previous = Object.keys(replacements).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  )
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  let disposed = false
  const page = {
    async evaluateHandle<T>(install: () => T) {
      const value = install()
      return {
        async evaluate<A, R>(read: (value: T, argument: A) => R, argument: A) {
          return read(value, argument)
        },
        async dispose() {
          disposed = true
        },
      }
    },
  } as unknown as Page
  const observer = await observeStockAcceptanceStart(page)
  try {
    await run({
      document,
      factory,
      info: { annotations: [] } as unknown as TestInfo,
      observer,
      disposed: () => disposed,
    })
  } finally {
    await observer.dispose()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

function gesture(document: EventTarget, type: string, target: Button) {
  const event = new Event(type)
  Object.defineProperty(event, "composedPath", { value: () => [target] })
  document.dispatchEvent(event)
}

async function seedAcceptance(factory: IDBFactory, key?: string) {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open("conduit", 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(
        "merchantInventoryAcceptedOrders"
      )
      if (key) store.put({ unrelatedContent: "not-read" }, key)
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(new Error("fixture setup failed"))
  })
}

it("stock acceptance start observes only the original trigger and separates visible controls", async () => {
  await withObserver(async ({ document, info, observer }) => {
    const original = document.buttons[0]!
    gesture(document, "pointerdown", original)
    document.buttons = [new Button("Accept order"), new Button("Recording…")]
    gesture(document, "pointerup", original)
    gesture(document, "click", new Button("Another action"))
    const saved = new Button("Retry acceptance publication")
    saved.hidden = true
    document.buttons.push(saved)
    document.alerts.push(new Button("not retained"))
    await observer.recordFailure(info, "not-retained", "start_wait")
    expect(JSON.parse(info.annotations[0]!.description!)).toEqual({
      phase: "start_wait",
      observationAvailable: true,
      pointerDownOnTrigger: true,
      pointerUpOnTrigger: true,
      clickOnTrigger: false,
      acceptCardinality: "single",
      acceptVisible: true,
      acceptEnabled: true,
      pendingCardinality: "single",
      pendingVisible: true,
      savedCardinality: "single",
      savedVisible: false,
      alertVisible: true,
      acceptanceReadAvailable: false,
    })
    expect(JSON.stringify(info.annotations)).not.toContain("not-retained")
  })
})

it("stock acceptance start distinguishes exact saved presence from readable absence", async () => {
  for (const present of [false, true])
    await withObserver(async ({ factory, info, observer }) => {
      await seedAcceptance(factory, present ? "exact-order" : "another-order")
      await observer.recordFailure(info, "exact-order", "start_wait")
      expect(JSON.parse(info.annotations[0]!.description!)).toMatchObject({
        acceptanceReadAvailable: true,
        acceptanceCardinality: present ? "single" : "absent",
      })
      expect(JSON.stringify(info.annotations)).not.toContain("exact-order")
      expect(JSON.stringify(info.annotations)).not.toContain("not-read")
    })
})

it("stock acceptance start leaves an absent database absent and removes event listeners", async () => {
  await withObserver(
    async ({ document, factory, info, observer, disposed }) => {
      await observer.recordFailure(info, "exact-order", "click")
      expect(await factory.databases()).toEqual([])
      await observer.dispose()
      gesture(document, "click", document.buttons[0]!)
      await observer.recordFailure(info, "exact-order", "click")
      expect(disposed()).toBe(true)
      expect(JSON.parse(info.annotations[0]!.description!)).toMatchObject({
        clickOnTrigger: false,
        acceptanceReadAvailable: false,
      })
    }
  )
})

it("stock acceptance start reports unavailable storage separately from absent acceptance", async () => {
  await withObserver(async ({ factory, info, observer }) => {
    factory.databases = () => new Promise(() => {})
    await observer.recordFailure(info, "exact-order", "start_wait")
    const values = JSON.parse(info.annotations[0]!.description!)
    expect(values.observationAvailable).toBe(true)
    expect(values.acceptanceReadAvailable).toBe(false)
    expect(values).not.toHaveProperty("acceptanceCardinality")
  })
})

it("stock acceptance start tolerates unavailable page observation and cleanup", async () => {
  const page = {
    evaluateHandle: () => Promise.reject(new Error("not retained")),
  } as unknown as Page
  const observer = await observeStockAcceptanceStart(page)
  const info = { annotations: [] } as unknown as TestInfo
  await observer.recordFailure(info, "not retained", "click")
  await observer.dispose()
  expect(JSON.parse(info.annotations[0]!.description!)).toEqual({
    phase: "click",
    observationAvailable: false,
  })
})
