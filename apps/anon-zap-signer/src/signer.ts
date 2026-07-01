import {
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
  ANON_SIGNER_ALLOWED_ORIGINS?: string
  ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS?: string
  ANON_SIGNER_PORT?: string
}

const DEFAULT_LOCAL_ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:7000",
  "http://127.0.0.1:7000",
])
const MAX_REQUEST_BYTES = 8_192
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 5 * 60

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

function getAllowedOrigins(env: AnonZapSignerEnv): Set<string> {
  const configured = parseCsv(env.ANON_SIGNER_ALLOWED_ORIGINS)
  return configured.length > 0
    ? new Set(configured)
    : DEFAULT_LOCAL_ALLOWED_ORIGINS
}

function getCorsHeaders(origin: string | null, env: AnonZapSignerEnv): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  })
  if (origin && getAllowedOrigins(env).has(origin)) {
    headers.set("access-control-allow-origin", origin)
  }
  return headers
}

function isOriginAllowed(
  origin: string | null,
  env: AnonZapSignerEnv
): boolean {
  if (!origin) return false
  return getAllowedOrigins(env).has(origin)
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

async function parseJsonRequest(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  const text = await request.text()
  if (text.length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  return JSON.parse(text)
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
  if (!isOriginAllowed(origin, env)) {
    return errorResponse("Origin is not allowed.", 403)
  }

  try {
    const body = await parseJsonRequest(request)
    if (!isRecord(body)) {
      return errorResponse("Invalid request body.", 400, corsHeaders)
    }
    const draft = parseDraft(body.zapRequest)
    if (!draft) {
      return errorResponse("Invalid zap request.", 400, corsHeaders)
    }

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
