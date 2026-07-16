import {
  CANONICAL_APP_BACKPLANE_RELAYS,
  CANONICAL_ZAP_PUBLIC_RELAYS,
} from "@conduit/core/config"
import {
  authorizeAnonZapCheckout,
  isValidSignedPublicNostrEvent,
  parseAnonZapCheckoutIntent,
  type AnonZapSigningAuthorization,
  type SignedPublicNostrEvent,
} from "@conduit/core/protocol/anon-zap-checkout"
import { fetchEventsFanoutDetailed } from "@conduit/core/protocol/ndk"
import { parseProductEvent } from "@conduit/core/protocol/products"
import {
  createAnonZapProviderAttestation,
  getAnonZapProviderAttestationPublicKey,
  parseAnonZapProviderAttestationPublicKeys,
  validateAnonZapRequestDraft,
  verifyAnonZapProviderAttestation,
  type AnonZapProviderAttestationVerification,
  type AnonZapRequestDraft,
} from "@conduit/core/protocol/anon-zap"
import { isFiatCurrencyCode, type BtcUsdRateQuote } from "@conduit/core/pricing"
import { fetchTrustedPricingRateQuote } from "@conduit/core/pricing/trusted-rate-provider"

export type AnonZapPagesEnv = {
  ANON_ZAP_ALLOWED_ORIGINS?: string
  ANON_ZAP_SIGNER_URL?: string
  ANON_ZAP_SIGNER_ALLOWED_HOSTS?: string
  ANON_ZAP_ALLOW_INSECURE_LOCALHOST?: string
  ANON_SIGNER_REQUEST_AUTH_SECRET?: string
  ANON_ZAP_COMMERCE_RELAYS?: string
  ANON_ZAP_RECEIPT_RELAYS?: string
  ANON_ZAP_AUTH_TTL_SECONDS?: string
  ANON_ZAP_LNURL_ALLOWED_HOSTS?: string
  ANON_ZAP_PROVIDER_ATTESTATION_KEY_ID?: string
  ANON_ZAP_PROVIDER_ATTESTATION_PRIVATE_KEY_HEX?: string
  ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS?: string
  ANON_ZAP_RATE_LIMIT_SERVICE?: AnonZapRateLimitServiceBinding
  ANON_ZAP_SIGNER_SERVICE?: AnonZapSignerServiceBinding
}

export type AnonZapRateLimitServiceBinding = {
  fetch(request: Request): Promise<Response>
}

export type AnonZapSignerServiceBinding = {
  fetch(request: Request): Promise<Response>
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

export type AnonZapPublicReadResult = {
  events: SignedPublicNostrEvent[]
  relays: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
    eventCount: number
  }>
}

export type AnonZapPagesDependencies = {
  fetchPublicEvents: (
    filter: PublicNostrFilter,
    relayUrls: string[]
  ) => Promise<AnonZapPublicReadResult>
  fetchPricingRateQuote: (
    requiredCurrencies: readonly string[]
  ) => Promise<BtcUsdRateQuote>
  fetchSigner: typeof fetch
  nowSeconds: () => number
}

type AnonZapAuthorizationTokenPayload = {
  version: 1
  expiresAt: number
  draft: AnonZapRequestDraft
  authorization: AnonZapSigningAuthorization
  relayUrls: string[]
}

const MAX_REQUEST_BYTES = 16_384
const DEFAULT_AUTH_TTL_SECONDS = 120
const SIGNER_REQUEST_TIMEOUT_MS = 8_000
const AUTH_TIMESTAMP_HEADER = "x-conduit-anon-signer-timestamp"
const AUTH_SIGNATURE_HEADER = "x-conduit-anon-signer-signature"
const TOKEN_DOMAIN = "conduit-anon-zap-checkout-v1"
const RATE_LIMIT_SOURCE_DOMAIN = "conduit-anon-zap-rate-source-v1"
const RATE_LIMIT_MERCHANT_DOMAIN = "conduit-anon-zap-rate-merchant-v1"
const RATE_LIMIT_AUTHORITY_DOMAIN = "conduit-anon-zap-rate-authority-v1"

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
    const result = await fetchEventsFanoutDetailed(
      filter as Parameters<typeof fetchEventsFanoutDetailed>[0],
      {
        relayUrls,
        connectTimeoutMs: 2_500,
        fetchTimeoutMs: 6_000,
        skipHealthFilter: true,
        reuseRelayConnections: false,
      }
    )
    return {
      events: result.events
        .map((event) => toSignedPublicEvent(event))
        .filter((event): event is SignedPublicNostrEvent => !!event),
      relays: result.relays.map((relay) => ({
        relayUrl: relay.relayUrl,
        status: relay.status,
        eventCount: relay.eventCount,
      })),
    }
  },
  fetchPricingRateQuote: (requiredCurrencies) =>
    fetchTrustedPricingRateQuote({
      requiredFiatCurrencies: requiredCurrencies,
      timeoutMs: 3_000,
    }),
  fetchSigner: fetch,
  nowSeconds: () => Math.floor(Date.now() / 1000),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function getRequiredPricingCurrencies(
  intent: { merchantPubkey: string; items: Array<{ productAddress: string }> },
  productEvents: SignedPublicNostrEvent[]
): string[] {
  const currencies = new Set<string>()
  const validProducts = productEvents.filter(
    (event) =>
      event.kind === 30402 &&
      event.pubkey === intent.merchantPubkey &&
      isValidSignedPublicNostrEvent(event)
  )
  for (const item of intent.items) {
    const dTag = item.productAddress.split(":").slice(2).join(":")
    const candidates = validProducts.filter((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag)
    )
    const newestCreatedAt = Math.max(
      ...candidates.map((event) => event.created_at)
    )
    for (const event of candidates.filter(
      (candidate) => candidate.created_at === newestCreatedAt
    )) {
      try {
        const product = parseProductEvent(event)
        const priceCurrency =
          product.sourcePrice?.normalizedCurrency ?? product.currency
        if (isFiatCurrencyCode(priceCurrency)) {
          currencies.add(priceCurrency.trim().toUpperCase())
        }
        const shippingCurrency =
          product.sourceShippingCost?.normalizedCurrency ??
          product.sourceShippingCost?.currency
        if (
          (product.sourceShippingCost?.amount ?? 0) > 0 &&
          shippingCurrency &&
          isFiatCurrencyCode(shippingCurrency)
        ) {
          currencies.add(shippingCurrency.trim().toUpperCase())
        }
      } catch {
        // Authorization below remains responsible for rejecting malformed events.
      }
    }
  }
  return Array.from(currencies).sort()
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

export function getAnonZapReceiptRelays(env: AnonZapPagesEnv): string[] {
  return getConfiguredRelays(
    env.ANON_ZAP_RECEIPT_RELAYS,
    CANONICAL_ZAP_PUBLIC_RELAYS
  )
}

export function getAnonZapCommerceRelays(env: AnonZapPagesEnv): string[] {
  return getConfiguredRelays(
    env.ANON_ZAP_COMMERCE_RELAYS,
    CANONICAL_APP_BACKPLANE_RELAYS
  )
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
  if (!secret || !isValidRequestAuthSecret(secret)) {
    throw new Error(
      "Anon zap authorization is not configured with a valid 256-bit secret."
    )
  }
  return secret
}

function getProviderAttestationSigningConfig(env: AnonZapPagesEnv): {
  keyId: string
  privateKeyHex: string
} {
  const keyId = env.ANON_ZAP_PROVIDER_ATTESTATION_KEY_ID?.trim() ?? ""
  const privateKeyHex =
    env.ANON_ZAP_PROVIDER_ATTESTATION_PRIVATE_KEY_HEX?.trim() ?? ""
  const publicKeys = parseAnonZapProviderAttestationPublicKeys(
    env.ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS
  )
  const derivedPublicKey = getAnonZapProviderAttestationPublicKey(privateKeyHex)
  if (
    !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
    !derivedPublicKey ||
    publicKeys?.get(keyId) !== derivedPublicKey
  ) {
    throw new Error("Anon zap provider attestation is not configured.")
  }
  return { keyId, privateKeyHex }
}

export function verifyAnonZapCheckoutProviderAttestation(
  draft: AnonZapRequestDraft,
  env: AnonZapPagesEnv
): AnonZapProviderAttestationVerification {
  return verifyAnonZapProviderAttestation(
    draft,
    env.ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS
  )
}

function isIpv4Address(hostname: string): boolean {
  const octets = hostname.split(".").map(Number)
  return !(
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
}

function isPrivateIpv4(hostname: string): boolean {
  if (!isIpv4Address(hostname)) return false
  const octets = hostname.split(".").map(Number)
  const [first, second] = octets as [number, number, number, number]
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  )
}

function isPrivateSignerHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    isPrivateIpv4(normalized)
  ) {
    return true
  }
  if (!normalized.includes(":")) return false
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^f[cd][0-9a-f]:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized)
  )
}

function isExplicitLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "127.0.0.1"
}

function getSignerUrl(env: AnonZapPagesEnv): string {
  const signerUrl = env.ANON_ZAP_SIGNER_URL?.trim()
  if (!signerUrl) throw new Error("Anon zap signer is not configured.")

  let parsed: URL
  try {
    parsed = new URL(signerUrl)
  } catch {
    throw new Error("Anon zap signer URL is invalid.")
  }
  const insecureLocalhostAllowed =
    env.ANON_ZAP_ALLOW_INSECURE_LOCALHOST === "true" &&
    isExplicitLocalhost(parsed.hostname)
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && insecureLocalhostAllowed)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && !insecureLocalhostAllowed) ||
    (isPrivateSignerHostname(parsed.hostname) && !insecureLocalhostAllowed)
  ) {
    throw new Error("Anon zap signer URL is invalid.")
  }

  const allowedHosts = parseCsv(env.ANON_ZAP_SIGNER_ALLOWED_HOSTS).map((host) =>
    host.toLowerCase()
  )
  if (allowedHosts.length === 0) {
    throw new Error("Anon zap signer host allow-list is not configured.")
  }
  if (
    !allowedHosts.every(
      (host) =>
        /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) &&
        !host.includes("..") &&
        ((env.ANON_ZAP_ALLOW_INSECURE_LOCALHOST === "true" &&
          isExplicitLocalhost(host)) ||
          (host.includes(".") &&
            !isIpv4Address(host) &&
            !isPrivateSignerHostname(host)))
    ) ||
    !allowedHosts.includes(parsed.hostname.toLowerCase())
  ) {
    throw new Error("Anon zap signer host is not allowed.")
  }
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
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.")
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (bytesToBase64Url(bytes) !== value) {
    throw new Error("Invalid base64url value.")
  }
  return bytes
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

function getCloudflareSource(request: Request): string | null {
  const source = request.headers.get("cf-connecting-ip")?.trim()
  if (!source || source.length > 64) return null
  if (isIpv4Address(source)) return source
  if (!source.includes(":")) return null
  try {
    const parsed = new URL(`http://[${source}]/`)
    return parsed.hostname ? source.toLowerCase() : null
  } catch {
    return null
  }
}

function rateLimitUnavailable(
  message: string,
  corsHeaders: HeadersInit
): Response {
  return jsonResponse({ error: message }, 503, corsHeaders)
}

function rateLimited(message: string, corsHeaders: HeadersInit): Response {
  const headers = new Headers(corsHeaders)
  headers.set("retry-after", "60")
  return jsonResponse({ error: message }, 429, headers)
}

async function applyRequiredRateLimits(
  scope: "authorization" | "authority",
  keys: string[],
  env: AnonZapPagesEnv,
  messages: { unavailable: string; limited: string },
  corsHeaders: HeadersInit
): Promise<Response | null> {
  if (!env.ANON_ZAP_RATE_LIMIT_SERVICE) {
    return rateLimitUnavailable(messages.unavailable, corsHeaders)
  }
  try {
    const secret = getSharedSecret(env)
    const body = JSON.stringify({ scope, keys })
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const signature = bytesToHex(
      await hmacSha256(secret, `${timestamp}.${body}`)
    )
    const response = await env.ANON_ZAP_RATE_LIMIT_SERVICE.fetch(
      new Request("https://anon-zap-rate-limit.internal/internal/rate-limit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_TIMESTAMP_HEADER]: timestamp,
          [AUTH_SIGNATURE_HEADER]: signature,
        },
        body,
      })
    )
    if (response.ok) return null
    if (response.status === 429) {
      return rateLimited(messages.limited, corsHeaders)
    }
    return rateLimitUnavailable(messages.unavailable, corsHeaders)
  } catch {
    return rateLimitUnavailable(messages.unavailable, corsHeaders)
  }
}

async function enforceAnonZapAuthorizationRateLimits(
  request: Request,
  env: AnonZapPagesEnv,
  secret: string,
  merchantPubkey: string,
  corsHeaders: HeadersInit
): Promise<Response | null> {
  const source = getCloudflareSource(request)
  if (!source) {
    return rateLimitUnavailable(
      "Anon zap authorization request source is unavailable.",
      corsHeaders
    )
  }
  try {
    const [sourceKey, merchantKey] = await Promise.all([
      hmacSha256(secret, `${RATE_LIMIT_SOURCE_DOMAIN}.${source}`),
      hmacSha256(secret, `${RATE_LIMIT_MERCHANT_DOMAIN}.${merchantPubkey}`),
    ])
    return applyRequiredRateLimits(
      "authorization",
      [
        "authorization:global",
        `authorization:source:${bytesToHex(sourceKey)}`,
        `authorization:merchant:${bytesToHex(merchantKey)}`,
      ],
      env,
      {
        unavailable: "Anon zap authorization rate limiting is unavailable.",
        limited: "Anon zap authorization is rate limited.",
      },
      corsHeaders
    )
  } catch {
    return rateLimitUnavailable(
      "Anon zap authorization rate limiting is unavailable.",
      corsHeaders
    )
  }
}

export async function enforceAnonZapAuthorityRequestRateLimit(
  request: Request,
  env: AnonZapPagesEnv
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(request, env)
  const source = getCloudflareSource(request)
  if (!source) {
    return rateLimitUnavailable(
      "Anon zap authority request source is unavailable.",
      corsHeaders
    )
  }
  let secret: string
  try {
    secret = getSharedSecret(env)
  } catch {
    return rateLimitUnavailable(
      "Anon zap authority rate limiting is unavailable.",
      corsHeaders
    )
  }
  try {
    const sourceKey = await hmacSha256(
      secret,
      `${RATE_LIMIT_AUTHORITY_DOMAIN}.source.${source}`
    )
    return applyRequiredRateLimits(
      "authority",
      ["authority:global", `authority:source:${bytesToHex(sourceKey)}`],
      env,
      {
        unavailable: "Anon zap authority rate limiting is unavailable.",
        limited: "Anon zap authority lookup is rate limited.",
      },
      corsHeaders
    )
  } catch {
    return rateLimitUnavailable(
      "Anon zap authority rate limiting is unavailable.",
      corsHeaders
    )
  }
}

export async function enforceAnonZapAuthoritySourceRecipientRateLimit(
  request: Request,
  env: AnonZapPagesEnv,
  recipientPubkeys: string | readonly string[]
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(request, env)
  const source = getCloudflareSource(request)
  if (!source) {
    return rateLimitUnavailable(
      "Anon zap authority request source is unavailable.",
      corsHeaders
    )
  }
  const recipients = Array.from(
    new Set(
      (typeof recipientPubkeys === "string"
        ? [recipientPubkeys]
        : recipientPubkeys
      ).map((pubkey) => pubkey.toLowerCase())
    )
  )
  if (
    recipients.length === 0 ||
    recipients.length > 20 ||
    !recipients.every((pubkey) => /^[0-9a-f]{64}$/.test(pubkey))
  ) {
    return jsonResponse(
      { error: "Invalid authority recipient." },
      400,
      corsHeaders
    )
  }
  let secret: string
  try {
    secret = getSharedSecret(env)
  } catch {
    return rateLimitUnavailable(
      "Anon zap authority rate limiting is unavailable.",
      corsHeaders
    )
  }
  try {
    const keys = await Promise.all(
      recipients.map((recipient) =>
        hmacSha256(
          secret,
          `${RATE_LIMIT_AUTHORITY_DOMAIN}.source-recipient.${source}.${recipient}`
        )
      )
    )
    return applyRequiredRateLimits(
      "authority",
      keys.map((key) => `authority:source-recipient:${bytesToHex(key)}`),
      env,
      {
        unavailable: "Anon zap authority rate limiting is unavailable.",
        limited: "Anon zap authority lookup is rate limited.",
      },
      corsHeaders
    )
  } catch {
    return rateLimitUnavailable(
      "Anon zap authority rate limiting is unavailable.",
      corsHeaders
    )
  }
}

export async function enforceAnonZapAuthorityRateLimit(
  request: Request,
  env: AnonZapPagesEnv,
  recipientPubkeys: string | readonly string[]
): Promise<Response | null> {
  const requestLimitError = await enforceAnonZapAuthorityRequestRateLimit(
    request,
    env
  )
  if (requestLimitError) return requestLimitError
  return enforceAnonZapAuthoritySourceRecipientRateLimit(
    request,
    env,
    recipientPubkeys
  )
}

function isValidRequestAuthSecret(secret: string): boolean {
  if (/^(?:[0-9a-f]{2}){32,}$/i.test(secret)) return true
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) return false
  try {
    return base64UrlToBytes(secret).byteLength >= 32
  } catch {
    return false
  }
}

function createCheckoutSessionId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
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

function requireCompletePublicRead(
  result: AnonZapPublicReadResult,
  configuredRelayUrls: readonly string[],
  queryLimit: number
): SignedPublicNostrEvent[] {
  const statuses = new Map(
    result.relays.map((relay) => [relay.relayUrl, relay.status])
  )
  if (
    statuses.size !== configuredRelayUrls.length ||
    configuredRelayUrls.some(
      (relayUrl) => statuses.get(relayUrl) !== "success"
    ) ||
    result.relays.some(
      (relay) =>
        !Number.isSafeInteger(relay.eventCount) ||
        relay.eventCount < 0 ||
        relay.eventCount >= queryLimit
    )
  ) {
    throw new Error("Checkout public relay reads are temporarily unavailable.")
  }
  return result.events
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
    const attestationConfig = getProviderAttestationSigningConfig(env)
    const intent = parseAnonZapCheckoutIntent(await readRequestJson(request))
    if (!intent)
      return jsonResponse(
        { error: "Invalid checkout intent." },
        400,
        corsHeaders
      )

    const rateLimitError = await enforceAnonZapAuthorizationRateLimits(
      request,
      env,
      sharedSecret,
      intent.merchantPubkey,
      corsHeaders
    )
    if (rateLimitError) return rateLimitError

    const commerceRelays = getAnonZapCommerceRelays(env)
    const receiptRelays = getAnonZapReceiptRelays(env)
    const productAddresses = Array.from(
      new Set(intent.items.map((item) => item.productAddress))
    )
    const dTags = productAddresses.map((address) =>
      address.split(":").slice(2).join(":")
    )
    const [productRead, profileRead, addressDeletionRead] = await Promise.all([
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
    const productEvents = requireCompletePublicRead(
      productRead,
      commerceRelays,
      100
    )
    const profileEvents = requireCompletePublicRead(
      profileRead,
      commerceRelays,
      10
    )
    const addressDeletionEvents = requireCompletePublicRead(
      addressDeletionRead,
      commerceRelays,
      300
    )
    const productEventIds = Array.from(
      new Set(productEvents.map((event) => event.id).filter(Boolean))
    )
    const eventDeletionEvents =
      productEventIds.length > 0
        ? requireCompletePublicRead(
            await dependencies.fetchPublicEvents(
              {
                kinds: [5],
                authors: [intent.merchantPubkey],
                "#e": productEventIds,
                limit: 300,
              },
              commerceRelays
            ),
            commerceRelays,
            300
          )
        : []
    const deletionEvents = [...addressDeletionEvents, ...eventDeletionEvents]
    const requiredPricingCurrencies = getRequiredPricingCurrencies(
      intent,
      productEvents
    )
    const pricingRate =
      requiredPricingCurrencies.length > 0
        ? await dependencies
            .fetchPricingRateQuote(requiredPricingCurrencies)
            .catch(() => {
              throw new Error("Checkout pricing is temporarily unavailable.")
            })
        : null
    const nowSeconds = dependencies.nowSeconds()
    const checkout = authorizeAnonZapCheckout({
      intent,
      productEvents,
      profileEvents,
      deletionEvents,
      receiptRelayUrls: receiptRelays,
      pricingRate,
      nowSeconds,
    })
    const providerAttestation = createAnonZapProviderAttestation(
      checkout.draft,
      attestationConfig.keyId,
      attestationConfig.privateKeyHex
    )
    const attestedDraft: AnonZapRequestDraft = {
      ...checkout.draft,
      tags: [...checkout.draft.tags, providerAttestation],
    }
    const checkoutSessionId = createCheckoutSessionId()
    const payload: AnonZapAuthorizationTokenPayload = {
      version: 1,
      expiresAt: nowSeconds + getAuthTtlSeconds(env),
      draft: attestedDraft,
      authorization: { ...checkout.authorization, checkoutSessionId },
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
        relayUrls: payload.relayUrls,
        pricing: checkout.pricing,
      },
      200,
      corsHeaders
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authorization failed."
    const status = /not configured|temporarily unavailable/i.test(message)
      ? 503
      : 403
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
      const signerRequestInit: RequestInit = {
        method: "POST",
        headers,
        body: signerBody,
        signal: AbortSignal.timeout(SIGNER_REQUEST_TIMEOUT_MS),
      }
      signerResponse = env.ANON_ZAP_SIGNER_SERVICE
        ? await env.ANON_ZAP_SIGNER_SERVICE.fetch(
            new Request(signerUrl, signerRequestInit)
          )
        : await dependencies.fetchSigner(signerUrl, signerRequestInit)
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
        lnurl: payload.authorization.lnurl,
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
