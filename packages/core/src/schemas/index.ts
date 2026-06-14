import { z } from "zod"

/**
 * Product schema for validation
 */
export const productSchema = z.object({
  id: z.string(),
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
  type: z.enum(["simple", "variable"]).default("simple"),
  /** Whether the product requires physical shipping. Defaults to "physical". */
  format: z.enum(["physical", "digital"]).default("physical"),
  /** Per-item shipping cost in sats. Omitted means shipping is coordinated manually. */
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
  /** Product-level snapshot of the referenced shipping option for checkout. */
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
  visibility: z.enum(["public", "private"]).default("public"),
  stock: z.number().int().min(0).optional(),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        alt: z.string().optional(),
      })
    )
    .default([]),
  tags: z.array(z.string()).default([]),
  location: z.string().optional(),
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
  picture: z.string().url().optional(),
  banner: z.string().url().optional(),
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
  picture: z.string().url().optional().or(z.literal("")),
  banner: z.string().url().optional().or(z.literal("")),
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

/**
 * Order item schema
 */
export const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1),
  priceAtPurchase: z.number().min(0),
  currency: z.string(),
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

export type OrderItemSchema = z.infer<typeof orderItemSchema>

/**
 * Conduit MVP order payload (sent as JSON in a NIP-17 wrapped kind-16 rumor).
 *
 * Note: This is an internal schema for our MVP flow; interop parsing should be best-effort.
 */
export const orderSchema = z.object({
  id: z.string(),
  merchantPubkey: z.string(),
  buyerPubkey: z.string(),
  items: z.array(orderItemSchema).min(1),
  subtotal: z.number().min(0),
  currency: z.string(),
  shippingCostSats: z.number().int().min(0).optional(),
  shippingCostStatus: z
    .enum(["not_required", "included", "priced", "manual"])
    .optional(),
  shippingAddress: shippingAddressSchema.optional(),
  note: z.string().max(2000).optional(),
  createdAt: z.number(),
})

export type OrderSchema = z.infer<typeof orderSchema>

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
])

export type OrderMessageTypeSchema = z.infer<typeof orderMessageTypeSchema>

/**
 * MVP order status updates sent over NIP-17.
 */
/** Known status values for our emitters. */
export const orderStatusEnum = z.enum([
  "pending",
  "invoiced",
  "paid",
  "processing",
  "shipped",
  "complete",
  "cancelled",
])

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
