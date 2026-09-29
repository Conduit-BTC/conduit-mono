/**
 * Local, versioned shipping tables carried by an explicit kind-30406 extension.
 * The Open Markets content remains a human-readable description; clients that
 * do not understand the extension must not treat its base price as a quote.
 */
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { z } from "zod"
import {
  getCurrencyFractionDigits,
  normalizeCurrencyIdentity,
} from "../pricing"
import { parseProductEvent } from "./products"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
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
export const shippingPolicySchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(200),
    originCountry: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().min(3).max(5),
    weightAllowanceGrams: integer,
    handlingMinor: integer,
    domestic: shippingPolicyTableSchema.nullable(),
    international: shippingPolicyTableSchema.nullable(),
  })
  .strict()
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
export type ShippingPolicy = z.infer<typeof shippingPolicySchema>
export type ShippingPolicyTable = z.infer<typeof shippingPolicyTableSchema>
export type ShippingPolicyRule = z.infer<typeof shippingPolicyRuleSchema>
export type ShippingPolicyBand = z.infer<typeof shippingPolicyBandSchema>

export function normalizeShippingPolicyRegion(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "")
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
    [SHIPPING_POLICY_EXTENSION_TAG, "1", JSON.stringify(policy)],
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
  if (markers.length !== 1 || markers[0]?.length !== 3 || markers[0][1] !== "1")
    return null
  try {
    const policy = parseShippingPolicy(JSON.parse(markers[0][2]!) as unknown)
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
  signer?: NDKSigner
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
  const signer = dependencies?.signer ?? getNdk().signer
  if (!signer || (await signer.user()).pubkey.toLowerCase() !== owner)
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
  signer: NDKSigner,
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
  await event.sign(signer)
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

export const shippingPolicyQuoteSchema = z
  .object({
    version: z.literal(1),
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
    items: z
      .array(
        z.object({
          productId: z.string(),
          productEventId: z.string().regex(HEX_64),
          productCreatedAt: integer,
          quantity: positiveInteger,
          weightGrams: positiveInteger,
          currency: z.string(),
          subtotalMinor: integer,
          productEvent: z.custom<SignedPublicNostrEvent>((value) =>
            Boolean(
              value &&
              typeof value === "object" &&
              isValidSignedPublicNostrEvent(value as SignedPublicNostrEvent)
            )
          ),
        })
      )
      .min(1),
    policyEvent: z.custom<SignedPublicNostrEvent>((value) =>
      Boolean(
        value &&
        typeof value === "object" &&
        isValidSignedPublicNostrEvent(value as SignedPublicNostrEvent)
      )
    ),
  })
  .strict()
  .superRefine((quote, context) => {
    const event = quote.policyEvent
    if (
      event.kind !== EVENT_KINDS.SHIPPING_OPTION ||
      event.pubkey !== quote.merchantPubkey ||
      event.id !== quote.policyEventId ||
      event.created_at !== quote.policyCreatedAt ||
      quote.policyCoordinate !==
        getMerchantShippingPolicyCoordinate(event.pubkey) ||
      !parseShippingPolicyEventTags(event.tags)
    ) {
      context.addIssue({
        code: "custom",
        message: "Quote must preserve its exact signed shipping policy.",
      })
      return
    }
    const policy = parseShippingPolicyEventTags(event.tags)!
    const result = quoteShippingPolicy({
      policy,
      policyCoordinate: quote.policyCoordinate,
      policyEventId: quote.policyEventId,
      policyCreatedAt: quote.policyCreatedAt,
      merchantPubkey: quote.merchantPubkey,
      policyEvent: event,
      items: quote.items,
      destination: quote.destination,
    })
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
export interface ShippingPolicyQuoteItem {
  productId: string
  productEventId: string
  productCreatedAt: number
  productEvent: SignedPublicNostrEvent
  quantity: number
  weightGrams?: number
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
    }

export interface ShippingPolicyPreviewItem {
  weightGrams?: number
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
  | ({ status: "quoted" } & ShippingPolicyCalculation)
  | Exclude<ShippingPolicyQuoteResult, { status: "quoted" }>

/** Same arithmetic as checkout, with no claim that an unpublished draft is signed. */
export function previewShippingPolicy(input: {
  policy: ShippingPolicy
  items: readonly ShippingPolicyPreviewItem[]
  destination: ShippingPolicyDestination
}): ShippingPolicyPreviewResult {
  let policy: ShippingPolicy
  try {
    policy = parseShippingPolicy(input.policy)
  } catch {
    return { status: "invalid_policy" }
  }
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
  const destination = {
    country: input.destination.country.trim().toUpperCase(),
    ...(input.destination.subdivision
      ? {
          subdivision: normalizeShippingPolicyRegion(
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
  // ISO subdivision values include the country. Accept a form's state code too.
  if (
    destination.subdivision &&
    !destination.subdivision.startsWith(destination.country)
  )
    destination.subdivision = `${destination.country}${destination.subdivision}`
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
    (sum, item) => sum + item.weightGrams! * item.quantity,
    policy.weightAllowanceGrams
  )
  const shippedSubtotalMinor = items.reduce(
    (sum, item) => sum + item.subtotalMinor,
    0
  )
  if (
    !Number.isSafeInteger(combinedWeightGrams) ||
    !Number.isSafeInteger(shippedSubtotalMinor)
  )
    return { status: "invalid_items" }
  const band = rule.bands.find(
    (candidate) => combinedWeightGrams <= candidate.maxWeightGrams
  )
  if (!band) return { status: "overweight" }
  const freeShippingApplied =
    table!.freeShippingThresholdMinor !== undefined &&
    shippedSubtotalMinor >= table!.freeShippingThresholdMinor
  const amountMinor = freeShippingApplied
    ? 0
    : band.priceMinor + policy.handlingMinor
  if (!Number.isSafeInteger(amountMinor)) return { status: "invalid_policy" }
  return {
    status: "quoted",
    currency: policy.currency,
    combinedWeightGrams,
    shippedSubtotalMinor,
    bandMaxWeightGrams: band.maxWeightGrams,
    bandPriceMinor: band.priceMinor,
    handlingMinor: policy.handlingMinor,
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
      product.id !== item.productId ||
      product.format !== "physical" ||
      product.shippingOptionId !== input.policyCoordinate ||
      product.shippingOptionLaunchUnsupported ||
      product.shippingWeightGrams !== item.weightGrams ||
      normalizeCurrencyIdentity(
        product.sourcePrice?.normalizedCurrency ?? product.currency
      ) !== policy.currency
    )
      return { status: "invalid_items" }
    try {
      if (
        shippingAmountToMinor(
          product.sourcePrice?.amount ?? product.price,
          policy.currency
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
  })
  if (calculation.status !== "quoted") return calculation
  const { status, ...terms } = calculation
  return {
    status,
    quote: {
      version: 1,
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
        productEvent: structuredClone(item.productEvent),
      })),
      policyEvent: structuredClone(input.policyEvent),
    },
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
      "A dimension exceeds 100 cm. Check your shipping table covers this item."
    )
  if (volume > 100_000)
    warnings.push(
      "This item is bulky. Check your shipping table covers its size."
    )
  if (weightGrams && volume > 0 && weightGrams / volume < 0.1)
    warnings.push(
      "This item is light for its size. Carrier charges may differ from your weight table."
    )
  return warnings
}
