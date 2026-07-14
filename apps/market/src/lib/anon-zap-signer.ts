import {
  config,
  isValidSignedPublicNostrEvent,
  normalizePubkey,
  validateAnonZapRequestDraft,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import type {
  CheckoutZapRequestDraft,
  SignedCheckoutZapRequest,
} from "./checkout-payment"

type AnonZapSignerConfig = Pick<
  typeof config,
  "anonZapSignerUrl" | "anonZapSignerPubkey"
>

type AnonZapSignerOptions = {
  fetchImpl?: typeof fetch
  config?: AnonZapSignerConfig
  authorizationTimeoutMs?: number
  signingTimeoutMs?: number
}

export type AnonZapCheckoutAuthorizationContext = {
  merchantPubkey: string
  amountMsats: number
  items: Array<{ productAddress: string; quantity: number }>
}

type AuthorizationResponse = {
  authorizationToken: string
  draft: CheckoutZapRequestDraft
  requestCreatedAt?: number
  lnurlCallback: string
  lnurlNostrPubkey: string
  relayUrls: string[]
}

type SignerResponse = {
  id: string
  rawEvent: SignedPublicNostrEvent
  requestCreatedAt: number
  lnurlCallback: string
  lnurl: string
  lnurlNostrPubkey: string
  relayUrls: string[]
}

export class AnonZapAuthorizationError extends Error {
  override name = "AnonZapAuthorizationError"
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 20_000
const DEFAULT_SIGNING_TIMEOUT_MS = 8_000

export function isAnonZapAuthorizationError(
  error: unknown
): error is AnonZapAuthorizationError {
  return error instanceof AnonZapAuthorizationError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function getSingleTagValue(
  tags: readonly string[][],
  name: string
): string | null {
  const matches = tags.filter((tag) => tag[0] === name)
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null
}

function isAllowedCallback(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    )
  } catch {
    return false
  }
}

function isAllowedRelay(value: string): boolean {
  try {
    const url = new URL(value)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    return (
      (url.protocol === "wss:" || (url.protocol === "ws:" && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

function getAuthorizeUrl(signerUrl: string): string {
  const match = /^(.*\/api\/anon-zap-)sign([?#].*)?$/.exec(signerUrl.trim())
  if (!match) {
    throw new Error("Anon zap signer URL must use /api/anon-zap-sign.")
  }
  return `${match[1]}authorize${match[2] ?? ""}`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error("Anon zap service returned an invalid response.")
  }
}

async function assertSuccessfulJson(response: Response): Promise<unknown> {
  const body = await readJson(response)
  if (response.ok) return body
  const reason =
    isRecord(body) && typeof body.error === "string"
      ? body.error
      : "Anon zap service is unavailable."
  throw new Error(reason)
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out.`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function parseAuthorizationResponse(value: unknown): AuthorizationResponse {
  if (
    !isRecord(value) ||
    typeof value.authorizationToken !== "string" ||
    !isRecord(value.draft) ||
    typeof value.lnurlCallback !== "string" ||
    typeof value.lnurlNostrPubkey !== "string" ||
    !Array.isArray(value.relayUrls) ||
    !value.relayUrls.every((relay) => typeof relay === "string")
  ) {
    throw new Error("Anon zap authorization response is invalid.")
  }
  const draft = value.draft as CheckoutZapRequestDraft
  const validation = validateAnonZapRequestDraft(draft)
  if (!validation.ok) throw new Error(validation.reason)
  if (
    !isAllowedCallback(value.lnurlCallback) ||
    !normalizePubkey(value.lnurlNostrPubkey) ||
    value.relayUrls.length === 0 ||
    !(value.relayUrls as string[]).every(isAllowedRelay)
  ) {
    throw new Error("Anon zap authorization metadata is invalid.")
  }
  return {
    authorizationToken: value.authorizationToken,
    draft,
    lnurlCallback: value.lnurlCallback,
    lnurlNostrPubkey: normalizePubkey(value.lnurlNostrPubkey)!,
    relayUrls: value.relayUrls as string[],
  }
}

function parseSignerResponse(value: unknown): SignerResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isRecord(value.rawEvent) ||
    typeof value.requestCreatedAt !== "number" ||
    typeof value.lnurlCallback !== "string" ||
    typeof value.lnurl !== "string" ||
    typeof value.lnurlNostrPubkey !== "string" ||
    !Array.isArray(value.relayUrls) ||
    !value.relayUrls.every((relay) => typeof relay === "string")
  ) {
    throw new Error("Anon zap signer response is invalid.")
  }
  return value as SignerResponse
}

function eventMatchesDraft(
  event: SignedPublicNostrEvent,
  draft: CheckoutZapRequestDraft
): boolean {
  return (
    event.kind === draft.kind &&
    event.created_at === draft.createdAt &&
    event.content === draft.content &&
    JSON.stringify(event.tags) === JSON.stringify(draft.tags)
  )
}

function validateServerDraft(
  draft: CheckoutZapRequestDraft,
  context: AnonZapCheckoutAuthorizationContext
): void {
  const merchantPubkey = normalizePubkey(context.merchantPubkey)
  if (!merchantPubkey) throw new Error("Merchant pubkey is invalid.")
  if (getSingleTagValue(draft.tags, "p") !== merchantPubkey) {
    throw new Error("Anon zap draft targets a different merchant.")
  }
  if (getSingleTagValue(draft.tags, "amount") !== String(context.amountMsats)) {
    throw new Error("Anon zap draft amount does not match checkout.")
  }
}

export function isAnonZapSignerConfigured(
  cfg: AnonZapSignerConfig = config
): boolean {
  return (
    !!cfg.anonZapSignerUrl?.trim() && !!normalizePubkey(cfg.anonZapSignerPubkey)
  )
}

export const validateAnonZapSignerDraft = validateAnonZapRequestDraft

export async function signCheckoutZapRequestWithAnonSigner(
  draft: CheckoutZapRequestDraft,
  context: AnonZapCheckoutAuthorizationContext,
  options: AnonZapSignerOptions = {}
): Promise<SignedCheckoutZapRequest> {
  try {
    const cfg = options.config ?? config
    if (!isAnonZapSignerConfigured(cfg)) {
      throw new Error("Anon zap signer is not configured.")
    }
    const initialValidation = validateAnonZapSignerDraft(draft)
    if (!initialValidation.ok) throw new Error(initialValidation.reason)

    const signerUrl = cfg.anonZapSignerUrl!.trim()
    const fetchImpl = options.fetchImpl ?? fetch
    const authorization = parseAuthorizationResponse(
      await assertSuccessfulJson(
        await fetchWithTimeout(
          fetchImpl,
          getAuthorizeUrl(signerUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(context),
            cache: "no-store",
          },
          options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
          "Anon zap authorization"
        )
      )
    )
    validateServerDraft(authorization.draft, context)

    const signed = parseSignerResponse(
      await assertSuccessfulJson(
        await fetchWithTimeout(
          fetchImpl,
          signerUrl,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              authorizationToken: authorization.authorizationToken,
              zapRequest: authorization.draft,
            }),
            cache: "no-store",
          },
          options.signingTimeoutMs ?? DEFAULT_SIGNING_TIMEOUT_MS,
          "Anon zap signing"
        )
      )
    )
    const expectedSignerPubkey = normalizePubkey(cfg.anonZapSignerPubkey)
    if (
      !expectedSignerPubkey ||
      !isValidSignedPublicNostrEvent(signed.rawEvent) ||
      signed.rawEvent.pubkey !== expectedSignerPubkey ||
      signed.rawEvent.id !== signed.id ||
      !eventMatchesDraft(signed.rawEvent, authorization.draft)
    ) {
      throw new Error("Anon zap signer returned an invalid event.")
    }
    if (
      signed.requestCreatedAt !== authorization.draft.createdAt ||
      signed.lnurlCallback !== authorization.lnurlCallback ||
      signed.lnurl !== getSingleTagValue(authorization.draft.tags, "lnurl") ||
      normalizePubkey(signed.lnurlNostrPubkey) !==
        authorization.lnurlNostrPubkey ||
      JSON.stringify(signed.relayUrls) !==
        JSON.stringify(authorization.relayUrls) ||
      !isAllowedCallback(signed.lnurlCallback) ||
      !signed.relayUrls.every(isAllowedRelay)
    ) {
      throw new Error("Anon zap signer receipt metadata is invalid.")
    }

    return {
      id: signed.id,
      rawEvent: signed.rawEvent,
      requestCreatedAt: signed.requestCreatedAt,
      lnurlCallback: signed.lnurlCallback,
      lnurl: signed.lnurl,
      lnurlNostrPubkey: normalizePubkey(signed.lnurlNostrPubkey)!,
      relayUrls: signed.relayUrls,
    }
  } catch (error) {
    if (error instanceof AnonZapAuthorizationError) throw error
    throw new AnonZapAuthorizationError(
      error instanceof Error ? error.message : "Anon zap authorization failed.",
      { cause: error }
    )
  }
}
