import { createHash } from "node:crypto"
import { type Page } from "@playwright/test"
import { verifyEvent, type VerifiedEvent } from "nostr-tools/pure"

type BlossomAuthorizationEncoding = "bud11" | "legacy"

export interface InterceptedBlossomState {
  putCount: number
  peakInFlight: number
  originalBodyObserved: boolean
  metadataSentinelObserved: boolean
  capabilityProbeCount: number
  canonicalAuthorizationCount: number
  legacyAuthorizationCount: number
  authorizationEventIds: string[]
  putAuthorizationEncodings: BlossomAuthorizationEncoding[]
  resourceRequestCount: number
  requestHashes: string[]
  resourceUrls: string[]
}

export interface InterceptBlossomOptions {
  abortFirstOnce?: boolean
  failSecondOnce?: boolean
  rejectFirstStatus?: number
  originalHashes?: ReadonlySet<string>
  metadataSentinel?: string
  authorizationMode?: "bud11" | "legacy-required"
  resourcePathPrefix?: string
}

function decodeAuthorization(
  value: string | undefined
): { encoding: BlossomAuthorizationEncoding; event: VerifiedEvent } | null {
  if (!value?.startsWith("Nostr ")) return null
  const token = value.slice("Nostr ".length)
  try {
    const bytes = Buffer.from(token, "base64")
    const encoding =
      token === bytes.toString("base64url")
        ? "bud11"
        : token === bytes.toString("base64")
          ? "legacy"
          : null
    if (!encoding) return null
    const event = JSON.parse(bytes.toString("utf8")) as VerifiedEvent
    return verifyEvent(event) ? { encoding, event } : null
  } catch {
    return null
  }
}

export async function interceptBlossom(
  page: Page,
  serverUrl: string,
  options: InterceptBlossomOptions = {}
): Promise<InterceptedBlossomState> {
  const state: InterceptedBlossomState = {
    putCount: 0,
    peakInFlight: 0,
    originalBodyObserved: false,
    metadataSentinelObserved: false,
    capabilityProbeCount: 0,
    canonicalAuthorizationCount: 0,
    legacyAuthorizationCount: 0,
    authorizationEventIds: [],
    putAuthorizationEncodings: [],
    resourceRequestCount: 0,
    requestHashes: [],
    resourceUrls: [],
  }
  const resources = new Map<string, { body: Buffer; type: string }>()
  const resourcePathPrefix = options.resourcePathPrefix
    ?.replace(/^\/+|\/+$/gu, "")
    .trim()
  const resourceRoot = resourcePathPrefix
    ? `https://cdn.conduit.market/${resourcePathPrefix}`
    : "https://cdn.conduit.market"
  let inFlight = 0

  const validateAuthorization = (
    headers: Record<string, string>
  ): BlossomAuthorizationEncoding | null => {
    const decoded = decodeAuthorization(headers.authorization)
    if (!decoded) return null
    const tags = new Map(decoded.event.tags.map((tag) => [tag[0], tag[1]]))
    const requestedHash = headers["x-sha-256"]
    if (
      decoded.event.kind !== 24_242 ||
      tags.get("t") !== "upload" ||
      tags.get("x") !== requestedHash ||
      tags.get("server") !== new URL(serverUrl).hostname
    ) {
      return null
    }
    if (decoded.encoding === "bud11") state.canonicalAuthorizationCount += 1
    else state.legacyAuthorizationCount += 1
    state.authorizationEventIds.push(decoded.event.id)
    return decoded.encoding
  }

  await page.addInitScript((targetServer) => {
    const browserWindow = window as unknown as {
      __conduitPreparedUploadBodies?: Record<string, number[]>
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (
        url.startsWith(`${targetServer}/`) &&
        init?.method === "PUT" &&
        init.body instanceof Blob
      ) {
        const hash = new Headers(init.headers).get("x-sha-256")
        if (hash) {
          const bytes = new Uint8Array(await init.body.arrayBuffer())
          browserWindow.__conduitPreparedUploadBodies ??= {}
          browserWindow.__conduitPreparedUploadBodies[hash] = Array.from(bytes)
        }
      }
      return originalFetch(input, init)
    }
  }, serverUrl)

  await page.route(`${serverUrl}/**`, async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "HEAD, PUT, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, x-content-length, x-content-type, x-sha-256",
        },
      })
      return
    }
    const headers = request.headers()
    if (request.method() === "HEAD") {
      state.capabilityProbeCount += 1
      const encoding = validateAuthorization(headers)
      const accepted =
        options.authorizationMode === "legacy-required"
          ? encoding === "legacy"
          : encoding === "bud11"
      await route.fulfill({
        status: accepted ? 200 : 400,
        headers: accepted ? { "access-control-allow-origin": "*" } : {},
      })
      return
    }
    if (request.method() !== "PUT") {
      await route.fulfill({ status: 405 })
      return
    }
    state.putCount += 1
    const authorizationEncoding = validateAuthorization(headers)
    if (authorizationEncoding) {
      state.putAuthorizationEncodings.push(authorizationEncoding)
    }
    const acceptedAuthorization =
      options.authorizationMode === "legacy-required"
        ? authorizationEncoding === "legacy"
        : authorizationEncoding === "bud11"
    if (!acceptedAuthorization) {
      await route.fulfill({
        status: 400,
        headers:
          options.authorizationMode === "legacy-required"
            ? {}
            : { "access-control-allow-origin": "*" },
      })
      return
    }
    const requestedHash = headers["x-sha-256"]
    if (requestedHash) state.requestHashes.push(requestedHash)
    inFlight += 1
    state.peakInFlight = Math.max(state.peakInFlight, inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      if (options.rejectFirstStatus && state.putCount === 1) {
        await route.fulfill({
          status: options.rejectFirstStatus,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      if (options.abortFirstOnce && state.putCount === 1) {
        await route.abort("timedout")
        return
      }
      if (options.failSecondOnce && state.putCount === 2) {
        await route.fulfill({
          status: 429,
          headers: { "access-control-allow-origin": "*" },
        })
        return
      }
      let body = request.postDataBuffer()
      if (!body) {
        const expectedHash = request.headers()["x-sha-256"]
        const captured = expectedHash
          ? await page.evaluate((hash) => {
              const browserWindow = window as unknown as {
                __conduitPreparedUploadBodies?: Record<string, number[]>
              }
              return browserWindow.__conduitPreparedUploadBodies?.[hash]
            }, expectedHash)
          : undefined
        if (captured) body = Buffer.from(captured)
      }
      if (!body) throw new Error("Expected prepared upload bytes")
      const hash = createHash("sha256").update(body).digest("hex")
      if (options.originalHashes?.has(hash)) state.originalBodyObserved = true
      if (
        options.metadataSentinel &&
        body.includes(Buffer.from(options.metadataSentinel, "utf8"))
      ) {
        state.metadataSentinelObserved = true
      }
      const type = headers["content-type"] ?? "image/png"
      const resourceUrl = `${resourceRoot}/${hash}.png`
      resources.set(resourceUrl, { body, type })
      state.resourceUrls.push(resourceUrl)
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          url: resourceUrl,
          sha256: hash,
          size: body.byteLength,
          type,
          uploaded: Math.floor(Date.now() / 1_000),
        }),
      })
    } finally {
      inFlight -= 1
    }
  })

  await page.route(`${resourceRoot}/**`, async (route) => {
    const resource = resources.get(route.request().url())
    if (!resource) {
      await route.fulfill({ status: 404 })
      return
    }
    state.resourceRequestCount += 1
    await route.fulfill({
      status: 200,
      contentType: resource.type,
      headers: {
        "access-control-allow-origin": "*",
        "content-length": String(resource.body.byteLength),
      },
      body: resource.body,
    })
  })
  return state
}
