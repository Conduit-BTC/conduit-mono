import { randomUUID } from "node:crypto"
import type {
  BrowserContext,
  Frame,
  Page,
  Request,
  Route,
} from "@playwright/test"
import type { HermeticLnurlResponder } from "./hermetic-lnurl"

type HermeticCommerceNetworkOptions = {
  appUrls: readonly string[]
  relayUrl: string
  imageUrl: string
  /** Exact runner-owned responses only; this does not allow public transport. */
  lnurl?: HermeticLnurlResponder
}

type ResourceDocument = { frame: Frame; marker: string | null }

type FrameDocumentState = {
  marker: string | null
  revision: number
  settled: Promise<void>
}

async function abortStoppedRoute(route: Route): Promise<void> {
  // A route may already be cancelled by its own source/context teardown.
  await route.abort("failed").catch(() => undefined)
}

async function readDocumentMarker(
  frame: Frame,
  documentKey: string
): Promise<string | null> {
  try {
    return await frame.evaluate((key) => {
      const marker = (window as unknown as Record<string, unknown>)[key]
      return typeof marker === "string" && marker.length > 0 ? marker : null
    }, documentKey)
  } catch {
    return null
  }
}

const REPLACEMENT_MARKER_RETRY_DELAYS_MS = [0, 25, 75] as const

async function readSettledDocumentMarker(
  frame: Frame,
  documentKey: string
): Promise<string | null> {
  let marker = await readDocumentMarker(frame, documentKey)
  for (const delayMs of REPLACEMENT_MARKER_RETRY_DELAYS_MS) {
    if (marker !== null) return marker
    // A cross-document commit can briefly destroy the old execution context
    // before the init-script marker is readable in its replacement. Yield only
    // at most 100 ms of retry delay, then still require a positive marker.
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    marker = await readDocumentMarker(frame, documentKey)
  }
  return marker
}

function createResourceDocumentTracker(documentKey: string) {
  const states = new WeakMap<Frame, FrameDocumentState>()
  const observedPages = new WeakSet<Page>()

  const refresh = (frame: Frame): FrameDocumentState => {
    const revision = (states.get(frame)?.revision ?? 0) + 1
    let settle!: () => void
    const state: FrameDocumentState = {
      marker: null,
      revision,
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
    }
    states.set(frame, state)
    void readDocumentMarker(frame, documentKey)
      .then((marker) => {
        if (states.get(frame) === state) state.marker = marker
      })
      .finally(settle)
    return state
  }

  const observePage = (page: Page): boolean => {
    if (observedPages.has(page)) return true
    // Unit fakes without page events retain the conservative direct-read path.
    // Real Playwright pages always expose both methods.
    if (typeof page.on !== "function" || typeof page.frames !== "function") {
      return false
    }
    observedPages.add(page)
    page.on("framenavigated", refresh)
    page.on("framedetached", (frame) => states.delete(frame))
    for (const frame of page.frames()) {
      if (!states.has(frame)) refresh(frame)
    }
    return true
  }

  return async (request: Request): Promise<ResourceDocument | null> => {
    try {
      const frame = request.frame()
      const tracked = observePage(frame.page())
      // A failing document navigation is never a harmless old resource, but it
      // must install tracking before commit so old subresources retain their
      // exact initiating document identity.
      if (request.isNavigationRequest()) return null
      if (!tracked) {
        return { frame, marker: await readDocumentMarker(frame, documentKey) }
      }
      const state = states.get(frame) ?? refresh(frame)
      if (state.marker !== null) return { frame, marker: state.marker }
      await state.settled
      // A commit during the first marker read provides no positive original
      // identity. Preserve the fail-closed null marker instead of rebinding the
      // request to whichever document is current after the await.
      if (states.get(frame) !== state) return { frame, marker: null }
      return { frame, marker: state.marker }
    } catch {
      return null
    }
  }
}

async function isAbandonedResourceDocument(
  source: ResourceDocument | null,
  documentKey: string
): Promise<boolean> {
  if (!source) return false
  try {
    if (source.frame.isDetached() || source.frame.page().isClosed()) return true
    if (source.marker === null) return false
    const current = await readSettledDocumentMarker(source.frame, documentKey)
    return current !== null && current !== source.marker
  } catch {
    return false
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.username || url.password ? undefined : url
  } catch {
    return undefined
  }
}

function localOrigin(value: string, protocol: "http:" | "ws:"): URL {
  const url = parseUrl(value)
  if (
    !url ||
    url.protocol !== protocol ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.port === "0" ||
    ["3000", "3001", "3002"].includes(url.port) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Commerce smoke requires explicit loopback origins.")
  }
  return url
}

/** No public target is contacted, including the synthetic image target. */
export function createHermeticCommerceNetworkPolicy(
  options: HermeticCommerceNetworkOptions
) {
  const apps = options.appUrls.map((value) => localOrigin(value, "http:"))
  if (apps.length === 0) {
    throw new Error("Commerce smoke requires at least one local app.")
  }
  const relay = localOrigin(options.relayUrl, "ws:")
  const httpOrigins = new Set([
    ...apps.map((url) => url.origin),
    relay.origin.replace(/^ws:/, "http:"),
  ])
  const socketOrigins = new Set([
    ...apps.map((url) => url.origin.replace(/^http:/, "ws:")),
    relay.origin,
  ])
  const image = parseUrl(options.imageUrl)
  if (!image || image.protocol !== "https:") {
    throw new Error("Commerce smoke requires an HTTPS image fixture target.")
  }
  return {
    http(value: string): "local" | "image" | "blocked" {
      const url = parseUrl(value)
      if (!url) return "blocked"
      if (url.href === image.href) return "image"
      return url.protocol === "http:" && httpOrigins.has(url.origin)
        ? "local"
        : "blocked"
    },
    webSocket(value: string): boolean {
      const url = parseUrl(value)
      return url !== undefined && socketOrigins.has(url.origin)
    },
  }
}

/**
 * Install before navigation in a fresh context with service workers blocked.
 * The runner must call the returned beginTeardown before intentionally closing
 * its context. This stops requests, never removes isolation or enables fallback.
 */
export async function installHermeticCommerceNetwork(
  context: BrowserContext,
  options: HermeticCommerceNetworkOptions
): Promise<() => void> {
  const policy = createHermeticCommerceNetworkPolicy(options)
  const lnurl = options.lnurl
  let tearingDown = false
  // Test-only document identity, not account/payment authority. Unlike URL or
  // framenavigated events, this stays unchanged for same-document navigation.
  // It is never persisted, exposed in evidence, or read from a live profile.
  const documentKey = `__conduitSmokeDocument_${randomUUID()}`
  await context.addInitScript((key) => {
    Object.defineProperty(window, key, { value: crypto.randomUUID() })
  }, documentKey)
  const captureResourceDocument = createResourceDocumentTracker(documentKey)
  await context.route("**/*", async (route) => {
    if (tearingDown) return abortStoppedRoute(route)
    try {
      const request = route.request()
      const url = request.url()
      // Capture the initiating document before any asynchronous fixture work.
      // A navigation can commit while an LNURL responder is resolving; reading
      // the frame marker afterward would bind an old resource to the new
      // document and turn its expected cancellation into a false fatal error.
      const sourceDocument = await captureResourceDocument(request)
      if (lnurl) {
        try {
          const response = await lnurl({ url, method: request.method() })
          if (tearingDown) return abortStoppedRoute(route)
          if (response) {
            await route.fulfill(response)
            return
          }
        } catch {
          // A failed fixture/runner callback never enables real HTTP fallback.
          await route.abort("failed")
          return
        }
      }
      const decision = policy.http(url)
      if (decision === "image") {
        await route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="gray"/></svg>',
        })
        return
      }
      if (decision === "blocked") {
        await route.abort("blockedbyclient")
        return
      }
      // Route handlers do not intercept every redirected request. Never let a
      // local server redirect this isolated scenario onto a public endpoint.
      if (tearingDown) return abortStoppedRoute(route)
      try {
        const response = await route.fetch({ maxRedirects: 0 })
        try {
          if (tearingDown) return abortStoppedRoute(route)
          if (response.status() >= 300 && response.status() < 400) {
            await route.abort("blockedbyclient")
            return
          }
          await route.fulfill({ response })
        } finally {
          await response.dispose()
        }
      } catch {
        if (tearingDown) return abortStoppedRoute(route)
        // Closing/reloading can abandon a resource while another document stays
        // open. Require positive exact-frame/document evidence of abandonment;
        // unknown/current resources and document navigations still fail closed.
        if (await isAbandonedResourceDocument(sourceDocument, documentKey)) {
          // Returning alone leaves Playwright's handled promise pending and can
          // hang unrouteAll({ behavior: "wait" }). Resolve this abandoned route;
          // a source that is already torn down may have cancelled it first.
          await abortStoppedRoute(route)
          return
        }
        throw new Error("Isolated local application request failed.")
      }
    } catch (error) {
      // Only explicit runner-owned teardown may settle current/unknown work.
      // Failures during the active scenario still escape and fail that test.
      if (tearingDown) return abortStoppedRoute(route)
      throw error
    }
  })
  await context.routeWebSocket(/^(?:ws|wss):\/\//, async (socket) => {
    if (tearingDown) {
      await socket
        .close({ code: 1008, reason: "Isolated commerce teardown" })
        .catch(() => undefined)
      return
    }
    if (policy.webSocket(socket.url())) {
      socket.connectToServer()
    } else {
      await socket.close({ code: 1008, reason: "Isolated commerce smoke" })
    }
  })
  return () => {
    tearingDown = true
  }
}
