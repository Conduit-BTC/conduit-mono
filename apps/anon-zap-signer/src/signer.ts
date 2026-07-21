import {
  ANON_ZAP_PROVIDER_ATTESTATION_TAG,
  getAnonZapDraftTag,
  type AnonZapRequestDraft,
  validateAnonZapRequestDraft,
  verifyAnonZapProviderAttestation,
} from "@conduit/core/protocol/anon-zap"
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  type Event as NostrEvent,
} from "nostr-tools"

export type AnonZapSignerEnv = {
  ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX?: string
  ANON_CONDUIT_SHOPPER_PUBKEY?: string
  ANON_SIGNER_REQUEST_AUTH_SECRET?: string
  ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS?: string
  ANON_SIGNER_ALLOWED_ORIGINS?: string
  ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS?: string
  ANON_SIGNER_PORT?: string
  ANON_CONDUIT_MARKET_NIP89_ADDRESS?: string
  ANON_CONDUIT_MARKET_NIP89_RELAY_HINT?: string
  ANON_SIGNER_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
  ANON_AUTHORIZATION_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
  ANON_AUTHORITY_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}

type AnonZapSigningAuthorization = {
  checkoutSessionId: string
  merchantPubkey: string
  amountMsats: number
  lnurl: string
  publicZapPolicy: "anonymous_public_zap_allowed"
}

const MAX_REQUEST_BYTES = 8_192
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 5 * 60
const AUTH_TIMESTAMP_HEADER = "x-conduit-anon-signer-timestamp"
const AUTH_SIGNATURE_HEADER = "x-conduit-anon-signer-signature"
const ANON_PUBLIC_ZAP_POLICY = "anonymous_public_zap_allowed"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function jsonResponse(
  body: Record<string, unknown>,
  init: ResponseInit = {},
  extraHeaders: HeadersInit = {}
): Response {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { ...init, headers })
}

function errorResponse(
  message: string,
  status: number,
  corsHeaders: HeadersInit = {}
): Response {
  return jsonResponse({ error: message }, { status }, corsHeaders)
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

function getCorsHeaders(origin: string | null, env: AnonZapSignerEnv): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": [
      "content-type",
      AUTH_TIMESTAMP_HEADER,
      AUTH_SIGNATURE_HEADER,
    ].join(", "),
    "access-control-max-age": "600",
    vary: "Origin",
  })
  if (origin && isOriginAllowed(origin, env)) {
    headers.set("access-control-allow-origin", origin)
  }
  return headers
}

function isOriginAllowed(
  origin: string | null,
  env: AnonZapSignerEnv
): boolean {
  if (!origin) return false
  return parseCsv(env.ANON_SIGNER_ALLOWED_ORIGINS).some((pattern) =>
    isOriginPatternMatch(origin, pattern)
  )
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function normalizePrivateKeyBytes(raw: string | undefined): Uint8Array | null {
  const value = raw?.trim()
  if (!value) return null
  if (/^[0-9a-fA-F]{64}$/.test(value)) return hexToBytes(value)

  try {
    const decoded = nip19.decode(value)
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      return null
    }
    return decoded.data
  } catch {
    return null
  }
}

function normalizeExpectedPubkey(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()

  try {
    const decoded = nip19.decode(value)
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase()
    }
  } catch {
    return null
  }

  return null
}

function normalizeClientRelayHint(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null

  try {
    const url = new URL(value)
    const localhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "wss:" && !(url.protocol === "ws:" && localhost)) {
      return null
    }
    if (url.username || url.password || url.search || url.hash) {
      return null
    }
    const pathname =
      url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

function normalizeMarketNip89Address(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null

  const match = /^31990:([0-9a-f]{64}):([A-Za-z0-9._-]{1,128})$/i.exec(value)
  if (!match) return null
  return `31990:${match[1].toLowerCase()}:${match[2]}`
}

function getAllowedClientTags(env: AnonZapSignerEnv): string[][] {
  const address = normalizeMarketNip89Address(
    env.ANON_CONDUIT_MARKET_NIP89_ADDRESS
  )
  const relayHint = normalizeClientRelayHint(
    env.ANON_CONDUIT_MARKET_NIP89_RELAY_HINT
  )
  if (!address || !relayHint) return []

  return [["client", "Conduit Market", address, relayHint]]
}

function getMaxClockSkewSeconds(env: AnonZapSignerEnv): number {
  const configured = Number(env.ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS)
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_CLOCK_SKEW_SECONDS
}

function assertFreshDraft(
  draft: AnonZapRequestDraft,
  env: AnonZapSignerEnv,
  nowSeconds = Math.floor(Date.now() / 1000)
): void {
  const skew = getMaxClockSkewSeconds(env)
  if (Math.abs(nowSeconds - draft.createdAt) > skew) {
    throw new Error("Zap request timestamp is outside the signing window.")
  }
}

function parseDraft(value: unknown): AnonZapRequestDraft | null {
  if (!isRecord(value)) return null
  const tags = value.tags
  if (!Array.isArray(tags)) return null
  if (
    typeof value.kind !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.content !== "string"
  ) {
    return null
  }
  return {
    kind: value.kind,
    createdAt: value.createdAt,
    content: value.content,
    tags: tags as string[][],
  }
}

function parseAuthorization(
  value: unknown
): AnonZapSigningAuthorization | null {
  if (!isRecord(value)) return null
  if (
    typeof value.checkoutSessionId !== "string" ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(value.checkoutSessionId)
  ) {
    return null
  }
  if (
    typeof value.merchantPubkey !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.merchantPubkey)
  ) {
    return null
  }
  if (
    typeof value.amountMsats !== "number" ||
    !Number.isSafeInteger(value.amountMsats) ||
    value.amountMsats <= 0
  ) {
    return null
  }
  if (typeof value.lnurl !== "string" || !/^lnurl/i.test(value.lnurl)) {
    return null
  }
  if (value.publicZapPolicy !== ANON_PUBLIC_ZAP_POLICY) {
    return null
  }
  return {
    checkoutSessionId: value.checkoutSessionId,
    merchantPubkey: value.merchantPubkey.toLowerCase(),
    amountMsats: value.amountMsats,
    lnurl: value.lnurl,
    publicZapPolicy: ANON_PUBLIC_ZAP_POLICY,
  }
}

function assertAuthorizedDraft(
  draft: AnonZapRequestDraft,
  authorization: AnonZapSigningAuthorization
): void {
  const merchantTag = getAnonZapDraftTag(draft, "p")
  if (merchantTag?.[1]?.toLowerCase() !== authorization.merchantPubkey) {
    throw new Error("Zap request authorization does not match merchant.")
  }
  const amountTag = getAnonZapDraftTag(draft, "amount")
  if (Number(amountTag?.[1]) !== authorization.amountMsats) {
    throw new Error("Zap request authorization does not match amount.")
  }
  const lnurlTag = getAnonZapDraftTag(draft, "lnurl")
  if (lnurlTag?.[1] !== authorization.lnurl) {
    throw new Error("Zap request authorization does not match LNURL.")
  }
}

async function readRequestText(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }

  if (!request.body) return ""

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw new Error("Request body is too large.")
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  return text
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return mismatch === 0
}

function isValidRequestAuthSecret(secret: string): boolean {
  if (/^(?:[0-9a-f]{2}){32,}$/i.test(secret)) return true
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) return false
  try {
    const padded = secret
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(secret.length / 4) * 4, "=")
    return atob(padded).length >= 32
  } catch {
    return false
  }
}

async function createRequestSignature(
  secret: string,
  timestamp: string,
  bodyText: string
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${bodyText}`)
  )
  return bytesToHex(signature)
}

async function assertAuthenticatedRequest(
  request: Request,
  bodyText: string,
  env: AnonZapSignerEnv
): Promise<void> {
  const secret = env.ANON_SIGNER_REQUEST_AUTH_SECRET?.trim()
  if (!secret || !isValidRequestAuthSecret(secret)) {
    throw new Error(
      "Anon signer request auth is not configured with a valid 256-bit secret."
    )
  }

  const timestamp = request.headers.get(AUTH_TIMESTAMP_HEADER)?.trim()
  const signature = request.headers.get(AUTH_SIGNATURE_HEADER)?.trim()
  if (!timestamp || !signature || !/^[0-9a-f]{64}$/i.test(signature)) {
    throw new Error("Anon signer request authentication is missing.")
  }

  const timestampSeconds = Number(timestamp)
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) >
      getMaxClockSkewSeconds(env)
  ) {
    throw new Error("Anon signer request authentication expired.")
  }

  const expectedSignature = await createRequestSignature(
    secret,
    timestamp,
    bodyText
  )
  if (!constantTimeEquals(expectedSignature, signature.toLowerCase())) {
    throw new Error("Anon signer request authentication is invalid.")
  }
}

async function assertWorkerRateLimit(
  env: AnonZapSignerEnv,
  authorization: AnonZapSigningAuthorization,
  corsHeaders: HeadersInit
): Promise<Response | null> {
  if (!env.ANON_SIGNER_RATE_LIMITER) {
    return errorResponse(
      "Anon signer rate limiter is not configured.",
      503,
      corsHeaders
    )
  }
  try {
    const secret = env.ANON_SIGNER_REQUEST_AUTH_SECRET!.trim()
    const keys = await Promise.all([
      createRequestSignature(
        secret,
        "signer-session-rate-limit-v1",
        authorization.checkoutSessionId
      ),
      createRequestSignature(
        secret,
        "signer-merchant-rate-limit-v1",
        authorization.merchantPubkey
      ),
    ])
    for (const key of keys) {
      const result = await env.ANON_SIGNER_RATE_LIMITER.limit({ key })
      if (!result.success) {
        const headers = new Headers(corsHeaders)
        headers.set("retry-after", "60")
        return errorResponse("Anon zap signing is rate limited.", 429, headers)
      }
    }
    return null
  } catch {
    return errorResponse(
      "Anon signer rate limiter is unavailable.",
      503,
      corsHeaders
    )
  }
}

async function handleInternalRateLimitRequest(
  bodyText: string,
  env: AnonZapSignerEnv,
  corsHeaders: HeadersInit
): Promise<Response> {
  const body = JSON.parse(bodyText) as unknown
  if (
    !isRecord(body) ||
    (body.scope !== "authorization" && body.scope !== "authority") ||
    !Array.isArray(body.keys) ||
    body.keys.length === 0 ||
    body.keys.length > 22
  ) {
    return errorResponse("Invalid rate-limit request.", 400, corsHeaders)
  }
  const keyPattern =
    body.scope === "authorization"
      ? /^authorization:(?:global|(?:source|merchant):[0-9a-f]{64})$/
      : /^authority:(?:global|(?:source|source-recipient):[0-9a-f]{64})$/
  if (
    !body.keys.every((key) => typeof key === "string" && keyPattern.test(key))
  ) {
    return errorResponse("Invalid rate-limit request.", 400, corsHeaders)
  }
  const limiter =
    body.scope === "authorization"
      ? env.ANON_AUTHORIZATION_RATE_LIMITER
      : env.ANON_AUTHORITY_RATE_LIMITER
  if (!limiter) {
    return errorResponse(
      "Anon signer rate limiter is not configured.",
      503,
      corsHeaders
    )
  }
  try {
    for (const key of body.keys) {
      const result = await limiter.limit({ key })
      if (!result.success) {
        const headers = new Headers(corsHeaders)
        headers.set("retry-after", "60")
        return errorResponse("Anon zap request is rate limited.", 429, headers)
      }
    }
    return new Response(null, { status: 204, headers: corsHeaders })
  } catch {
    return errorResponse(
      "Anon signer rate limiter is unavailable.",
      503,
      corsHeaders
    )
  }
}

export function getAnonZapSignerDevPort(env: AnonZapSignerEnv): number {
  const port = Number(env.ANON_SIGNER_PORT ?? "7010")
  return Number.isSafeInteger(port) && port > 0 ? port : 7010
}

export async function signAnonZapRequestDraft(
  draft: AnonZapRequestDraft,
  env: AnonZapSignerEnv,
  options: { nowSeconds?: number } = {}
): Promise<NostrEvent> {
  const validation = validateAnonZapRequestDraft(draft, {
    allowedClientTags: getAllowedClientTags(env),
  })
  if (!validation.ok) throw new Error(validation.reason)
  if (getAnonZapDraftTag(draft, "omf")) {
    if (!getAnonZapDraftTag(draft, ANON_ZAP_PROVIDER_ATTESTATION_TAG)) {
      throw new Error("Zap request provider attestation is missing.")
    }
    if (
      verifyAnonZapProviderAttestation(
        draft,
        env.ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS
      ) !== "verified"
    ) {
      throw new Error("Zap request provider attestation is invalid.")
    }
  }
  assertFreshDraft(draft, env, options.nowSeconds)

  const secretBytes = normalizePrivateKeyBytes(
    env.ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX
  )
  if (!secretBytes) {
    throw new Error("Anon signer private key is not configured.")
  }

  const expectedPubkey = normalizeExpectedPubkey(
    env.ANON_CONDUIT_SHOPPER_PUBKEY
  )
  if (!expectedPubkey) {
    throw new Error("Anon signer expected pubkey is not configured.")
  }
  if (getPublicKey(secretBytes) !== expectedPubkey) {
    throw new Error("Anon signer private key does not match expected pubkey.")
  }

  return finalizeEvent(
    {
      kind: draft.kind,
      created_at: draft.createdAt,
      content: draft.content,
      tags: draft.tags.map((tag) => [...tag]),
    },
    secretBytes
  )
}

export async function handleAnonZapSignerRequest(
  request: Request,
  env: AnonZapSignerEnv
): Promise<Response> {
  const origin = request.headers.get("origin")
  const corsHeaders = getCorsHeaders(origin, env)

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: isOriginAllowed(origin, env) ? 204 : 403,
      headers: corsHeaders,
    })
  }
  if (request.method !== "POST") {
    return errorResponse("Method not allowed.", 405, corsHeaders)
  }
  if (origin && !isOriginAllowed(origin, env)) {
    return errorResponse("Origin is not allowed.", 403)
  }

  try {
    const bodyText = await readRequestText(request)
    await assertAuthenticatedRequest(request, bodyText, env)
    if (new URL(request.url).pathname === "/internal/rate-limit") {
      return handleInternalRateLimitRequest(bodyText, env, corsHeaders)
    }
    const body = JSON.parse(bodyText)
    if (!isRecord(body)) {
      return errorResponse("Invalid request body.", 400, corsHeaders)
    }
    const draft = parseDraft(body.zapRequest)
    if (!draft) {
      return errorResponse("Invalid zap request.", 400, corsHeaders)
    }
    const authorization = parseAuthorization(body.authorization)
    if (!authorization) {
      return errorResponse(
        "Invalid zap request authorization.",
        400,
        corsHeaders
      )
    }
    assertAuthorizedDraft(draft, authorization)
    const rateLimitError = await assertWorkerRateLimit(
      env,
      authorization,
      corsHeaders
    )
    if (rateLimitError) return rateLimitError

    const rawEvent = await signAnonZapRequestDraft(draft, env)
    return jsonResponse(
      { id: rawEvent.id, rawEvent },
      { status: 200 },
      corsHeaders
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signing failed."
    return errorResponse(
      message,
      /not configured/i.test(message) ? 503 : 400,
      corsHeaders
    )
  }
}
