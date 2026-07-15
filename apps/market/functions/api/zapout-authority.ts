import type { AnonZapRequestDraft } from "@conduit/core/protocol/anon-zap"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "@conduit/core/protocol/anon-zap-checkout"
import { EVENT_KINDS } from "@conduit/core/protocol/kinds"
import {
  fetchLnurlPayMetadata,
  parseOmfZapoutReceipt,
  verifyOmfZapoutReceiptAuthority,
  type LnurlPayMetadata,
  type OmfZapoutReceiptEvent,
} from "@conduit/core/protocol/lightning"
import { fetchEventsFanoutDetailed } from "@conduit/core/protocol/ndk"
import { normalizePubkey } from "@conduit/core/utils"

import {
  assertAllowedOrigin,
  enforceAnonZapAuthoritySourceRecipientRateLimit,
  enforceAnonZapAuthorityRequestRateLimit,
  getAnonZapCommerceRelays,
  getCorsHeaders,
  jsonResponse,
  optionsResponse,
  verifyAnonZapCheckoutProviderAttestation,
  type AnonZapPagesEnv,
  type AnonZapPagesFunctionContext,
} from "../_lib/anon-zap-checkout-auth"

type ZapoutAuthorityStatus = "verified" | "invalid" | "authority_unavailable"

type ZapoutAuthorityDependencies = {
  fetchProfileEvents: (
    recipientPubkeys: string[],
    relayUrls: string[]
  ) => Promise<{
    events: SignedPublicNostrEvent[]
    complete: boolean
  }>
  fetchLnurlMetadata: (
    lud16: string,
    options?: { timeoutMs?: number }
  ) => Promise<LnurlPayMetadata>
  nowMs: () => number
}

type AuthorityResolution =
  | {
      status: "resolved"
      pubkey: string
      mismatchStatus?: "invalid" | "unavailable"
    }
  | { status: "invalid" }
  | { status: "unavailable" }

const MAX_AUTHORITY_RECEIPTS = 20
const MAX_AUTHORITY_REQUEST_BYTES = 128 * 1024
const AUTHORITY_METADATA_TIMEOUT_MS = 2_500
const MAX_MUTABLE_AUTHORITY_AGE_SECONDS = 5 * 60

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function toSignedPublicEvent(value: OmfZapoutReceiptEvent) {
  const raw = typeof value.rawEvent === "function" ? value.rawEvent() : value
  return raw as SignedPublicNostrEvent
}

const defaultDependencies: ZapoutAuthorityDependencies = {
  fetchProfileEvents: async (recipientPubkeys, relayUrls) => {
    const result = await fetchEventsFanoutDetailed(
      {
        kinds: [EVENT_KINDS.PROFILE],
        authors: recipientPubkeys,
        limit: Math.min(300, Math.max(50, recipientPubkeys.length * 10)),
      },
      {
        relayUrls,
        connectTimeoutMs: 1_500,
        fetchTimeoutMs: 3_000,
        skipHealthFilter: true,
      }
    )
    return {
      events: result.events.map(toSignedPublicEvent),
      complete:
        result.relays.length === relayUrls.length &&
        result.relays.every(
          (relay) =>
            relay.status === "success" &&
            relay.eventCount <
              Math.min(300, Math.max(50, recipientPubkeys.length * 10))
        ),
    }
  },
  fetchLnurlMetadata: fetchLnurlPayMetadata,
  nowMs: Date.now,
}

function selectCurrentLud16(
  events: SignedPublicNostrEvent[],
  recipientPubkey: string,
  requestCreatedAt: number
):
  | { status: "resolved"; lud16: string }
  | { status: "invalid" }
  | { status: "unavailable" } {
  const candidates = events.filter(
    (event) =>
      event.kind === EVENT_KINDS.PROFILE &&
      event.pubkey === recipientPubkey &&
      isValidSignedPublicNostrEvent(event)
  )
  if (candidates.length === 0) return { status: "unavailable" }
  const newestCreatedAt = Math.max(
    ...candidates.map((event) => event.created_at)
  )
  const newest = candidates.filter(
    (event) => event.created_at === newestCreatedAt
  )
  if (new Set(newest.map((event) => event.id)).size !== 1) {
    return { status: "unavailable" }
  }
  if (newestCreatedAt > requestCreatedAt) return { status: "unavailable" }

  try {
    const profile = JSON.parse(newest[0]!.content) as unknown
    if (!isRecord(profile) || typeof profile.lud16 !== "string") {
      return { status: "invalid" }
    }
    const lud16 = profile.lud16.trim().toLowerCase()
    return lud16 ? { status: "resolved", lud16 } : { status: "invalid" }
  } catch {
    return { status: "invalid" }
  }
}

async function getInFlightLnurlMetadata(
  lud16: string,
  dependencies: ZapoutAuthorityDependencies,
  inFlightMetadata: Map<string, Promise<LnurlPayMetadata>>
): Promise<LnurlPayMetadata> {
  const existing = inFlightMetadata.get(lud16)
  if (existing) return existing
  const value = dependencies.fetchLnurlMetadata(lud16, {
    timeoutMs: AUTHORITY_METADATA_TIMEOUT_MS,
  })
  inFlightMetadata.set(lud16, value)
  try {
    return await value
  } finally {
    if (inFlightMetadata.get(lud16) === value) {
      inFlightMetadata.delete(lud16)
    }
  }
}

async function resolvePaymentTimeAuthority(
  input: {
    payRequestUrl: string
    recipientPubkey: string
    requestCreatedAt: number
    allowedLnurlHosts: ReadonlySet<string>
    profileRead: Awaited<
      ReturnType<ZapoutAuthorityDependencies["fetchProfileEvents"]>
    >
    inFlightMetadata: Map<string, Promise<LnurlPayMetadata>>
    canResolveRecipient: () => Promise<boolean>
  },
  dependencies: ZapoutAuthorityDependencies
): Promise<AuthorityResolution> {
  const ageSeconds =
    Math.floor(dependencies.nowMs() / 1_000) - input.requestCreatedAt
  if (
    !Number.isSafeInteger(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > MAX_MUTABLE_AUTHORITY_AGE_SECONDS
  ) {
    return { status: "unavailable" }
  }
  if (!input.profileRead.complete) return { status: "unavailable" }

  const profileAuthority = selectCurrentLud16(
    input.profileRead.events,
    input.recipientPubkey,
    input.requestCreatedAt
  )
  if (profileAuthority.status !== "resolved") return profileAuthority
  const lud16Host = profileAuthority.lud16.split("@")[1]?.toLowerCase()
  const lud16User = profileAuthority.lud16.split("@")[0]
  const expectedPayRequestUrl =
    lud16User && lud16Host
      ? `https://${lud16Host}/.well-known/lnurlp/${lud16User}`
      : null
  let payRequestHost: string
  try {
    payRequestHost = new URL(input.payRequestUrl).hostname.toLowerCase()
  } catch {
    return { status: "invalid" }
  }
  if (
    !lud16Host ||
    input.payRequestUrl !== expectedPayRequestUrl ||
    !input.allowedLnurlHosts.has(lud16Host) ||
    !input.allowedLnurlHosts.has(payRequestHost)
  ) {
    return input.payRequestUrl !== expectedPayRequestUrl
      ? { status: "invalid" }
      : { status: "unavailable" }
  }
  if (!(await input.canResolveRecipient())) return { status: "unavailable" }

  let metadata: LnurlPayMetadata
  try {
    metadata = await getInFlightLnurlMetadata(
      profileAuthority.lud16,
      dependencies,
      input.inFlightMetadata
    )
  } catch {
    return { status: "unavailable" }
  }
  const providerPubkey = normalizePubkey(metadata.nostrPubkey)
  if (
    metadata.payRequestUrl !== input.payRequestUrl ||
    !metadata.allowsNostr ||
    !providerPubkey
  ) {
    return metadata.payRequestUrl !== input.payRequestUrl
      ? { status: "invalid" }
      : { status: "unavailable" }
  }
  return {
    status: "resolved",
    pubkey: providerPubkey,
    mismatchStatus: "unavailable",
  }
}

async function readAuthorityRequest(
  request: Request
): Promise<OmfZapoutReceiptEvent[]> {
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_AUTHORITY_REQUEST_BYTES
  ) {
    throw new Error("Authority request is too large.")
  }
  if (!request.body) throw new Error("Authority request is invalid.")
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytesRead += chunk.value.byteLength
    if (bytesRead > MAX_AUTHORITY_REQUEST_BYTES) {
      await reader.cancel("Authority request exceeded the byte limit")
      throw new Error("Authority request is too large.")
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  text += decoder.decode()
  const body = JSON.parse(text) as unknown
  if (
    !isRecord(body) ||
    !Array.isArray(body.receipts) ||
    body.receipts.length === 0 ||
    body.receipts.length > MAX_AUTHORITY_RECEIPTS
  ) {
    throw new Error("Authority request is invalid.")
  }
  return body.receipts as OmfZapoutReceiptEvent[]
}

export async function verifyZapoutAuthorityRequest(
  request: Request,
  env: AnonZapPagesEnv,
  dependencies: ZapoutAuthorityDependencies = defaultDependencies
): Promise<Response> {
  const corsHeaders = getCorsHeaders(request, env)
  try {
    const requestRateLimitError = await enforceAnonZapAuthorityRequestRateLimit(
      request,
      env
    )
    if (requestRateLimitError) return requestRateLimitError
    const events = await readAuthorityRequest(request)
    const relayUrls = getAnonZapCommerceRelays(env)
    const allowedLnurlHosts = new Set(
      (env.ANON_ZAP_LNURL_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
    )
    const parsedReceipts = events.map((event) => ({
      event,
      receipt: parseOmfZapoutReceipt(event),
    }))
    const recipients = parsedReceipts
      .map(({ receipt }) => receipt?.recipientPubkey)
      .filter((pubkey): pubkey is string => !!pubkey)
    let profileReadPromise: ReturnType<
      ZapoutAuthorityDependencies["fetchProfileEvents"]
    > | null = null
    const loadProfileRead = async () => {
      if (!profileReadPromise) {
        profileReadPromise = dependencies
          .fetchProfileEvents(Array.from(new Set(recipients)), relayUrls)
          .catch(() => ({ events: [], complete: false }))
      }
      return profileReadPromise
    }
    const inFlightMetadata = new Map<string, Promise<LnurlPayMetadata>>()
    const recipientRateLimits = new Map<string, Promise<boolean>>()
    const canResolveRecipient = (recipientPubkey: string) => {
      const existing = recipientRateLimits.get(recipientPubkey)
      if (existing) return existing
      const decision = enforceAnonZapAuthoritySourceRecipientRateLimit(
        request,
        env,
        recipientPubkey
      ).then((error) => error === null)
      recipientRateLimits.set(recipientPubkey, decision)
      return decision
    }

    const results: Array<{ id: string; status: ZapoutAuthorityStatus }> =
      await Promise.all(
        parsedReceipts.map(async ({ event, receipt: parsed }) => {
          if (
            !parsed?.recipientPubkey ||
            !parsed.zapRequestCreatedAt ||
            !event ||
            typeof event.id !== "string"
          ) {
            return {
              id: typeof event?.id === "string" ? event.id : "",
              status: "invalid" as const,
            }
          }

          const verification = await verifyOmfZapoutReceiptAuthority(event, {
            verifyProviderAttestation: async ({ zapRequest }) => {
              const draft: AnonZapRequestDraft = {
                kind: zapRequest.kind,
                createdAt: zapRequest.created_at,
                content: zapRequest.content,
                tags: zapRequest.tags,
              }
              const attestation = verifyAnonZapCheckoutProviderAttestation(
                draft,
                env
              )
              if (attestation === "verified") return "verified"
              return attestation === "invalid" ? "invalid" : "unavailable"
            },
            resolveLnurlNostrPubkey: async (payRequestUrl, recipientPubkey) => {
              const authorityAgeSeconds =
                Math.floor(dependencies.nowMs() / 1_000) -
                parsed.zapRequestCreatedAt!
              if (
                !Number.isSafeInteger(authorityAgeSeconds) ||
                authorityAgeSeconds < 0 ||
                authorityAgeSeconds > MAX_MUTABLE_AUTHORITY_AGE_SECONDS
              ) {
                return { status: "unavailable" }
              }
              return resolvePaymentTimeAuthority(
                {
                  payRequestUrl,
                  recipientPubkey,
                  requestCreatedAt: parsed.zapRequestCreatedAt!,
                  allowedLnurlHosts,
                  profileRead: await loadProfileRead(),
                  inFlightMetadata,
                  canResolveRecipient: () =>
                    canResolveRecipient(recipientPubkey),
                },
                dependencies
              )
            },
          })
          return { id: event.id, status: verification.status }
        })
      )

    return jsonResponse({ results }, 200, corsHeaders)
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Zapout authority verification failed.",
      },
      400,
      corsHeaders
    )
  }
}

export async function onRequestPost({
  request,
  env,
}: AnonZapPagesFunctionContext): Promise<Response> {
  const originError = assertAllowedOrigin(request, env)
  if (originError) return originError
  return verifyZapoutAuthorityRequest(request, env)
}

export function onRequestOptions({
  request,
  env,
}: AnonZapPagesFunctionContext): Response {
  return optionsResponse(request, env)
}

export function onRequest(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405)
}
