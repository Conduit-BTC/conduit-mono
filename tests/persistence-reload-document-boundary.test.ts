import { expect, test } from "bun:test"
import type {
  BrowserContext,
  Frame,
  Page,
  Request,
  Route,
} from "@playwright/test"
import { installHermeticCommerceNetwork } from "../e2e/helpers/hermetic-network"
import { installPersistenceReloadBarrier } from "../e2e/helpers/persistence-reload-barrier"

const appUrl = "http://127.0.0.1:7000"

async function browserFixture(
  options: {
    originalMarker?: string | null
    navigation?: boolean
    sourceUnavailable?: boolean
    requestUrl?: string
    status?: number
    failAt?: "fetch" | "deliver" | "dispose"
    dispose?: () => Promise<void>
  } = {}
) {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  let marker: string | null =
    options.originalMarker === undefined
      ? "synthetic-original-document"
      : options.originalMarker
  let readMarker = async () => marker
  let detached = false
  let closed = false
  let reloads = 0
  let handleRoute!: (route: Route) => Promise<void>
  const page = {
    frames: () => [frame],
    isClosed: () => closed,
    on(event: string, listener: (value: unknown) => void) {
      const registered = listeners.get(event) ?? new Set()
      registered.add(listener)
      listeners.set(event, registered)
    },
    off(event: string, listener: (value: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
    async reload() {
      reloads += 1
      return null
    },
  } as unknown as Page
  const frame = {
    page: () => page,
    isDetached: () => detached,
    evaluate: () => readMarker(),
  } as unknown as Frame
  const otherFrame = {
    page: () => page,
    isDetached: () => false,
    evaluate: async () => "synthetic-other-document",
  } as unknown as Frame
  let requestFrame = frame
  const context = {
    addInitScript: async () => {},
    route: async (_match: string, handler: typeof handleRoute) => {
      handleRoute = handler
    },
    routeWebSocket: async () => {},
  } as unknown as BrowserContext
  const network = await installHermeticCommerceNetwork(context, {
    appUrls: [appUrl],
    relayUrl: "ws://127.0.0.1:17777",
    imageUrl: "https://media.example.invalid/product.svg",
  })
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value)
  }
  const request = {
    url: () =>
      options.requestUrl ??
      `${appUrl}/node_modules/.vite/deps/synthetic-module.js`,
    frame: () => {
      if (options.sourceUnavailable) throw new Error("Synthetic missing frame.")
      return requestFrame
    },
    method: () => "GET",
    isNavigationRequest: () => options.navigation === true,
  } as unknown as Request
  return {
    page,
    network,
    request,
    emit,
    barrier: () =>
      installPersistenceReloadBarrier(page, appUrl, {
        isAbandonedCompletedRequest: network.isAbandonedCompletedRequest,
      }),
    replaceDocument() {
      marker = "synthetic-replacement-document"
      emit("framenavigated", frame)
    },
    sameDocumentNavigation() {
      emit("framenavigated", frame)
    },
    replaceOtherDocument() {
      emit("framenavigated", otherFrame)
    },
    changeRequestFrame() {
      requestFrame = otherFrame
    },
    setMarker(value: string | null) {
      marker = value
    },
    setMarkerReader(reader: () => Promise<string | null>) {
      readMarker = reader
    },
    detach() {
      detached = true
    },
    close() {
      closed = true
    },
    reloads: () => reloads,
    async deliver() {
      emit("request", request)
      await handleRoute({
        request: () => request,
        fetch: async () => {
          if (options.failAt === "fetch") throw new Error("Synthetic fetch.")
          return {
            status: () => options.status ?? 200,
            dispose: async () => {
              if (options.failAt === "dispose")
                throw new Error("Synthetic disposal.")
              await options.dispose?.()
            },
          }
        },
        fulfill: async () => {
          if (options.failAt === "deliver")
            throw new Error("Synthetic delivery.")
        },
        abort: async () => {},
      } as unknown as Route)
      // Chromium can omit both requestfinished and requestfailed for a resource
      // that its own initiating document abandoned after local fulfillment.
    },
  }
}

test("a persistence reload can drain an exactly completed resource of a positively replaced document", async () => {
  const fixture = await browserFixture()
  const barrier = installPersistenceReloadBarrier(fixture.page, appUrl, {
    isAbandonedCompletedRequest: fixture.network.isAbandonedCompletedRequest,
  })
  try {
    await fixture.deliver()
    fixture.replaceDocument()
    await barrier.wait(25)
    await barrier.reload()
    expect(fixture.reloads()).toBe(1)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test("successful delivery alone cannot discard a current or same-document resource", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  try {
    await fixture.deliver()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    fixture.sameDocumentNavigation()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
    fixture.emit("requestfinished", fixture.request)
    await barrier.reload()
    expect(fixture.reloads()).toBe(1)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test.each([
  "original marker",
  "current marker",
  "source frame",
  "different frame",
  "other document",
  "navigation",
  "detached frame",
  "closed page",
] as const)("reload stays blocked with %s evidence", async (missing) => {
  const fixture = await browserFixture({
    ...(missing === "original marker" ? { originalMarker: null } : {}),
    navigation: missing === "navigation",
    sourceUnavailable: missing === "source frame",
  })
  const barrier = fixture.barrier()
  try {
    await fixture.deliver()
    if (missing === "other document") fixture.replaceOtherDocument()
    else fixture.replaceDocument()
    if (missing === "current marker") fixture.setMarker(null)
    if (missing === "different frame") fixture.changeRequestFrame()
    if (missing === "detached frame") fixture.detach()
    if (missing === "closed page") fixture.close()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test("completed local transport for one request does not clear another exact request with the same URL", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  try {
    await fixture.deliver()
    const unfinishedRequest = { ...fixture.request } as Request
    fixture.emit("request", unfinishedRequest)
    fixture.replaceDocument()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
    fixture.emit("requestfinished", unfinishedRequest)
    await barrier.reload()
    expect(fixture.reloads()).toBe(1)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test.each([302, 404, 500])(
  "local HTTP %s cannot substitute for successful fulfillment",
  async (status) => {
    const fixture = await browserFixture({ status })
    const barrier = fixture.barrier()
    try {
      await fixture.deliver()
      fixture.replaceDocument()
      await expect(barrier.wait(10)).rejects.toThrow(
        "Persistence reload work did not settle."
      )
      expect(fixture.reloads()).toBe(0)
    } finally {
      barrier.dispose()
      fixture.network()
    }
  }
)

test.each(["fetch", "deliver", "dispose"] as const)(
  "a local %s failure remains fatal and cannot become completed-work proof",
  async (failAt) => {
    const fixture = await browserFixture({ failAt })
    const barrier = fixture.barrier()
    try {
      await expect(fixture.deliver()).rejects.toThrow(
        "Isolated local application request failed."
      )
      fixture.replaceDocument()
      await expect(barrier.wait(10)).rejects.toThrow(
        "Persistence reload work did not settle."
      )
      fixture.emit("requestfailed", fixture.request)
      await expect(barrier.wait()).rejects.toThrow(
        "Persistence reload local request failed."
      )
      expect(fixture.reloads()).toBe(0)
    } finally {
      barrier.dispose()
      fixture.network()
    }
  }
)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test("fulfilled work stays pending until local response disposal successfully finishes", async () => {
  const disposalStarted = deferred<void>()
  const disposal = deferred<void>()
  const fixture = await browserFixture({
    dispose: async () => {
      disposalStarted.resolve()
      await disposal.promise
    },
  })
  const barrier = fixture.barrier()
  const delivery = fixture.deliver()
  try {
    await disposalStarted.promise
    fixture.replaceDocument()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
    disposal.resolve()
    await delivery
    await barrier.reload()
    expect(fixture.reloads()).toBe(1)
  } finally {
    disposal.resolve()
    await delivery
    barrier.dispose()
    fixture.network()
  }
})

test.each(["failed", "disposed", "teardown"] as const)(
  "%s during a positive document read cannot grant reload authority",
  async (stopped) => {
    const fixture = await browserFixture()
    const barrier = fixture.barrier()
    const readStarted = deferred<void>()
    const read = deferred<string | null>()
    try {
      await fixture.deliver()
      fixture.setMarkerReader(async () => {
        readStarted.resolve()
        return read.promise
      })
      const waiting = barrier.wait(25)
      await readStarted.promise
      if (stopped === "failed") fixture.emit("requestfailed", fixture.request)
      if (stopped === "disposed") barrier.dispose()
      if (stopped === "teardown") fixture.network()
      read.resolve("synthetic-replacement-document")
      const expected =
        stopped === "failed"
          ? "Persistence reload local request failed."
          : stopped === "disposed"
            ? "Persistence reload barrier was disposed."
            : "Persistence reload work did not settle."
      await expect(waiting).rejects.toThrow(expected)
      await expect(barrier.wait(10)).rejects.toThrow(expected)
      expect(fixture.reloads()).toBe(0)
    } finally {
      read.resolve("synthetic-replacement-document")
      barrier.dispose()
      fixture.network()
    }
  }
)

test("a document read finishing after the original wait budget cannot clear admitted work", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  const readStarted = deferred<void>()
  const read = deferred<string | null>()
  try {
    await fixture.deliver()
    fixture.setMarkerReader(async () => {
      readStarted.resolve()
      return read.promise
    })
    const waiting = barrier.wait(10)
    await readStarted.promise
    await expect(waiting).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    fixture.setMarkerReader(async () => "synthetic-original-document")
    read.resolve("synthetic-replacement-document")
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    read.resolve("synthetic-replacement-document")
    barrier.dispose()
    fixture.network()
  }
})

test("a reload rechecks new exact local work admitted while old-document evidence is awaited", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  const readStarted = deferred<void>()
  const read = deferred<string | null>()
  let reloading: Promise<unknown> | undefined
  try {
    await fixture.deliver()
    fixture.setMarkerReader(async () => {
      readStarted.resolve()
      return read.promise
    })
    reloading = barrier.reload()
    await readStarted.promise
    const newRequest = { ...fixture.request } as Request
    fixture.emit("request", newRequest)
    read.resolve("synthetic-replacement-document")
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
    fixture.emit("requestfinished", newRequest)
    await reloading
    expect(fixture.reloads()).toBe(1)
  } finally {
    read.resolve("synthetic-replacement-document")
    barrier.dispose()
    await reloading?.catch(() => undefined)
    fixture.network()
  }
})

test("without the installer's positive proof a replaced resource remains pending", async () => {
  const fixture = await browserFixture()
  const barrier = installPersistenceReloadBarrier(fixture.page, appUrl)
  try {
    await fixture.deliver()
    fixture.replaceDocument()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test("another isolated context cannot supply completion evidence for this exact request", async () => {
  const fixture = await browserFixture()
  const unrelated = await browserFixture()
  const barrier = installPersistenceReloadBarrier(fixture.page, appUrl, {
    isAbandonedCompletedRequest: unrelated.network.isAbandonedCompletedRequest,
  })
  try {
    await fixture.deliver()
    await unrelated.deliver()
    fixture.replaceDocument()
    unrelated.replaceDocument()
    await expect(barrier.wait(10)).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    barrier.dispose()
    fixture.network()
    unrelated.network()
  }
})

test("a late failure for the exact abandoned request remains fatal after its positive drain", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  try {
    await fixture.deliver()
    fixture.replaceDocument()
    await barrier.wait(25)
    fixture.emit("requestfailed", fixture.request)
    await expect(barrier.wait()).rejects.toThrow(
      "Persistence reload local request failed."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    barrier.dispose()
    fixture.network()
  }
})

test("a replacement-marker read crossing a further same-frame document commit cannot drain the request", async () => {
  const fixture = await browserFixture()
  const barrier = fixture.barrier()
  const readStarted = deferred<void>()
  const read = deferred<string | null>()
  try {
    await fixture.deliver()
    fixture.setMarkerReader(async () => {
      readStarted.resolve()
      return read.promise
    })
    const waiting = barrier.wait(25)
    await readStarted.promise
    // Model a replacement document's read completing only after the original
    // document was restored in the same frame (for example through BFCache).
    fixture.setMarkerReader(async () => "synthetic-original-document")
    fixture.sameDocumentNavigation()
    read.resolve("synthetic-replacement-document")
    await expect(waiting).rejects.toThrow(
      "Persistence reload work did not settle."
    )
    expect(fixture.reloads()).toBe(0)
  } finally {
    read.resolve("synthetic-replacement-document")
    barrier.dispose()
    fixture.network()
  }
})
