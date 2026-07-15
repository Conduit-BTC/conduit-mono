import {
  config,
  buildAnonZapCheckoutContent,
  isValidSignedPublicNostrEvent,
  normalizePubkey,
  validateAnonZapRequestDraft,
  type AuthorizedAnonZapPricing,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import type { CheckoutPricingIntent } from "./checkout-payment"
import {
  applyAuthorizedAnonZapPricing,
  getAuthorizedAnonZapDestinationEligibility,
  hasAuthorizedAnonZapPricingChanged,
  type CheckoutZapRequestDraft,
  type SignedCheckoutZapRequest,
} from "./checkout-payment"

type AnonZapSignerConfig = Pick<
  typeof config,
  "anonZapSignerUrl" | "anonZapSignerPubkey"
>

export type AnonZapSignerOptions = {
  fetchImpl?: typeof fetch
  config?: AnonZapSignerConfig
  authorizationTimeoutMs?: number
  signingTimeoutMs?: number
}

export type AnonZapCheckoutAuthorizationContext = {
  merchantPubkey: string
  items: Array<{ productAddress: string; quantity: number }>
}

export type AuthorizedAnonZapCheckoutClient = {
  authorizationToken: string
  expiresAt: number
  draft: CheckoutZapRequestDraft
  lnurlCallback: string
  lnurlNostrPubkey: string
  relayUrls: string[]
  pricing: AuthorizedAnonZapPricing
}

export type PreparedAnonZapCheckout = Omit<
  SignedCheckoutZapRequest,
  "rawEvent"
> & {
  rawEvent: SignedPublicNostrEvent
  pricing: AuthorizedAnonZapPricing
  authorizationExpiresAt: number
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

function parseAuthorizationResponse(
  value: unknown
): AuthorizedAnonZapCheckoutClient {
  if (
    !isRecord(value) ||
    typeof value.authorizationToken !== "string" ||
    !value.authorizationToken.trim() ||
    value.authorizationToken.length > 16_384 ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !isRecord(value.draft) ||
    typeof value.lnurlCallback !== "string" ||
    typeof value.lnurlNostrPubkey !== "string" ||
    !Array.isArray(value.relayUrls) ||
    !value.relayUrls.every((relay) => typeof relay === "string") ||
    !isRecord(value.pricing) ||
    !Array.isArray(value.pricing.items)
  ) {
    throw new Error("Anon zap authorization response is invalid.")
  }
  const draft = value.draft as CheckoutZapRequestDraft
  const pricing = value.pricing as unknown as AuthorizedAnonZapPricing
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
    expiresAt: value.expiresAt,
    draft,
    lnurlCallback: value.lnurlCallback,
    lnurlNostrPubkey: normalizePubkey(value.lnurlNostrPubkey)!,
    relayUrls: value.relayUrls as string[],
    pricing,
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

function isValidAuthorizedPricingQuote(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  const allowedSources = new Set(["env", "mempool", "coinbase"])
  const allowedFiatSources = new Set([
    "frankfurter",
    "exchange-rate-api",
    "env",
    "mempool",
  ])
  return (
    typeof value.rate === "number" &&
    Number.isFinite(value.rate) &&
    value.rate > 0 &&
    typeof value.fetchedAt === "number" &&
    Number.isSafeInteger(value.fetchedAt) &&
    value.fetchedAt > 0 &&
    typeof value.source === "string" &&
    allowedSources.has(value.source) &&
    (value.fiatSource === undefined ||
      (typeof value.fiatSource === "string" &&
        allowedFiatSources.has(value.fiatSource)))
  )
}

function isValidAuthorizedShippingCountryRules(
  value: unknown,
  format: unknown
): boolean {
  if (!Array.isArray(value) || value.length > 250) return false
  if (format === "digital") return value.length === 0
  if (format !== "physical" || value.length === 0) return false

  const codes = new Set<string>()
  for (const rule of value) {
    if (
      !isRecord(rule) ||
      typeof rule.code !== "string" ||
      !/^[A-Z]{2}$/.test(rule.code) ||
      codes.has(rule.code) ||
      !Array.isArray(rule.restrictTo) ||
      rule.restrictTo.length > 250 ||
      !Array.isArray(rule.exclude) ||
      rule.exclude.length > 250
    ) {
      return false
    }
    const patterns = [...rule.restrictTo, ...rule.exclude]
    if (
      !patterns.every(
        (pattern) =>
          typeof pattern === "string" &&
          !!pattern.trim() &&
          pattern.length <= 64
      )
    ) {
      return false
    }
    codes.add(rule.code)
  }
  return true
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
  context: AnonZapCheckoutAuthorizationContext,
  pricing: AuthorizedAnonZapPricing,
  lnurlNostrPubkey: string
): void {
  const merchantPubkey = normalizePubkey(context.merchantPubkey)
  if (!merchantPubkey) throw new Error("Merchant pubkey is invalid.")
  if (getSingleTagValue(draft.tags, "p") !== merchantPubkey) {
    throw new Error("Anon zap draft targets a different merchant.")
  }
  const itemCount = context.items.reduce(
    (total, item) => total + item.quantity,
    0
  )
  if (draft.content !== buildAnonZapCheckoutContent(itemCount)) {
    throw new Error("Anon zap draft content is invalid.")
  }
  if (
    getSingleTagValue(draft.tags, "omf_provider") !==
    normalizePubkey(lnurlNostrPubkey)
  ) {
    throw new Error("Anon zap draft provider authority is invalid.")
  }
  const providerAttestations = draft.tags.filter((tag) => tag[0] === "omf_auth")
  if (
    providerAttestations.length !== 1 ||
    providerAttestations[0]?.length !== 3 ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(providerAttestations[0]?.[1] ?? "") ||
    !/^[0-9a-f]{128}$/.test(providerAttestations[0]?.[2] ?? "")
  ) {
    throw new Error("Anon zap draft provider attestation is invalid.")
  }
  if (
    !Number.isSafeInteger(pricing.itemSubtotalSats) ||
    pricing.itemSubtotalSats < 1 ||
    !Number.isSafeInteger(pricing.shippingCostSats) ||
    pricing.shippingCostSats < 0 ||
    !Number.isSafeInteger(pricing.totalSats) ||
    pricing.totalSats !== pricing.itemSubtotalSats + pricing.shippingCostSats ||
    !Number.isSafeInteger(pricing.totalMsats) ||
    pricing.totalMsats !== pricing.totalSats * 1000 ||
    !Array.isArray(pricing.items) ||
    pricing.items.length !== context.items.length ||
    !isValidAuthorizedPricingQuote(pricing.quote)
  ) {
    throw new Error("Anon zap authorization pricing is invalid.")
  }
  const expectedItems = new Map(
    context.items.map((item) => [item.productAddress, item.quantity])
  )
  let itemSubtotalSats = 0
  let shippingCostSats = 0
  for (const item of pricing.items) {
    if (!isRecord(item)) {
      throw new Error("Anon zap authorization pricing is invalid.")
    }
    const expectedQuantity = expectedItems.get(item.productAddress)
    if (
      typeof item.productAddress !== "string" ||
      expectedQuantity !== item.quantity ||
      (item.format !== "physical" && item.format !== "digital") ||
      !Number.isSafeInteger(item.unitPriceSats) ||
      item.unitPriceSats < 1 ||
      !Number.isSafeInteger(item.unitShippingSats) ||
      item.unitShippingSats < 0 ||
      !Number.isSafeInteger(item.lineTotalSats) ||
      (item.shippingOptionId !== undefined &&
        (typeof item.shippingOptionId !== "string" ||
          !item.shippingOptionId.trim() ||
          item.shippingOptionId.length > 200)) ||
      !isValidAuthorizedShippingCountryRules(
        item.shippingCountryRules,
        item.format
      ) ||
      typeof item.productEventId !== "string" ||
      !/^[0-9a-f]{64}$/i.test(item.productEventId) ||
      item.lineTotalSats !==
        (item.unitPriceSats + item.unitShippingSats) * item.quantity
    ) {
      throw new Error("Anon zap authorization pricing is invalid.")
    }
    expectedItems.delete(item.productAddress)
    itemSubtotalSats += item.unitPriceSats * item.quantity
    shippingCostSats += item.unitShippingSats * item.quantity
    if (
      !Number.isSafeInteger(itemSubtotalSats) ||
      !Number.isSafeInteger(shippingCostSats)
    ) {
      throw new Error("Anon zap authorization pricing is invalid.")
    }
  }
  if (
    expectedItems.size > 0 ||
    itemSubtotalSats !== pricing.itemSubtotalSats ||
    shippingCostSats !== pricing.shippingCostSats
  ) {
    throw new Error("Anon zap authorization pricing is invalid.")
  }
  if (getSingleTagValue(draft.tags, "amount") !== String(pricing.totalMsats)) {
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

function wrapAuthorizationError(error: unknown): AnonZapAuthorizationError {
  return error instanceof AnonZapAuthorizationError
    ? error
    : new AnonZapAuthorizationError(
        error instanceof Error
          ? error.message
          : "Anon zap authorization failed.",
        { cause: error }
      )
}

export async function authorizeCheckoutWithAnonSigner(
  context: AnonZapCheckoutAuthorizationContext,
  options: AnonZapSignerOptions = {}
): Promise<AuthorizedAnonZapCheckoutClient> {
  try {
    const cfg = options.config ?? config
    if (!isAnonZapSignerConfigured(cfg)) {
      throw new Error("Anon zap signer is not configured.")
    }
    const signerUrl = cfg.anonZapSignerUrl!.trim()
    const authorization = parseAuthorizationResponse(
      await assertSuccessfulJson(
        await fetchWithTimeout(
          options.fetchImpl ?? fetch,
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
    validateServerDraft(
      authorization.draft,
      context,
      authorization.pricing,
      authorization.lnurlNostrPubkey
    )
    return authorization
  } catch (error) {
    throw wrapAuthorizationError(error)
  }
}

export async function signAuthorizedAnonZapCheckout(
  authorization: AuthorizedAnonZapCheckoutClient,
  options: AnonZapSignerOptions = {}
): Promise<PreparedAnonZapCheckout> {
  try {
    const cfg = options.config ?? config
    if (!isAnonZapSignerConfigured(cfg)) {
      throw new Error("Anon zap signer is not configured.")
    }
    const signerUrl = cfg.anonZapSignerUrl!.trim()
    const signed = parseSignerResponse(
      await assertSuccessfulJson(
        await fetchWithTimeout(
          options.fetchImpl ?? fetch,
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
      pricing: authorization.pricing,
      authorizationExpiresAt: authorization.expiresAt,
    }
  } catch (error) {
    throw wrapAuthorizationError(error)
  }
}

export type PrepareAnonZapCheckoutResult =
  | {
      status: "private_fallback"
      failedStage: "authorization" | "signing"
      checkoutPricing: Extract<CheckoutPricingIntent, { status: "ok" }>
    }
  | {
      status: "review_required"
      authorization: AuthorizedAnonZapCheckoutClient
      checkoutPricing: Extract<CheckoutPricingIntent, { status: "ok" }>
    }
  | {
      status: "prepared"
      authorization: AuthorizedAnonZapCheckoutClient
      prepared: PreparedAnonZapCheckout
      checkoutPricing: Extract<CheckoutPricingIntent, { status: "ok" }>
    }

type PrepareAnonZapCheckoutDependencies = {
  authorize: typeof authorizeCheckoutWithAnonSigner
  sign: typeof signAuthorizedAnonZapCheckout
}

export async function prepareAnonZapCheckout(input: {
  context: AnonZapCheckoutAuthorizationContext
  localPricing: Extract<CheckoutPricingIntent, { status: "ok" }>
  destination: { country: string; postalCode: string }
  reusableAuthorization?: AuthorizedAnonZapCheckoutClient | null
  options?: AnonZapSignerOptions
  dependencies?: Partial<PrepareAnonZapCheckoutDependencies>
}): Promise<PrepareAnonZapCheckoutResult> {
  const authorize =
    input.dependencies?.authorize ?? authorizeCheckoutWithAnonSigner
  const sign = input.dependencies?.sign ?? signAuthorizedAnonZapCheckout
  const reusableAuthorization = input.reusableAuthorization ?? null
  let authorization: AuthorizedAnonZapCheckoutClient
  try {
    authorization =
      reusableAuthorization ?? (await authorize(input.context, input.options))
  } catch {
    return {
      status: "private_fallback",
      failedStage: "authorization",
      checkoutPricing: input.localPricing,
    }
  }

  let checkoutPricing: Extract<CheckoutPricingIntent, { status: "ok" }>
  try {
    checkoutPricing = applyAuthorizedAnonZapPricing(
      input.localPricing,
      authorization.pricing
    )
  } catch {
    return {
      status: "private_fallback",
      failedStage: "authorization",
      checkoutPricing: input.localPricing,
    }
  }
  const destinationEligibility = getAuthorizedAnonZapDestinationEligibility(
    input.destination,
    authorization.pricing
  )
  if (destinationEligibility.eligible === false) {
    return {
      status: "private_fallback",
      failedStage: "authorization",
      checkoutPricing,
    }
  }
  if (destinationEligibility.eligible === null) {
    return {
      status: "private_fallback",
      failedStage: "authorization",
      checkoutPricing,
    }
  }

  if (
    !reusableAuthorization &&
    hasAuthorizedAnonZapPricingChanged(input.localPricing, checkoutPricing)
  ) {
    return {
      status: "review_required",
      authorization,
      checkoutPricing,
    }
  }

  try {
    return {
      status: "prepared",
      authorization,
      prepared: await sign(authorization, input.options),
      checkoutPricing,
    }
  } catch {
    return {
      status: "private_fallback",
      failedStage: "signing",
      checkoutPricing,
    }
  }
}

export async function signCheckoutZapRequestWithAnonSigner(
  draft: CheckoutZapRequestDraft,
  context: AnonZapCheckoutAuthorizationContext,
  options: AnonZapSignerOptions = {}
): Promise<SignedCheckoutZapRequest> {
  try {
    const initialValidation = validateAnonZapSignerDraft(draft)
    if (!initialValidation.ok) throw new Error(initialValidation.reason)
    const authorization = await authorizeCheckoutWithAnonSigner(
      context,
      options
    )
    return await signAuthorizedAnonZapCheckout(authorization, options)
  } catch (error) {
    throw wrapAuthorizationError(error)
  }
}
