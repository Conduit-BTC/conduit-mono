import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  canonicalizeProductPrice,
  decodeProductReference,
  getProductImageCandidates,
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
  applyMerchantEventHandoffPreference,
  ensureMerchantEventHandoffPreference,
  type MerchantEventHandoffPreference,
  type MerchantEventHandoffStorage,
} from "./merchant-event-handoff-arrangement"
import { loadMerchantEventHandoffTransition } from "./merchant-event-handoff-transition"
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
  type ProductSignerRequestProgress,
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

export function createFreshEventProductDTag(
  title: string,
  sourceCoordinate = "",
  suffix = randomSuffix()
): string {
  const candidate = `${slugify(title) || "product"}-${suffix}`
  const sourceDTag = decodeProductReference(sourceCoordinate)?.dTag
  return candidate === sourceDTag ? `${candidate}-event` : candidate
}

export function createEmptyEventProductForm(
  market: MerchantOrganizerEventMarket,
  preference?: MerchantEventHandoffPreference | null
): EventProductPublishFormValues {
  const form: EventProductPublishFormValues = {
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
  return preference
    ? applyMerchantEventHandoffPreference(form, preference)
    : form
}

export function eventProductFormFromTemplate(
  template: EventProductTemplate,
  market: MerchantOrganizerEventMarket,
  preference?: MerchantEventHandoffPreference | null
): EventProductPublishFormValues {
  const product = template.product
  const source = product.sourcePrice
  return {
    ...createEmptyEventProductForm(market, preference),
    templateCoordinate: template.coordinate,
    title: product.title,
    summary: product.summary ?? "",
    price: formatProductAmountInput(source?.amount ?? product.price),
    currency: source?.normalizedCurrency ?? product.currency,
    stock: typeof product.stock === "number" ? String(product.stock) : "",
    imageUrl: getProductImageCandidates(product)[0]?.url ?? "",
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
  merchantPubkey: string,
  authenticatedPubkey: string | null,
  shouldContinue?: () => boolean
): Promise<EventProductTemplate[]> {
  const result = await getMerchantStorefront({
    merchantPubkey,
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue,
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
  authenticatedPubkey: string | null
  shouldContinue?: () => boolean
  marketReference: string
  form: EventProductPublishFormValues
  handoffStorage?: MerchantEventHandoffStorage | null
  onSignedLocal?: (event: NDKEvent) => void | Promise<void>
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
}): Promise<EventProductPublishResult> {
  const initialValidation = validateEventProductPublishForm(input.form)
  if (!initialValidation.product.canPublish) {
    throw new Error(
      initialValidation.product.firstError ?? "Product form is not publishable."
    )
  }

  const market = await resolveOrganizerEventMarket(
    input.marketReference,
    undefined,
    input.authenticatedPubkey,
    undefined,
    input.shouldContinue
  )
  const transition = loadMerchantEventHandoffTransition(
    input.merchantPubkey,
    market.collectionCoordinate,
    input.handoffStorage
  )
  const preference = await ensureMerchantEventHandoffPreference({
    merchantPubkey: input.merchantPubkey,
    market,
    requested: {
      mode: input.form.handoffMode,
      merchantPickup: {
        title: "Merchant pickup",
        location: input.form.merchantPickupLocation,
        country: input.form.merchantPickupCountry,
      },
    },
    transition,
    storage: input.handoffStorage,
  })
  const form = applyMerchantEventHandoffPreference(input.form, preference)
  const validation = validateEventProductPublishForm(form)
  if (!validation.canPublish) {
    throw new Error(validation.firstError ?? "Product form is not publishable.")
  }

  const dTag = createFreshEventProductDTag(form.title, form.templateCoordinate)
  let signerRequestOffset = 0
  const pickupMetadata =
    preference.mode === "organizer_handoff"
      ? buildProductLocalPickupMetadata(market, {
          handoffMode: "organizer_handoff",
        })
      : buildProductLocalPickupMetadata(market, {
          handoffMode: "merchant_handoff",
          merchantPickupCoordinate: (
            await ensureMerchantBoothPickup({
              authorPubkey: input.merchantPubkey,
              authenticatedPubkey: input.authenticatedPubkey,
              shouldContinue: input.shouldContinue,
              dTag: preference.merchantPickup!.dTag,
              title: preference.merchantPickup!.title,
              location: preference.merchantPickup!.location,
              geohash: preference.merchantPickup!.geohash,
              countries: preference.merchantPickup!.countries,
              storage: input.handoffStorage,
              onSignerRequest: () => {
                signerRequestOffset = 1
                input.onSignerRequest?.({
                  kind: "shipping",
                  current: 1,
                  total: 2,
                })
              },
            })
          ).coordinate,
        })
  const currency = form.currency.trim().toUpperCase() || "SATS"
  const price = normalizePublishableProductPrice(
    parsePlainDecimalAmount(form.price, "Price"),
    currency,
    { allowZero: true }
  )
  const now = Date.now()
  const product: ProductSchema = canonicalizeProductPrice({
    id: `30402:${input.merchantPubkey}:${dTag}`,
    pubkey: input.merchantPubkey,
    title: form.title.trim(),
    summary: form.summary.trim() || undefined,
    price,
    currency,
    type: "simple",
    specifications: [],
    ...pickupMetadata,
    visibility: "private",
    stock: parseProductStockInput(form.stock),
    images: [{ url: form.imageUrl.trim() }],
    tags: validation.product.tags,
    publicZapEnabled: form.publicZapEnabled,
    zapMessagePolicy: form.zapMessagePolicy,
    publicZapPolicyKnown: true,
    createdAt: now,
    updatedAt: now,
  })
  const delivery = await signAndPublishProductListing({
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    product,
    dTag,
    fulfillmentIntent: { kind: "coordinate_after_order" },
    onSignerRequest: (progress) =>
      input.onSignerRequest?.({
        ...progress,
        current: progress.current + signerRequestOffset,
        total: progress.total + signerRequestOffset,
      }),
    onSignedLocal: async (event) => {
      await input.onSignedLocal?.(event)
    },
  })
  return { productCoordinate: product.id, delivery }
}

export async function retryEventProductDelivery(
  event: NDKEvent,
  merchantPubkey: string,
  authenticatedPubkey?: string | null,
  shouldContinue?: () => boolean
): Promise<PublishWithPlannerResult> {
  return deliverSignedProductEvent(event, merchantPubkey, {
    authenticatedPubkey,
    shouldContinue,
  })
}
