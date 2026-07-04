import {
  getAnonZapDraftTag,
  type AnonZapRequestDraft,
  validateAnonZapRequestDraft,
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
  ANON_SIGNER_ALLOWED_ORIGINS?: string
  ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS?: string
  ANON_SIGNER_PORT?: string
}

type AnonZapSigningAuthorization = {
  checkoutSessionId: string
  merchantPubkey: string
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
  if (value.publicZapPolicy !== ANON_PUBLIC_ZAP_POLICY) {
    return null
  }
  return {
    checkoutSessionId: value.checkoutSessionId,
    merchantPubkey: value.merchantPubkey.toLowerCase(),
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
}

async function readRequestText(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) {
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
  if (!secret) {
    throw new Error("Anon signer request auth is not configured.")
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

export function getAnonZapSignerDevPort(env: AnonZapSignerEnv): number {
  const port = Number(env.ANON_SIGNER_PORT ?? "7010")
  return Number.isSafeInteger(port) && port > 0 ? port : 7010
}

export async function signAnonZapRequestDraft(
  draft: AnonZapRequestDraft,
  env: AnonZapSignerEnv,
  options: { nowSeconds?: number } = {}
): Promise<NostrEvent> {
  const validation = validateAnonZapRequestDraft(draft)
  if (!validation.ok) throw new Error(validation.reason)
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

    const rawEvent = await signAnonZapRequestDraft(draft, env)
    return jsonResponse(
      { id: rawEvent.id, rawEvent },
      { status: 200 },
      corsHeaders
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signing failed."
    return errorResponse(message, 400, corsHeaders)
  }
}
