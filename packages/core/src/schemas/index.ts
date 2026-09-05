import { z } from "zod"
import { normalizePublicMediaUrl } from "../network-target-safety"

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
  /** Signed kind-30402 price-tag evidence was missing or malformed. */
  priceEvidenceMalformed: z.literal(true).optional(),
  type: z.enum(["simple", "variable", "variation"]).default("simple"),
  /** Full kind-30402 coordinate of this variation's variable parent. */
  parentProductId: z.string().optional(),
  /** Open Markets `spec` tags preserved in signed-event order. */
  specifications: z.array(productSpecificationSchema).default([]),
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
  /** True when the product reference uses a launch-unsupported Gamma shape. */
  shippingOptionLaunchUnsupported: z.boolean().optional(),
  /** Every Gamma shipping_option tag, in first-seen order. */
  shippingOptionRefs: z.array(productShippingOptionReferenceSchema).optional(),
  /** Every kind-30405 collection request/reference, in first-seen order. */
  collectionRefs: z.array(z.string()).optional(),
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

export const orderItemFulfillmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("digital") }),
  z.object({ type: z.literal("shipping") }),
  orderPickupFulfillmentSchema,
])

export type PickupEvidenceCoordinateSchema = z.infer<
  typeof pickupEvidenceCoordinateSchema
>
export type OrderPickupFulfillmentSchema = z.infer<
  typeof orderPickupFulfillmentSchema
>
export type OrderItemFulfillmentSchema = z.infer<
  typeof orderItemFulfillmentSchema
>

export interface OrderPickupHandoffAuthority {
  mode: EventMarketHandoffModeSchema
  handlerPubkey: string
  /** True means no organizer receipt or handoff authority was granted. */
  legacySafeDefault: boolean
}

/**
 * Resolve snapshot authority without upgrading legacy organizer-authored pickup
 * evidence into receipt sharing. Legacy omission always remains merchant-only.
 */
export function resolveOrderPickupHandoffAuthority(
  fulfillment: Pick<
    OrderPickupFulfillmentSchema,
    "handoffMode" | "handlerPubkey" | "product"
  >
): OrderPickupHandoffAuthority {
  if (fulfillment.handoffMode && fulfillment.handlerPubkey) {
    return {
      mode: fulfillment.handoffMode,
      handlerPubkey: fulfillment.handlerPubkey.toLowerCase(),
      legacySafeDefault: false,
    }
  }
  return {
    mode: "merchant_handoff",
    handlerPubkey: fulfillment.product.merchantPubkey.toLowerCase(),
    legacySafeDefault: true,
  }
}

function canonicalPickupCoordinateIdentity(coordinate: string): string | null {
  if (typeof coordinate !== "string") return null
  const firstSeparator = coordinate.indexOf(":")
  const secondSeparator = coordinate.indexOf(":", firstSeparator + 1)
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return null

  const kind = coordinate.slice(0, firstSeparator)
  const author = coordinate.slice(firstSeparator + 1, secondSeparator)
  const identifier = coordinate.slice(secondSeparator + 1)
  if (!kind || !author || !identifier) return null
  return `${kind}:${author.toLowerCase()}:${identifier}`
}

function hasSamePickupEvidenceRevision(
  left: PickupEvidenceCoordinateSchema,
  right: PickupEvidenceCoordinateSchema
): boolean {
  if (
    !left ||
    !right ||
    typeof left.eventId !== "string" ||
    typeof right.eventId !== "string" ||
    typeof left.createdAt !== "number" ||
    typeof right.createdAt !== "number"
  ) {
    return false
  }
  const leftCoordinate = canonicalPickupCoordinateIdentity(left.coordinate)
  const rightCoordinate = canonicalPickupCoordinateIdentity(right.coordinate)
  return (
    leftCoordinate !== null &&
    leftCoordinate === rightCoordinate &&
    left.eventId.toLowerCase() === right.eventId.toLowerCase() &&
    left.createdAt === right.createdAt
  )
}

/**
 * Pickup items may have different merchant-owned products and per-product
 * costs, but one order must preserve one exact organizer-authored event graph.
 */
export function hasSamePickupFulfillmentGraph(
  left: OrderPickupFulfillmentSchema,
  right: OrderPickupFulfillmentSchema
): boolean {
  if (
    !left ||
    !right ||
    typeof left.organizerPubkey !== "string" ||
    typeof right.organizerPubkey !== "string" ||
    !left.calendar ||
    !right.calendar ||
    !left.collection ||
    !right.collection ||
    !left.option ||
    !right.option
  ) {
    return false
  }
  return (
    left.organizerPubkey.toLowerCase() ===
      right.organizerPubkey.toLowerCase() &&
    hasSamePickupEvidenceRevision(left.calendar, right.calendar) &&
    hasSamePickupEvidenceRevision(left.collection, right.collection) &&
    hasSamePickupEvidenceRevision(left.option, right.option) &&
    resolveOrderPickupHandoffAuthority(left).mode ===
      resolveOrderPickupHandoffAuthority(right).mode &&
    resolveOrderPickupHandoffAuthority(left).handlerPubkey ===
      resolveOrderPickupHandoffAuthority(right).handlerPubkey
  )
}

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
    if (!item.fulfillment) return
    if ((item.fulfillment.type === "digital") !== (item.format === "digital")) {
      context.addIssue({
        code: "custom",
        path: ["fulfillment", "type"],
        message: "Fulfillment type must match the signed product format.",
      })
    }
    if (item.fulfillment.type !== "pickup") return
    if (item.fulfillment.product.coordinate !== item.productId) {
      context.addIssue({
        code: "custom",
        path: ["fulfillment", "product", "coordinate"],
        message: "Pickup product evidence must match the ordered product.",
      })
    }
    if (item.shippingOptionId !== item.fulfillment.option.coordinate) {
      context.addIssue({
        code: "custom",
        path: ["shippingOptionId"],
        message: "Pickup orders must carry the selected shipping coordinate.",
      })
    }
    if (item.shippingCostSats !== item.fulfillment.costSats) {
      context.addIssue({
        code: "custom",
        path: ["shippingCostSats"],
        message: "Pickup cost must match the signed fulfillment snapshot.",
      })
    }
    const expectedOptionDTag = item.fulfillment.option.coordinate
      .split(":")
      .slice(2)
      .join(":")
    if (item.shippingOptionDTag !== expectedOptionDTag) {
      context.addIssue({
        code: "custom",
        path: ["shippingOptionDTag"],
        message:
          "Pickup option identity must match the signed fulfillment snapshot.",
      })
    }
    if (
      item.sourceShippingCost?.amount !== item.fulfillment.sourceCost.amount ||
      item.sourceShippingCost.currency !==
        item.fulfillment.sourceCost.currency ||
      item.sourceShippingCost.normalizedCurrency !==
        item.fulfillment.sourceCost.normalizedCurrency
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceShippingCost"],
        message:
          "Pickup source cost must match the signed fulfillment snapshot.",
      })
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
    note: z.string().max(2000).optional(),
    createdAt: z.number(),
  })
  .superRefine((order, context) => {
    const firstPickup = order.items.find(
      (item) => item.fulfillment?.type === "pickup"
    )?.fulfillment
    const hasPickup = firstPickup?.type === "pickup"
    const hasShipping = order.items.some(
      (item) =>
        item.fulfillment?.type === "shipping" ||
        (!item.fulfillment && item.format !== "digital")
    )
    for (const [index, item] of order.items.entries()) {
      if (
        item.fulfillment?.type === "pickup" &&
        item.fulfillment.product.merchantPubkey.toLowerCase() !==
          order.merchantPubkey.toLowerCase()
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "fulfillment", "product", "merchantPubkey"],
          message: "Pickup product evidence must belong to the order merchant.",
        })
      }
      if (
        firstPickup?.type === "pickup" &&
        item.fulfillment?.type === "pickup" &&
        !hasSamePickupFulfillmentGraph(firstPickup, item.fulfillment)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "fulfillment"],
          message:
            "Pickup items from different organizer event graphs require separate orders.",
        })
      }
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
    if (order.buyerIdentityKind === "guest_ephemeral" && !order.guestContact) {
      context.addIssue({
        code: "custom",
        path: ["guestContact"],
        message: "Guest orders require a recovery contact.",
      })
    }
    if (
      order.buyerIdentityKind === "guest_ephemeral" &&
      !hasPickup &&
      order.guestContact &&
      (!order.guestContact.email || !order.guestContact.phone)
    ) {
      context.addIssue({
        code: "custom",
        path: ["guestContact"],
        message: "Guest delivery orders require both email and phone.",
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

export const eventMarketReceiptItemSchema = z
  .object({
    product: pickupEvidenceCoordinateSchema,
    quantity: z.number().int().min(1).max(10_000),
    /** Reserved for a future signed-product option projection. */
    variants: z.tuple([]).default([]),
  })
  .strict()

const eventMarketPrivateGraphFields = {
  claimRef: eventMarketClaimRefSchema,
  merchantPubkey: hex64Schema,
  organizerPubkey: hex64Schema,
  calendar: pickupEvidenceCoordinateSchema,
  collection: pickupEvidenceCoordinateSchema,
  option: pickupEvidenceCoordinateSchema,
} as const

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

function refineEventMarketPrivateGraph(
  value: {
    merchantPubkey: string
    organizerPubkey: string
    calendar: PickupEvidenceCoordinateSchema
    collection: PickupEvidenceCoordinateSchema
    option: PickupEvidenceCoordinateSchema
  },
  context: z.RefinementCtx
): void {
  const merchant = value.merchantPubkey.toLowerCase()
  const organizer = value.organizerPubkey.toLowerCase()
  const calendar = eventMarketCoordinateAuthority(value.calendar.coordinate)
  const collection = eventMarketCoordinateAuthority(value.collection.coordinate)
  const option = eventMarketCoordinateAuthority(value.option.coordinate)
  const checks: Array<[boolean, string[], string]> = [
    [
      Boolean(
        calendar &&
        [31922, 31923].includes(calendar.kind) &&
        calendar.authorPubkey === organizer
      ),
      ["calendar", "coordinate"],
      "Organizer receipt calendar authority is invalid.",
    ],
    [
      Boolean(
        collection?.kind === 30405 && collection.authorPubkey === organizer
      ),
      ["collection", "coordinate"],
      "Organizer receipt collection authority is invalid.",
    ],
    [
      Boolean(option?.kind === 30406 && option.authorPubkey === organizer),
      ["option", "coordinate"],
      "Organizer receipt pickup authority is invalid.",
    ],
    [
      merchant !== organizer,
      ["merchantPubkey"],
      "Organizer handoff requires distinct merchant and organizer identities.",
    ],
  ]
  for (const [valid, path, message] of checks) {
    if (!valid) context.addIssue({ code: "custom", path, message })
  }
}

export const eventMarketReadyReceiptSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("organizer_fulfillment_receipt"),
    state: z.literal("ready_for_pickup"),
    paymentConfirmed: z.literal(true),
    orderReady: z.literal(true),
    releaseAuthorized: z.literal(true),
    ...eventMarketPrivateGraphFields,
    items: z.array(eventMarketReceiptItemSchema).min(1).max(64),
    issuedAt: z.number().int().min(0),
  })
  .strict()
  .superRefine((receipt, context) => {
    refineEventMarketPrivateGraph(receipt, context)
    const merchant = receipt.merchantPubkey.toLowerCase()
    const productCoordinates = new Set<string>()
    for (let index = 0; index < receipt.items.length; index += 1) {
      const item = receipt.items[index]!
      const product = eventMarketCoordinateAuthority(item.product.coordinate)
      if (product?.kind !== 30402 || product.authorPubkey !== merchant) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "product", "coordinate"],
          message: "Organizer receipt product authority is invalid.",
        })
      }
      const key = canonicalPickupCoordinateIdentity(item.product.coordinate)
      if (!key || productCoordinates.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "product", "coordinate"],
          message: "Organizer receipt products must be unique.",
        })
      } else {
        productCoordinates.add(key)
      }
    }
  })

export const eventMarketFulfillmentRevocationSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("organizer_fulfillment_revocation"),
    state: z.literal("revoked"),
    ...eventMarketPrivateGraphFields,
    readyReceiptId: hex64Schema,
    issuedAt: z.number().int().min(0),
  })
  .strict()
  .superRefine(refineEventMarketPrivateGraph)

export const eventMarketHandoffAckSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("organizer_handoff_ack"),
    state: z.literal("handed_out"),
    ...eventMarketPrivateGraphFields,
    readyReceiptId: hex64Schema,
    handedOutAt: z.number().int().min(0),
  })
  .strict()
  .superRefine(refineEventMarketPrivateGraph)

export type EventMarketReceiptItemSchema = z.infer<
  typeof eventMarketReceiptItemSchema
>
export type EventMarketReadyReceiptSchema = z.infer<
  typeof eventMarketReadyReceiptSchema
>
export type EventMarketFulfillmentRevocationSchema = z.infer<
  typeof eventMarketFulfillmentRevocationSchema
>
export type EventMarketHandoffAckSchema = z.infer<
  typeof eventMarketHandoffAckSchema
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
  "organizer_fulfillment_receipt",
  "organizer_fulfillment_revocation",
  "organizer_handoff_ack",
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
