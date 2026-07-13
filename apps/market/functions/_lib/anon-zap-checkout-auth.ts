import {
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
  CANONICAL_ZAP_PUBLIC_RELAYS,
} from "@conduit/core/config"
import {
  authorizeAnonZapCheckout,
  parseAnonZapCheckoutIntent,
  resolveAnonZapMerchantLud16,
  type AnonZapSigningAuthorization,
  type SignedPublicNostrEvent,
} from "@conduit/core/protocol/anon-zap-checkout"
import {
  fetchLnurlPayMetadata,
  type LnurlPayMetadata,
} from "@conduit/core/protocol/lightning"
import { fetchEventsFanout } from "@conduit/core/protocol/ndk"
import {
  validateAnonZapRequestDraft,
  type AnonZapRequestDraft,
} from "@conduit/core/protocol/anon-zap"

export type AnonZapPagesEnv = {
  ANON_ZAP_ALLOWED_ORIGINS?: string
  ANON_ZAP_SIGNER_URL?: string
  ANON_SIGNER_REQUEST_AUTH_SECRET?: string
  ANON_ZAP_COMMERCE_RELAYS?: string
  ANON_ZAP_RECEIPT_RELAYS?: string
  ANON_ZAP_AUTH_TTL_SECONDS?: string
}

export type AnonZapPagesFunctionContext = {
  request: Request
  env: AnonZapPagesEnv
}

type PublicNostrFilter = {
  kinds: number[]
  authors: string[]
  "#d"?: string[]
  "#a"?: string[]
  "#e"?: string[]
  limit: number
}

export type AnonZapPagesDependencies = {
  fetchPublicEvents: (
    filter: PublicNostrFilter,
    relayUrls: string[]
  ) => Promise<SignedPublicNostrEvent[]>
  fetchLnurlMetadata: (lud16: string) => Promise<LnurlPayMetadata>
  fetchSigner: typeof fetch
  nowSeconds: () => number
}

type AnonZapAuthorizationTokenPayload = {
  version: 1
  expiresAt: number
  draft: AnonZapRequestDraft
  authorization: AnonZapSigningAuthorization
  lnurlCallback: string
  lnurlNostrPubkey: string
  relayUrls: string[]
}

const MAX_REQUEST_BYTES = 16_384
const DEFAULT_AUTH_TTL_SECONDS = 120
const SIGNER_REQUEST_TIMEOUT_MS = 8_000
const AUTH_TIMESTAMP_HEADER = "x-conduit-anon-signer-timestamp"
const AUTH_SIGNATURE_HEADER = "x-conduit-anon-signer-signature"
const TOKEN_DOMAIN = "conduit-anon-zap-checkout-v1"

function toSignedPublicEvent(value: unknown): SignedPublicNostrEvent | null {
  if (!isRecord(value)) return null
  const raw =
    typeof value.rawEvent === "function"
      ? (value.rawEvent as () => unknown)()
      : value
  if (!isRecord(raw) || !Array.isArray(raw.tags)) return null
  if (
    typeof raw.id !== "string" ||
    typeof raw.pubkey !== "string" ||
    typeof raw.created_at !== "number" ||
    typeof raw.kind !== "number" ||
    typeof raw.content !== "string" ||
    typeof raw.sig !== "string"
  ) {
    return null
  }
  return {
    id: raw.id,
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    content: raw.content,
    sig: raw.sig,
    tags: raw.tags as string[][],
  }
}

const defaultDependencies: AnonZapPagesDependencies = {
  fetchPublicEvents: async (filter, relayUrls) => {
    const events = await fetchEventsFanout(
      filter as Parameters<typeof fetchEventsFanout>[0],
      {
        relayUrls,
        connectTimeoutMs: 2_500,
        fetchTimeoutMs: 6_000,
      }
    )
    return events
      .map((event) => toSignedPublicEvent(event))
      .filter((event): event is SignedPublicNostrEvent => !!event)
  },
  fetchLnurlMetadata: fetchLnurlPayMetadata,
  fetchSigner: fetch,
  nowSeconds: () => Math.floor(Date.now() / 1000),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function isOriginPatternMatch(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) return origin === pattern

  try {
    const originUrl = new URL(origin)
    const patternUrl = new URL(pattern)
    if (originUrl.protocol !== patternUrl.protocol) return false
    if (originUrl.port !== patternUrl.port) return false
    if (patternUrl.pathname !== "/" || patternUrl.search || patternUrl.hash) {
      return false
    }
    const wildcardPrefix = "*."
    if (!patternUrl.hostname.startsWith(wildcardPrefix)) return false
    const suffix = patternUrl.hostname.slice(wildcardPrefix.length)
    if (!originUrl.hostname.endsWith(`.${suffix}`)) return false
    const prefix = originUrl.hostname.slice(0, -(suffix.length + 1))
    return !!prefix && !prefix.includes(".")
  } catch {
    return false
  }
}

export function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: HeadersInit = {}
): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", "application/json")
  responseHeaders.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

export function isOriginAllowed(
  request: Request,
  env: AnonZapPagesEnv
): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false

  const configuredPatterns = parseCsv(env.ANON_ZAP_ALLOWED_ORIGINS)
  if (configuredPatterns.length > 0) {
    return configuredPatterns.some((pattern) =>
      isOriginPatternMatch(origin, pattern)
    )
  }

  return origin === new URL(request.url).origin
}

export function assertAllowedOrigin(
  request: Request,
  env: AnonZapPagesEnv
): Response | null {
  if (isOriginAllowed(request, env)) return null
  return jsonResponse({ error: "Origin is not allowed." }, 403)
}

export function getCorsHeaders(
  request: Request,
  env: AnonZapPagesEnv
): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  })
  const origin = request.headers.get("origin")
  if (origin && isOriginAllowed(request, env)) {
    headers.set("access-control-allow-origin", origin)
  }
  return headers
}

export function optionsResponse(
  request: Request,
  env: AnonZapPagesEnv
): Response {
  return new Response(null, {
    status: isOriginAllowed(request, env) ? 204 : 403,
    headers: getCorsHeaders(request, env),
  })
}

function getConfiguredRelays(
  raw: string | undefined,
  fallback: readonly string[]
): string[] {
  const configured = parseCsv(raw)
  return Array.from(new Set(configured.length > 0 ? configured : fallback))
}

function getAuthTtlSeconds(env: AnonZapPagesEnv): number {
  const configured = Number(env.ANON_ZAP_AUTH_TTL_SECONDS)
  return Number.isSafeInteger(configured) &&
    configured >= 30 &&
    configured <= 300
    ? configured
    : DEFAULT_AUTH_TTL_SECONDS
}

function getSharedSecret(env: AnonZapPagesEnv): string {
  const secret = env.ANON_SIGNER_REQUEST_AUTH_SECRET?.trim()
  if (!secret) throw new Error("Anon zap authorization is not configured.")
  return secret
}

function getSignerUrl(env: AnonZapPagesEnv): string {
  const signerUrl = env.ANON_ZAP_SIGNER_URL?.trim()
  if (!signerUrl) throw new Error("Anon zap signer is not configured.")
  return signerUrl
}

async function readRequestJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  return JSON.parse(body)
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value))
  )
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
}

function constantTimeEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index]! ^ right[index]!
  }
  return mismatch === 0
}

async function createAuthorizationToken(
  payload: AnonZapAuthorizationTokenPayload,
  secret: string
): Promise<string> {
  const encodedPayload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  )
  const signature = await hmacSha256(
    secret,
    `${TOKEN_DOMAIN}.${encodedPayload}`
  )
  return `${encodedPayload}.${bytesToBase64Url(signature)}`
}

function parseAuthorizationPayload(
  value: unknown
): AnonZapAuthorizationTokenPayload | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    !isRecord(value.draft) ||
    !isRecord(value.authorization) ||
    typeof value.lnurlCallback !== "string" ||
    typeof value.lnurlNostrPubkey !== "string" ||
    !Array.isArray(value.relayUrls) ||
    !value.relayUrls.every((relay) => typeof relay === "string")
  ) {
    return null
  }
  const draft = value.draft as AnonZapRequestDraft
  const validation = validateAnonZapRequestDraft(draft)
  if (!validation.ok) return null
  const authorization = value.authorization
  if (
    typeof authorization.checkoutSessionId !== "string" ||
    typeof authorization.merchantPubkey !== "string" ||
    typeof authorization.amountMsats !== "number" ||
    typeof authorization.lnurl !== "string" ||
    authorization.publicZapPolicy !== "anonymous_public_zap_allowed"
  ) {
    return null
  }
  return {
    version: 1,
    expiresAt: value.expiresAt,
    draft,
    authorization: authorization as AnonZapSigningAuthorization,
    lnurlCallback: value.lnurlCallback,
    lnurlNostrPubkey: value.lnurlNostrPubkey,
    relayUrls: value.relayUrls as string[],
  }
}

async function verifyAuthorizationToken(
  token: string,
  secret: string,
  nowSeconds: number
): Promise<AnonZapAuthorizationTokenPayload> {
  const [encodedPayload, encodedSignature, extra] = token.split(".")
  if (!encodedPayload || !encodedSignature || extra) {
    throw new Error("Checkout authorization is invalid.")
  }
  const expected = await hmacSha256(secret, `${TOKEN_DOMAIN}.${encodedPayload}`)
  let actual: Uint8Array
  try {
    actual = base64UrlToBytes(encodedSignature)
  } catch {
    throw new Error("Checkout authorization is invalid.")
  }
  if (!constantTimeEquals(expected, actual)) {
    throw new Error("Checkout authorization is invalid.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(encodedPayload))
    )
  } catch {
    throw new Error("Checkout authorization is invalid.")
  }
  const payload = parseAuthorizationPayload(parsed)
  if (!payload) throw new Error("Checkout authorization is invalid.")
  if (payload.expiresAt < nowSeconds) {
    throw new Error("Checkout authorization has expired.")
  }
  return payload
}

function exactDraftMatch(
  expected: AnonZapRequestDraft,
  actual: unknown
): actual is AnonZapRequestDraft {
  return isRecord(actual) && JSON.stringify(actual) === JSON.stringify(expected)
}

export async function authorizeAnonZapRequest(
  request: Request,
  env: AnonZapPagesEnv,
  dependencies: AnonZapPagesDependencies = defaultDependencies
): Promise<Response> {
  const corsHeaders = getCorsHeaders(request, env)
  try {
    getSignerUrl(env)
    const sharedSecret = getSharedSecret(env)
    const intent = parseAnonZapCheckoutIntent(await readRequestJson(request))
    if (!intent)
      return jsonResponse(
        { error: "Invalid checkout intent." },
        400,
        corsHeaders
      )

    const commerceRelays = getConfiguredRelays(env.ANON_ZAP_COMMERCE_RELAYS, [
      ...CANONICAL_APP_BACKPLANE_RELAYS,
      ...CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS,
    ])
    const receiptRelays = getConfiguredRelays(
      env.ANON_ZAP_RECEIPT_RELAYS,
      CANONICAL_ZAP_PUBLIC_RELAYS
    )
    const productAddresses = Array.from(
      new Set(intent.items.map((item) => item.productAddress))
    )
    const dTags = productAddresses.map((address) =>
      address.split(":").slice(2).join(":")
    )
    const [productEvents, profileEvents, addressDeletionEvents] =
      await Promise.all([
        dependencies.fetchPublicEvents(
          {
            kinds: [30402],
            authors: [intent.merchantPubkey],
            "#d": dTags,
            limit: 100,
          },
          commerceRelays
        ),
        dependencies.fetchPublicEvents(
          { kinds: [0], authors: [intent.merchantPubkey], limit: 10 },
          commerceRelays
        ),
        dependencies.fetchPublicEvents(
          {
            kinds: [5],
            authors: [intent.merchantPubkey],
            "#a": productAddresses,
            limit: 300,
          },
          commerceRelays
        ),
      ])
    const productEventIds = Array.from(
      new Set(productEvents.map((event) => event.id).filter(Boolean))
    )
    const eventDeletionEvents =
      productEventIds.length > 0
        ? await dependencies.fetchPublicEvents(
            {
              kinds: [5],
              authors: [intent.merchantPubkey],
              "#e": productEventIds,
              limit: 300,
            },
            commerceRelays
          )
        : []
    const deletionEvents = [...addressDeletionEvents, ...eventDeletionEvents]
    const lud16 = resolveAnonZapMerchantLud16(
      intent.merchantPubkey,
      profileEvents
    )
    const lnurlMetadata = await dependencies.fetchLnurlMetadata(lud16)
    const nowSeconds = dependencies.nowSeconds()
    const checkout = authorizeAnonZapCheckout({
      intent,
      productEvents,
      profileEvents,
      deletionEvents,
      lnurlMetadata,
      receiptRelayUrls: receiptRelays,
      nowSeconds,
    })
    const checkoutSessionId = await sha256Hex(
      JSON.stringify({
        draft: checkout.draft,
        authorization: checkout.authorization,
      })
    )
    const payload: AnonZapAuthorizationTokenPayload = {
      version: 1,
      expiresAt: nowSeconds + getAuthTtlSeconds(env),
      draft: checkout.draft,
      authorization: { ...checkout.authorization, checkoutSessionId },
      lnurlCallback: checkout.lnurlCallback,
      lnurlNostrPubkey: checkout.lnurlNostrPubkey,
      relayUrls: checkout.relayUrls,
    }
    const authorizationToken = await createAuthorizationToken(
      payload,
      sharedSecret
    )
    return jsonResponse(
      {
        authorizationToken,
        expiresAt: payload.expiresAt,
        draft: payload.draft,
        lnurlCallback: payload.lnurlCallback,
        lnurlNostrPubkey: payload.lnurlNostrPubkey,
        relayUrls: payload.relayUrls,
      },
      200,
      corsHeaders
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authorization failed."
    const status = /not configured/i.test(message) ? 503 : 403
    return jsonResponse({ error: message }, status, corsHeaders)
  }
}

export async function signAuthorizedAnonZapRequest(
  request: Request,
  env: AnonZapPagesEnv,
  dependencies: AnonZapPagesDependencies = defaultDependencies
): Promise<Response> {
  const corsHeaders = getCorsHeaders(request, env)
  try {
    const body = await readRequestJson(request)
    if (
      !isRecord(body) ||
      typeof body.authorizationToken !== "string" ||
      !body.zapRequest
    ) {
      return jsonResponse(
        { error: "Invalid signing request." },
        400,
        corsHeaders
      )
    }
    const nowSeconds = dependencies.nowSeconds()
    const secret = getSharedSecret(env)
    const payload = await verifyAuthorizationToken(
      body.authorizationToken,
      secret,
      nowSeconds
    )
    if (!exactDraftMatch(payload.draft, body.zapRequest)) {
      return jsonResponse(
        { error: "Zap request does not match checkout authorization." },
        403,
        corsHeaders
      )
    }

    const signerUrl = getSignerUrl(env)
    const signerBody = JSON.stringify({
      zapRequest: payload.draft,
      authorization: payload.authorization,
    })
    const timestamp = String(nowSeconds)
    const signature = bytesToHex(
      await hmacSha256(secret, `${timestamp}.${signerBody}`)
    )
    const headers = new Headers({
      "content-type": "application/json",
      [AUTH_TIMESTAMP_HEADER]: timestamp,
      [AUTH_SIGNATURE_HEADER]: signature,
    })
    const origin = request.headers.get("origin")
    if (origin) headers.set("origin", origin)
    let signerResponse: Response
    try {
      signerResponse = await dependencies.fetchSigner(signerUrl, {
        method: "POST",
        headers,
        body: signerBody,
        signal: AbortSignal.timeout(SIGNER_REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error("Anon zap signer is temporarily unavailable.")
    }
    if (!signerResponse.ok) {
      throw new Error("Anon zap signer is temporarily unavailable.")
    }
    const signed = (await signerResponse.json()) as unknown
    if (
      !isRecord(signed) ||
      typeof signed.id !== "string" ||
      !signed.rawEvent
    ) {
      throw new Error("Anon zap signer returned an invalid event.")
    }
    return jsonResponse(
      {
        id: signed.id,
        rawEvent: signed.rawEvent,
        requestCreatedAt: payload.draft.createdAt,
        lnurlCallback: payload.lnurlCallback,
        lnurl: payload.authorization.lnurl,
        lnurlNostrPubkey: payload.lnurlNostrPubkey,
        relayUrls: payload.relayUrls,
      },
      200,
      corsHeaders
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signing failed."
    const status = /not configured|temporarily unavailable/i.test(message)
      ? 503
      : 403
    return jsonResponse({ error: message }, status, corsHeaders)
  }
}
