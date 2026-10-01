/**
 * Local, versioned shipping tables carried by an explicit kind-30406 extension.
 * The Open Markets content remains a human-readable description; clients that
 * do not understand the extension must not treat its base price as a quote.
 */
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { z } from "zod"
import {
  getCurrencyFractionDigits,
  normalizeCurrencyIdentity,
  type PricingRateInput,
  type SourcePriceQuote,
} from "../pricing"
import { parseProductEvent } from "./products"
import { normalizeAddressRegion } from "./address-validation"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import { getAccountSigner } from "./session-signer"
import type { AccountSigner, UnsignedNostrEvent } from "./nostr-event-signer"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { publishWithPlanner } from "./relay-publish"
import {
  buildShippingOptionDeletionEventDraft,
  getShippingOptionsByCoordinatesDetailed,
  rememberPublishedShippingEvidence,
  type ShippingOptionReadOptions,
  type ShippingOptionEventDraft,
} from "./shipping"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export const MERCHANT_SHIPPING_POLICY_D_TAG = "conduit-shipping-policy"
export const SHIPPING_POLICY_EXTENSION_TAG = "conduit_shipping_table"
const HEX_64 = /^[0-9a-f]{64}$/
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveInteger = integer.min(1)

export const shippingPolicyBandSchema = z
  .object({
    maxWeightGrams: positiveInteger,
    priceMinor: integer,
  })
  .strict()
export const shippingPolicyRuleSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    subdivision: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{1,6}$/)
      .optional(),
    postalPrefix: z
      .string()
      .regex(/^[A-Z0-9]{1,32}$/)
      .optional(),
    bands: z.array(shippingPolicyBandSchema).min(1).max(100),
  })
  .strict()
export const shippingPolicyTableSchema = z
  .object({
    rules: z.array(shippingPolicyRuleSchema).min(1).max(500),
    freeShippingThresholdMinor: integer.optional(),
  })
  .strict()
const shippingPolicyFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    originCountry: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().min(3).max(5),

    domestic: shippingPolicyTableSchema.nullable(),
    international: shippingPolicyTableSchema.nullable(),
  })
  .strict()
export const shippingPolicyV1Schema = shippingPolicyFields.extend({
  version: z.literal(1),
  weightAllowanceGrams: integer,
  handlingMinor: integer,
})
export const shippingPolicyV2Schema = shippingPolicyFields.extend({
  version: z.literal(2),
})
export const shippingPolicySchema = z
  .discriminatedUnion("version", [
    shippingPolicyV1Schema,
    shippingPolicyV2Schema,
  ])
  .superRefine((policy, context) => {
    if (!policy.domestic && !policy.international) {
      context.addIssue({
        code: "custom",
        message: "Add at least one destination table.",
      })
    }
    if (
      normalizeCurrencyIdentity(policy.currency) !== policy.currency ||
      !/^(?:[A-Z]{3}|SATS|MSATS)$/.test(policy.currency)
    ) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Invalid shipping currency.",
      })
    }
    for (const scope of ["domestic", "international"] as const) {
      const table = policy[scope]
      const seen = new Set<string>()
      for (const [index, rule] of (table?.rules ?? []).entries()) {
        if (
          (rule.country === policy.originCountry) !==
          (scope === "domestic")
        ) {
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index, "country"],
            message: "Destination belongs in the other table.",
          })
        }
        if (rule.subdivision && !rule.subdivision.startsWith(rule.country)) {
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index, "subdivision"],
            message: "Subdivision must include its country code.",
          })
        }
        const key = JSON.stringify([
          rule.country,
          rule.subdivision ?? "",
          rule.postalPrefix ?? "",
        ])
        if (seen.has(key))
          context.addIssue({
            code: "custom",
            path: [scope, "rules", index],
            message: "Duplicate destination rule.",
          })
        seen.add(key)
        let previous = 0
        for (const [bandIndex, band] of rule.bands.entries()) {
          if (band.maxWeightGrams <= previous)
            context.addIssue({
              code: "custom",
              path: [scope, "rules", index, "bands", bandIndex],
              message: "Weight limits must increase.",
            })
          previous = band.maxWeightGrams
        }
      }
    }
  })
export type ShippingPolicyV1 = z.infer<typeof shippingPolicyV1Schema>
export type ShippingPolicyV2 = z.infer<typeof shippingPolicyV2Schema>
export type ShippingPolicy = z.infer<typeof shippingPolicySchema>
export type ShippingPolicyTable = z.infer<typeof shippingPolicyTableSchema>
export type ShippingPolicyRule = z.infer<typeof shippingPolicyRuleSchema>
export type ShippingPolicyBand = z.infer<typeof shippingPolicyBandSchema>

export function normalizeShippingPolicyRegion(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "")
}

export function normalizeShippingPolicySubdivision(
  country: string,
  value: string | undefined
): string | undefined {
  const code = country.trim().toUpperCase()
  const normalized = normalizeShippingPolicyRegion(value ?? "")
  if (!normalized) return undefined
  const region =
    normalizeAddressRegion(code, value) ??
    normalizeAddressRegion(
      code,
      normalized.startsWith(code) ? normalized.slice(code.length) : normalized
    ) ??
    normalized
  return region.startsWith(code) ? region : `${code}${region}`
}

/** Normalize human-entered identifiers before validating the signed document. */
export function parseShippingPolicy(input: unknown): ShippingPolicy {
  if (!input || typeof input !== "object")
    throw new Error("Invalid shipping policy.")
  const value = input as Record<string, unknown>
  const normalizeTable = (table: unknown): unknown => {
    if (!table || typeof table !== "object") return table
    const record = table as Record<string, unknown>
    return {
      ...record,
      rules: Array.isArray(record.rules)
        ? record.rules.map((item) => {
            if (!item || typeof item !== "object") return item
            const rule = item as Record<string, unknown>
            return {
              ...rule,
              country:
                typeof rule.country === "string"
                  ? rule.country.trim().toUpperCase()
                  : rule.country,
              ...(typeof rule.subdivision === "string"
                ? {
                    subdivision: normalizeShippingPolicyRegion(
                      rule.subdivision
                    ),
                  }
                : {}),
              ...(typeof rule.postalPrefix === "string"
                ? {
                    postalPrefix: normalizeShippingPolicyRegion(
                      rule.postalPrefix
                    ),
                  }
                : {}),
            }
          })
        : record.rules,
    }
  }
  return shippingPolicySchema.parse({
    ...value,
    originCountry:
      typeof value.originCountry === "string"
        ? value.originCountry.trim().toUpperCase()
        : value.originCountry,
    currency:
      typeof value.currency === "string"
        ? normalizeCurrencyIdentity(value.currency)
        : value.currency,
    domestic: normalizeTable(value.domestic),
    international: normalizeTable(value.international),
  })
}

export const policyCurrencyMinorDigits = getCurrencyFractionDigits

/** Decimal conversion checks precision instead of silently rounding terms. */
export function shippingMoneyToMinorUnits(
  amount: number | string,
  currency: string
): number {
  const digits = getCurrencyFractionDigits(currency)
  let text = String(amount).trim()
  if (typeof amount === "number" && /e/i.test(text)) {
    const [coefficient, exponentText] = text.toLowerCase().split("e")
    const exponent = Number(exponentText)
    if (!coefficient || !Number.isInteger(exponent) || Math.abs(exponent) > 100)
      throw new Error("Invalid amount.")
    const digitsOnly = coefficient.replace(".", "")
    const decimalIndex =
      (coefficient.includes(".")
        ? coefficient.indexOf(".")
        : coefficient.length) + exponent
    text =
      decimalIndex <= 0
        ? `0.${"0".repeat(-decimalIndex)}${digitsOnly}`
        : decimalIndex >= digitsOnly.length
          ? `${digitsOnly}${"0".repeat(decimalIndex - digitsOnly.length)}`
          : `${digitsOnly.slice(0, decimalIndex)}.${digitsOnly.slice(decimalIndex)}`
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) throw new Error("Enter a non-negative decimal amount.")
  const fraction = match[2] ?? ""
  if (fraction.slice(digits).replace(/0/g, ""))
    throw new Error("Amount exceeds currency precision.")
  const minor = Number(
    BigInt(match[1]!) * 10n ** BigInt(digits) +
      BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0")
  )
  if (!Number.isSafeInteger(minor))
    throw new Error("Amount exceeds the supported range.")
  return minor
}
export const shippingAmountToMinor = shippingMoneyToMinorUnits
export function shippingMinorUnitsToAmount(
  minor: number,
  currency: string
): number {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error("Invalid minor-unit amount.")
  return minor / 10 ** getCurrencyFractionDigits(currency)
}
export const shippingMinorToAmount = shippingMinorUnitsToAmount
function minorDecimal(minor: number, currency: string): string {
  const digits = getCurrencyFractionDigits(currency)
  if (!digits) return String(minor)
  const text = String(minor).padStart(digits + 1, "0")
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`
}
function ownerPubkey(pubkey: string): string {
  const owner = pubkey.trim().toLowerCase()
  if (!HEX_64.test(owner)) throw new Error("Merchant identity is invalid.")
  return owner
}
export function getMerchantShippingPolicyCoordinate(pubkey: string): string {
  return `${EVENT_KINDS.SHIPPING_OPTION}:${ownerPubkey(pubkey)}:${MERCHANT_SHIPPING_POLICY_D_TAG}`
}
export function buildShippingPolicyEventDraft(input: {
  policy: ShippingPolicy
  clientAppId?: ConduitAppId
}): ShippingOptionEventDraft {
  const policy = parseShippingPolicy(input.policy)
  const rules = [
    ...(policy.domestic?.rules ?? []),
    ...(policy.international?.rules ?? []),
  ]
  let tags: string[][] = [
    ["d", MERCHANT_SHIPPING_POLICY_D_TAG],
    ["title", policy.title],
    [
      "price",
      minorDecimal(rules[0]!.bands[0]!.priceMinor, policy.currency),
      policy.currency,
    ],
    [
      "country",
      ...Array.from(new Set(rules.map((rule) => rule.country))).sort(),
    ],
    ["service", "standard"],
    [
      SHIPPING_POLICY_EXTENSION_TAG,
      String(policy.version),
      JSON.stringify(policy),
    ],
  ]
  if (input.clientAppId) tags = appendConduitClientTag(tags, input.clientAppId)
  return {
    kind: EVENT_KINDS.SHIPPING_OPTION,
    content: `${policy.title}. Shipping is calculated from the destination and combined product weight using the attached merchant table.`,
    tags,
  }
}

/** An extension is authoritative only when all standard summary tags agree. */
export function parseShippingPolicyEventTags(
  tags: readonly string[][]
): ShippingPolicy | null {
  const markers = tags.filter((tag) => tag[0] === SHIPPING_POLICY_EXTENSION_TAG)
  if (
    markers.length !== 1 ||
    markers[0]?.length !== 3 ||
    !["1", "2"].includes(markers[0][1]!)
  )
    return null
  try {
    const policy = parseShippingPolicy(JSON.parse(markers[0][2]!) as unknown)
    if (String(policy.version) !== markers[0]![1]) return null
    const draft = buildShippingPolicyEventDraft({ policy })
    const permitted = new Set([...draft.tags.map((tag) => tag[0]), "client"])
    if (tags.some((tag) => !permitted.has(tag[0]))) return null
    for (const name of ["d", "title", "price", "service"]) {
      const expected = draft.tags.find((tag) => tag[0] === name)!
      const actual = tags.filter((tag) => tag[0] === name)
      if (
        actual.length !== 1 ||
        JSON.stringify(actual[0]) !== JSON.stringify(expected)
      )
        return null
    }
    const countries = tags.filter((tag) => tag[0] === "country")
    if (countries.some((tag) => tag.length < 2)) return null
    const actual = Array.from(
      new Set(countries.flatMap((tag) => tag.slice(1)))
    ).sort()
    if (
      JSON.stringify(actual) !==
      JSON.stringify(draft.tags.find((tag) => tag[0] === "country")!.slice(1))
    )
      return null
    return policy
  } catch {
    return null
  }
}

export interface ShippingPolicyRevision {
  eventId: string
  createdAt: number
}
export type MerchantShippingPolicyReadResult =
  | {
      state: "found"
      policy: ShippingPolicy
      revision: ShippingPolicyRevision
      signedEvent: SignedPublicNostrEvent
      coverageComplete: boolean
      source: "relay" | "retained"
    }
  | { state: "not_found"; coverageComplete: true }
  | {
      state: "withdrawn"
      revision: ShippingPolicyRevision
      coverageComplete: boolean
    }
  | {
      state: "unavailable"
      reason: "relay_read" | "invalid_policy" | "conflicting"
      coverageComplete: boolean
      revision?: ShippingPolicyRevision
    }

export async function fetchMerchantShippingPolicy(
  pubkey: string,
  options: ShippingOptionReadOptions = {}
): Promise<MerchantShippingPolicyReadResult> {
  const coordinate = getMerchantShippingPolicyCoordinate(pubkey)
  const result = await getShippingOptionsByCoordinatesDetailed(
    [coordinate],
    options
  )
  const coverageComplete = result.coverage === "complete"
  const events = result.signedEvents.filter((event) =>
    event.tags.some(
      (tag) => tag[0] === "d" && tag[1] === MERCHANT_SHIPPING_POLICY_D_TAG
    )
  )
  const latest = events.sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
  )[0]
  const revision = latest
    ? { eventId: latest.id, createdAt: latest.created_at }
    : undefined
  const option = result.options.find((value) => value.id === coordinate)
  if (option?.shippingPolicy && option.signedEvent)
    return {
      state: "found",
      policy: option.shippingPolicy,
      revision: { eventId: option.eventId, createdAt: option.createdAt / 1000 },
      signedEvent: option.signedEvent,
      coverageComplete,
      source: option.readSource ?? "relay",
    }
  const withdrawal = result.deletionEvents
    .filter(
      (event) =>
        event.pubkey === ownerPubkey(pubkey) &&
        event.tags.some(
          (tag) =>
            (tag[0] === "e" && latest && tag[1] === latest.id) ||
            (tag[0] === "a" &&
              tag[1] === coordinate &&
              (!latest || event.created_at >= latest.created_at))
        )
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  if (withdrawal)
    return {
      state: "withdrawn",
      // A withdrawal revision is its signed deletion frontier. It remains
      // usable for a replacement even when relays suppress the prior option.
      revision: { eventId: withdrawal.id, createdAt: withdrawal.created_at },
      coverageComplete,
    }

  if (latest)
    return {
      state: "unavailable",
      reason: "invalid_policy",
      coverageComplete,
      revision,
    }
  return coverageComplete
    ? { state: "not_found", coverageComplete: true }
    : { state: "unavailable", reason: "relay_read", coverageComplete: false }
}

interface ShippingPolicyMutationDependencies {
  signer?: AccountSigner
  fetchPolicy?: typeof fetchMerchantShippingPolicy
  publishEvent?: typeof publishWithPlanner
  readOptions?: ShippingOptionReadOptions
  shouldContinue?: () => boolean
  now?: () => number
}
function ensureSession(
  dependencies?: ShippingPolicyMutationDependencies
): void {
  if (dependencies?.shouldContinue?.() === false)
    throw new Error("Merchant session changed during shipping update.")
}
async function prepareMutation(
  pubkey: string,
  acceptedRevision: ShippingPolicyRevision | null | undefined,
  dependencies?: ShippingPolicyMutationDependencies
) {
  const owner = ownerPubkey(pubkey)
  ensureSession(dependencies)
  const signer = dependencies?.signer ?? getAccountSigner()
  if (!signer || (await signer.getPublicKey()).toLowerCase() !== owner)
    throw new Error(
      "Connect the matching merchant signer before saving shipping."
    )
  ensureSession(dependencies)
  const current = await (
    dependencies?.fetchPolicy ?? fetchMerchantShippingPolicy
  )(owner, {
    ...dependencies?.readOptions,
    accountPubkey: owner,
    authenticatedPubkey: owner,
    shouldContinue: dependencies?.shouldContinue,
  })
  ensureSession(dependencies)
  if (
    !current.coverageComplete ||
    (current.state === "unavailable" && !current.revision)
  )
    throw new Error(
      "Shipping could not be read completely. Retry before replacing it."
    )
  if (current.state === "found" && current.source === "retained")
    throw new Error(
      "Current shipping revision was not observed on relays. Retry before replacing it."
    )
  const observedRevision =
    current.state === "not_found" ? null : current.revision
  if (
    (acceptedRevision?.eventId ?? null) !== (observedRevision?.eventId ?? null)
  )
    throw new Error("Shipping changed. Reload before saving.")
  const createdAt = Math.max(
    Math.floor((dependencies?.now?.() ?? Date.now()) / 1000),
    (observedRevision?.createdAt ?? 0) + 1
  )
  return { owner, signer, current, createdAt }
}
async function signAndPublishPolicyDraft(
  owner: string,
  signer: AccountSigner,
  createdAt: number,
  draft:
    | ShippingOptionEventDraft
    | ReturnType<typeof buildShippingOptionDeletionEventDraft>,
  dependencies?: ShippingPolicyMutationDependencies
): Promise<SignedPublicNostrEvent> {
  ensureSession(dependencies)
  const event = new NDKEvent(getNdk())
  event.kind = draft.kind
  event.pubkey = owner
  event.created_at = createdAt
  event.tags = draft.tags
  event.content = draft.content
  Object.assign(
    event,
    await signer.signEvent(event.rawEvent() as UnsignedNostrEvent)
  )
  ensureSession(dependencies)
  const signedEvent = event.rawEvent() as SignedPublicNostrEvent
  if (
    !isValidSignedPublicNostrEvent(signedEvent) ||
    signedEvent.pubkey !== owner
  )
    throw new Error("Signer returned invalid shipping evidence.")
  const result = await (dependencies?.publishEvent ?? publishWithPlanner)(
    event,
    {
      intent: "commerce_author_event",
      authorPubkey: owner,
      accountPubkey: owner,
      authenticatedPubkey: owner,
      deliveryMode: "standard",
      shouldContinue: dependencies?.shouldContinue,
    }
  )
  if (!result.successfulRelayUrls.length)
    throw new Error("No relay accepted the shipping update.")
  await rememberPublishedShippingEvidence(signedEvent)
  ensureSession(dependencies)
  return signedEvent
}
export async function publishMerchantShippingPolicy(input: {
  pubkey: string
  policy: ShippingPolicy
  acceptedRevision?: ShippingPolicyRevision | null
  clientAppId?: ConduitAppId
  dependencies?: ShippingPolicyMutationDependencies
}): Promise<ShippingPolicyRevision> {
  const draft = buildShippingPolicyEventDraft(input)
  const prepared = await prepareMutation(
    input.pubkey,
    input.acceptedRevision,
    input.dependencies
  )
  const event = await signAndPublishPolicyDraft(
    prepared.owner,
    prepared.signer,
    prepared.createdAt,
    draft,
    input.dependencies
  )
  return { eventId: event.id, createdAt: event.created_at }
}
export async function withdrawMerchantShippingPolicy(input: {
  pubkey: string
  acceptedRevision: ShippingPolicyRevision
  clientAppId?: ConduitAppId
  dependencies?: ShippingPolicyMutationDependencies
}): Promise<void> {
  const prepared = await prepareMutation(
    input.pubkey,
    input.acceptedRevision,
    input.dependencies
  )
  if (
    prepared.current.state === "not_found" ||
    prepared.current.state === "withdrawn"
  )
    throw new Error("Shipping is already withdrawn.")
  const draft = buildShippingOptionDeletionEventDraft({
    merchantPubkey: prepared.owner,
    coordinate: getMerchantShippingPolicyCoordinate(prepared.owner),
    eventId: input.acceptedRevision.eventId,
    clientAppId: input.clientAppId,
  })
  await signAndPublishPolicyDraft(
    prepared.owner,
    prepared.signer,
    prepared.createdAt,
    draft,
    input.dependencies
  )
}

function canonicalShippingValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalShippingValue)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => item !== undefined && key !== "sig")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalShippingValue(item)])
    )
  return value
}
export function hasSameShippingPolicyQuote(
  left: ShippingPolicyQuote,
  right: ShippingPolicyQuote
): boolean {
  return (
    JSON.stringify(canonicalShippingValue(left)) ===
    JSON.stringify(canonicalShippingValue(right))
  )
}

const signedShippingEventSchema = z.custom<SignedPublicNostrEvent>((value) =>
  Boolean(
    value &&
    typeof value === "object" &&
    isValidSignedPublicNostrEvent(value as SignedPublicNostrEvent)
  )
)
const shippingHandlingSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    currency: z.string(),
    normalizedCurrency: z.string(),
  })
  .strict()
const shippingPricingRateSchema = z.union([
  z.number().finite().positive(),
  z
    .object({
      rate: z.number().finite().positive(),
      fetchedAt: z.number().finite().nonnegative(),
      source: z.enum(["env", "mempool", "coinbase"]),
      fiatUsdRates: z
        .record(z.string(), z.number().finite().positive())
        .optional(),
      fiatSource: z
        .enum(["frankfurter", "exchange-rate-api", "env", "mempool"])
        .optional(),
    })
    .strict(),
  z.null(),
])
const shippingQuoteItemSchema = z.object({
  productId: z.string(),
  productEventId: z.string().regex(HEX_64),
  productCreatedAt: integer,
  quantity: positiveInteger,
  weightGrams: positiveInteger,
  currency: z.string(),
  subtotalMinor: integer,
  productEvent: signedShippingEventSchema,
})
const shippingQuoteFields = z
  .object({
    merchantPubkey: z.string().regex(HEX_64),
    policyCoordinate: z.string(),
    policyEventId: z.string().regex(HEX_64),
    policyCreatedAt: integer,
    currency: z.string(),
    combinedWeightGrams: positiveInteger,
    shippedSubtotalMinor: integer,
    bandMaxWeightGrams: positiveInteger,
    bandPriceMinor: integer,
    handlingMinor: integer,
    freeShippingApplied: z.boolean(),
    amountMinor: integer,
    destination: z.object({
      country: z.string(),
      subdivision: z.string().optional(),
      postalCode: z.string().optional(),
    }),
    rule: z.object({
      country: z.string(),
      subdivision: z.string().optional(),
      postalPrefix: z.string().optional(),
    }),
    itemProductIds: z.array(z.string()).min(1),
    policyEvent: signedShippingEventSchema,
  })
  .strict()
const shippingPolicyQuoteV1Schema = shippingQuoteFields.extend({
  version: z.literal(1),
  amountSats: integer.optional(),
  pricingRate: shippingPricingRateSchema.optional(),
  items: z.array(shippingQuoteItemSchema).min(1),
})
const shippingPolicyQuoteV2Schema = shippingQuoteFields.extend({
  version: z.literal(2),
  amountSats: integer,
  pricingRate: shippingPricingRateSchema,
  items: z
    .array(
      shippingQuoteItemSchema.extend({
        shippingWeightAllowanceGrams: integer.optional(),
        shippingHandling: shippingHandlingSchema.optional(),
        convertedSubtotalMinor: integer,
        convertedHandlingMinor: integer,
      })
    )
    .min(1),
})
export const shippingPolicyQuoteSchema = z
  .discriminatedUnion("version", [
    shippingPolicyQuoteV1Schema,
    shippingPolicyQuoteV2Schema,
  ])
  .superRefine((quote, context) => {
    const event = quote.policyEvent
    const policy = parseShippingPolicyEventTags(event.tags)
    if (
      event.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      event.pubkey !== quote.merchantPubkey ||
      event.id !== quote.policyEventId ||
      event.created_at !== quote.policyCreatedAt ||
      quote.policyCoordinate !==
        getMerchantShippingPolicyCoordinate(event.pubkey) ||
      !policy ||
      policy.version !== quote.version
    ) {
      context.addIssue({
        code: "custom",
        message: "Quote must preserve its exact signed shipping policy.",
      })
      return
    }
    const result = quoteShippingPolicy({
      policy,
      policyCoordinate: quote.policyCoordinate,
      policyEventId: quote.policyEventId,
      policyCreatedAt: quote.policyCreatedAt,
      merchantPubkey: quote.merchantPubkey,
      policyEvent: event,
      items: quote.items,
      destination: quote.destination,
      rateInput: quote.pricingRate,
    })
    // Earlier v2 snapshots converted merchandise even without a threshold.
    // Preserve readback of those exact terms using their retained rate only.
    if (
      result.status === "quoted" &&
      quote.version === 2 &&
      result.quote.version === 2
    ) {
      const table =
        quote.destination.country === policy.originCountry
          ? policy.domestic
          : policy.international
      if (
        table?.freeShippingThresholdMinor === undefined &&
        !hasSameShippingPolicyQuote(result.quote, quote)
      ) {
        try {
          const converted = quote.items.map((item) =>
            convertShippingMinor(
              item.subtotalMinor,
              item.currency,
              policy.currency,
              quote.pricingRate
            )
          )
          result.quote.shippedSubtotalMinor = converted.reduce(
            (sum, amount) => sum + amount,
            0
          )
          result.quote.items.forEach((item, index) => {
            item.convertedSubtotalMinor = converted[index]!
          })
          // The old snapshot retained the rate used for these optional conversions.
          result.quote.pricingRate = quote.pricingRate
        } catch {
          context.addIssue({
            code: "custom",
            message:
              "Historical shipping subtotal conversion cannot be verified.",
          })
          return
        }
      }
    }
    if (
      result.status !== "quoted" ||
      !hasSameShippingPolicyQuote(result.quote, quote)
    )
      context.addIssue({
        code: "custom",
        message:
          "Shipping quote terms do not match their signed policy and inputs.",
      })
  })
export type ShippingPolicyQuote = z.infer<typeof shippingPolicyQuoteSchema>
export type ShippingPolicyQuoteV1 = z.infer<typeof shippingPolicyQuoteV1Schema>
export type ShippingPolicyQuoteV2 = z.infer<typeof shippingPolicyQuoteV2Schema>
export interface ShippingPolicyQuoteItem {
  productId: string
  productEventId: string
  productCreatedAt: number
  productEvent: SignedPublicNostrEvent
  quantity: number
  weightGrams?: number
  shippingWeightAllowanceGrams?: number
  shippingHandling?: SourcePriceQuote
  currency: string
  subtotalMinor: number
  format?: "physical" | "digital"
  fulfillmentType?: "shipping" | "pickup" | "digital"
}
export interface ShippingPolicyDestination {
  country: string
  subdivision?: string
  postalCode?: string
}
export type ShippingPolicyQuoteResult =
  | { status: "quoted"; quote: ShippingPolicyQuote }
  | {
      status:
        | "unsupported_destination"
        | "missing_weight"
        | "overweight"
        | "currency_mismatch"
        | "invalid_items"
        | "invalid_policy"
        | "not_required"
        | "rate_required"
    }

export interface ShippingPolicyPreviewItem {
  weightGrams?: number
  shippingWeightAllowanceGrams?: number
  shippingHandling?: SourcePriceQuote
  shippingWeightGrams?: number
  quantity: number
  currency: string
  subtotalMinor: number
  format?: "physical" | "digital"
  fulfillmentType?: "shipping" | "pickup" | "digital"
}
export type ShippingPolicyCalculation = Pick<
  ShippingPolicyQuote,
  | "currency"
  | "combinedWeightGrams"
  | "shippedSubtotalMinor"
  | "bandMaxWeightGrams"
  | "bandPriceMinor"
  | "handlingMinor"
  | "freeShippingApplied"
  | "amountMinor"
  | "destination"
  | "rule"
>
export type ShippingPolicyPreviewResult =
  | ({ status: "quoted"; amountSats?: number } & ShippingPolicyCalculation)
  | Exclude<ShippingPolicyQuoteResult, { status: "quoted" }>

class ShippingRateRequired extends Error {}
type Ratio = { n: bigint; d: bigint }
function decimalRatio(value: number): Ratio {
  if (!Number.isFinite(value) || value <= 0) throw new ShippingRateRequired()
  const [coefficient, exponentText] = String(value).toLowerCase().split("e")
  const [whole, fraction = ""] = coefficient!.split(".")
  const exponent = Number(exponentText ?? 0) - fraction.length
  const n = BigInt(whole! + fraction)
  return exponent >= 0
    ? { n: n * 10n ** BigInt(exponent), d: 1n }
    : { n, d: 10n ** BigInt(-exponent) }
}
function bitcoinUnit(currency: string): Ratio | null {
  if (currency === "BTC") return { n: 100_000_000n, d: 1n }
  if (currency === "SATS") return { n: 1n, d: 1n }
  if (currency === "MSATS") return { n: 1n, d: 1000n }
  return null
}
function usdUnit(currency: string, rate: PricingRateInput): Ratio {
  if (currency === "USD") return { n: 1n, d: 1n }
  const bitcoin = bitcoinUnit(currency)
  if (bitcoin) {
    const btc = decimalRatio(
      typeof rate === "number" ? rate : (rate?.rate ?? NaN)
    )
    return { n: bitcoin.n * btc.n, d: bitcoin.d * btc.d * 100_000_000n }
  }
  return decimalRatio(
    typeof rate === "object" && rate
      ? (rate.fiatUsdRates?.[currency] ?? NaN)
      : NaN
  )
}
/** Each quantity-total line is rounded once, half up, to policy minor units.
 * The final combined charge is rounded once to sats. Decimal snapshot rates are
 * used as exact rational numbers; replay never fetches rates or tests their age.
 */
export function convertShippingMinor(
  minor: number,
  fromCurrency: string,
  toCurrency: string,
  rateInput: PricingRateInput = null
): number {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error("Invalid shipping amount.")
  const from = normalizeCurrencyIdentity(fromCurrency),
    to = normalizeCurrencyIdentity(toCurrency)
  if (from === to || minor === 0) return minor
  const fromBitcoin = bitcoinUnit(from),
    toBitcoin = bitcoinUnit(to)
  const source =
    fromBitcoin && toBitcoin ? fromBitcoin : usdUnit(from, rateInput)
  const target = fromBitcoin && toBitcoin ? toBitcoin : usdUnit(to, rateInput)
  const numerator =
    BigInt(minor) *
    source.n *
    target.d *
    10n ** BigInt(getCurrencyFractionDigits(to))
  const denominator =
    source.d * target.n * 10n ** BigInt(getCurrencyFractionDigits(from))
  const result = Number((numerator * 2n + denominator) / (denominator * 2n))
  if (!Number.isSafeInteger(result))
    throw new Error("Shipping amount is too large.")
  return result
}

/** Same arithmetic as checkout, with no claim that an unpublished draft is signed. */
export function previewShippingPolicy(input: {
  policy: ShippingPolicy
  items: readonly ShippingPolicyPreviewItem[]
  destination: ShippingPolicyDestination
  rateInput?: PricingRateInput
}): ShippingPolicyPreviewResult {
  let policy: ShippingPolicy
  try {
    policy = parseShippingPolicy(input.policy)
  } catch {
    return { status: "invalid_policy" }
  }
  if (
    input.rateInput !== undefined &&
    !shippingPricingRateSchema.safeParse(input.rateInput).success
  )
    return { status: "rate_required" }
  const normalizedItems = input.items.map((item) => ({
    ...item,
    weightGrams: item.weightGrams ?? item.shippingWeightGrams,
  }))
  const items = normalizedItems.filter(
    (item) =>
      item.format !== "digital" &&
      item.fulfillmentType !== "pickup" &&
      item.fulfillmentType !== "digital"
  )
  if (!items.length) return { status: "not_required" }
  if (
    policy.version === 1 &&
    items.some(
      (item) => normalizeCurrencyIdentity(item.currency) !== policy.currency
    )
  )
    return { status: "currency_mismatch" }
  if (
    items.some(
      (item) =>
        !Number.isSafeInteger(item.weightGrams) || item.weightGrams! <= 0
    )
  )
    return { status: "missing_weight" }
  if (
    items.some(
      (item) =>
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        !Number.isSafeInteger(item.subtotalMinor) ||
        item.subtotalMinor < 0
    )
  )
    return { status: "invalid_items" }
  if (
    items.some(
      (item) =>
        (item.shippingWeightAllowanceGrams !== undefined &&
          (!Number.isSafeInteger(item.shippingWeightAllowanceGrams) ||
            item.shippingWeightAllowanceGrams < 0)) ||
        (policy.version === 1 &&
          (item.shippingWeightAllowanceGrams !== undefined ||
            item.shippingHandling !== undefined))
    )
  )
    return { status: "invalid_items" }
  const destination = {
    country: input.destination.country.trim().toUpperCase(),
    ...(input.destination.subdivision
      ? {
          subdivision: normalizeShippingPolicySubdivision(
            input.destination.country,
            input.destination.subdivision
          ),
        }
      : {}),
    ...(input.destination.postalCode
      ? {
          postalCode: normalizeShippingPolicyRegion(
            input.destination.postalCode
          ),
        }
      : {}),
  }
  const table =
    destination.country === policy.originCountry
      ? policy.domestic
      : policy.international
  const rules = (table?.rules ?? [])
    .filter(
      (rule) =>
        rule.country === destination.country &&
        (!rule.subdivision || rule.subdivision === destination.subdivision) &&
        (!rule.postalPrefix ||
          destination.postalCode?.startsWith(rule.postalPrefix))
    )
    .sort(
      (a, b) =>
        (b.postalPrefix?.length ?? 0) - (a.postalPrefix?.length ?? 0) ||
        Number(Boolean(b.subdivision)) - Number(Boolean(a.subdivision))
    )
  const rule = rules[0]
  if (!rule) return { status: "unsupported_destination" }
  const combinedWeightGrams = items.reduce(
    (sum, item) =>
      sum +
      (item.weightGrams! +
        (policy.version === 2 ? (item.shippingWeightAllowanceGrams ?? 0) : 0)) *
        item.quantity,
    policy.version === 1 ? policy.weightAllowanceGrams : 0
  )
  const needsSubtotal =
    policy.version === 1 || table!.freeShippingThresholdMinor !== undefined
  let shippedSubtotalMinor = 0
  let handlingMinor = policy.version === 1 ? policy.handlingMinor : 0
  try {
    for (const item of items) {
      if (needsSubtotal)
        shippedSubtotalMinor +=
          policy.version === 1
            ? item.subtotalMinor
            : convertShippingMinor(
                item.subtotalMinor,
                item.currency,
                policy.currency,
                input.rateInput ?? null
              )
      if (policy.version === 2 && item.shippingHandling) {
        const handling = item.shippingHandling
        if (
          normalizeCurrencyIdentity(handling.currency) !==
            normalizeCurrencyIdentity(item.currency) ||
          handling.normalizedCurrency !==
            normalizeCurrencyIdentity(handling.currency)
        )
          return { status: "invalid_items" }
        handlingMinor += convertShippingMinor(
          shippingAmountToMinor(handling.amount, handling.currency) *
            item.quantity,
          handling.currency,
          policy.currency,
          input.rateInput ?? null
        )
      }
    }
  } catch (error) {
    return {
      status:
        error instanceof ShippingRateRequired
          ? "rate_required"
          : "invalid_items",
    }
  }
  if (
    !Number.isSafeInteger(combinedWeightGrams) ||
    !Number.isSafeInteger(shippedSubtotalMinor) ||
    !Number.isSafeInteger(handlingMinor)
  )
    return { status: "invalid_items" }
  const band = rule.bands.find(
    (candidate) => combinedWeightGrams <= candidate.maxWeightGrams
  )
  if (!band) return { status: "overweight" }
  const freeShippingApplied =
    table!.freeShippingThresholdMinor !== undefined &&
    shippedSubtotalMinor >= table!.freeShippingThresholdMinor
  const amountMinor = freeShippingApplied ? 0 : band.priceMinor + handlingMinor
  if (!Number.isSafeInteger(amountMinor)) return { status: "invalid_policy" }
  let amountSats: number | undefined
  if (policy.version === 2) {
    try {
      amountSats = convertShippingMinor(
        amountMinor,
        policy.currency,
        "SATS",
        input.rateInput ?? null
      )
    } catch (error) {
      // An unsigned preview can show policy-currency money without a settlement rate.
      if (!(error instanceof ShippingRateRequired))
        return { status: "invalid_items" }
    }
  }
  return {
    status: "quoted",
    ...(policy.version === 2 ? { amountSats } : {}),
    currency: policy.currency,
    combinedWeightGrams,
    shippedSubtotalMinor,
    bandMaxWeightGrams: band.maxWeightGrams,
    bandPriceMinor: band.priceMinor,
    handlingMinor,
    freeShippingApplied,
    amountMinor,
    destination,
    rule: {
      country: rule.country,
      ...(rule.subdivision ? { subdivision: rule.subdivision } : {}),
      ...(rule.postalPrefix ? { postalPrefix: rule.postalPrefix } : {}),
    },
  }
}

export function quoteShippingPolicy(input: {
  policy: ShippingPolicy
  policyCoordinate: string
  policyEventId: string
  policyCreatedAt: number
  merchantPubkey: string
  policyEvent: SignedPublicNostrEvent
  items: readonly ShippingPolicyQuoteItem[]
  destination: ShippingPolicyDestination
  rateInput?: PricingRateInput
}): ShippingPolicyQuoteResult {
  let policy: ShippingPolicy
  try {
    policy = parseShippingPolicy(input.policy)
  } catch {
    return { status: "invalid_policy" }
  }
  if (!input.policyEvent || !isValidSignedPublicNostrEvent(input.policyEvent))
    return { status: "invalid_policy" }
  const signedPolicy = parseShippingPolicyEventTags(input.policyEvent.tags)
  if (
    !signedPolicy ||
    JSON.stringify(signedPolicy) !== JSON.stringify(policy) ||
    input.policyEvent.id !== input.policyEventId ||
    input.policyEvent.pubkey !== input.merchantPubkey ||
    input.policyEvent.created_at !== input.policyCreatedAt ||
    input.policyEvent.kind !== EVENT_KINDS.SHIPPING_OPTION ||
    input.policyCoordinate !==
      getMerchantShippingPolicyCoordinate(input.merchantPubkey)
  )
    return { status: "invalid_policy" }
  const items = input.items.filter(
    (item) =>
      item.format !== "digital" &&
      item.fulfillmentType !== "pickup" &&
      item.fulfillmentType !== "digital"
  )
  if (
    new Set(items.map((item) => item.productId)).size !== items.length ||
    items.some(
      (item) =>
        !item.productId.startsWith(`30402:${input.merchantPubkey}:`) ||
        !HEX_64.test(item.productEventId) ||
        !Number.isSafeInteger(item.productCreatedAt) ||
        item.productCreatedAt < 0
    )
  )
    return { status: "invalid_items" }
  for (const item of items) {
    const event = item.productEvent
    if (
      !event ||
      !isValidSignedPublicNostrEvent(event) ||
      event.kind !== EVENT_KINDS.PRODUCT ||
      event.pubkey !== input.merchantPubkey ||
      event.id !== item.productEventId ||
      event.created_at !== item.productCreatedAt
    )
      return { status: "invalid_items" }
    const product = parseProductEvent(new NDKEvent(undefined, event))
    if (
      !product ||
      product.priceEvidenceMalformed ||
      product.shippingAdjustmentsMalformed ||
      product.id !== item.productId ||
      product.format !== "physical" ||
      product.shippingOptionId !== input.policyCoordinate ||
      product.shippingOptionLaunchUnsupported ||
      product.shippingWeightGrams !== item.weightGrams ||
      normalizeCurrencyIdentity(
        product.sourcePrice?.normalizedCurrency ?? product.currency
      ) !== normalizeCurrencyIdentity(item.currency) ||
      product.shippingWeightAllowanceGrams !==
        item.shippingWeightAllowanceGrams ||
      JSON.stringify(canonicalShippingValue(product.shippingHandling)) !==
        JSON.stringify(canonicalShippingValue(item.shippingHandling))
    )
      return { status: "invalid_items" }
    try {
      if (
        shippingAmountToMinor(
          product.sourcePrice?.amount ?? product.price,
          item.currency
        ) *
          item.quantity !==
        item.subtotalMinor
      )
        return { status: "invalid_items" }
    } catch {
      return { status: "invalid_items" }
    }
  }
  const calculation = previewShippingPolicy({
    policy,
    items,
    destination: input.destination,
    rateInput: input.rateInput,
  })
  if (calculation.status !== "quoted") return calculation
  const { status, amountSats: calculatedSats, ...terms } = calculation
  let amountSats = calculatedSats
  const retainsConversion =
    policy.version === 2 || input.rateInput !== undefined
  if (policy.version === 1 && retainsConversion) {
    try {
      amountSats = convertShippingMinor(
        terms.amountMinor,
        policy.currency,
        "SATS",
        input.rateInput
      )
    } catch {
      return { status: "rate_required" }
    }
  }
  const table =
    terms.destination.country === policy.originCountry
      ? policy.domestic
      : policy.international
  const needsSubtotal =
    policy.version === 1 || table?.freeShippingThresholdMinor !== undefined
  if (policy.version === 2 && amountSats === undefined)
    return { status: "rate_required" }
  if (retainsConversion && terms.amountMinor > 0 && amountSats === 0)
    return { status: "invalid_items" }
  const usesRate = (from: string, to: string, minor: number) =>
    minor !== 0 &&
    normalizeCurrencyIdentity(from) !== normalizeCurrencyIdentity(to) &&
    !(
      bitcoinUnit(normalizeCurrencyIdentity(from)) &&
      bitcoinUnit(normalizeCurrencyIdentity(to))
    )
  const capturesRate =
    usesRate(policy.currency, "SATS", terms.amountMinor) ||
    items.some(
      (item) =>
        (policy.version === 2 &&
          needsSubtotal &&
          usesRate(item.currency, policy.currency, item.subtotalMinor)) ||
        (item.shippingHandling &&
          usesRate(
            item.shippingHandling.currency,
            policy.currency,
            shippingAmountToMinor(
              item.shippingHandling.amount,
              item.shippingHandling.currency
            ) * item.quantity
          ))
    )
  return {
    status,
    quote: {
      version: policy.version,
      ...(retainsConversion
        ? {
            amountSats: amountSats!,
            pricingRate: structuredClone(
              capturesRate ? (input.rateInput ?? null) : null
            ),
          }
        : {}),
      merchantPubkey: input.merchantPubkey,
      policyCoordinate: input.policyCoordinate,
      policyEventId: input.policyEventId,
      policyCreatedAt: input.policyCreatedAt,
      ...terms,
      itemProductIds: items.map((item) => item.productId),
      items: items.map((item) => ({
        productId: item.productId,
        productEventId: item.productEventId,
        productCreatedAt: item.productCreatedAt,
        currency: normalizeCurrencyIdentity(item.currency),
        quantity: item.quantity,
        weightGrams: item.weightGrams!,
        subtotalMinor: item.subtotalMinor,
        ...(policy.version === 2
          ? {
              ...(item.shippingWeightAllowanceGrams !== undefined
                ? {
                    shippingWeightAllowanceGrams:
                      item.shippingWeightAllowanceGrams,
                  }
                : {}),
              ...(item.shippingHandling
                ? { shippingHandling: structuredClone(item.shippingHandling) }
                : {}),
              convertedSubtotalMinor: needsSubtotal
                ? convertShippingMinor(
                    item.subtotalMinor,
                    item.currency,
                    policy.currency,
                    input.rateInput ?? null
                  )
                : 0,
              convertedHandlingMinor: item.shippingHandling
                ? convertShippingMinor(
                    shippingAmountToMinor(
                      item.shippingHandling.amount,
                      item.shippingHandling.currency
                    ) * item.quantity,
                    item.shippingHandling.currency,
                    policy.currency,
                    input.rateInput ?? null
                  )
                : 0,
            }
          : {}),
        productEvent: structuredClone(item.productEvent),
      })),
      policyEvent: structuredClone(input.policyEvent),
    } as ShippingPolicyQuote,
  }
}

/** Advisory only: never changes weight, price, eligibility, or signed terms. */
export function getShippingDimensionWarnings(
  weightGrams: number | undefined,
  dimensions: { length: number; width: number; height: number } | undefined
): string[] {
  if (!dimensions) return []
  const volume = dimensions.length * dimensions.width * dimensions.height
  const warnings: string[] = []
  if (Math.max(dimensions.length, dimensions.width, dimensions.height) > 100)
    warnings.push(
      "A dimension exceeds 100 cm. Consider extra packing weight or handling."
    )
  if (volume > 100_000)
    warnings.push(
      "This item is bulky. Consider extra packing weight or handling."
    )
  if (weightGrams && volume > 0 && weightGrams / volume < 0.1)
    warnings.push(
      "This item is light for its size. Consider extra packing weight or handling."
    )
  return warnings
}
