import {
  ADDRESS_REQUEST_ACTION,
  ADDRESS_REQUEST_PATH,
  addressRequestHash,
  validSparkIdentity,
  verifyAddressRequestAuthority,
  verifyAddressWalletSignature,
  type SignedAddressNameRequest,
} from "@conduit/core/wallets/address-name-request"
import { breezAddressMessage } from "@conduit/core/wallets/breez-lightning-address"
import { verifyEvent, type Event } from "nostr-tools/pure"
import { boundedText } from "./bounded-text"
import {
  admitPreviewOrigin,
  previewProject,
  type PreviewOriginEnv,
} from "./preview-origin"

export interface ApprovedName {
  name: string
  ownerPubkey: string
  sparkIdentity: string
  registration: boolean
  replaces?: string
  deleteUntil?: number
  transferFrom?: string
  transferUntil?: number
}
export interface Statement {
  bind(...values: unknown[]): Statement
  first<T>(): Promise<T | null>
  run(): Promise<{ success: boolean; meta: { changes: number } }>
}
export interface AddressGatewayEnv extends PreviewOriginEnv {
  ADDRESS_REQUESTS: { prepare(sql: string): Statement }
  REQUEST_RATE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
  ALLOWED_ORIGINS: string
  TURNSTILE_HOSTNAMES: string
  TURNSTILE_SECRET_KEY: string
  BREEZ_PROXY_SHARED_SECRET: string
  BREEZ_DOMAIN_API_KEY: string
  PROVIDER_PROXY_QUALIFIED: string
}
export type GatewayFetch = typeof fetch
const NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/
function validName(value: string): boolean {
  return typeof value === "string" && value.length <= 64 && NAME.test(value)
}
export function validateApprovedNames(names: ApprovedName[]): void {
  const used = new Set<string>()
  for (const n of names) {
    if (
      !validName(n.name) ||
      used.has(n.name) ||
      !validSparkIdentity(n.sparkIdentity) ||
      !/^[a-f0-9]{64}$/.test(n.ownerPubkey) ||
      typeof n.registration !== "boolean" ||
      (n.replaces !== undefined && !validName(n.replaces)) ||
      (n.transferFrom !== undefined && !validSparkIdentity(n.transferFrom)) ||
      (n.deleteUntil !== undefined &&
        (!Number.isSafeInteger(n.deleteUntil) || n.deleteUntil <= 0)) ||
      (n.transferUntil !== undefined &&
        (!Number.isSafeInteger(n.transferUntil) || n.transferUntil <= 0)) ||
      (n.transferFrom === undefined) !== (n.transferUntil === undefined)
    )
      throw new Error("Invalid approved-name registry.")
    used.add(n.name)
  }
  const registrations = names
    .filter((n) => n.registration)
    .map((n) => n.sparkIdentity)
  if (new Set(registrations).size !== registrations.length)
    throw new Error("Conflicting wallet approvals.")
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  })
}
function decodeAccountProof(request: Request): Event | null {
  const header = request.headers.get("Authorization") ?? ""
  if (!header.startsWith("Nostr ") || header.length > 4096) return null
  try {
    return JSON.parse(atob(header.slice(6))) as Event
  } catch {
    return null
  }
}
function validManagementAccountProof(
  request: Request,
  raw: string,
  ownerPubkey: string,
  now: number
): boolean {
  try {
    const event = decodeAccountProof(request)
    if (
      !event ||
      event.pubkey !== ownerPubkey ||
      event.kind !== 27235 ||
      event.content !== "" ||
      !Number.isSafeInteger(event.created_at) ||
      Math.abs(now - event.created_at) > 60 ||
      !verifyEvent(event)
    )
      return false
    return (
      JSON.stringify(event.tags) ===
      JSON.stringify([
        ["u", request.url],
        ["method", request.method],
        ["payload", addressRequestHash(raw)],
      ])
    )
  } catch {
    return false
  }
}
async function nameRequest(
  request: Request,
  env: AddressGatewayEnv,
  names: ApprovedName[],
  fetcher: GatewayFetch,
  now: number
): Promise<Response> {
  const path = new URL(request.url).pathname
  const raw = await boundedText(request.body, 8192)
  const value = JSON.parse(raw) as SignedAddressNameRequest
  let event = decodeAccountProof(request)
  const original = request.headers.get("X-Address-Request-Proof")
  if (original !== null) {
    if (
      !original ||
      original.length > 5500 ||
      !validManagementAccountProof(request, raw, value.ownerPubkey, now)
    )
      return response({ status: "invalid" }, 401)
    try {
      event = JSON.parse(atob(original)) as Event
    } catch {
      return response({ status: "invalid" }, 401)
    }
  }
  if (
    !event ||
    value.timestamp > now + 60 ||
    !verifyAddressRequestAuthority(
      value,
      event,
      original !== null ? ADDRESS_REQUEST_PATH : path,
      original !== null ? value.timestamp : now,
      new URL(request.url).origin,
      raw
    )
  )
    return response({ status: "invalid" }, 401)
  const hash = addressRequestHash(
    JSON.stringify([
      value.ownerPubkey,
      value.sparkIdentity,
      value.desiredName,
      value.note,
    ])
  )
  const previous = await env.ADDRESS_REQUESTS.prepare(
    "SELECT owner_pubkey, spark_identity, desired_name, request_hash, signed_payload, status FROM name_requests WHERE request_id = ?"
  )
    .bind(value.requestId)
    .first<{
      owner_pubkey: string
      spark_identity: string
      desired_name: string
      request_hash: string
      signed_payload: string
      status: string
    }>()
  if (
    previous &&
    (previous.owner_pubkey !== value.ownerPubkey ||
      previous.spark_identity !== value.sparkIdentity ||
      previous.desired_name !== value.desiredName ||
      (original !== null && previous.signed_payload !== raw) ||
      (!path.endsWith("/status") && previous.request_hash !== hash))
  )
    return response({ status: "invalid" }, 409)
  if (path.endsWith("/status") || previous) {
    if (!previous) return response({ status: "not_received" }, 404)
    const approved = names.find(
      (n) =>
        n.name === value.desiredName &&
        n.sparkIdentity === value.sparkIdentity &&
        n.ownerPubkey === value.ownerPubkey &&
        n.registration
    )
    return response({ status: approved ? "approved" : previous.status })
  }
  if (!env.TURNSTILE_SECRET_KEY || !env.REQUEST_RATE_LIMITER)
    return response({ status: "unavailable" }, 503)
  if (
    !(await env.REQUEST_RATE_LIMITER.limit({ key: value.ownerPubkey })).success
  )
    return response({ status: "rate_limited" }, 429)
  const token = request.headers.get("X-Turnstile-Token")
  if (!token || token.length > 2048)
    return response({ status: "challenge_failed" }, 400)
  const verified = await fetcher(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        // A new security token is a new verification attempt. Reusing the
        // durable request ID here can replay a cached rejection after refresh.
        idempotency_key: crypto.randomUUID(),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!verified.ok) return response({ status: "unavailable" }, 503)
  const challenge = JSON.parse(await boundedText(verified.body, 4096)) as {
    success?: boolean
    hostname?: string
    action?: string
  }
  if (
    !challenge.success ||
    challenge.action !== ADDRESS_REQUEST_ACTION ||
    challenge.hostname !== new URL(request.headers.get("Origin")!).hostname ||
    (!previewProject(request.headers.get("Origin")!) &&
      !env.TURNSTILE_HOSTNAMES.split(",").includes(challenge.hostname ?? ""))
  )
    return response({ status: "challenge_failed" }, 400)
  const result = await env.ADDRESS_REQUESTS.prepare(
    "INSERT OR IGNORE INTO name_requests (request_id, owner_pubkey, spark_identity, desired_name, note, request_hash, signed_payload, account_proof, wallet_proof, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      value.requestId,
      value.ownerPubkey,
      value.sparkIdentity,
      value.desiredName,
      value.note,
      hash,
      raw,
      JSON.stringify(original !== null ? { version: 2, event } : event),
      value.walletSignature,
      now
    )
    .run()
  if (!result.success) return response({ status: "unavailable" }, 503)
  const saved = await env.ADDRESS_REQUESTS.prepare(
    "SELECT request_hash, signed_payload FROM name_requests WHERE request_id = ?"
  )
    .bind(value.requestId)
    .first<{ request_hash: string; signed_payload: string }>()
  return saved?.request_hash === hash &&
    (original === null || saved.signed_payload === raw)
    ? response({ status: "received" })
    : response({ status: "invalid" }, 409)
}
function fresh(timestamp: unknown, now: number): timestamp is number {
  return (
    Number.isSafeInteger(timestamp) &&
    Math.abs(now - (timestamp as number)) <= 600
  )
}
// A reviewed PR/deployment window is not the provider's signed-message window.
// Keep exceptional destructive authority bounded without requiring a deploy
// within ten minutes of an absolute expiration timestamp.
function approvalWindow(until: number | undefined, now: number): boolean {
  return (
    until !== undefined &&
    Number.isSafeInteger(until) &&
    until >= now &&
    until - now <= 86400
  )
}
async function recoveryRateLimit(
  request: Request,
  env: AddressGatewayEnv,
  identity: string
): Promise<Response | null> {
  if (!env.REQUEST_RATE_LIMITER || !env.BREEZ_PROXY_SHARED_SECRET)
    return response("recovery unavailable", 503)
  // Cloudflare supplies this header at the edge. HMAC prevents raw source IPs
  // from entering limiter keys or diagnostics; a missing source shares a bucket.
  const source = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BREEZ_PROXY_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`address-recovery-source:${source}`)
  )
  const sourceKey = `recover:source:${Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")}`
  if (!(await env.REQUEST_RATE_LIMITER.limit({ key: sourceKey })).success)
    return response("recovery rate limited", 429)
  if (
    !(
      await env.REQUEST_RATE_LIMITER.limit({
        key: `recover:identity:${addressRequestHash(identity)}`,
      })
    ).success
  )
    return response("recovery rate limited", 429)
  return null
}
async function proxy(
  request: Request,
  env: AddressGatewayEnv,
  body: string | undefined,
  fetcher: GatewayFetch
): Promise<Response> {
  if (!env.BREEZ_PROXY_SHARED_SECRET || !env.BREEZ_DOMAIN_API_KEY)
    return response("domain unavailable", 503)
  const source = new URL(request.url)
  // A same-zone Route subrequest goes to the zone's DNS origin. Keep the
  // custom domain in the URL so TLS SNI and Host both identify it at Breez.
  const upstream = new URL(
    source.pathname + source.search,
    "https://conduit.cash"
  )
  const headers = new Headers({
    "X-Breez-Reverse-Proxy-Shared-Secret": env.BREEZ_PROXY_SHARED_SECRET,
    "X-Forwarded-For": request.headers.get("CF-Connecting-IP") ?? "",
  })
  // No client-supplied proxy headers, cookies or bearer credentials reach Breez.
  headers.set("Authorization", `Bearer ${env.BREEZ_DOMAIN_API_KEY}`)
  if (body !== undefined) headers.set("Content-Type", "application/json")
  for (const name of ["x-breez-signature", "x-breez-timestamp"]) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const result = await fetcher(upstream, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (result.status >= 300 && result.status < 400)
    return response("upstream redirect rejected", 502)
  const text = result.body ? await boundedText(result.body, 65536) : ""
  if (
    text.includes(env.BREEZ_PROXY_SHARED_SECRET) ||
    text.includes(env.BREEZ_DOMAIN_API_KEY)
  )
    return response("upstream response rejected", 502)
  return new Response(text, {
    status: result.status,
    headers: {
      "Content-Type": result.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  })
}
async function management(
  request: Request,
  env: AddressGatewayEnv,
  names: ApprovedName[],
  fetcher: GatewayFetch,
  now: number
): Promise<Response> {
  const url = new URL(request.url)
  const match =
    /^\/lnurlpay\/((?:02|03)[a-f0-9]{64})(?:\/(recover|available|transfer|metadata))?$/.exec(
      url.pathname
    )
  if (!match || !validSparkIdentity(match[1]!))
    return response("invalid route", 404)
  const identity = match[1]!,
    operation =
      match[2] ?? (request.method === "DELETE" ? "unregister" : "register")
  if (operation === "metadata") return response("metadata unavailable", 403)
  if (
    (operation === "unregister"
      ? request.method !== "DELETE"
      : request.method !== "POST") ||
    url.search
  )
    return response("invalid route", 405)
  const raw = await boundedText(request.body, 8192)
  const body = JSON.parse(raw) as Record<string, unknown>
  if (!fresh(body.timestamp, now)) return response("invalid timestamp", 401)
  const timestamp = body.timestamp
  const name = typeof body.username === "string" ? body.username : ""
  const description =
    typeof body.description === "string" ? body.description : ""
  if (
    description.length > 1024 ||
    (operation !== "recover" && !validName(name))
  )
    return response("invalid request", 400)
  const approval = names.find(
    (n) => n.name === name && n.sparkIdentity === identity
  )
  let verifiedStatements: string[]
  if (operation === "transfer") {
    const from = String(body.from_pubkey ?? "")
    if (
      !approval ||
      approval.transferFrom !== from ||
      !approvalWindow(approval.transferUntil, now) ||
      from === identity
    )
      return response("name not approved", 403)
    const base = [
      "breez-lnurl:v2",
      "transfer-from",
      "conduit.cash",
      name,
      from,
      identity,
      String(timestamp),
    ].join("\n")
    const target = [
      "breez-lnurl:v2",
      "transfer-to",
      "conduit.cash",
      name,
      from,
      identity,
      addressRequestHash(description),
      String(timestamp),
    ].join("\n")
    if (
      !verifyAddressWalletSignature(base, String(body.from_signature), from) ||
      !verifyAddressWalletSignature(target, String(body.to_signature), identity)
    )
      return response("invalid signature", 401)
    verifiedStatements = [base, target]
  } else {
    const message =
      operation === "unregister"
        ? [
            "breez-lnurl:v2",
            "unregister",
            "conduit.cash",
            name,
            String(timestamp),
          ].join("\n")
        : breezAddressMessage({
            operation: operation as "register" | "recover" | "available",
            domain: "conduit.cash",
            identity,
            timestamp,
            username: name,
            description,
          })
    if (
      !verifyAddressWalletSignature(message, String(body.signature), identity)
    )
      return response("invalid signature", 401)
    verifiedStatements = [message]
    if (operation === "available" && !approval?.registration)
      return response("name not approved", 403)
    if (
      operation === "unregister" &&
      (!approval || !approvalWindow(approval.deleteUntil, now))
    )
      return response("deletion not approved", 403)
    if (operation === "register") {
      if (!approval?.registration) return response("name not approved", 403)
      const observed = await env.ADDRESS_REQUESTS.prepare(
        "SELECT name, observed_at FROM address_observations WHERE identity = ?"
      )
        .bind(identity)
        .first<{ name: string | null; observed_at: number }>()
      if (
        !observed ||
        now - observed.observed_at > 60 ||
        (observed.name !== null &&
          observed.name !== name &&
          observed.name !== approval.replaces)
      )
        return response("recover wallet before registration", 409)
    }
  }
  if (
    !["recover", "available"].includes(operation) &&
    (!approval ||
      !validManagementAccountProof(request, raw, approval.ownerPubkey, now))
  )
    return response("invalid account proof", 401)
  if (operation === "recover") {
    const limited = await recoveryRateLimit(request, env, identity)
    if (limited) return limited
  }
  if (!["recover", "available"].includes(operation)) {
    if (env.PROVIDER_PROXY_QUALIFIED !== "true")
      return response("domain management unavailable", 503)
    const statement = addressRequestHash(
      JSON.stringify([identity, ...verifiedStatements])
    )
    const claim = await env.ADDRESS_REQUESTS.prepare(
      "INSERT OR IGNORE INTO mutation_claims (statement_hash, identity, expires_at) VALUES (?, ?, ?)"
    )
      .bind(statement, identity, timestamp + 600)
      .run()
    if (!claim.success || claim.meta.changes !== 1)
      return response("registration pending", 409)
  }
  const result = await proxy(request, env, raw, fetcher)
  if (operation === "recover") {
    let observed: string | null | undefined
    const data: unknown = await result.clone().json()
    if (result.status === 404 && data === "user not found") observed = null
    if (result.ok && data && typeof data === "object") {
      const value = data as Record<string, unknown>
      if (
        typeof value.username === "string" &&
        validName(value.username) &&
        value.lightning_address === `${value.username}@conduit.cash` &&
        value.lnurl === `lnurlp://conduit.cash/lnurlp/${value.username}`
      )
        observed = value.username
    }
    if (
      observed !== undefined &&
      names.some((name) => name.sparkIdentity === identity && name.registration)
    ) {
      await env.ADDRESS_REQUESTS.prepare(
        "DELETE FROM address_observations WHERE observed_at < ?"
      )
        .bind(now - 86400)
        .run()
      await env.ADDRESS_REQUESTS.prepare(
        "INSERT INTO address_observations (identity, name, observed_at) VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET name = excluded.name, observed_at = excluded.observed_at WHERE excluded.observed_at >= observed_at"
      )
        .bind(identity, observed, now)
        .run()
    }
  }
  return result
}
function isPublicReceivingPath(pathname: string): boolean {
  return (
    /^\/\.well-known\/lnurlp\/[a-z0-9_.-]+$/.test(pathname) ||
    /^\/lnurlp\/[a-z0-9_.-]+(?:\/(?:invoice|verify)(?:\/[a-f0-9]+)?)?$/.test(
      pathname
    ) ||
    /^\/lnurlp\/verify\/[a-f0-9]{64}$/.test(pathname)
  )
}
export async function handleAddressGateway(
  request: Request,
  env: AddressGatewayEnv,
  names: ApprovedName[],
  fetcher: GatewayFetch = fetch,
  now = Math.floor(Date.now() / 1000)
): Promise<Response> {
  const origin = request.headers.get("Origin")
  const url = new URL(request.url)
  const publicReceiving =
    ["GET", "OPTIONS"].includes(request.method) &&
    isPublicReceivingPath(url.pathname)
  const readiness =
    url.pathname === `${ADDRESS_REQUEST_PATH}/availability` &&
    request.method === "GET" &&
    !url.search
  const exactOrigin =
    !!origin && env.ALLOWED_ORIGINS.split(",").includes(origin)
  const admission =
    !origin || publicReceiving || exactOrigin
      ? "allowed"
      : await admitPreviewOrigin(origin, env, fetcher, now)
  const allowed = admission === "allowed"
  let result: Response
  try {
    validateApprovedNames(names)
    if (readiness) {
      const status = !origin
        ? "origin_forbidden"
        : !allowed
          ? admission
          : !env.TURNSTILE_SECRET_KEY || !env.REQUEST_RATE_LIMITER
            ? "unavailable"
            : "ready"
      result = response(
        { status },
        status === "ready" ? 200 : status === "unavailable" ? 503 : 403
      )
    } else if (origin && !allowed)
      result = response(
        { status: admission },
        admission === "unavailable" ? 503 : 403
      )
    else if (request.method === "OPTIONS")
      result = new Response(null, { status: 204 })
    else if (
      [ADDRESS_REQUEST_PATH, `${ADDRESS_REQUEST_PATH}/status`].includes(
        url.pathname
      )
    ) {
      result =
        request.method === "POST" && !!origin && allowed && !url.search
          ? await nameRequest(request, env, names, fetcher, now)
          : response({ status: "invalid" }, 405)
    } else if (url.pathname.startsWith("/lnurlpay/"))
      result = await management(request, env, names, fetcher, now)
    else if (request.method === "GET" && isPublicReceivingPath(url.pathname))
      result = await proxy(request, env, undefined, fetcher)
    else result = response("not found", 404)
  } catch {
    result = response("request unavailable", 503)
  }
  result.headers.set("X-Conduit-Address-Gateway", "approved-names-v1")
  // Readiness is public, contains no request data and uses no credentials. Expose
  // its denial to browsers so a blocked preflight is never mistaken for submission.
  if (origin && (allowed || readiness)) {
    result.headers.set(
      "Access-Control-Allow-Origin",
      publicReceiving ? "*" : origin
    )
    result.headers.set("Vary", "Origin")
    result.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS"
    )
    result.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Turnstile-Token, X-Address-Request-Proof"
    )
  }
  return result
}
