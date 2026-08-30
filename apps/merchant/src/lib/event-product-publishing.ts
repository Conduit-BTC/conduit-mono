import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  canonicalizeProductPrice,
  getMerchantStorefront,
  type EventMarketHandoffMode,
  type ProductSchema,
  type PublishWithPlannerResult,
} from "@conduit/core"
import { ensureMerchantBoothPickup } from "./event-market-pickup"
import {
  resolveOrganizerEventMarket,
  type MerchantOrganizerEventMarket,
} from "./event-market"
import {
  buildProductLocalPickupMetadata,
  getMerchantBoothPickupFormError,
} from "./product-local-pickup"
import {
  validateProductPublishForm,
  type ProductPublishFormValidation,
} from "./productForm"
import {
  formatProductAmountInput,
  normalizePublishableProductPrice,
  parsePlainDecimalAmount,
} from "./productPriceForm"
import {
  deliverSignedProductEvent,
  signAndPublishProductListing,
} from "./product-publishing"
import { parseProductStockInput } from "./productStock"

export interface EventProductTemplate {
  coordinate: string
  product: ProductSchema
}

export interface EventProductPublishFormValues {
  templateCoordinate: string
  title: string
  summary: string
  price: string
  currency: string
  stock: string
  imageUrl: string
  tags: string
  handoffMode: EventMarketHandoffMode
  merchantPickupLocation: string
  merchantPickupCountry: string
  publicZapEnabled: boolean
  zapMessagePolicy: "generic_only" | "custom"
}

export interface EventProductPublishResult {
  productCoordinate: string
  delivery: PublishWithPlannerResult
}

export interface EventProductFormValidation {
  product: ProductPublishFormValidation
  pickupError: string | null
  canPublish: boolean
  firstError: string | null
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function randomSuffix(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  } catch {
    return Math.random().toString(36).slice(2, 10)
  }
}

export function createEmptyEventProductForm(
  market: MerchantOrganizerEventMarket
): EventProductPublishFormValues {
  return {
    templateCoordinate: "",
    title: "",
    summary: "",
    price: "",
    currency: "SATS",
    stock: "",
    imageUrl: "",
    tags: "",
    handoffMode: "merchant_handoff",
    merchantPickupLocation: market.eventLocation ?? "",
    merchantPickupCountry: market.pickupCountry ?? "US",
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
  }
}

export function eventProductFormFromTemplate(
  template: EventProductTemplate,
  market: MerchantOrganizerEventMarket
): EventProductPublishFormValues {
  const product = template.product
  const source = product.sourcePrice
  return {
    ...createEmptyEventProductForm(market),
    templateCoordinate: template.coordinate,
    title: product.title,
    summary: product.summary ?? "",
    price: formatProductAmountInput(source?.amount ?? product.price),
    currency: source?.normalizedCurrency ?? product.currency,
    stock: typeof product.stock === "number" ? String(product.stock) : "",
    imageUrl: product.images[0]?.url ?? "",
    tags: product.tags.join(", "),
    publicZapEnabled: product.publicZapPolicyKnown
      ? product.publicZapEnabled
      : true,
    zapMessagePolicy: product.publicZapPolicyKnown
      ? product.zapMessagePolicy
      : "generic_only",
  }
}

export async function listEventProductTemplates(
  merchantPubkey: string
): Promise<EventProductTemplate[]> {
  const result = await getMerchantStorefront({
    merchantPubkey,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  return result.data
    .filter((record) => record.product.pubkey === merchantPubkey)
    .map((record) => ({
      coordinate: record.product.id,
      product: record.product,
    }))
}

export function validateEventProductPublishForm(
  form: EventProductPublishFormValues
): EventProductFormValidation {
  const product = validateProductPublishForm(
    {
      title: form.title,
      price: form.price,
      stock: form.stock,
      currency: form.currency,
      format: "physical",
      shippingPricingMode: "coordinate_after_order",
      shippingCost: "",
      usePresetShippingZone: false,
      customShippingConfig: { countries: [] },
      imageUrl: form.imageUrl,
      tags: form.tags,
    },
    { hasPresetShippingZone: false, allowZeroPrice: true }
  )
  const pickupError =
    form.handoffMode === "merchant_handoff"
      ? getMerchantBoothPickupFormError({
          title: "Merchant pickup",
          location: form.merchantPickupLocation,
          geohash: "",
          country: form.merchantPickupCountry,
        })
      : null
  return {
    product,
    pickupError,
    canPublish: product.canPublish && !pickupError,
    firstError: product.firstError ?? pickupError,
  }
}

export async function publishEventProduct(input: {
  merchantPubkey: string
  marketReference: string
  form: EventProductPublishFormValues
  onSignedLocal?: (event: NDKEvent) => void | Promise<void>
}): Promise<EventProductPublishResult> {
  const validation = validateEventProductPublishForm(input.form)
  if (!validation.canPublish) {
    throw new Error(validation.firstError ?? "Product form is not publishable.")
  }

  const market = await resolveOrganizerEventMarket(
    input.marketReference,
    undefined,
    input.merchantPubkey
  )
  const dTag = `${slugify(input.form.title) || "product"}-${randomSuffix()}`
  const pickupMetadata =
    input.form.handoffMode === "organizer_handoff"
      ? buildProductLocalPickupMetadata(market, {
          handoffMode: "organizer_handoff",
        })
      : buildProductLocalPickupMetadata(market, {
          handoffMode: "merchant_handoff",
          merchantPickupCoordinate: (
            await ensureMerchantBoothPickup({
              authorPubkey: input.merchantPubkey,
              dTag: `${dTag}-event-pickup`,
              title: "Merchant pickup",
              location: input.form.merchantPickupLocation.trim(),
              country: input.form.merchantPickupCountry.trim().toUpperCase(),
            })
          ).coordinate,
        })
  const currency = input.form.currency.trim().toUpperCase() || "SATS"
  const price = normalizePublishableProductPrice(
    parsePlainDecimalAmount(input.form.price, "Price"),
    currency,
    { allowZero: true }
  )
  const now = Date.now()
  const product: ProductSchema = canonicalizeProductPrice({
    id: `30402:${input.merchantPubkey}:${dTag}`,
    pubkey: input.merchantPubkey,
    title: input.form.title.trim(),
    summary: input.form.summary.trim() || undefined,
    price,
    currency,
    type: "simple",
    specifications: [],
    ...pickupMetadata,
    visibility: "public",
    stock: parseProductStockInput(input.form.stock),
    images: [{ url: input.form.imageUrl.trim() }],
    tags: validation.product.tags,
    publicZapEnabled: input.form.publicZapEnabled,
    zapMessagePolicy: input.form.zapMessagePolicy,
    publicZapPolicyKnown: true,
    createdAt: now,
    updatedAt: now,
  })
  const delivery = await signAndPublishProductListing({
    merchantPubkey: input.merchantPubkey,
    product,
    dTag,
    fulfillmentIntent: { kind: "coordinate_after_order" },
    onSignedLocal: async (event) => {
      await input.onSignedLocal?.(event)
    },
  })
  return { productCoordinate: product.id, delivery }
}

export async function retryEventProductDelivery(
  event: NDKEvent,
  merchantPubkey: string
): Promise<PublishWithPlannerResult> {
  return deliverSignedProductEvent(event, merchantPubkey)
}
