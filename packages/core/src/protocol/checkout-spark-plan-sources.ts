import { isSatsLikeCurrency } from "../pricing"
import { assertCheckoutSparkSignedCommerceAllocations } from "./checkout-spark-signed-allocation"
import {
  restoreCheckoutSparkSettledPlan,
  type CheckoutSparkSettledPlan,
} from "./checkout-spark-settled-router"
import { parseAddressableCoordinate } from "./event-market"
import { isValidLud16Address } from "./lightning"
import { projectProfileContent } from "./profile-cache"
import { parseProductEvent } from "./products"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
/** Application resource budget, not a Nostr event or encryption limit. */
export const CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES = 32 * 1024
const VALIDATION_KEYS = [
  "schemaVersion",
  "checkoutId",
  "planDigest",
  "merchantPubkey",
] as const

export interface CheckoutSparkPlanSourceReference {
  readonly eventId: string
  readonly kind: 0 | 30402 | 30405 | 30406 | 31922 | 31923
  readonly pubkey: string
}

/** Local source admission only; not payment proof or invoice attribution. */
export interface CheckoutSparkPlanSourceValidation {
  readonly schemaVersion: 1
  readonly checkoutId: string
  readonly planDigest: string
  readonly merchantPubkey: string
}

function unavailable(): never {
  throw new Error("Checkout Spark signed plan sources are unavailable.")
}

/**
 * Pre-plan source snapshot for checkout preparation. Preserve signed values,
 * discard unsigned transport metadata, and bound bytes before verifying crypto.
 */
export function snapshotCheckoutSparkPlanSourceEvents(
  events: readonly SignedPublicNostrEvent[]
): SignedPublicNostrEvent[] {
  try {
    if (!Array.isArray(events) || events.length === 0) unavailable()
    const sources: SignedPublicNostrEvent[] = []
    const ids = new Set<string>()
    let bytes = 2 // The canonical array's opening and closing brackets.
    for (const event of events) {
      const source: SignedPublicNostrEvent = {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag: string[]) => [...tag]),
        content: event.content,
        sig: event.sig,
      }
      if (
        (source.kind !== 0 &&
          source.kind !== 30_402 &&
          source.kind !== 30_405 &&
          source.kind !== 30_406 &&
          source.kind !== 31_922 &&
          source.kind !== 31_923) ||
        ids.has(source.id)
      ) {
        unavailable()
      }
      bytes +=
        new TextEncoder().encode(JSON.stringify(source)).byteLength +
        (sources.length > 0 ? 1 : 0)
      if (bytes > CHECKOUT_SPARK_PLAN_SOURCE_BUNDLE_MAX_BYTES) unavailable()
      ids.add(source.id)
      sources.push(source)
    }
    sources.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    )
    for (const source of sources) {
      if (!isValidSignedPublicNostrEvent(source)) unavailable()
      source.tags.forEach(Object.freeze)
      Object.freeze(source.tags)
      Object.freeze(source)
    }
    Object.freeze(sources)
    return sources
  } catch {
    return unavailable()
  }
}

/** Exact, complete and bounded source set for a frozen settled plan. */
export function canonicalizeCheckoutSparkPlanSourceEvents(
  plan: CheckoutSparkSettledPlan,
  events: readonly SignedPublicNostrEvent[]
): SignedPublicNostrEvent[] {
  try {
    const frozen = restoreCheckoutSparkSettledPlan(plan)
    const sources = snapshotCheckoutSparkPlanSourceEvents(events)
    const references = referencesFor(frozen)
    const byId = new Map(sources.map((source) => [source.id, source]))
    if (
      sources.length !== references.length ||
      references.some((reference) => {
        const source = byId.get(reference.eventId)
        return (
          !source ||
          source.kind !== reference.kind ||
          source.pubkey !== reference.pubkey
        )
      })
    ) {
      unavailable()
    }
    validateCheckoutSparkPlanSources(frozen, sources)
    return sources
  } catch {
    return unavailable()
  }
}

function referencesFor(
  plan: CheckoutSparkSettledPlan
): readonly CheckoutSparkPlanSourceReference[] {
  const references = new Map<string, CheckoutSparkPlanSourceReference>()
  const add = (reference: CheckoutSparkPlanSourceReference) => {
    const existing = references.get(reference.eventId)
    if (
      existing &&
      (existing.kind !== reference.kind || existing.pubkey !== reference.pubkey)
    ) {
      unavailable()
    }
    references.set(reference.eventId, Object.freeze(reference))
  }
  for (const line of plan.commerceQuote.lines) {
    add({
      eventId: line.productEventId,
      kind: 30402,
      pubkey: line.merchantPubkey,
    })
    if (line.pickup) {
      const calendar = parseAddressableCoordinate(
        line.pickup.calendar.coordinate,
        [31922, 31923]
      )
      const collection = parseAddressableCoordinate(
        line.pickup.collection.coordinate,
        [30405]
      )
      const pickup = line.shippingOption
        ? parseAddressableCoordinate(line.shippingOption.coordinate, [30406])
        : null
      if (
        !calendar ||
        (calendar.kind !== 31922 && calendar.kind !== 31923) ||
        !collection ||
        !pickup ||
        !line.shippingOption
      ) {
        unavailable()
      }
      add({
        eventId: line.shippingOption.eventId,
        kind: 30406,
        pubkey: pickup.authorPubkey,
      })
      add({
        eventId: line.pickup.calendar.eventId,
        kind: calendar.kind,
        pubkey: calendar.authorPubkey,
      })
      add({
        eventId: line.pickup.collection.eventId,
        kind: 30405,
        pubkey: collection.authorPubkey,
      })
    } else if (line.shippingOption) {
      add({
        eventId: line.shippingOption.eventId,
        kind: 30406,
        pubkey: line.merchantPubkey,
      })
    }
  }
  for (const recipient of plan.recipients) {
    if (recipient.kind === "conduit") continue
    if (recipient.kind !== "merchant" && recipient.kind !== "supplier") {
      unavailable()
    }
    if (recipient.destination.source.type !== "signed_profile") unavailable()
    add({
      eventId: recipient.destination.source.profileEventId,
      kind: 0,
      pubkey: recipient.recipientId,
    })
  }
  return Object.freeze([...references.values()])
}

/** Read exact historical IDs; a latest replaceable event must not redirect a plan. */
export function getCheckoutSparkPlanSourceReferences(
  plan: CheckoutSparkSettledPlan
): readonly CheckoutSparkPlanSourceReference[] {
  try {
    return referencesFor(restoreCheckoutSparkSettledPlan(plan))
  } catch {
    return unavailable()
  }
}

/**
 * Re-establish signed commerce and destination authority from exact source
 * events. No relay freshness, wallet, provider payment, or invoice-provenance
 * claim is made. Missing retained historical evidence remains unavailable.
 */
export function validateCheckoutSparkPlanSources(
  plan: CheckoutSparkSettledPlan,
  events: readonly SignedPublicNostrEvent[]
): CheckoutSparkPlanSourceValidation {
  try {
    const frozen = restoreCheckoutSparkSettledPlan(plan)
    const references = referencesFor(frozen)
    const wanted = new Map(
      references.map((reference) => [reference.eventId, reference])
    )
    const sources = new Map<string, SignedPublicNostrEvent>()
    for (const event of events) {
      const reference = wanted.get(event.id)
      if (!reference) continue
      // Keep only the signed public fields and detach nested tags before use.
      const source: SignedPublicNostrEvent = {
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        kind: event.kind,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
        sig: event.sig,
      }
      if (
        !isValidSignedPublicNostrEvent(source) ||
        source.kind !== reference.kind ||
        source.pubkey !== reference.pubkey ||
        source.created_at > Math.floor(frozen.createdAt / 1_000)
      ) {
        unavailable()
      }
      const existing = sources.get(source.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(source)) {
        unavailable()
      }
      sources.set(source.id, source)
    }
    if (sources.size !== references.length) unavailable()

    const products = frozen.commerceQuote.lines.map((line) => {
      const event = sources.get(line.productEventId)!
      const product = { ...parseProductEvent(event), sourceEventId: event.id }
      if (
        product.sourcePrice !== undefined &&
        !isSatsLikeCurrency(product.sourcePrice.normalizedCurrency)
      ) {
        unavailable()
      }
      return product
    })
    assertCheckoutSparkSignedCommerceAllocations({
      quote: frozen.commerceQuote,
      products,
      merchantPubkey: frozen.merchantPubkey,
      shippingEvents: [...sources.values()].filter(
        (source) => source.kind === 30_406
      ),
      pickupSourceEvents: [...sources.values()].filter(
        (source) =>
          source.kind === 30_405 ||
          source.kind === 30_406 ||
          source.kind === 31_922 ||
          source.kind === 31_923
      ),
      acceptedAtMs: frozen.createdAt,
      commerce: frozen.recipients.flatMap((recipient) => {
        if (recipient.kind === "conduit") return []
        if (recipient.kind !== "merchant" && recipient.kind !== "supplier") {
          return unavailable()
        }
        return [
          {
            kind: recipient.kind,
            recipientId: recipient.recipientId,
            amountSats: recipient.weightSats,
          },
        ]
      }),
    })

    for (const recipient of frozen.recipients) {
      if (recipient.kind === "conduit") continue
      const source = recipient.destination.source
      if (source.type !== "signed_profile") unavailable()
      const event = sources.get(source.profileEventId)!
      const address = projectProfileContent(
        event.pubkey,
        event.content
      ).lud16?.trim()
      if (
        event.created_at !== source.profileEventCreatedAt ||
        !address ||
        !isValidLud16Address(address) ||
        address !== recipient.destination.value
      ) {
        unavailable()
      }
    }
    return Object.freeze({
      schemaVersion: 1,
      checkoutId: frozen.checkoutId,
      planDigest: frozen.planDigest,
      merchantPubkey: frozen.merchantPubkey,
    })
  } catch {
    return unavailable()
  }
}

/** Validate a local attestation's exact scope; this does not verify source events. */
export function restoreCheckoutSparkPlanSourceValidation(
  value: unknown,
  expected: Pick<
    CheckoutSparkSettledPlan,
    "checkoutId" | "planDigest" | "merchantPubkey"
  >
): CheckoutSparkPlanSourceValidation {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      unavailable()
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).length !== VALIDATION_KEYS.length ||
      Object.keys(record).some(
        (key) => !VALIDATION_KEYS.some((allowed) => allowed === key)
      ) ||
      record.schemaVersion !== 1 ||
      typeof record.checkoutId !== "string" ||
      record.checkoutId.length === 0 ||
      record.checkoutId.length > 512 ||
      record.checkoutId.trim() !== record.checkoutId ||
      typeof record.planDigest !== "string" ||
      !HEX_64.test(record.planDigest) ||
      typeof record.merchantPubkey !== "string" ||
      !HEX_64.test(record.merchantPubkey) ||
      record.checkoutId !== expected.checkoutId ||
      record.planDigest !== expected.planDigest ||
      record.merchantPubkey !== expected.merchantPubkey
    ) {
      unavailable()
    }
    return Object.freeze({
      schemaVersion: 1,
      checkoutId: record.checkoutId,
      planDigest: record.planDigest,
      merchantPubkey: record.merchantPubkey,
    })
  } catch {
    return unavailable()
  }
}
