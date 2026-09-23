import type { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  canonicalizeProductPrice,
  decodeProductReference,
  getMerchantStorefront,
  type EventMarketHandoffMode,
  type EventMarketResolutionState,
  type ProductImage,
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
  prepareProductImages,
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
  images: ProductImage[]
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

export interface MerchantEventPublishPresentation {
  message: string | null
  publishable: boolean
  retryLabel: string | null
  state: "available" | "checking" | "closed" | "ended" | "recoverable"
}

export function getMerchantEventPublishPresentation(input: {
  actionReady: boolean
  orderAcceptance?: "open" | "closed"
  refreshing: boolean
  requiredRecordsResolved: boolean
  state: EventMarketResolutionState
}): MerchantEventPublishPresentation {
  const publishable =
    input.actionReady &&
    input.orderAcceptance !== "closed" &&
    input.requiredRecordsResolved &&
    (input.state === "active" || input.state === "partial")

  if (publishable) {
    return {
      message: null,
      publishable: true,
      retryLabel: null,
      state: "available",
    }
  }
  if (input.orderAcceptance === "closed") {
    return {
      message: "This event is closed. New products can't be published.",
      publishable: false,
      retryLabel: null,
      state: "closed",
    }
  }
  if (input.state === "ended") {
    return {
      message: "This event has ended. New products can't be published.",
      publishable: false,
      retryLabel: null,
      state: "ended",
    }
  }
  if (input.refreshing) {
    return {
      message: "Checking current event details before publishing.",
      publishable: false,
      retryLabel: "Checking event details...",
      state: "checking",
    }
  }
  return {
    message:
      "Current event details couldn't be confirmed. Retry before publishing a product.",
    publishable: false,
    retryLabel: "Retry event details",
    state: "recoverable",
  }
}

export function assertEventProductMarketPublishable(
  market: Pick<
    MerchantOrganizerEventMarket,
    "orderAcceptance" | "source" | "state"
  >
): void {
  const requiredRecordsResolved = Boolean(
    market.source.collection &&
    market.source.calendar &&
    (!market.source.pickupCoordinate || market.source.pickup)
  )
  const presentation = getMerchantEventPublishPresentation({
    actionReady: true,
    orderAcceptance: market.orderAcceptance,
    refreshing: false,
    requiredRecordsResolved,
    state: market.state,
  })
  if (!presentation.publishable) {
    throw new Error(
      presentation.message ??
        "Current event details do not permit publishing a product."
    )
  }
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
  market: MerchantOrganizerEventMarket
): EventProductPublishFormValues {
  return {
    templateCoordinate: "",
    title: "",
    summary: "",
    price: "",
    currency: "SATS",
    stock: "",
    images: [],
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
    images: product.images.map((image) => ({ ...image })),
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
  accountPubkey: string | null,
  authenticatedPubkey: string | null,
  shouldContinue?: () => boolean
): Promise<EventProductTemplate[]> {
  const result = await getMerchantStorefront({
    merchantPubkey,
    accountPubkey,
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
      images: form.images,
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
  onProductPrepared?: (dTag: string) => void | Promise<void>
  onSignedLocal?: (event: NDKEvent) => void | Promise<void>
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
}): Promise<EventProductPublishResult> {
  const validation = validateEventProductPublishForm(input.form)
  if (!validation.canPublish) {
    throw new Error(validation.firstError ?? "Product form is not publishable.")
  }

  const market = await resolveOrganizerEventMarket(
    input.marketReference,
    undefined,
    input.authenticatedPubkey,
    undefined,
    input.shouldContinue,
    { includeParticipation: false }
  )
  // Re-check the current organizer-authored graph before any signer request or
  // publication. A newly closed event must not leave an orphan booth pickup.
  assertEventProductMarketPublishable(market)
  const dTag = createFreshEventProductDTag(
    input.form.title,
    input.form.templateCoordinate
  )
  await input.onProductPrepared?.(dTag)
  let signerRequestOffset = 0
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
              authenticatedPubkey: input.authenticatedPubkey,
              shouldContinue: input.shouldContinue,
              dTag: `${dTag}-event-pickup`,
              title: "Merchant pickup",
              location: input.form.merchantPickupLocation.trim(),
              country: input.form.merchantPickupCountry.trim().toUpperCase(),
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
    visibility: "private",
    stock: parseProductStockInput(input.form.stock),
    images: prepareProductImages(input.form.images),
    tags: validation.product.tags,
    publicZapEnabled: input.form.publicZapEnabled,
    zapMessagePolicy: input.form.zapMessagePolicy,
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
