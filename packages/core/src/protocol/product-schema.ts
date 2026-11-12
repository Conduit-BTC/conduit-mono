import { z } from "zod"
import { normalizeCurrencyIdentity } from "../pricing"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import {
  isVerifiedNostrEvent,
  type VerifiedNostrEvent,
} from "./verified-public-event"
import { shippingMoneyToMinorUnits } from "./shipping-policy-model"

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
    .custom<VerifiedNostrEvent>(isVerifiedNostrEvent)
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
