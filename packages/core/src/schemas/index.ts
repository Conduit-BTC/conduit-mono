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
  type: z.enum(["simple", "variable"]).default("simple"),
  visibility: z.enum(["public", "private"]).default("public"),
  stock: z.number().int().min(0).optional(),
  images: z.array(
    z.object({
      url: z.string().url(),
      alt: z.string().optional(),
    })
  ).default([]),
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
  note: z.string().max(2000).optional(),
  createdAt: z.number(),
})

export type OrderSchema = z.infer<typeof orderSchema>
