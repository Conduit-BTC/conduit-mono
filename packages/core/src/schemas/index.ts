import { z } from "zod"
import { checkoutSparkCommercePricingSchema } from "../protocol/checkout-spark-commerce-pricing"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "../protocol/signed-event"
import { normalizeCurrencyIdentity } from "../pricing"
import {
  shippingPolicyQuoteSchema,
  shippingMoneyToMinorUnits,
  convertShippingMinor,
  normalizeShippingPolicyRegion,
  normalizeShippingPolicySubdivision,
  hasSameShippingPolicyQuote,
  MERCHANT_SHIPPING_POLICY_D_TAG,
} from "../protocol/shipping-policy"
import { EVENT_KINDS } from "../protocol/kinds"
export { shippingPolicyQuoteSchema } from "../protocol/shipping-policy"
import { isContactFreeEventHandoff } from "../protocol/event-guest-checkout"
import {
  normalizePublicMediaUrl,
  normalizePublicWebSocketUrl,
} from "../network-target-safety"
import { resolveEventMarketAuthorization } from "../protocol/event-market-authorization"
import { parseEventMarketCalendarEvent } from "../protocol/event-market"
import { parseEventMarketSeriesEvent } from "../protocol/event-market-schedule"
import { projectSignedProductPreviewEvidence } from "../protocol/product-event-evidence"

/** Conduit product extension; not an Open Markets physical-property tag. */
export const productShippingAdjustmentsSchema = z
  .object({
    weightAllowanceGrams: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    handling: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string(),
        normalizedCurrency: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.handling) return
    try {
      if (
        value.handling.normalizedCurrency !==
        normalizeCurrencyIdentity(value.handling.currency)
      )
        throw new Error("Currency mismatch")
      shippingMoneyToMinorUnits(value.handling.amount, value.handling.currency)
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid product shipping handling amount.",
      })
    }
  })

const publicMediaUrlSchema = z
  .string()
  .refine(
    (value) => normalizePublicMediaUrl(value) !== null,
    "URL must use a public http or https destination"
  )

const protocolHttpUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (value !== value.trim()) return false
    try {
      const url = new URL(value)
      return url.protocol === "http:" || url.protocol === "https:"
    } catch {
      return false
    }
  }, "URL must be an absolute http or https URL")

/**
 * Product schema for validation
 */
export const productZapMessagePolicySchema = z.enum(["generic_only", "custom"])

export type ProductZapMessagePolicy = z.infer<
  typeof productZapMessagePolicySchema
>

export const productSpecificationSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
})

export type ProductSpecificationSchema = z.infer<
  typeof productSpecificationSchema
>

export const productShippingOptionReferenceSchema = z.object({
  coordinate: z.string(),
  dTag: z.string().optional(),
  /** A present Gamma extra-cost field that could not be parsed safely. */
  extraCostMalformed: z.literal(true).optional(),
  extraCost: z
    .object({
      amount: z.number().min(0),
      currency: z.string(),
      normalizedCurrency: z.string(),
    })
    .optional(),
})

export type ProductShippingOptionReference = z.infer<
  typeof productShippingOptionReferenceSchema
>

export const productSupplierAllocationIssueSchema = z.enum([
  "invalid_version",
  "invalid_author",
  "invalid_recipient",
  "invalid_relay_hint",
  "invalid_weight",
  "duplicate_recipient",
  "missing_merchant",
  "duplicate_merchant",
  "missing_supplier",
  "weight_total_overflow",
])

export type ProductSupplierAllocationIssue = z.infer<
  typeof productSupplierAllocationIssueSchema
>

export const productSupplierAllocationRecipientSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  relayHint: z
    .string()
    .min(1)
    .refine(
      (value) => normalizePublicWebSocketUrl(value) === value,
      "Relay hint must be a normalized public WebSocket URL"
    ),
  weight: z.number().int().positive(),
  role: z.enum(["merchant", "supplier"]),
})

export type ProductSupplierAllocationRecipient = z.infer<
  typeof productSupplierAllocationRecipientSchema
>

const productSupplierAllocationRevisionEventSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.number().int().min(0),
    kind: z.literal(30_402),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict()

export const productSupplierAllocationSchema = z
  .object({
    state: z.enum(["absent", "valid", "invalid"]),
    recipients: z.array(productSupplierAllocationRecipientSchema),
    issues: z.array(productSupplierAllocationIssueSchema),
    revisionEventId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    revisionCreatedAt: z.number().int().min(0).optional(),
    revisionEvent: productSupplierAllocationRevisionEventSchema.optional(),
  })
  .superRefine((allocation, context) => {
    if (allocation.state === "absent") {
      if (allocation.recipients.length > 0 || allocation.issues.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Absent allocation evidence cannot include terms or issues",
        })
      }
      return
    }

    if (allocation.state === "valid" && allocation.issues.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid allocation evidence cannot include issues",
      })
    }
    if (allocation.state === "invalid" && allocation.issues.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid allocation evidence must explain why it is invalid",
      })
    }

    if (allocation.state !== "valid") return

    if (
      allocation.revisionEvent &&
      (allocation.revisionEvent.id !== allocation.revisionEventId ||
        allocation.revisionEvent.created_at !== allocation.revisionCreatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allocation revision evidence must match its signed event",
      })
    }

    const pubkeys = allocation.recipients.map((recipient) => recipient.pubkey)
    if (new Set(pubkeys).size !== pubkeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allocation recipients must be unique",
      })
    }
    const merchantCount = allocation.recipients.filter(
      (recipient) => recipient.role === "merchant"
    ).length
    const supplierCount = allocation.recipients.filter(
      (recipient) => recipient.role === "supplier"
    ).length
    if (merchantCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid allocation evidence requires one merchant recipient",
      })
    }
    if (supplierCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Valid allocation evidence requires a supplier recipient",
      })
    }
    const totalWeight = allocation.recipients.reduce(
      (sum, recipient) => sum + recipient.weight,
      0
    )
    if (!Number.isSafeInteger(totalWeight)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allocation weight total must be a safe integer",
      })
    }
  })

export type ProductSupplierAllocation = z.infer<
  typeof productSupplierAllocationSchema
>

export const productSchema = z.object({
  id: z.string(),
  sourceEventId: z.string().optional(),
  signedProductEvent: z
    .custom<SignedPublicNostrEvent>((value) =>
      Boolean(
        value &&
        typeof value === "object" &&
        isValidSignedPublicNostrEvent(value as SignedPublicNostrEvent)
      )
    )
    .optional(),
  pubkey: z.string(),
  title: z.string().min(1).max(200),
  summary: z.string().max(5000).optional(),
  price: z.number().min(0),
  currency: z.string().default("USD"),
  priceSats: z.number().int().min(0).optional(),
  sourcePrice: z
    .object({
      amount: z.number().min(0),
      currency: z.string(),
      normalizedCurrency: z.string(),
    })
    .optional(),
  /** Signed kind-30402 price-tag evidence was missing or malformed. */
  priceEvidenceMalformed: z.literal(true).optional(),
  type: z.enum(["simple", "variable", "variation"]).default("simple"),
  /** Full kind-30402 coordinate of this variation's variable parent. */
  parentProductId: z.string().optional(),
  /** Open Markets `spec` tags preserved in signed-event order. */
  specifications: z.array(productSpecificationSchema).default([]),
  /** Whether the product requires physical shipping. Defaults to "physical". */
  format: z.enum(["physical", "digital"]).default("physical"),
  shippingWeightGrams: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  shippingWeightAllowanceGrams: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  shippingHandling: z
    .object({
      amount: z.number().finite().nonnegative(),
      currency: z.string(),
      normalizedCurrency: z.string(),
    })
    .optional(),
  shippingAdjustmentsMalformed: z.literal(true).optional(),
  shippingDimensionsCm: z
    .object({
      length: z.number().positive().max(Number.MAX_SAFE_INTEGER),
      width: z.number().positive().max(Number.MAX_SAFE_INTEGER),
      height: z.number().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .optional(),
  /** Per-item fixed shipping; table orders retain a group quote separately. */
  shippingCostSats: z.number().int().min(0).optional(),
  sourceShippingCost: z
    .object({
      amount: z.number().min(0),
      currency: z.string(),
      normalizedCurrency: z.string(),
    })
    .optional(),
  /** Addressable kind-30406 shipping option reference attached by the merchant. */
  shippingOptionId: z.string().optional(),
  shippingOptionDTag: z.string().optional(),
  /** True when the product reference uses a launch-unsupported Gamma shape. */
  shippingOptionLaunchUnsupported: z.boolean().optional(),
  /** Every Gamma shipping_option tag, in first-seen order. */
  shippingOptionRefs: z.array(productShippingOptionReferenceSchema).optional(),
  /** Every kind-30405 collection request/reference, in first-seen order. */
  collectionRefs: z.array(z.string()).optional(),
  /** Experimental kind-30409 Event Market associations, in signed order. */
  eventMarketRefs: z.array(z.string()).optional(),
  /** Merchant-signed Conduit opt-in for immediate event handoff only. */
  eventGuestContactOptional: z.boolean().optional(),
  /** Read-side shipping details. Canonical checkout requires explicit resolution. */
  shippingCountries: z.array(z.string()).optional(),
  shippingCountryRules: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        restrictTo: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      })
    )
    .optional(),
  canonicalShippingResolved: z.boolean().optional(),
  shippingOptionCreatedAt: z.number().int().min(0).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  stock: z.number().int().min(0).optional(),
  images: z
    .array(
      z.object({
        // Signed listing evidence is retained here. Request/render consumers
        // apply public-network projection before loading an image.
        url: protocolHttpUrlSchema,
        alt: z.string().optional(),
      })
    )
    .default([]),
  tags: z.array(z.string()).default([]),
  publicZapEnabled: z.boolean().default(true),
  zapMessagePolicy: productZapMessagePolicySchema.default("generic_only"),
  publicZapPolicyKnown: z.boolean().default(false),
  /** Signed NIP-57 zap allocation terms declared by this product revision. */
  supplierAllocation: productSupplierAllocationSchema.optional(),
  location: z.string().optional(),
  geohash: z
    .string()
    .regex(/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/)
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type ProductSchema = z.infer<typeof productSchema>

/**
 * Profile schema
 */
export const profileSchema = z.object({
  pubkey: z.string(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  about: z.string().optional(),
  picture: publicMediaUrlSchema.optional(),
  banner: publicMediaUrlSchema.optional(),
  nip05: z.string().optional(),
  lud16: z.string().optional(),
  website: z.string().url().optional(),
})

export type ProfileSchema = z.infer<typeof profileSchema>

/**
 * Profile form schema — allows empty strings so users can clear fields.
 */
export const profileFormSchema = z.object({
  name: z.string().max(50).optional().or(z.literal("")),
  displayName: z.string().max(100).optional().or(z.literal("")),
  about: z.string().max(500).optional().or(z.literal("")),
  picture: publicMediaUrlSchema.optional().or(z.literal("")),
  banner: publicMediaUrlSchema.optional().or(z.literal("")),
  nip05: z.string().max(100).optional().or(z.literal("")),
  lud16: z.string().max(100).optional().or(z.literal("")),
  website: z.string().url().optional().or(z.literal("")),
})

export type ProfileFormValues = z.infer<typeof profileFormSchema>

/**
 * Shipping address schema
 */
export const shippingAddressSchema = z.object({
  name: z.string().min(1),
  street: z.string().min(1),
  city: z.string().min(1),
  state: z.string().optional(),
  postalCode: z.string().min(1),
  country: z.string().min(2).max(2), // ISO 3166-1 alpha-2
})

export type ShippingAddressSchema = z.infer<typeof shippingAddressSchema>

export const orderBuyerIdentityKindSchema = z.enum([
  "signed_in",
  "guest_ephemeral",
])

export type OrderBuyerIdentityKindSchema = z.infer<
  typeof orderBuyerIdentityKindSchema
>

export const orderGuestContactSchema = z
  .object({
    email: z.string().min(1).max(320).optional(),
    phone: z.string().min(1).max(80).optional(),
  })
  .refine((contact) => Boolean(contact.email || contact.phone), {
    message: "Guest contact requires email or phone.",
  })

export type OrderGuestContactSchema = z.infer<typeof orderGuestContactSchema>

/**
 * Order item schema
 */
const hex64Schema = z.string().regex(/^[0-9a-f]{64}$/i)
const addressableCoordinateSchema = z
  .string()
  .regex(/^\d{5}:[0-9a-f]{64}:[^:].*$/i)
  .refine(
    (coordinate) =>
      !Array.from(coordinate).some((character) => {
        const codePoint = character.codePointAt(0)!
        return codePoint <= 0x1f || codePoint === 0x7f
      }),
    { message: "Addressable coordinate contains unsupported characters." }
  )

export const pickupEvidenceCoordinateSchema = z.object({
  coordinate: addressableCoordinateSchema,
  eventId: hex64Schema,
  createdAt: z.number().int().min(0),
})

const signedEventMarketEvidenceSchema = z
  .object({
    id: hex64Schema,
    pubkey: hex64Schema,
    created_at: z.number().int().min(0),
    kind: z.number().int().min(0),
    tags: z.array(z.array(z.string()).min(1)),
    content: z.string(),
    sig: z.string().regex(/^[0-9a-f]{128}$/i),
  })
  .refine(isValidSignedPublicNostrEvent, "Signed evidence must be valid.")

const signedPickupEvidenceCoordinateSchema =
  pickupEvidenceCoordinateSchema.extend({
    /** Exact signed revision retained with the private order. */
    signedEvent: signedEventMarketEvidenceSchema,
  })

function signedEvidenceMatchesCoordinate(evidence: {
  coordinate: string
  eventId: string
  createdAt: number
  signedEvent: z.infer<typeof signedEventMarketEvidenceSchema>
}): boolean {
  const [kind, author, ...dTagParts] = evidence.coordinate.split(":")
  const dTags = evidence.signedEvent.tags.filter((tag) => tag[0] === "d")
  return (
    evidence.signedEvent.id === evidence.eventId &&
    evidence.signedEvent.created_at * 1_000 === evidence.createdAt &&
    Number(kind) === evidence.signedEvent.kind &&
    author?.toLowerCase() === evidence.signedEvent.pubkey &&
    dTags.length === 1 &&
    dTags[0]?.length === 2 &&
    dTags[0]?.[1] === dTagParts.join(":")
  )
}

/** Future Event Market snapshot freezes roster, occurrence and causal grant evidence. */
export const orderEventMarketPickupFulfillmentSchema = z
  .object({
    type: z.literal("event_market_pickup"),
    organizerPubkey: hex64Schema,
    merchantPubkey: hex64Schema,
    payeePubkey: hex64Schema,
    market: signedPickupEvidenceCoordinateSchema,
    /** Exact organizer-signed merchant grant accepted for this order. */
    grant: z.object({
      kind: z.literal(3841),
      pubkey: hex64Schema,
      eventId: hex64Schema,
      createdAt: z.number().int().min(0),
      /** Causal signed grant and revoke evidence observed at order creation. */
      ancestryEventIds: z.array(hex64Schema).min(1).max(128),
      observedDeletionEventIds: z.array(hex64Schema).max(128),
      signedEvidence: z.object({
        tip: signedEventMarketEvidenceSchema,
        ancestry: z.array(signedEventMarketEvidenceSchema).min(1).max(128),
        deletions: z.array(signedEventMarketEvidenceSchema).max(128),
      }),
    }),
    calendar: signedPickupEvidenceCoordinateSchema.extend({
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }),
    /** Exact 31924 revision that includes the selected occurrence, when present. */
    schedule: signedPickupEvidenceCoordinateSchema.optional(),
    product: signedPickupEvidenceCoordinateSchema,
    mode: z.enum(["merchant_present", "organizer_handoff"]),
    assignment: z.string().min(1).max(120),
  })
  .superRefine((fulfillment, context) => {
    const kind = (coordinate: string) => Number(coordinate.split(":", 1)[0])
    const author = (coordinate: string) =>
      coordinate.split(":", 3)[1]?.toLowerCase()
    const organizer = fulfillment.organizerPubkey.toLowerCase()
    const merchant = fulfillment.merchantPubkey.toLowerCase()
    for (const field of ["market", "calendar", "product"] as const) {
      if (!signedEvidenceMatchesCoordinate(fulfillment[field])) {
        context.addIssue({
          code: "custom",
          path: [field, "signedEvent"],
          message:
            "Signed evidence must match the exact saved revision and coordinate.",
        })
      }
    }
    if (
      fulfillment.schedule &&
      !signedEvidenceMatchesCoordinate(fulfillment.schedule)
    ) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "signedEvent"],
        message: "Signed schedule must match the exact saved revision.",
      })
    }
    const marketEvent = fulfillment.market.signedEvent
    const marketCalendarTags = marketEvent.tags.filter((tag) => tag[0] === "a")
    const marketStateTags = marketEvent.tags.filter(
      (tag) => tag[0] === "event_market"
    )
    const rosterRows = marketEvent.tags.filter((tag) => tag[0] === "merchant")
    const matchingRows = rosterRows.filter((tag) => tag[1] === merchant)
    if (
      marketEvent.content !== "" ||
      marketCalendarTags.length !== 1 ||
      marketCalendarTags[0]?.length !== 2 ||
      marketCalendarTags[0]?.[1] !==
        (fulfillment.schedule?.coordinate ?? fulfillment.calendar.coordinate) ||
      marketStateTags.length !== 1 ||
      marketStateTags[0]?.length !== 3 ||
      marketStateTags[0]?.[1] !== "2" ||
      marketStateTags[0]?.[2] !== "open" ||
      matchingRows.length !== 1 ||
      matchingRows[0]?.length !== 4 ||
      matchingRows[0]?.[2] !== fulfillment.mode ||
      matchingRows[0]?.[3] !== fulfillment.assignment
    ) {
      context.addIssue({
        code: "custom",
        path: ["market", "signedEvent"],
        message:
          "Signed market roster must contain the saved date and merchant terms.",
      })
    }
    if (fulfillment.schedule) {
      const series = parseEventMarketSeriesEvent(
        fulfillment.schedule.signedEvent
      )
      if (
        !series ||
        series.coordinate !== fulfillment.schedule.coordinate ||
        series.organizerPubkey !== organizer ||
        !series.memberCoordinates.includes(fulfillment.calendar.coordinate)
      ) {
        context.addIssue({
          code: "custom",
          path: ["schedule", "signedEvent"],
          message: "Signed schedule must include the selected date.",
        })
      }
    } else if (marketCalendarTags[0]?.[1]?.startsWith("31924:")) {
      context.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "A series order requires its exact signed schedule.",
      })
    }
    const signedCalendar = parseEventMarketCalendarEvent(
      fulfillment.calendar.signedEvent
    )
    if (
      !signedCalendar ||
      signedCalendar.coordinate !== fulfillment.calendar.coordinate ||
      signedCalendar.start !== fulfillment.calendar.start ||
      signedCalendar.end !== fulfillment.calendar.end
    ) {
      context.addIssue({
        code: "custom",
        path: ["calendar", "signedEvent"],
        message: "Signed calendar must contain the saved pickup time.",
      })
    }
    if (
      !fulfillment.product.signedEvent.tags.some(
        (tag) => tag[0] === "a" && tag[1] === fulfillment.market.coordinate
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["product", "signedEvent"],
        message: "Signed product must associate with the saved market.",
      })
    }
    if (
      kind(fulfillment.market.coordinate) !== 30409 ||
      author(fulfillment.market.coordinate) !== organizer
    ) {
      context.addIssue({
        code: "custom",
        path: ["market"],
        message: "Market must be organizer-authored kind 30409.",
      })
    }
    if (fulfillment.grant.pubkey.toLowerCase() !== organizer) {
      context.addIssue({
        code: "custom",
        path: ["grant"],
        message:
          "Merchant admission must be an organizer-signed kind 3841 grant.",
      })
    }
    if (
      !fulfillment.grant.ancestryEventIds.includes(fulfillment.grant.eventId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["grant", "ancestryEventIds"],
        message: "Grant ancestry must include the accepted signed tip.",
      })
    }
    const signed = fulfillment.grant.signedEvidence
    if (
      signed.tip.id !== fulfillment.grant.eventId ||
      signed.tip.created_at * 1_000 !== fulfillment.grant.createdAt ||
      JSON.stringify(signed.ancestry.map((event) => event.id).sort()) !==
        JSON.stringify([...fulfillment.grant.ancestryEventIds].sort()) ||
      JSON.stringify(signed.deletions.map((event) => event.id).sort()) !==
        JSON.stringify([...fulfillment.grant.observedDeletionEventIds].sort())
    ) {
      context.addIssue({
        code: "custom",
        path: ["grant", "signedEvidence"],
        message:
          "The signed authorization bundle must match the exact saved event IDs.",
      })
    } else {
      const resolved = resolveEventMarketAuthorization({
        marketCoordinate: fulfillment.market.coordinate,
        merchantPubkey: fulfillment.merchantPubkey,
        transitions: signed.ancestry,
        deletions: signed.deletions,
      })
      if (
        resolved.state !== "active" ||
        resolved.tip.eventId !== signed.tip.id ||
        signed.tip.pubkey !== fulfillment.organizerPubkey
      ) {
        context.addIssue({
          code: "custom",
          path: ["grant", "signedEvidence"],
          message:
            "The signed authorization bundle must validate to the accepted grant.",
        })
      }
    }
    if (
      new Set([
        fulfillment.market.eventId,
        fulfillment.calendar.eventId,
        fulfillment.product.eventId,
        ...fulfillment.grant.ancestryEventIds,
        ...fulfillment.grant.observedDeletionEventIds,
      ]).size > 64
    ) {
      context.addIssue({
        code: "custom",
        path: ["grant"],
        message:
          "Signed Event Market order evidence exceeds the bounded recovery read.",
      })
    }
    if (
      ![31922, 31923].includes(kind(fulfillment.calendar.coordinate)) ||
      author(fulfillment.calendar.coordinate) !== organizer
    ) {
      context.addIssue({
        code: "custom",
        path: ["calendar"],
        message: "Calendar must be organizer-authored NIP-52.",
      })
    }
    if (
      kind(fulfillment.product.coordinate) !== 30402 ||
      author(fulfillment.product.coordinate) !== merchant
    ) {
      context.addIssue({
        code: "custom",
        path: ["product"],
        message: "Product must be merchant-authored kind 30402.",
      })
    }
    if (fulfillment.payeePubkey.toLowerCase() !== merchant) {
      context.addIssue({
        code: "custom",
        path: ["payeePubkey"],
        message: "The merchant remains the payee.",
      })
    }
    if (fulfillment.calendar.end < fulfillment.calendar.start) {
      context.addIssue({
        code: "custom",
        path: ["calendar", "end"],
        message: "Calendar end must follow start.",
      })
    }
  })

/** Bounded decoding of pre-31927 private order/recovery snapshots only. */
export const eventMarketHandoffModeSchema = z.enum([
  "merchant_handoff",
  "organizer_handoff",
])

export type EventMarketHandoffModeSchema = z.infer<
  typeof eventMarketHandoffModeSchema
>

export const orderPickupFulfillmentSchema = z
  .object({
    type: z.literal("pickup"),
    organizerPubkey: hex64Schema,
    product: pickupEvidenceCoordinateSchema.extend({
      merchantPubkey: hex64Schema,
    }),
    calendar: pickupEvidenceCoordinateSchema,
    collection: pickupEvidenceCoordinateSchema,
    option: pickupEvidenceCoordinateSchema.extend({
      title: z.string().min(1).max(200),
      location: z.string().min(1).max(500).optional(),
      geohash: z
        .string()
        .regex(/^[0-9bcdefghjkmnpqrstuvwxyz]{1,32}$/i)
        .optional(),
    }),
    /** Omitted only by legacy snapshots, which never authorize organizer sharing. */
    handoffMode: eventMarketHandoffModeSchema.optional(),
    handlerPubkey: hex64Schema.optional(),
    costSats: z.number().int().min(0),
    sourceCost: z
      .object({
        amount: z.number().min(0),
        currency: z.string().min(1).max(12),
        normalizedCurrency: z.string().min(1).max(12),
      })
      .required(),
  })
  .superRefine((fulfillment, context) => {
    const coordinateAuthor = (coordinate: string) =>
      coordinate.split(":", 3)[1]?.toLowerCase()
    const coordinateKind = (coordinate: string) =>
      Number(coordinate.split(":", 1)[0])
    const organizer = fulfillment.organizerPubkey.toLowerCase()
    const merchant = fulfillment.product.merchantPubkey.toLowerCase()
    const pickupAuthor = coordinateAuthor(fulfillment.option.coordinate)
    const failures: Array<[boolean, (string | number)[], string]> = [
      [
        coordinateKind(fulfillment.product.coordinate) === 30402 &&
          coordinateAuthor(fulfillment.product.coordinate) === merchant,
        ["product", "coordinate"],
        "Product evidence must preserve the merchant-owned kind-30402 identity.",
      ],
      [
        [31922, 31923].includes(
          coordinateKind(fulfillment.calendar.coordinate)
        ) && coordinateAuthor(fulfillment.calendar.coordinate) === organizer,
        ["calendar", "coordinate"],
        "Calendar evidence must preserve the organizer identity.",
      ],
      [
        coordinateKind(fulfillment.collection.coordinate) === 30405 &&
          coordinateAuthor(fulfillment.collection.coordinate) === organizer,
        ["collection", "coordinate"],
        "Collection evidence must preserve the organizer identity.",
      ],
      [
        coordinateKind(fulfillment.option.coordinate) === 30406 &&
          (pickupAuthor === organizer || pickupAuthor === merchant),
        ["option", "coordinate"],
        "Pickup evidence must preserve either the organizer or merchant handoff identity.",
      ],
      [
        Boolean(fulfillment.option.location || fulfillment.option.geohash),
        ["option"],
        "Pickup evidence requires a public location or geohash.",
      ],
    ]
    for (const [valid, path, message] of failures) {
      if (!valid) context.addIssue({ code: "custom", path, message })
    }
    const hasExplicitMode = fulfillment.handoffMode !== undefined
    const hasExplicitHandler = fulfillment.handlerPubkey !== undefined
    if (hasExplicitMode !== hasExplicitHandler) {
      context.addIssue({
        code: "custom",
        path: [hasExplicitMode ? "handlerPubkey" : "handoffMode"],
        message:
          "Pickup handoff mode and handler must be snapshotted together.",
      })
      return
    }
    if (!hasExplicitMode || !hasExplicitHandler) return
    const expectedMode =
      pickupAuthor === merchant ? "merchant_handoff" : "organizer_handoff"
    const expectedHandler = pickupAuthor === organizer ? organizer : merchant
    // Older own-product snapshots used organizer_handoff. Keep them readable;
    // new same-account pickups resolve as merchant handoff, with no third party.
    const historicalOwnOrganizerMode =
      pickupAuthor === merchant &&
      merchant === organizer &&
      fulfillment.handoffMode === "organizer_handoff"
    if (
      fulfillment.handoffMode !== expectedMode &&
      !historicalOwnOrganizerMode
    ) {
      context.addIssue({
        code: "custom",
        path: ["handoffMode"],
        message: "Pickup handoff mode must match the exact pickup author.",
      })
    }
    if (fulfillment.handlerPubkey!.toLowerCase() !== expectedHandler) {
      context.addIssue({
        code: "custom",
        path: ["handlerPubkey"],
        message: "Pickup handler must match the exact pickup author.",
      })
    }
  })

export type OrderPickupFulfillmentSchema = z.infer<
  typeof orderPickupFulfillmentSchema
>

export const orderItemFulfillmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("digital") }),
  z.object({ type: z.literal("shipping") }),
  orderEventMarketPickupFulfillmentSchema,
  orderPickupFulfillmentSchema,
])

export type PickupEvidenceCoordinateSchema = z.infer<
  typeof pickupEvidenceCoordinateSchema
>
export type OrderEventMarketPickupFulfillmentSchema = z.infer<
  typeof orderEventMarketPickupFulfillmentSchema
>
export type OrderItemFulfillmentSchema = z.infer<
  typeof orderItemFulfillmentSchema
>

export const orderItemSchema = z
  .object({
    productId: z.string(),
    familyProductId: z.string().optional(),
    selectedSpecifications: z
      .array(
        z.object({
          key: z.string().min(1).max(80),
          value: z.string().min(1).max(200),
        })
      )
      .optional(),
    title: z.string().max(200).optional(),
    /** Durable fulfillment snapshot; legacy orders remain physical-safe. */
    format: z.enum(["physical", "digital"]).default("physical"),
    fulfillment: orderItemFulfillmentSchema.optional(),
    quantity: z.number().int().min(1),
    priceAtPurchase: z.number().min(0),
    currency: z.string(),
    shippingPolicyQuote: z.lazy(() => shippingPolicyQuoteSchema).optional(),
    shippingAllocatedCostSats: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    shippingCostSats: z.number().int().min(0).optional(),
    sourceShippingCost: z
      .object({
        amount: z.number().min(0),
        currency: z.string(),
        normalizedCurrency: z.string(),
      })
      .optional(),
    shippingOptionId: z.string().optional(),
    shippingOptionDTag: z.string().optional(),
    shippingCountries: z.array(z.string()).optional(),
    shippingCountryRules: z
      .array(
        z.object({
          code: z.string(),
          name: z.string(),
          restrictTo: z.array(z.string()).default([]),
          exclude: z.array(z.string()).default([]),
        })
      )
      .optional(),
    sourcePrice: z
      .object({
        amount: z.number().min(0),
        currency: z.string(),
        normalizedCurrency: z.string(),
      })
      .optional(),
  })
  .superRefine((item, context) => {
    if (item.shippingPolicyQuote) {
      const quote = item.shippingPolicyQuote
      const quotedItem = quote.items.find(
        (line) => line.productId === item.productId
      )
      if (
        item.format === "digital" ||
        item.fulfillment?.type === "event_market_pickup" ||
        !quotedItem ||
        quotedItem.quantity !== item.quantity ||
        quote.policyCoordinate !== item.shippingOptionId ||
        normalizeCurrencyIdentity(
          item.sourcePrice?.normalizedCurrency ??
            item.sourcePrice?.currency ??
            item.currency
        ) !== quotedItem?.currency ||
        item.shippingAllocatedCostSats === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["shippingPolicyQuote"],
          message: "Shipping quote must match this shipped order item.",
        })
      }
    } else if (item.shippingAllocatedCostSats !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["shippingAllocatedCostSats"],
        message: "Allocated shipping requires a policy quote.",
      })
    }
    if (!item.fulfillment) return
    if ((item.fulfillment.type === "digital") !== (item.format === "digital")) {
      context.addIssue({
        code: "custom",
        path: ["fulfillment", "type"],
        message: "Fulfillment type must match the signed product format.",
      })
    }
    if (item.fulfillment.type === "event_market_pickup") {
      if (item.fulfillment.product.coordinate !== item.productId) {
        context.addIssue({
          code: "custom",
          path: ["fulfillment", "product", "coordinate"],
          message:
            "Event Market product evidence must match the ordered product.",
        })
      }
      const signedTerms = projectSignedProductPreviewEvidence(
        item.fulfillment.product.signedEvent
      )
      if (
        !signedTerms ||
        signedTerms.priceStatus !== "resolved" ||
        signedTerms.format !== "physical" ||
        item.currency !== "SATS" ||
        !Number.isSafeInteger(item.priceAtPurchase) ||
        ((signedTerms.sourcePrice?.amount ?? 0) > 0 &&
          item.priceAtPurchase === 0) ||
        (item.title !== undefined && item.title !== signedTerms.title) ||
        !item.sourcePrice ||
        item.sourcePrice.amount !== signedTerms.sourcePrice?.amount ||
        item.sourcePrice.currency !== signedTerms.sourcePrice.currency ||
        item.sourcePrice.normalizedCurrency !==
          signedTerms.sourcePrice.normalizedCurrency ||
        (signedTerms.currency === "SATS" &&
          (item.currency !== "SATS" ||
            item.priceAtPurchase !== signedTerms.price))
      ) {
        context.addIssue({
          code: "custom",
          path: ["fulfillment", "product"],
          message: "Order terms must match the signed product revision.",
        })
      }
      if (
        item.shippingOptionId ||
        item.shippingOptionDTag ||
        (item.shippingCostSats ?? 0) !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["shippingOptionId"],
          message:
            "Event Market pickup has no separate buyer fee or pickup option.",
        })
      }
      return
    }
  })

export type OrderItemSchema = z.infer<typeof orderItemSchema>

/**
 * Conduit MVP order payload (sent as JSON in a NIP-17 wrapped kind-16 rumor).
 *
 * Note: This is an internal schema for our MVP flow; interop parsing should be best-effort.
 */
export const orderSchema = z
  .object({
    checkoutSparkPricing: checkoutSparkCommercePricingSchema.optional(),
    id: z.string(),
    merchantPubkey: z.string(),
    buyerPubkey: z.string(),
    buyerIdentityKind: orderBuyerIdentityKindSchema.optional(),
    items: z.array(orderItemSchema).min(1),
    subtotal: z.number().min(0),
    currency: z.string(),
    shippingCostSats: z.number().int().min(0).optional(),
    shippingCostStatus: z
      .enum(["not_required", "included", "priced", "manual"])
      .optional(),
    shippingAddress: shippingAddressSchema.optional(),
    guestContact: orderGuestContactSchema.optional(),
    contactFreePickup: z
      .strictObject({
        label: z.string().trim().min(1).max(80),
        receiptCommitment: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .optional(),
    note: z.string().max(2000).optional(),
    createdAt: z.number(),
  })
  .superRefine((order, context) => {
    const policyGroups = new Map<string, typeof order.items>()
    for (const item of order.items) {
      if (!item.shippingPolicyQuote) continue
      const key = item.shippingPolicyQuote.policyCoordinate
      const group = policyGroups.get(key) ?? []
      group.push(item)
      policyGroups.set(key, group)
    }
    const merchantTableCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${order.merchantPubkey.toLowerCase()}:${MERCHANT_SHIPPING_POLICY_D_TAG}`
    const pricedShipping =
      order.shippingCostStatus !== "manual" &&
      (order.shippingCostSats !== undefined ||
        order.shippingCostStatus === "priced" ||
        order.shippingCostStatus === "included")
    for (const [index, item] of order.items.entries()) {
      if (
        item.shippingPolicyQuote ||
        item.format !== "physical" ||
        (item.fulfillment && item.fulfillment.type !== "shipping")
      )
        continue
      const group = policyGroups.get(item.shippingOptionId ?? "")
      if (group) group.push(item)
      else if (
        pricedShipping &&
        item.shippingOptionId === merchantTableCoordinate
      )
        context.addIssue({
          code: "custom",
          path: ["items", index, "shippingPolicyQuote"],
          message:
            "Priced table shipping requires a quote for every shipped item.",
        })
    }
    for (const group of policyGroups.values()) {
      const quote = group[0]!.shippingPolicyQuote!
      const country = order.shippingAddress?.country.trim().toUpperCase()
      const subdivision = normalizeShippingPolicySubdivision(
        country ?? "",
        order.shippingAddress?.state
      )
      const postalCode = order.shippingAddress?.postalCode
        ? normalizeShippingPolicyRegion(order.shippingAddress.postalCode)
        : undefined
      let invalid =
        quote.merchantPubkey !== order.merchantPubkey.toLowerCase() ||
        quote.destination.country !== country ||
        quote.destination.subdivision !== subdivision ||
        quote.destination.postalCode !== postalCode ||
        group.length !== quote.items.length ||
        group.some(
          (item) =>
            !item.shippingPolicyQuote ||
            !hasSameShippingPolicyQuote(item.shippingPolicyQuote, quote) ||
            item.shippingAllocatedCostSats === undefined
        )
      for (const quoted of quote.items) {
        const line = group.find((item) => item.productId === quoted.productId)
        if (!line || line.quantity !== quoted.quantity) {
          invalid = true
          continue
        }
        try {
          const unitMinor = shippingMoneyToMinorUnits(
            line.sourcePrice?.amount ?? line.priceAtPurchase,
            line.sourcePrice?.currency ?? line.currency
          )
          if (unitMinor * line.quantity !== quoted.subtotalMinor) invalid = true
        } catch {
          invalid = true
        }
      }
      const groupAllocation = group.reduce(
        (sum, item) => sum + (item.shippingAllocatedCostSats ?? 0),
        0
      )
      let expectedAllocation = quote.amountSats
      if (expectedAllocation === undefined) {
        try {
          // Historical native Bitcoin amounts are exact; legacy fiat quotes
          // remain readable but cannot establish an automatic settlement amount.
          expectedAllocation = convertShippingMinor(
            quote.amountMinor,
            quote.currency,
            "SATS"
          )
        } catch {
          invalid = true
        }
      }
      if (
        !Number.isSafeInteger(groupAllocation) ||
        groupAllocation !== expectedAllocation
      )
        invalid = true
      if (invalid)
        context.addIssue({
          code: "custom",
          path: ["items"],
          message:
            "Shipping quote group or destination does not match the order.",
        })
    }
    if (policyGroups.size > 0) {
      const allocated = order.items.reduce(
        (sum, item) =>
          sum +
          (item.shippingAllocatedCostSats ??
            (item.shippingCostSats ?? 0) * item.quantity),
        0
      )
      if (
        !Number.isSafeInteger(allocated) ||
        allocated !== order.shippingCostSats
      )
        context.addIssue({
          code: "custom",
          path: ["shippingCostSats"],
          message: "Shipping allocations must match the order shipping total.",
        })
    }
    const firstFuture = order.items.find(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )?.fulfillment
    const hasPickup = firstFuture?.type === "event_market_pickup"
    const pickupOnly = order.items.every(
      (item) => item.fulfillment?.type === "event_market_pickup"
    )
    const hasShipping = order.items.some(
      (item) =>
        item.fulfillment?.type === "shipping" ||
        (!item.fulfillment && item.format !== "digital")
    )
    for (const [index, item] of order.items.entries()) {
      if (item.fulfillment?.type === "event_market_pickup") {
        const fulfillment = item.fulfillment
        if (
          fulfillment.merchantPubkey.toLowerCase() !==
            order.merchantPubkey.toLowerCase() ||
          fulfillment.payeePubkey.toLowerCase() !==
            order.merchantPubkey.toLowerCase() ||
          firstFuture?.type !== "event_market_pickup" ||
          fulfillment.market.coordinate !== firstFuture.market.coordinate ||
          fulfillment.market.eventId !== firstFuture.market.eventId ||
          fulfillment.calendar.eventId !== firstFuture.calendar.eventId ||
          fulfillment.schedule?.eventId !== firstFuture.schedule?.eventId ||
          fulfillment.grant.eventId !== firstFuture.grant.eventId ||
          fulfillment.mode !== firstFuture.mode ||
          fulfillment.assignment !== firstFuture.assignment
        ) {
          context.addIssue({
            code: "custom",
            path: ["items", index, "fulfillment"],
            message:
              "Future Event Market items require one exact merchant admission and assignment.",
          })
        }
      }
    }
    if (firstFuture?.type === "event_market_pickup") {
      const subtotal = order.items.reduce(
        (total, item) => total + item.priceAtPurchase * item.quantity,
        0
      )
      if (
        order.currency !== "SATS" ||
        !Number.isSafeInteger(subtotal) ||
        order.subtotal !== subtotal
      ) {
        context.addIssue({
          code: "custom",
          path: ["subtotal"],
          message:
            "Event Market subtotal must equal the exact satoshi line totals.",
        })
      }
      const eventIds = new Set([
        firstFuture.market.eventId,
        firstFuture.calendar.eventId,
        ...(firstFuture.schedule ? [firstFuture.schedule.eventId] : []),
        ...firstFuture.grant.ancestryEventIds,
        ...firstFuture.grant.observedDeletionEventIds,
        ...order.items.flatMap((item) =>
          item.fulfillment?.type === "event_market_pickup"
            ? [item.fulfillment.product.eventId]
            : []
        ),
      ])
      if (eventIds.size > 64) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message:
            "Signed Event Market order evidence exceeds the bounded recovery read.",
        })
      }
    }
    if (
      firstFuture?.type === "event_market_pickup" &&
      ((order.shippingCostSats ?? 0) !== 0 ||
        (order.shippingCostStatus !== undefined &&
          order.shippingCostStatus !== "not_required" &&
          order.shippingCostStatus !== "included"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["shippingCostSats"],
        message: "Event Market pickup has no separate order shipping charge.",
      })
    }
    if (hasPickup && hasShipping) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Pickup and shipped items require separate orders.",
      })
    }
    if (hasPickup && order.shippingAddress) {
      context.addIssue({
        code: "custom",
        path: ["shippingAddress"],
        message: "Pickup orders must not include a delivery address.",
      })
    }
    if (
      order.contactFreePickup &&
      (order.buyerIdentityKind !== "guest_ephemeral" ||
        !isContactFreeEventHandoff(order.items, order.createdAt))
    ) {
      context.addIssue({
        code: "custom",
        path: ["contactFreePickup"],
        message:
          "Contact-free checkout requires every merchant-signed opt-in and immediate merchant-present event handoff.",
      })
    }
    if (
      order.buyerIdentityKind === "guest_ephemeral" &&
      !order.guestContact &&
      !order.contactFreePickup
    ) {
      context.addIssue({
        code: "custom",
        path: ["guestContact"],
        message: "Guest orders require a recovery contact.",
      })
    }
    if (
      order.buyerIdentityKind === "guest_ephemeral" &&
      !pickupOnly &&
      order.guestContact &&
      (!order.guestContact.email || !order.guestContact.phone)
    ) {
      context.addIssue({
        code: "custom",
        path: ["guestContact"],
        message: "Guest orders require both email and phone.",
      })
    }
    if (order.guestContact && order.buyerIdentityKind !== "guest_ephemeral") {
      context.addIssue({
        code: "custom",
        path: ["guestContact"],
        message:
          "Guest contact metadata requires an explicit ephemeral guest identity.",
      })
    }
  })

export type OrderSchema = z.infer<typeof orderSchema>

export const eventMarketClaimRefSchema = z.string().regex(/^[0-9a-f]{64}$/)

const futureMarketReceiptProductSchema = pickupEvidenceCoordinateSchema
  .extend({
    /** New receipts carry the exact public listing; older v2 receipts may omit it. */
    signedEvent: signedEventMarketEvidenceSchema.strict().optional(),
  })
  .superRefine((product, context) => {
    if (
      product.signedEvent &&
      !signedEvidenceMatchesCoordinate({
        ...product,
        signedEvent: product.signedEvent,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["signedEvent"],
        message:
          "Receipt product evidence must match the exact signed revision.",
      })
    }
  })

const futureMarketReceiptItemSchema = z
  .object({
    product: futureMarketReceiptProductSchema,
    quantity: z.number().int().min(1).max(10_000),
    selectedSpecifications: z
      .array(
        z.object({
          key: z.string().min(1).max(80),
          value: z.string().min(1).max(200),
        })
      )
      .max(32)
      .optional(),
  })
  .strict()

function eventMarketCoordinateAuthority(
  coordinate: string
): { kind: number; authorPubkey: string } | null {
  const first = coordinate.indexOf(":")
  const second = coordinate.indexOf(":", first + 1)
  if (first < 1 || second <= first + 1) return null
  const kind = Number(coordinate.slice(0, first))
  const authorPubkey = coordinate.slice(first + 1, second).toLowerCase()
  return Number.isSafeInteger(kind) && /^[0-9a-f]{64}$/.test(authorPubkey)
    ? { kind, authorPubkey }
    : null
}

/** Order-specific physical release; no buyer identity, payment, or full order. */
const futureMarketPrivateGraphSchema = z.object({
  claimRef: eventMarketClaimRefSchema,
  merchantPubkey: hex64Schema,
  organizerPubkey: hex64Schema,
  market: pickupEvidenceCoordinateSchema,
  calendar: pickupEvidenceCoordinateSchema,
  grant: z.object({
    eventId: hex64Schema,
    createdAt: z.number().int().min(0),
  }),
})

function refineFutureMarketPrivateGraph(
  graph: z.infer<typeof futureMarketPrivateGraphSchema>,
  context: z.RefinementCtx
): void {
  const market = eventMarketCoordinateAuthority(graph.market.coordinate)
  const calendar = eventMarketCoordinateAuthority(graph.calendar.coordinate)
  if (
    !market ||
    market.kind !== 30409 ||
    market.authorPubkey !== graph.organizerPubkey.toLowerCase() ||
    !calendar ||
    ![31922, 31923].includes(calendar.kind) ||
    calendar.authorPubkey !== graph.organizerPubkey.toLowerCase() ||
    graph.merchantPubkey.toLowerCase() === graph.organizerPubkey.toLowerCase()
  ) {
    context.addIssue({
      code: "custom",
      path: ["market"],
      message: "Future organizer release graph authority is invalid.",
    })
  }
}

export const futureMarketReadyReceiptSchema = futureMarketPrivateGraphSchema
  .extend({
    version: z.literal(2),
    type: z.literal("future_market_ready"),
    releaseAuthorized: z.literal(true),
    /** Original public approval only; no buyer, payment or full-order fields. */
    authorityEvidence: z
      .array(signedEventMarketEvidenceSchema.strict())
      .min(3)
      .max(64)
      .optional(),
    items: z.array(futureMarketReceiptItemSchema).min(1).max(64),
    issuedAt: z.number().int().min(0),
  })
  .strict()
  .superRefine((receipt, context) => {
    refineFutureMarketPrivateGraph(receipt, context)
    const products = new Set<string>()
    for (const [index, item] of receipt.items.entries()) {
      const product = eventMarketCoordinateAuthority(item.product.coordinate)
      if (
        !product ||
        product.kind !== 30402 ||
        product.authorPubkey !== receipt.merchantPubkey.toLowerCase() ||
        products.has(item.product.coordinate)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Ready receipt product authority is invalid.",
        })
      }
      products.add(item.product.coordinate)
    }
  })

export const futureMarketRevocationSchema = futureMarketPrivateGraphSchema
  .extend({
    version: z.literal(2),
    type: z.literal("future_market_revoked"),
    readyReceiptId: hex64Schema,
    issuedAt: z.number().int().min(0),
  })
  .strict()
  .superRefine(refineFutureMarketPrivateGraph)

export const futureMarketHandoffAckSchema = futureMarketPrivateGraphSchema
  .extend({
    version: z.literal(2),
    type: z.literal("future_market_handed_out"),
    readyReceiptId: hex64Schema,
    handedOutAt: z.number().int().min(0),
  })
  .strict()
  .superRefine(refineFutureMarketPrivateGraph)

export type FutureMarketReadyReceiptSchema = z.infer<
  typeof futureMarketReadyReceiptSchema
>
export type FutureMarketRevocationSchema = z.infer<
  typeof futureMarketRevocationSchema
>
export type FutureMarketHandoffAckSchema = z.infer<
  typeof futureMarketHandoffAckSchema
>

/**
 * Kind-16 message types used in MVP order conversations.
 */
export const orderMessageTypeSchema = z.enum([
  "order",
  "payment_request",
  "status_update",
  "shipping_update",
  "receipt",
  "message",
  "payment_proof",
  "future_market_ready",
  "future_market_revoked",
  "future_market_handed_out",
])

export type OrderMessageTypeSchema = z.infer<typeof orderMessageTypeSchema>

/**
 * MVP order status updates sent over NIP-17.
 */
/** Canonical status values for Conduit emitters and presentation. */
export const KNOWN_ORDER_STATUSES = [
  "pending",
  "invoiced",
  "paid",
  "accepted",
  "processing",
  "shipped",
  "complete",
  "delivered",
  "cancelled",
  "refund_requested",
] as const

export const orderStatusEnum = z.enum(KNOWN_ORDER_STATUSES)

export type KnownOrderStatus = z.infer<typeof orderStatusEnum>

const knownOrderStatusSet: ReadonlySet<string> = new Set(KNOWN_ORDER_STATUSES)

export function isKnownOrderStatus(value: string): value is KnownOrderStatus {
  return knownOrderStatusSet.has(value)
}

/** Accepts known statuses and any unknown string for forward-compatibility. */
export const orderStatusSchema = z.union([orderStatusEnum, z.string().min(1)])

export type OrderStatusSchema = z.infer<typeof orderStatusSchema>

export const paymentRequestMessageSchema = z.object({
  invoice: z.string().min(1),
  amount: z.number().min(0).optional(),
  currency: z.string().min(1).optional(),
  note: z.string().max(2000).optional(),
})

export type PaymentRequestMessageSchema = z.infer<
  typeof paymentRequestMessageSchema
>

export const statusUpdateMessageSchema = z.object({
  status: orderStatusSchema,
  note: z.string().max(2000).optional(),
  /** Event id of the merchant cancellation this correction reopens. */
  reopens: hex64Schema.optional(),
})

export type StatusUpdateMessageSchema = z.infer<
  typeof statusUpdateMessageSchema
>

export const shippingUpdateMessageSchema = z.object({
  carrier: z.string().min(1).optional(),
  trackingNumber: z.string().min(1).optional(),
  trackingUrl: z.string().url().optional(),
  note: z.string().max(2000).optional(),
})

export type ShippingUpdateMessageSchema = z.infer<
  typeof shippingUpdateMessageSchema
>

export const receiptMessageSchema = z.object({
  note: z.string().max(2000).optional(),
})

export type ReceiptMessageSchema = z.infer<typeof receiptMessageSchema>

export const conversationMessageSchema = z.object({
  note: z.string().min(1).max(2000),
})

export type ConversationMessageSchema = z.infer<
  typeof conversationMessageSchema
>

export const paymentProofActionSchema = z.enum([
  "zap",
  "private_checkout",
  "invoice",
  "external_invoice",
])

export const paymentProofDeliveryStatusSchema = z.enum([
  "pending",
  "sent",
  "retry_needed",
])

export const paymentProofSourceSchema = z.enum([
  "wallet",
  "nwc",
  "webln",
  "external",
  "buyer",
])

export const paymentProofVerificationStateSchema = z.enum([
  "buyer_evidence_received",
  "verified",
  "needs_merchant_verification",
  "verification_failed",
  "disputed",
])

export const paymentProofVerificationSchema = z
  .object({
    state: z
      .union([paymentProofVerificationStateSchema, z.string().min(1)])
      .default("buyer_evidence_received"),
    checkedAt: z.number().optional(),
    checks: z.array(z.string()).default([]),
  })
  .passthrough()

/**
 * Payment proof message -- sent by the buyer after a successful Lightning payment.
 *
 * This parser schema is deliberately tolerant so older or foreign proof
 * messages can render as degraded evidence instead of crashing order views.
 * Conduit-emitted v1 proofs should be created through the strict shared builder.
 */
export const paymentProofMessageSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    orderId: z.string().optional(),
    rail: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    amount: z.number().min(0).optional(),
    amountMsats: z.number().int().min(0).optional(),
    currency: z.string().min(1).optional(),
    /** BOLT11 invoice that was paid, when available. */
    invoice: z.string().min(1).optional(),
    /** Payment preimage returned by the wallet, when available. */
    preimage: z.string().min(1).optional(),
    /** Payment hash, if returned by the wallet. */
    paymentHash: z.string().min(1).optional(),
    /** Fees paid in msats, if returned by the wallet. */
    feeMsats: z.number().optional(),
    zapRequestId: z.string().min(1).optional(),
    zapReceiptId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    proofDeliveryStatus: z.string().min(1).optional(),
    verification: paymentProofVerificationSchema.optional(),
    /** Human-readable note. */
    note: z.string().max(2000).optional(),
  })
  .passthrough()

export type PaymentProofMessageSchema = z.infer<
  typeof paymentProofMessageSchema
>

export type PaymentProofActionSchema = z.infer<typeof paymentProofActionSchema>

export type PaymentProofDeliveryStatusSchema = z.infer<
  typeof paymentProofDeliveryStatusSchema
>

export type PaymentProofSourceSchema = z.infer<typeof paymentProofSourceSchema>

export type PaymentProofVerificationStateSchema = z.infer<
  typeof paymentProofVerificationStateSchema
>
