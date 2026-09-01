import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { Plus, Search } from "lucide-react"
import {
  EVENT_KINDS,
  SHIPPING_COUNTRIES,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  buildProductDeletionEventDraft,
  applyPreparedProductFulfillment,
  buildProductPublishResultTelemetryProperties,
  cacheSignedProductDeletionEvent,
  canonicalizeProductPrice,
  compileProductFulfillmentIntent,
  evaluateListingSafety,
  getCachedMerchantStorefront,
  getListingSafetyDisplay,
  getMerchantStorefront,
  getShippingOptionsByCoordinates,
  getProductImageCandidates,
  getProductPriceDisplay,
  getNdk,
  isCommerceReadIncomplete,
  prepareProductCatalog,
  recordBrowserTelemetryEvent,
  resolveProductFulfillment,
  resolveEventMarketOrganizerInbox,
  waitForVisibleDocument,
  type CommerceResult,
  type ListingSafetyEvaluation,
  type PreparedProductFamily,
  type ProductSchema,
  type ProductDeletionDeliveryJob,
  type ProductZapMessagePolicy,
  type PublishWithPlannerResult,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
} from "@conduit/core"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DoubleSideStatusPill,
  Input,
  Label,
  ProductCard,
  RefreshChip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SignedActionStatus,
  StatusPill,
  Textarea,
  cn,
} from "@conduit/ui"
import { ProductCombinationMatrix } from "../components/ProductCombinationMatrix"
import { ProductInboxReadinessDialog } from "../components/ProductInboxReadinessDialog"
import { ProductSignerRecoveryNotice } from "../components/ProductSignerRecoveryNotice"
import { ProductTagEditor } from "../components/ProductTagEditor"
import { ProductFulfillmentEditor } from "../components/ProductFulfillmentEditor"
import { ShippingDestinationsEditor } from "../components/ShippingDestinationsEditor"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { requireAuth } from "../lib/auth"
import {
  clearProductVariationAuthoringState,
  isProductDraftOwnedBySigner,
  isProductDraftPublishAuthorized,
  loadProductVariationAuthoringState,
  ProductDraftStore,
  saveProductVariationAuthoringState,
  type ProductDraftTarget,
  type ProductVariationAuthoringTarget,
} from "../lib/productDraft"
import {
  buildProductShippingMetadata,
  canUseZeroProductPrice,
  canSubmitProductForm,
  getProductShippingPricingMode,
  isProductUsingPresetShippingZone,
  MAX_PRODUCT_TAG_COUNT,
  MAX_PRODUCT_TAG_LENGTH,
  reconcileProductFormShippingPreset,
  validateProductPublishForm,
  type MerchantProductFormValues,
} from "../lib/productForm"
import {
  canonicalizeProductShippingCost,
  formatProductAmountInput,
  getProductAmountInputMode,
  getProductShippingCostHelpText,
  getProductShippingCurrencyLabel,
  isPlainDecimalInput,
  normalizePublishableProductPrice,
  parsePlainDecimalAmount,
} from "../lib/productPriceForm"
import { buildProductTagCatalog } from "../lib/productTagSuggestions"
import {
  buildLocalProductDeliveryNotice,
  buildLocalProductRetryNotice,
  buildProductDeliveryNotice,
  buildQueuedProductDeletionNotice,
  formatProductRelayUrls,
  getProductDeliveryNoticeVariant,
  reconcilePendingProductDeletionRetry,
  type ProductDeliveryNotice,
  type ProductWriteAction,
} from "../lib/product-delivery"
import {
  isShippingComplete,
  loadShippingConfig,
  type ShippingConfig,
} from "../lib/readiness"
import { needsProductInboxPublishGuidance } from "../lib/productInboxReadiness"
import {
  deliverQueuedProductDeletion,
  getPendingProductDeletionJobs,
  persistSignedProductDeletion,
  planCurrentProductDeletionWriteRelays,
  productDeletionJobToPublishResult,
} from "../lib/product-deletion-delivery"
import {
  buildProductRemovalDeletionTargets,
  deliverSignedProductWriteBundle,
  getProductSignerRequestCount,
  getProductSignerRequestMessage,
  getRelayPublishDiagnosticsError,
  signAndPublishProductWriteBundle,
  SignedProductDeliveryError,
  type ProductSignerRequestProgress,
  type SignedProductWriteBundle,
} from "../lib/product-publishing"
import {
  listOrganizerEventMarkets,
  resolveOrganizerEventMarket,
  type MerchantOrganizerEventMarket,
} from "../lib/event-market"
import { ensureMerchantBoothPickup } from "../lib/event-market-pickup"
import {
  buildProductLocalPickupMetadata,
  getMerchantBoothPickupFormError,
  getProductEventParticipationState,
  getProductFulfillmentProjection,
  getProductLocalPickupEvidenceError,
} from "../lib/product-local-pickup"
import {
  getProductFamilyStockDisplay,
  getProductStockDisplay,
  isPlainStockInput,
  parseProductStockInput,
} from "../lib/productStock"
import {
  addProductVariationAxis,
  buildProductFamilyChangePlan,
  createEmptyProductVariationForm,
  generateProductVariationRows,
  getProductVariationCartesianCount,
  getProductVariationCombinations,
  getProductVariationMatrix,
  getProductVariationFormState,
  getProductVariationRemovalCount,
  groupProductVariationRecords,
  MAX_PRODUCT_VARIATION_AXES,
  MAX_PRODUCT_VARIATION_COUNT,
  mergeProductVariationAuthoringState,
  reconcileProductVariationDraftResolution,
  reconcileProductVariationForm,
  removeProductVariationAxis,
  setProductVariationCombinationIncluded,
  updateProductVariationAxis,
  updateProductVariationInheritance,
  updateProductVariationOverride,
  type ProductVariationFormResult,
} from "../lib/productVariations"

export const Route = createFileRoute("/products")({
  beforeLoad: () => {
    requireAuth()
  },
  component: ProductsPage,
})

type MerchantProduct = {
  eventId: string
  addressId: string
  dTag: string | null
  eventCreatedAt: number
  sourceRelayUrls: string[]
  product: ProductSchema
  safety: ListingSafetyEvaluation
}

type MerchantProductFamily = MerchantProduct & {
  variations: MerchantProduct[]
  orphanVariation: boolean
  variationForm: ProductVariationFormResult
  family?: PreparedProductFamily<MerchantProduct>
}

type ProductFormState = MerchantProductFormValues

type ProductPublishMutationPayload = {
  merchantPubkey: string
  form: ProductFormState
  dTag: string
  existing?: MerchantProductFamily
  signedBundle?: SignedProductWriteBundle
  previousNotice?: ProductDeliveryNotice
}

type ProductDeleteMutationPayload = {
  product?: MerchantProductFamily
  deliveryJobId?: string
  previousNotice?: ProductDeliveryNotice
}

type ProductDeliveryRetryState =
  | { action: "publish"; payload: ProductPublishMutationPayload }
  | { action: "delete"; payload: ProductDeleteMutationPayload }

type ProductSort = "updated_desc" | "title_asc" | "price_asc" | "price_desc"

type EditFulfillmentResolution =
  "ready" | "resolving" | "unresolved" | "verifying_pickup"

function createEmptyProductForm(
  usePresetShippingZone = true
): ProductFormState {
  return {
    title: "",
    summary: "",
    price: "0",
    stock: "",
    variations: createEmptyProductVariationForm(),
    currency: "USD",
    format: "physical",
    fulfillment: "ship",
    eventMarketReference: "",
    eventHandoffMode: "merchant_handoff",
    merchantPickupTitle: "Merchant booth pickup",
    merchantPickupLocation: "",
    merchantPickupGeohash: "",
    merchantPickupCountry: "US",
    shippingPricingMode: "fixed",
    shippingCost: "",
    usePresetShippingZone,
    customShippingConfig: { countries: [] },
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    imageUrl: "",
    tags: "",
  }
}

const EMPTY_FORM: ProductFormState = createEmptyProductForm()

function getProductDraftTarget(
  merchantPubkey: string,
  product?: MerchantProductFamily | null
): ProductDraftTarget {
  const familyEventId = product
    ? [product, ...product.variations]
        .map((record) => record.eventId)
        .sort()
        .join(":")
    : null
  return {
    merchantPubkey,
    productAddressId: product?.addressId ?? null,
    baseEventId: familyEventId,
  }
}

function getProductVariationAuthoringTarget(
  merchantPubkey: string,
  product: MerchantProductFamily
): ProductVariationAuthoringTarget {
  return {
    merchantPubkey,
    productAddressId: product.addressId,
    rootEventId: product.eventId,
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
  return Math.random().toString(36).slice(2, 8)
}

function getShippingCountryName(code: string, fallback?: string): string {
  const normalized = code.trim().toUpperCase()
  const country = SHIPPING_COUNTRIES.find((entry) => entry.code === normalized)
  return country?.name ?? fallback?.trim() ?? normalized
}

function productShippingConfigFromProduct(
  product: ProductSchema
): ShippingConfig {
  if (product.shippingCountryRules && product.shippingCountryRules.length > 0) {
    return {
      countries: product.shippingCountryRules.map((rule) => ({
        code: rule.code.trim().toUpperCase(),
        name: getShippingCountryName(rule.code, rule.name),
        restrictTo: rule.restrictTo,
        exclude: rule.exclude,
      })),
    }
  }

  return {
    countries: (product.shippingCountries ?? []).map((code) => ({
      code: code.trim().toUpperCase(),
      name: getShippingCountryName(code),
      restrictTo: [],
      exclude: [],
    })),
  }
}

function productToForm(
  family: MerchantProductFamily,
  presetAvailable = true,
  verifiedMarket?: MerchantOrganizerEventMarket | null
): ProductFormState {
  const product = family.product
  const source = product.sourcePrice
  const sourceShippingCost = product.sourceShippingCost
  const currency = source?.normalizedCurrency ?? product.currency
  const fulfillment = getProductFulfillmentProjection(product, verifiedMarket)
  return {
    title: product.title,
    summary: product.summary ?? "",
    price: formatProductAmountInput(source?.amount ?? product.price),
    stock: typeof product.stock === "number" ? String(product.stock) : "",
    variations: family.variationForm.state,
    currency,
    format: product.format,
    shippingPricingMode: getProductShippingPricingMode(product),
    fulfillment: fulfillment.intent,
    eventMarketReference: fulfillment.eventMarketReference,
    eventHandoffMode: fulfillment.handoffMode ?? "merchant_handoff",
    merchantPickupTitle: "Merchant booth pickup",
    merchantPickupLocation: "",
    merchantPickupGeohash: "",
    merchantPickupCountry: "US",
    shippingCost:
      typeof sourceShippingCost?.amount === "number"
        ? formatProductAmountInput(sourceShippingCost.amount)
        : typeof product.shippingCostSats === "number"
          ? formatProductAmountInput(product.shippingCostSats)
          : "",
    usePresetShippingZone: isProductUsingPresetShippingZone(
      product,
      presetAvailable
    ),
    customShippingConfig: productShippingConfigFromProduct(product),
    publicZapEnabled: product.publicZapPolicyKnown
      ? product.publicZapEnabled
      : false,
    zapMessagePolicy: product.publicZapPolicyKnown
      ? product.zapMessagePolicy
      : "generic_only",
    imageUrl: product.images[0]?.url ?? "",
    tags: product.tags.join(", "),
  }
}

function buildShippingMetadata(
  merchantPubkey: string,
  productDTag: string,
  form: ProductFormState
) {
  const shippingConfig = form.usePresetShippingZone
    ? loadShippingConfig(merchantPubkey)
    : form.customShippingConfig
  const intent = compileProductFulfillmentIntent({
    format: form.format,
    shippingPricingMode: form.shippingPricingMode,
    amount:
      form.format === "physical" && form.shippingPricingMode === "fixed"
        ? parsePlainDecimalAmount(form.shippingCost, "Shipping")
        : undefined,
    currency: form.currency,
    destinations: shippingConfig.countries,
  })
  return {
    intent,
    authoringCountries: Array.from(
      new Set(
        shippingConfig.countries.map((country) =>
          country.code.trim().toUpperCase()
        )
      )
    ).sort(),
    metadata: buildProductShippingMetadata(merchantPubkey, productDTag, intent),
  }
}

function getPublishErrorMessage(
  error: unknown,
  action: "publish" | "delete"
): string {
  const fallback =
    action === "delete"
      ? "Failed to delete listing"
      : "Failed to publish listing"
  if (error instanceof SignedProductDeliveryError) {
    return action === "delete"
      ? "Delete saved locally. Relay delivery needs retry."
      : "Publish saved locally. Relay delivery needs retry."
  }
  if (!(error instanceof Error)) return fallback

  if (
    error.message.includes("Not enough relays received the event") ||
    error.message.includes(
      "Could not publish to configured or fallback relays"
    ) ||
    error.message.includes("no primary relay accepted")
  ) {
    return `${fallback}. No relay accepted the signed event. Open Network Settings, reset to defaults or enable OUT on another relay, then try again.`
  }

  return error.message
}

function ProductDeliveryStatusNotice({
  notice,
  onDismiss,
  onRetry,
}: {
  notice: ProductDeliveryNotice
  onDismiss: () => void
  onRetry?: () => void
}) {
  const showRelayDetails =
    notice.attemptedRelayUrls.length > 0 ||
    notice.successfulRelayUrls.length > 0 ||
    notice.failedRelayUrls.length > 0

  return (
    <div className="rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              variant={getProductDeliveryNoticeVariant(notice.state)}
              className="text-[10px]"
            >
              {notice.state === "delivering"
                ? "Delivering"
                : notice.state === "delivered"
                  ? "Delivered"
                  : notice.state === "partial"
                    ? "Partial"
                    : "Retry needed"}
            </StatusPill>
            <div className="font-medium text-[var(--text-primary)]">
              {notice.title}
            </div>
          </div>
          <p className="mt-2 leading-6">{notice.detail}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onRetry && (
            <Button
              type="button"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={onRetry}
            >
              Retry delivery
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
      </div>
      {showRelayDetails && (
        <div className="mt-3 grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-5">
          <div className="break-all">
            <span className="font-medium text-[var(--text-primary)]">
              Attempted:
            </span>{" "}
            {formatProductRelayUrls(notice.attemptedRelayUrls)}
          </div>
          <div className="break-all">
            <span className="font-medium text-[var(--text-primary)]">
              ACKed:
            </span>{" "}
            {formatProductRelayUrls(notice.successfulRelayUrls)}
          </div>
          {notice.failedRelayUrls.length > 0 && (
            <div className="break-all">
              <span className="font-medium text-[var(--text-primary)]">
                Needs retry:
              </span>{" "}
              {formatProductRelayUrls(notice.failedRelayUrls)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getStatusPillVariant(
  tone: ReturnType<typeof getListingSafetyDisplay>["tone"]
): "success" | "warning" | "error" | "info" | "neutral" {
  return tone
}

function getZapPolicyLabel(product: ProductSchema): string {
  if (!product.publicZapPolicyKnown) return "Zap policy: unknown"
  if (!product.publicZapEnabled) return "Private invoice only"

  switch (product.zapMessagePolicy) {
    case "custom":
      return "Public zap: shopper custom"
    case "generic_only":
      return "Public zap: generic"
  }
}

function getZapPolicyBadge(product: ProductSchema): {
  left: string
  right: string
} {
  if (!product.publicZapPolicyKnown) return { left: "Zap", right: "unknown" }
  if (!product.publicZapEnabled)
    return { left: "Checkout", right: "invoice only" }

  switch (product.zapMessagePolicy) {
    case "custom":
      return { left: "Public zap", right: "shopper custom" }
    case "generic_only":
      return { left: "Public zap", right: "generic" }
  }
}

function ListingSafetySummary({
  item,
  onEdit,
}: {
  item: MerchantProductFamily
  onEdit?: () => void
}) {
  const display = getListingSafetyDisplay(item.safety)
  const isActive = item.safety.state === "active"
  const isPolicyWarning = item.safety.state === "flagged"
  const zapPolicyLabel = getZapPolicyLabel(item.product)

  if (item.product.type === "variable" && item.variationForm.supported) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2">
        <StatusPill variant="info" className="text-[10px]">
          Variable product
        </StatusPill>
        <span className="text-xs text-[var(--text-secondary)]">
          {item.variations.length} variation
          {item.variations.length === 1 ? "" : "s"}
        </span>
      </div>
    )
  }

  if (!item.variationForm.supported) {
    return (
      <article className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-[var(--text-primary)]">
              {item.product.title}
            </div>
            <p className="mt-2 leading-6">
              {item.variationForm.reason ??
                "This variation family cannot be edited safely."}
            </p>
          </div>
          <StatusPill variant="warning" className="text-[10px]">
            Read-only
          </StatusPill>
        </div>
        <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">
          You can delete the known listing family, but editing is disabled to
          avoid losing unsupported option data.
        </p>
      </article>
    )
  }

  if (isActive) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2">
        <StatusPill variant="success" className="text-[10px]">
          {display.label}
        </StatusPill>
      </div>
    )
  }

  return (
    <article className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--text-primary)]">
            {item.product.title}
          </div>
          <div className="mt-2 leading-6">{display.summary}</div>
        </div>
        <StatusPill
          variant={getStatusPillVariant(display.tone)}
          className="text-[10px]"
        >
          {display.label}
        </StatusPill>
      </div>

      <div className="mt-3 grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-secondary)] sm:grid-cols-2">
        <div>
          <span className="font-medium text-[var(--text-primary)]">
            Market visibility:
          </span>{" "}
          {isPolicyWarning ? "Active" : "Hidden"}
        </div>
        <div>
          <span className="font-medium text-[var(--text-primary)]">
            Checkout:
          </span>{" "}
          {isPolicyWarning ? "Available" : "Disabled"}
        </div>
        <div>
          <span className="font-medium text-[var(--text-primary)]">
            Zap checkout:
          </span>{" "}
          {zapPolicyLabel}
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">
        {display.merchantAction}
      </p>
      {onEdit && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onEdit}>
          {isPolicyWarning ? "Review listing" : "Fix listing"}
        </Button>
      )}
    </article>
  )
}

async function fetchMerchantProducts(
  merchantPubkey: string
): Promise<CommerceResult<MerchantProduct[]>> {
  const result = await getMerchantStorefront({
    merchantPubkey,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  const shippingOptions = await getShippingOptionsByCoordinates(
    result.data.flatMap((record) =>
      record.product.shippingOptionId ? [record.product.shippingOptionId] : []
    )
  )
  return {
    data: result.data.map((record) => {
      const fulfillment = resolveProductFulfillment(
        record.product,
        shippingOptions
      )
      const product =
        fulfillment.status === "ready"
          ? applyPreparedProductFulfillment(record.product, fulfillment)
          : record.product
      return {
        eventId: record.eventId,
        addressId: record.addressId,
        dTag: record.dTag,
        eventCreatedAt: record.eventCreatedAt,
        sourceRelayUrls: record.sourceRelayUrls ?? [],
        product,
        safety: record.safety ?? evaluateListingSafety(product),
      }
    }),
    meta: result.meta,
  }
}

async function fetchCachedMerchantProducts(
  merchantPubkey: string
): Promise<CommerceResult<MerchantProduct[]>> {
  const result = await getCachedMerchantStorefront({
    merchantPubkey,
    sort: "updated_at_desc",
    includeMarketHidden: true,
  })
  return {
    data: result.data.map((record) => ({
      eventId: record.eventId,
      addressId: record.addressId,
      dTag: record.dTag,
      eventCreatedAt: record.eventCreatedAt,
      sourceRelayUrls: record.sourceRelayUrls ?? [],
      product: record.product,
      safety: record.safety ?? evaluateListingSafety(record.product),
    })),
    meta: result.meta,
  }
}

async function publishProduct(
  merchantPubkey: string,
  form: ProductFormState,
  dTag: string,
  onSignedLocal: (
    bundle: SignedProductWriteBundle,
    authoringTarget: ProductVariationAuthoringTarget
  ) => Promise<void>,
  existing?: MerchantProductFamily,
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void,
  onSignerRequestsComplete?: () => void
): Promise<PublishWithPlannerResult> {
  const localPickup = form.fulfillment === "local_pickup"
  const presetShippingConfig = loadShippingConfig(merchantPubkey)
  const formValidation = validateProductPublishForm(
    localPickup
      ? { ...form, shippingPricingMode: "coordinate_after_order" }
      : form,
    {
      hasPresetShippingZone: isShippingComplete(presetShippingConfig),
      presetShippingConfig,
      allowZeroPrice:
        localPickup &&
        (form.eventHandoffMode === "merchant_handoff" ||
          form.eventHandoffMode === "organizer_handoff"),
    }
  )
  if (!formValidation.canPublish) {
    throw new Error(
      formValidation.firstError ?? "Product form is not publishable"
    )
  }

  const signerPubkey = merchantPubkey

  const title = form.title.trim()
  if (!title) throw new Error("Title is required")

  const price = parsePlainDecimalAmount(form.price, "Price")
  const isDigital = form.fulfillment === "digital"
  const hasFixedShipping =
    form.fulfillment === "ship" && form.shippingPricingMode === "fixed"
  const shippingCostInput = hasFixedShipping ? form.shippingCost.trim() : ""
  const shippingCostAmount =
    shippingCostInput.length > 0
      ? parsePlainDecimalAmount(shippingCostInput, "Shipping")
      : undefined

  const currency = form.currency.trim().toUpperCase() || "USD"
  const shippingCost = canonicalizeProductShippingCost(
    shippingCostAmount,
    currency
  )
  const publicationFulfillment = localPickup
    ? {
        intent: { kind: "coordinate_after_order" as const },
        authoringCountries: [] as string[],
        metadata: {},
      }
    : buildShippingMetadata(signerPubkey, dTag, form)
  let shippingMetadata: Pick<
    ProductSchema,
    | "shippingOptionId"
    | "shippingOptionDTag"
    | "shippingOptionRefs"
    | "collectionRefs"
    | "shippingCountries"
    | "shippingCountryRules"
  > = publicationFulfillment.metadata
  let localPickupEvidenceVerified = false
  let verifiedLocalPickupMarket: MerchantOrganizerEventMarket | null = null
  let merchantBoothPickupInput:
    Parameters<typeof ensureMerchantBoothPickup>[0] | null = null
  if (localPickup) {
    if (!form.eventMarketReference.trim()) {
      throw new Error(
        "Import an organizer event catalog before publishing local pickup."
      )
    }
    const eventMarket = await resolveOrganizerEventMarket(
      form.eventMarketReference
    )
    verifiedLocalPickupMarket = eventMarket
    localPickupEvidenceVerified = true
  }
  const zeroPriceAuthorized = canUseZeroProductPrice({
    fulfillment: form.fulfillment,
    handoffMode: form.eventHandoffMode,
    evidenceVerified: localPickupEvidenceVerified,
  })
  const normalizedPrice = normalizePublishableProductPrice(price, currency, {
    allowZero: zeroPriceAuthorized,
  })
  if (localPickup) {
    const eventMarket = verifiedLocalPickupMarket
    if (!eventMarket) {
      throw new Error("Local pickup evidence could not be verified.")
    }
    if (form.eventHandoffMode === "organizer_handoff") {
      shippingMetadata = buildProductLocalPickupMetadata(eventMarket, {
        handoffMode: "organizer_handoff",
      })
    } else {
      const existingProjection = existing
        ? getProductFulfillmentProjection(existing.product, eventMarket)
        : null
      const existingPickupCoordinate =
        existingProjection?.handoffMode === "merchant_handoff"
          ? existingProjection.pickupCoordinate
          : undefined
      const pickupDTag = existingPickupCoordinate
        ? existingPickupCoordinate.split(":").slice(2).join(":")
        : `${dTag}-event-pickup`
      merchantBoothPickupInput = {
        authorPubkey: signerPubkey,
        dTag: pickupDTag,
        title: form.merchantPickupTitle.trim(),
        location: form.merchantPickupLocation.trim() || undefined,
        geohash: form.merchantPickupGeohash.trim() || undefined,
        country: form.merchantPickupCountry.trim().toUpperCase(),
      }
      shippingMetadata = buildProductLocalPickupMetadata(eventMarket, {
        handoffMode: "merchant_handoff",
        merchantPickupCoordinate: `${EVENT_KINDS.SHIPPING_OPTION}:${signerPubkey}:${pickupDTag}`,
      })
    }
  }
  const hasShippingZone =
    (shippingMetadata.shippingCountries?.length ?? 0) > 0 ||
    (shippingMetadata.shippingCountryRules?.length ?? 0) > 0
  if (
    form.fulfillment === "ship" &&
    typeof shippingCostAmount === "number" &&
    !hasShippingZone
  ) {
    throw new Error(
      form.usePresetShippingZone
        ? "Attach your preset shipping zone before publishing a physical product with a fixed shipping cost."
        : "Add at least one custom shipping destination before publishing a physical product with a fixed shipping cost."
    )
  }
  const summary = form.summary.trim()
  const imageUrl = form.imageUrl.trim()
  if (!imageUrl) {
    throw new Error("Image URL is required for Market-visible products")
  }
  if (!/^https:\/\//i.test(imageUrl)) {
    throw new Error("Image URL must start with https://")
  }

  const now = Date.now()
  const tags = formValidation.tags

  const product: ProductSchema = canonicalizeProductPrice({
    id: `30402:${signerPubkey}:${dTag}`,
    pubkey: signerPubkey,
    title,
    summary: summary || undefined,
    price: normalizedPrice,
    currency,
    type: "simple",
    parentProductId: undefined,
    specifications: [],
    format: isDigital ? "digital" : "physical",
    ...shippingCost,
    ...shippingMetadata,
    visibility: "public",
    stock: parseProductStockInput(form.stock),
    images: [{ url: imageUrl }],
    tags,
    publicZapEnabled: form.publicZapEnabled,
    zapMessagePolicy: form.zapMessagePolicy,
    publicZapPolicyKnown: true,
    location: undefined,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  })

  const plan = buildProductFamilyChangePlan({
    parentDTag: dTag,
    baseProduct: product,
    variations: form.variations,
    currency,
    fulfillmentIntent: publicationFulfillment.intent,
    authoringCountries: publicationFulfillment.authoringCountries,
    existing: existing
      ? {
          root: existing,
          variations: existing.variations,
          orphanVariation: existing.orphanVariation,
        }
      : undefined,
    now,
  })

  const listings = plan.publish.map((target) => ({
    product: target.product,
    dTag: target.dTag,
    previousEventCreatedAt: target.existing?.eventCreatedAt,
    fulfillmentIntent: target.fulfillmentIntent,
  }))
  const deletions = buildProductRemovalDeletionTargets(plan.remove)
  const bundleSignerRequestTotal = getProductSignerRequestCount({
    listings,
    deletions,
  })
  let signerRequestOffset = 0
  if (merchantBoothPickupInput) {
    await ensureMerchantBoothPickup({
      ...merchantBoothPickupInput,
      onSignerRequest: () => {
        signerRequestOffset = 1
        onSignerRequest?.({
          kind: "shipping",
          current: 1,
          total: bundleSignerRequestTotal + 1,
        })
      },
    })
  }

  return signAndPublishProductWriteBundle({
    merchantPubkey,
    listings,
    deletions,
    onSignerRequest: (progress) =>
      onSignerRequest?.({
        ...progress,
        current: progress.current + signerRequestOffset,
        total: progress.total + signerRequestOffset,
      }),
    onSignerRequestsComplete,
    onSignedLocal: async (bundle) => {
      const rootPublishIndex = plan.publish.findIndex(
        (target) => target.dTag === dTag
      )
      const rootEventId =
        rootPublishIndex >= 0
          ? bundle.events[rootPublishIndex]?.id
          : plan.desired[0]?.existing?.eventId
      if (!rootEventId) {
        throw new Error("Published product root event is missing")
      }
      await onSignedLocal(bundle, {
        merchantPubkey,
        productAddressId: plan.desired[0]!.product.id,
        rootEventId,
      })
    },
  })
}

async function deleteProduct(
  merchantPubkey: string,
  product: MerchantProductFamily,
  onSignedLocal: (event: NDKEvent, deliveryJobId: string) => Promise<void>,
  onSignerRequest?: (progress: ProductSignerRequestProgress) => void
): Promise<{ delivery: PublishWithPlannerResult; deliveryJobId: string }> {
  const ndk = getNdk()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = (await ndk.signer.user()).pubkey
  if (signerPubkey !== merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }
  const familyRecords = [product, ...product.variations]
  if (
    familyRecords.some((record) => record.product.pubkey !== merchantPubkey)
  ) {
    throw new Error(
      "Product pubkey mismatch; refusing to publish deletion event"
    )
  }
  const draft = buildProductDeletionEventDraft({
    merchantPubkey,
    targets: familyRecords.map((record) => ({
      eventId: record.eventId,
      addressId: record.dTag ? record.addressId : undefined,
    })),
    clientAppId: "merchant",
  })
  const currentWriteRelayUrls =
    await planCurrentProductDeletionWriteRelays(merchantPubkey)

  const deletion = new NDKEvent(ndk)
  deletion.kind = EVENT_KINDS.DELETION
  deletion.created_at = Math.floor(Date.now() / 1000)
  deletion.tags = draft.tags
  deletion.content = draft.content

  onSignerRequest?.({ kind: "deletion", current: 1, total: 1 })
  await waitForVisibleDocument()
  await deletion.sign(ndk.signer)
  const deliveryJob = await persistSignedProductDeletion({
    signedEvent: deletion.rawEvent(),
    currentWriteRelayUrls,
    sourceRelayUrls: Array.from(
      new Set(familyRecords.flatMap((record) => record.sourceRelayUrls))
    ),
  })
  await cacheSignedProductDeletionEvent(deletion)
  try {
    await onSignedLocal(deletion, deliveryJob.id)
    return {
      delivery: await deliverQueuedProductDeletion(deliveryJob.id),
      deliveryJobId: deliveryJob.id,
    }
  } catch (error) {
    throw error instanceof SignedProductDeliveryError
      ? error
      : new SignedProductDeliveryError(error)
  }
}

function ProductsPage() {
  const {
    pubkey,
    signer,
    status: authStatus,
    remoteSignerRecovery,
    connect,
    disconnect,
  } = useAuth()
  const session = useConduitSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const btcUsdRateQuery = useBtcUsdRate()
  const productDialogReturnFocusRef = useRef<HTMLElement | null>(null)
  const productDraftStoreRef = useRef(new ProductDraftStore())
  const productPublishStartedAtRef = useRef<number | null>(null)
  const productPublishInFlightRef = useRef(false)
  const editFulfillmentRequestRef = useRef(0)
  const signerRestoredNoticeRef = useRef<HTMLDivElement | null>(null)
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<MerchantProductFamily | null>(null)
  const [editFulfillmentResolution, setEditFulfillmentResolution] =
    useState<EditFulfillmentResolution>("ready")
  const [editFulfillmentMarket, setEditFulfillmentMarket] =
    useState<MerchantOrganizerEventMarket | null>(null)
  const [productDialogOpen, setProductDialogOpen] = useState(false)
  const [activeProductDraftTarget, setActiveProductDraftTarget] =
    useState<ProductDraftTarget | null>(null)
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedTag, setSelectedTag] = useState("all")
  const [sortOrder, setSortOrder] = useState<ProductSort>("updated_desc")
  const [productDeliveryNotice, setProductDeliveryNotice] =
    useState<ProductDeliveryNotice | null>(null)
  const [productDeliveryRetry, setProductDeliveryRetry] =
    useState<ProductDeliveryRetryState | null>(null)
  const [productSignerProgress, setProductSignerProgress] =
    useState<ProductSignerRequestProgress | null>(null)
  const [productSignerRequestsComplete, setProductSignerRequestsComplete] =
    useState(false)
  const [pendingProductPublish, setPendingProductPublish] =
    useState<ProductPublishMutationPayload | null>(null)
  const [signerRestoredForDraft, setSignerRestoredForDraft] = useState(false)
  const [signerChangePending, setSignerChangePending] = useState(false)
  const [signerChangeError, setSignerChangeError] = useState<string | null>(
    null
  )

  const draftOwnerPubkey = activeProductDraftTarget?.merchantPubkey ?? null
  const signerReady =
    authStatus === "connected" &&
    !!signer &&
    !remoteSignerRecovery &&
    isProductDraftOwnedBySigner(activeProductDraftTarget, pubkey)

  useEffect(() => {
    if (signerRestoredForDraft) signerRestoredNoticeRef.current?.focus()
  }, [signerRestoredForDraft])

  // Product publishing stays permissive. This readiness check only provides
  // guidance before a new listing; it never changes order delivery routing.
  const inboxReadinessEnabled =
    !!pubkey && productDialogOpen && !editing && session.relaySettingsReady
  const inboxReadiness = useInboxDeclaration(pubkey, {
    enabled: inboxReadinessEnabled,
    relayScope: session.relayScope,
  })

  const productsQuery = useQuery({
    queryKey: ["merchant-products-live", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchMerchantProducts(pubkey!),
    refetchInterval: 15_000,
  })
  const localPickupQuery = useQuery({
    queryKey: [
      "merchant-product-event-market",
      form.eventMarketReference || "none",
    ],
    enabled:
      productDialogOpen &&
      form.fulfillment === "local_pickup" &&
      !!form.eventMarketReference,
    queryFn: () => resolveOrganizerEventMarket(form.eventMarketReference),
    retry: false,
    staleTime: 15_000,
  })
  const organizerEventMarketsQuery = useQuery({
    queryKey: ["merchant-product-organizer-events", pubkey ?? "none"],
    enabled:
      productDialogOpen && form.fulfillment === "local_pickup" && !!pubkey,
    queryFn: () => listOrganizerEventMarkets(pubkey!),
    retry: false,
    staleTime: 15_000,
  })
  const organizerInboxQuery = useQuery({
    queryKey: [
      "merchant-product-organizer-inbox",
      localPickupQuery.data?.organizerPubkey ?? "none",
    ],
    enabled:
      productDialogOpen &&
      form.fulfillment === "local_pickup" &&
      !!localPickupQuery.data?.organizerPubkey,
    queryFn: () =>
      resolveEventMarketOrganizerInbox(localPickupQuery.data!.organizerPubkey),
    retry: false,
    staleTime: 30_000,
  })
  const cachedProductsQuery = useQuery({
    queryKey: ["merchant-products", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchCachedMerchantProducts(pubkey!),
    staleTime: 5_000,
  })
  const pendingDeletionJobsQuery = useQuery({
    queryKey: ["merchant-product-deletion-jobs", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => getPendingProductDeletionJobs(pubkey!),
    refetchInterval: 5_000,
  })
  const pendingDeletionJobs = useMemo<ProductDeletionDeliveryJob[]>(
    () => pendingDeletionJobsQuery.data ?? [],
    [pendingDeletionJobsQuery.data]
  )
  const merchantProductRecords = useMemo(
    () => productsQuery.data?.data ?? cachedProductsQuery.data?.data ?? [],
    [cachedProductsQuery.data?.data, productsQuery.data?.data]
  )
  const merchantProductReadMeta =
    productsQuery.data?.meta ?? cachedProductsQuery.data?.meta
  const merchantProductReadIncomplete =
    isCommerceReadIncomplete(merchantProductReadMeta) ||
    !!productsQuery.error ||
    productsQuery.isPaused
  const merchantProducts = useMemo<MerchantProductFamily[]>(
    () =>
      // Group at the read boundary so edit and delete always operate on the
      // same complete variation family shown to the merchant.
      groupProductVariationRecords(merchantProductRecords).map((family) => {
        const variationForm = getProductVariationFormState(
          family.root,
          family.variations
        )
        const hasFamilyImage = [family.root, ...family.variations].some(
          (record) => getProductImageCandidates(record.product).length > 0
        )
        const safety =
          family.root.product.type === "variable" && variationForm.supported
            ? evaluateListingSafety(family.root.product, undefined, {
                variationGroupRole: "parent",
                hasGroupImage: hasFamilyImage,
              })
            : family.root.safety
        const prepared = prepareProductCatalog(
          [family.root, ...family.variations],
          {
            source: merchantProductReadMeta?.source ?? "local_cache",
            fetchedAt: merchantProductReadMeta?.fetchedAt ?? Date.now(),
            stale: merchantProductReadMeta?.stale ?? true,
            degraded: merchantProductReadMeta?.degraded ?? true,
            capped: merchantProductReadMeta?.capped ?? false,
          }
        ).items[0]

        return {
          ...family.root,
          safety,
          variations: family.variations,
          orphanVariation: family.orphanVariation,
          variationForm,
          family: prepared?.kind === "family" ? prepared.family : undefined,
        }
      }),
    [merchantProductReadMeta, merchantProductRecords]
  )
  const shippingConfig = loadShippingConfig(pubkey)
  const hasPresetShippingZone = isShippingComplete(shippingConfig)

  async function refreshProductQueries(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["merchant-products", pubkey ?? "none"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-products-live", pubkey ?? "none"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-product-deletion-jobs", pubkey ?? "none"],
      }),
    ])
  }

  async function showLocalProductProjection(
    action: ProductWriteAction,
    merchantPubkey: string
  ): Promise<void> {
    const localResult = await fetchCachedMerchantProducts(merchantPubkey)
    queryClient.setQueryData(["merchant-products", merchantPubkey], localResult)
    queryClient.setQueryData(
      ["merchant-products-live", merchantPubkey],
      localResult
    )
    setProductDeliveryNotice(buildLocalProductDeliveryNotice(action))
  }

  function productPublishPayloadIsAuthorized(
    payload: ProductPublishMutationPayload
  ): boolean {
    if (
      !isProductDraftPublishAuthorized(
        activeProductDraftTarget,
        pubkey,
        payload.merchantPubkey
      )
    ) {
      return false
    }
    if (!payload.existing) return true
    return [payload.existing, ...payload.existing.variations].every(
      (record) => record.product.pubkey === payload.merchantPubkey
    )
  }

  function completeLocalProductSave(
    variables: ProductPublishMutationPayload,
    authoringTarget: ProductVariationAuthoringTarget
  ): void {
    const draftCleared = productDraftStoreRef.current.clear(
      getProductDraftTarget(
        variables.merchantPubkey,
        variables.existing ?? null
      )
    )
    const authoringSaved = saveProductVariationAuthoringState(
      authoringTarget,
      variables.form.variations
    )
    editFulfillmentRequestRef.current += 1
    setEditing(null)
    setEditFulfillmentResolution("ready")
    setEditFulfillmentMarket(null)
    setActiveProductDraftTarget(null)
    setForm(createEmptyProductForm(hasPresetShippingZone))
    setProductDialogOpen(false)
    setDraftStorageAvailable(draftCleared && authoringSaved)
  }

  const saveMutation = useMutation({
    mutationFn: async (payload: ProductPublishMutationPayload) => {
      if (payload.signedBundle) {
        return deliverSignedProductWriteBundle(
          payload.signedBundle,
          payload.merchantPubkey
        )
      }

      if (!productPublishPayloadIsAuthorized(payload)) {
        throw new Error(
          "The product draft belongs to a different merchant account. Reconnect that account before publishing."
        )
      }

      return publishProduct(
        payload.merchantPubkey,
        payload.form,
        payload.dTag,
        async (signedBundle, authoringTarget) => {
          setProductDeliveryRetry({
            action: "publish",
            payload: { ...payload, signedBundle },
          })
          completeLocalProductSave(payload, authoringTarget)
          await showLocalProductProjection("publish", payload.merchantPubkey)
        },
        payload.existing,
        setProductSignerProgress,
        () => {
          setProductSignerProgress(null)
          setProductSignerRequestsComplete(true)
        }
      )
    },
    onMutate: (payload) => {
      productPublishStartedAtRef.current = Date.now()
      setProductSignerProgress(null)
      setProductSignerRequestsComplete(!!payload.signedBundle)
      if (!payload.signedBundle) setProductDeliveryRetry(null)
      setProductDeliveryNotice(
        payload.signedBundle ? buildLocalProductDeliveryNotice("publish") : null
      )
    },
    onSuccess: async (data, variables) => {
      const notice = buildProductDeliveryNotice(
        "publish",
        data,
        variables.previousNotice
      )
      recordBrowserTelemetryEvent({
        app: "merchant",
        eventName: "product_publish_result",
        properties: buildProductPublishResultTelemetryProperties({
          eventFamily: variables.signedBundle
            ? "delivery_retry"
            : variables.existing
              ? "update"
              : "create",
          latencyMs:
            Date.now() - (productPublishStartedAtRef.current ?? Date.now()),
          status: notice.failedRelayUrls.length === 0 ? "success" : "failure",
        }),
      })
      productPublishStartedAtRef.current = null
      setProductSignerProgress(null)
      setProductSignerRequestsComplete(false)
      setProductDeliveryNotice(notice)
      if (notice.failedRelayUrls.length === 0) setProductDeliveryRetry(null)
      await refreshProductQueries()
    },
    onError: async (error, variables) => {
      recordBrowserTelemetryEvent({
        app: "merchant",
        eventName: "product_publish_result",
        properties: buildProductPublishResultTelemetryProperties({
          eventFamily: variables.signedBundle
            ? "delivery_retry"
            : variables.existing
              ? "update"
              : "create",
          latencyMs:
            Date.now() - (productPublishStartedAtRef.current ?? Date.now()),
          status: "failure",
        }),
      })
      productPublishStartedAtRef.current = null
      setProductSignerProgress(null)
      setProductSignerRequestsComplete(false)
      const diagnosticsError = getRelayPublishDiagnosticsError(error)
      if (diagnosticsError) {
        setProductDeliveryNotice(
          buildProductDeliveryNotice(
            "publish",
            diagnosticsError.diagnostics,
            variables.previousNotice
          )
        )
      } else if (error instanceof SignedProductDeliveryError) {
        setProductDeliveryNotice(
          variables.previousNotice ?? buildLocalProductRetryNotice("publish")
        )
      } else {
        setProductDeliveryNotice((current) =>
          current?.action === "publish" && current.state === "delivering"
            ? buildLocalProductRetryNotice("publish")
            : current
        )
      }
      await refreshProductQueries()
    },
    onSettled: () => {
      productPublishInFlightRef.current = false
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (payload: ProductDeleteMutationPayload) => {
      if (payload.deliveryJobId) {
        return {
          delivery: await deliverQueuedProductDeletion(payload.deliveryJobId),
          deliveryJobId: payload.deliveryJobId,
        }
      }
      if (!payload.product)
        throw new Error("Product deletion target is missing")

      return deleteProduct(
        pubkey!,
        payload.product,
        async (_event, deliveryJobId) => {
          setProductDeliveryRetry({
            action: "delete",
            payload: { ...payload, deliveryJobId },
          })
          await showLocalProductProjection("delete", pubkey!)
        },
        setProductSignerProgress
      )
    },
    onMutate: (payload) => {
      setProductSignerProgress(null)
      if (!payload.deliveryJobId) setProductDeliveryRetry(null)
      setProductDeliveryNotice(
        payload.deliveryJobId
          ? buildQueuedProductDeletionNotice("delivering")
          : null
      )
    },
    onSuccess: async (data, variables) => {
      const { product } = variables
      setProductSignerProgress(null)
      if (product) {
        const draftCleared = productDraftStoreRef.current.clear(
          getProductDraftTarget(product.product.pubkey, product)
        )
        const authoringCleared = clearProductVariationAuthoringState(
          getProductVariationAuthoringTarget(product.product.pubkey, product)
        )
        if (activeProductDraftTarget?.productAddressId === product.addressId) {
          setEditing(null)
          setActiveProductDraftTarget(null)
          setForm(createEmptyProductForm(hasPresetShippingZone))
          setDraftStorageAvailable(draftCleared && authoringCleared)
        }
      }
      const notice = buildProductDeliveryNotice(
        "delete",
        data.delivery,
        variables.previousNotice
      )
      setProductDeliveryNotice(notice)
      if (notice.failedRelayUrls.length === 0) setProductDeliveryRetry(null)
      await refreshProductQueries()
    },
    onError: async (error, variables) => {
      setProductSignerProgress(null)
      const diagnosticsError = getRelayPublishDiagnosticsError(error)
      if (diagnosticsError) {
        setProductDeliveryNotice(
          buildProductDeliveryNotice(
            "delete",
            diagnosticsError.diagnostics,
            variables.previousNotice
          )
        )
      } else if (error instanceof SignedProductDeliveryError) {
        setProductDeliveryNotice(
          variables.previousNotice ?? buildLocalProductRetryNotice("delete")
        )
      } else if (variables.deliveryJobId) {
        setProductDeliveryNotice(
          variables.previousNotice ??
            buildQueuedProductDeletionNotice("retry_needed")
        )
      } else {
        setProductDeliveryNotice((current) =>
          current?.action === "delete" && current.state === "delivering"
            ? buildLocalProductRetryNotice("delete")
            : current
        )
      }
      await refreshProductQueries()
    },
  })

  useEffect(() => {
    if (deleteMutation.isPending) return
    const job = pendingDeletionJobs.at(-1)
    if (!job) {
      setProductDeliveryRetry((current) =>
        current?.action === "delete" ? null : current
      )
      setProductDeliveryNotice((current) =>
        current?.action === "delete" &&
        (current.state === "partial" ||
          current.state === "retry_needed" ||
          current.state === "delivering")
          ? null
          : current
      )
      return
    }

    setProductDeliveryRetry((current) =>
      reconcilePendingProductDeletionRetry<ProductDeliveryRetryState>(current, {
        action: "delete",
        payload: { deliveryJobId: job.id },
      })
    )
    setProductDeliveryNotice((current) => {
      if (current?.action === "publish") return current
      return job.deliveryAttemptCount === 0
        ? buildQueuedProductDeletionNotice("retry_needed")
        : buildProductDeliveryNotice(
            "delete",
            productDeletionJobToPublishResult(job)
          )
    })
  }, [deleteMutation.isPending, pendingDeletionJobs])

  const productDeliveryCanRetry =
    (productDeliveryNotice?.state === "partial" ||
      productDeliveryNotice?.state === "retry_needed") &&
    productDeliveryRetry?.action === productDeliveryNotice.action

  function startProductSave(payload: ProductPublishMutationPayload): void {
    if (productPublishInFlightRef.current) return
    productPublishInFlightRef.current = true
    saveMutation.mutate(payload)
  }

  function retryProductDelivery(): void {
    if (productDeliveryRetry?.action === "delete") {
      if (productDeliveryRetry.payload.deliveryJobId) {
        deleteMutation.mutate({
          ...productDeliveryRetry.payload,
          previousNotice: productDeliveryNotice ?? undefined,
        })
      }
      return
    }

    if (
      productDeliveryRetry?.action === "publish" &&
      productDeliveryRetry.payload.signedBundle
    ) {
      startProductSave({
        ...productDeliveryRetry.payload,
        previousNotice: productDeliveryNotice ?? undefined,
      })
    }
  }

  const isSaving = saveMutation.isPending
  const isDeleting = deleteMutation.isPending
  const editFulfillmentChoiceRequired =
    editFulfillmentResolution === "resolving" ||
    editFulfillmentResolution === "unresolved"
  const savedProductForm = useMemo(
    () =>
      editing
        ? productToForm(editing, hasPresetShippingZone, editFulfillmentMarket)
        : createEmptyProductForm(hasPresetShippingZone),
    [editing, hasPresetShippingZone, editFulfillmentMarket]
  )
  const hasProductChanges = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedProductForm),
    [form, savedProductForm]
  )
  useEffect(() => {
    if (!productDialogOpen || !activeProductDraftTarget) return
    if (editing && editFulfillmentChoiceRequired) return

    if (!hasProductChanges) {
      setDraftStorageAvailable(
        productDraftStoreRef.current.clear(activeProductDraftTarget)
      )
      return
    }

    setDraftStorageAvailable(
      productDraftStoreRef.current.save(activeProductDraftTarget, form)
    )
  }, [
    activeProductDraftTarget,
    editFulfillmentChoiceRequired,
    editing,
    form,
    hasProductChanges,
    productDialogOpen,
  ])
  const localPickupEvidenceError =
    form.fulfillment === "local_pickup"
      ? getProductLocalPickupEvidenceError({
          reference: form.eventMarketReference,
          market: localPickupQuery.data,
          handoffMode: form.eventHandoffMode,
          resolving: localPickupQuery.isFetching,
          readFailed: localPickupQuery.isError,
        })
      : null
  const merchantBoothPickupError =
    form.fulfillment === "local_pickup" &&
    form.eventHandoffMode === "merchant_handoff" &&
    localPickupQuery.data
      ? getMerchantBoothPickupFormError({
          title: form.merchantPickupTitle,
          location: form.merchantPickupLocation,
          geohash: form.merchantPickupGeohash,
          country: form.merchantPickupCountry,
        })
      : null
  const organizerInboxState = !localPickupQuery.data
    ? ("idle" as const)
    : organizerInboxQuery.isFetching || organizerInboxQuery.isPending
      ? ("checking" as const)
      : organizerInboxQuery.data?.state === "ready"
        ? ("ready" as const)
        : ("unavailable" as const)
  useEffect(() => {
    if (
      editFulfillmentResolution === "verifying_pickup" &&
      form.fulfillment === "local_pickup" &&
      !localPickupEvidenceError
    ) {
      setEditFulfillmentResolution("ready")
    }
  }, [editFulfillmentResolution, form.fulfillment, localPickupEvidenceError])
  const unresolvedEditFulfillmentError = editing
    ? editFulfillmentResolution === "resolving"
      ? "Verifying the listing's existing event and shipping evidence before editing."
      : editFulfillmentResolution === "unresolved"
        ? "Existing event and shipping evidence is ambiguous or unavailable. Choose shipping explicitly, or verify local pickup before editing."
        : editFulfillmentResolution === "verifying_pickup"
          ? "Verify current local-pickup evidence, or choose shipping explicitly."
          : null
    : null
  const productFulfillmentError =
    localPickupEvidenceError ??
    merchantBoothPickupError ??
    unresolvedEditFulfillmentError
  const zeroPriceFormAuthorized = canUseZeroProductPrice({
    fulfillment: form.fulfillment,
    handoffMode: form.eventHandoffMode,
    evidenceVerified:
      form.fulfillment === "local_pickup" &&
      !!localPickupQuery.data &&
      !productFulfillmentError,
  })
  const productFormValidation = useMemo(() => {
    const validation = validateProductPublishForm(
      form.fulfillment === "local_pickup"
        ? { ...form, shippingPricingMode: "coordinate_after_order" }
        : form,
      {
        hasPresetShippingZone,
        presetShippingConfig: shippingConfig,
        allowZeroPrice: zeroPriceFormAuthorized,
      }
    )
    return productFulfillmentError
      ? {
          ...validation,
          canPublish: false,
          firstError: validation.firstError ?? productFulfillmentError,
        }
      : validation
  }, [
    form,
    hasPresetShippingZone,
    productFulfillmentError,
    shippingConfig,
    zeroPriceFormAuthorized,
  ])
  const productTagFieldError =
    productFormValidation.errors.tags &&
    (productFormValidation.tags.length > MAX_PRODUCT_TAG_COUNT ||
      productFormValidation.tags.some(
        (tag) => tag.length > MAX_PRODUCT_TAG_LENGTH
      ))
      ? productFormValidation.errors.tags
      : null
  const productCanSubmit = canSubmitProductForm(productFormValidation, {
    isEditing: !!editing,
    hasProductChanges,
  })
  const productStatusMessage = !productFormValidation.canPublish
    ? productFormValidation.firstError
    : editing
      ? form.variations.enabled
        ? "Save changes to publish only the parent or variations that changed."
        : "Save changes to publish this listing update."
      : "Publish this product to add it to your store."
  const productsInitialLoading =
    !!pubkey && productsQuery.isPending && cachedProductsQuery.isPending

  const tagFilters = useMemo(
    () => buildProductTagCatalog(merchantProducts.map((item) => item.product)),
    [merchantProducts]
  )

  const visibleProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const filtered = merchantProducts.filter((item) => {
      const tagMatch =
        selectedTag === "all" || item.product.tags.includes(selectedTag)
      if (!tagMatch) return false
      if (!query) return true

      const haystack = [
        item.product.title,
        item.product.summary ?? "",
        item.product.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(query)
    })

    return filtered.slice().sort((a, b) => {
      switch (sortOrder) {
        case "title_asc":
          return a.product.title.localeCompare(b.product.title)
        case "price_asc":
          return (
            (a.family?.priceSummary.minimum?.product.priceSats ??
              a.family?.priceSummary.minimum?.product.price ??
              a.product.priceSats ??
              a.product.price) -
            (b.family?.priceSummary.minimum?.product.priceSats ??
              b.family?.priceSummary.minimum?.product.price ??
              b.product.priceSats ??
              b.product.price)
          )
        case "price_desc":
          return (
            (b.family?.priceSummary.minimum?.product.priceSats ??
              b.family?.priceSummary.minimum?.product.price ??
              b.product.priceSats ??
              b.product.price) -
            (a.family?.priceSummary.minimum?.product.priceSats ??
              a.family?.priceSummary.minimum?.product.price ??
              a.product.priceSats ??
              a.product.price)
          )
        case "updated_desc":
          return b.eventCreatedAt - a.eventCreatedAt
      }
    })
  }, [merchantProducts, searchQuery, selectedTag, sortOrder])

  const itemCountLabel = useMemo(() => {
    const count = merchantProducts.length
    return `${count} listing${count === 1 ? "" : "s"}`
  }, [merchantProducts])

  const productStatusLabel = productsQuery.isFetching
    ? "Updating listings"
    : `${visibleProducts.length} of ${merchantProducts.length} listings`
  const productVariationCombinations = useMemo(
    () => getProductVariationCombinations(form.variations),
    [form.variations]
  )
  const productVariationMatrix = useMemo(
    () => getProductVariationMatrix(form.variations),
    [form.variations]
  )
  const productVariationRemovalCount = useMemo(
    () => getProductVariationRemovalCount(form.variations, editing?.variations),
    [editing?.variations, form.variations]
  )
  const productVariationCartesianCount = useMemo(
    () => getProductVariationCartesianCount(form.variations),
    [form.variations]
  )
  const productVariationGenerationMessage =
    productVariationCartesianCount > MAX_PRODUCT_VARIATION_COUNT
      ? `These options create ${productVariationCartesianCount} combinations. Reduce the values to review at most ${MAX_PRODUCT_VARIATION_COUNT}; existing available combinations are preserved.`
      : null
  const productIsDigital = form.fulfillment === "digital"
  const productIsLocalPickup = form.fulfillment === "local_pickup"
  const productCoordinatesShipping =
    form.fulfillment === "ship" &&
    form.shippingPricingMode === "coordinate_after_order"
  const customShippingZoneActive =
    form.fulfillment === "ship" &&
    !productCoordinatesShipping &&
    (!hasPresetShippingZone || !form.usePresetShippingZone)
  const presetShippingZoneUnavailable =
    form.fulfillment !== "ship" ||
    productCoordinatesShipping ||
    !hasPresetShippingZone
  const localPickupParticipation = getProductEventParticipationState(
    editing?.product ?? null,
    localPickupQuery.data ?? null
  )

  function persistCurrentProductDraft(): boolean {
    if (editing && editFulfillmentChoiceRequired) return true
    if (!activeProductDraftTarget || !hasProductChanges) return true
    const saved = productDraftStoreRef.current.save(
      activeProductDraftTarget,
      form
    )
    setDraftStorageAvailable(saved)
    return saved
  }

  function requestProductPublish(payload: ProductPublishMutationPayload): void {
    if (
      isSaving ||
      !signerReady ||
      !productPublishPayloadIsAuthorized(payload)
    ) {
      return
    }
    setSignerRestoredForDraft(false)
    if (
      !needsProductInboxPublishGuidance(
        inboxReadiness.status,
        !!payload.existing,
        inboxReadinessEnabled
      )
    ) {
      startProductSave(payload)
      return
    }

    setPendingProductPublish(payload)
  }

  function publishPendingProduct(): void {
    if (
      !pendingProductPublish ||
      isSaving ||
      !signerReady ||
      !productPublishPayloadIsAuthorized(pendingProductPublish)
    ) {
      return
    }
    const payload = pendingProductPublish
    setSignerRestoredForDraft(false)
    setPendingProductPublish(null)
    startProductSave(payload)
  }

  function openPrivateInboxSetup(): void {
    if (!persistCurrentProductDraft()) {
      setPendingProductPublish(null)
      return
    }

    setPendingProductPublish(null)
    setProductDialogOpen(false)
    saveMutation.reset()
    void navigate({ to: "/network" })
  }

  function rememberProductDialogTrigger(): void {
    const activeElement = document.activeElement
    productDialogReturnFocusRef.current =
      activeElement instanceof HTMLElement ? activeElement : null
  }

  function requestCloseProductDialog(): void {
    if (isSaving) return
    editFulfillmentRequestRef.current += 1
    persistCurrentProductDraft()
    setPendingProductPublish(null)
    setProductDialogOpen(false)
    setSignerRestoredForDraft(false)
    saveMutation.reset()
  }

  function discardProductChanges(): void {
    if (
      hasProductChanges &&
      !window.confirm(
        editing
          ? `Discard unpublished changes to "${form.title || editing.product.title}"?`
          : "Discard this unpublished product draft?"
      )
    ) {
      return
    }

    if (activeProductDraftTarget) {
      const cleared = productDraftStoreRef.current.clear(
        activeProductDraftTarget
      )
      if (!cleared) {
        setDraftStorageAvailable(false)
        return
      }
    }
    editFulfillmentRequestRef.current += 1
    setPendingProductPublish(null)
    setProductDialogOpen(false)
    setEditing(null)
    setEditFulfillmentResolution("ready")
    setEditFulfillmentMarket(null)
    setActiveProductDraftTarget(null)
    setForm(createEmptyProductForm(hasPresetShippingZone))
    setDraftStorageAvailable(true)
    setSignerRestoredForDraft(false)
    saveMutation.reset()
  }

  async function reconnectProductSigner(): Promise<void> {
    setSignerChangeError(null)
    await connect({ mode: "restore" })
    saveMutation.reset()
    setSignerRestoredForDraft(true)
  }

  async function useDifferentProductSigner(): Promise<void> {
    setSignerChangeError(null)
    if (!persistCurrentProductDraft()) return

    setSignerChangePending(true)
    try {
      await disconnect()
    } catch {
      setSignerChangeError(
        "Your draft is saved, but the old signer connection could not be retired safely. Try again before connecting another signer."
      )
    } finally {
      setSignerChangePending(false)
    }
  }

  function openCreateDialog(): void {
    rememberProductDialogTrigger()
    setSignerRestoredForDraft(false)
    saveMutation.reset()
    if (
      activeProductDraftTarget &&
      activeProductDraftTarget.merchantPubkey === pubkey &&
      !activeProductDraftTarget.productAddressId &&
      !editing &&
      hasProductChanges
    ) {
      setProductDialogOpen(true)
      return
    }

    if (!persistCurrentProductDraft()) {
      setProductDialogOpen(true)
      return
    }
    const emptyForm = createEmptyProductForm(hasPresetShippingZone)
    const draftTarget = pubkey ? getProductDraftTarget(pubkey) : null
    const loaded = draftTarget
      ? productDraftStoreRef.current.load(draftTarget)
      : { draft: null, storageAvailable: false }
    editFulfillmentRequestRef.current += 1
    setEditing(null)
    setEditFulfillmentResolution("ready")
    setEditFulfillmentMarket(null)
    setActiveProductDraftTarget(draftTarget)
    setForm(
      loaded.draft
        ? reconcileProductFormShippingPreset(
            loaded.draft,
            hasPresetShippingZone
          )
        : emptyForm
    )
    setDraftStorageAvailable(loaded.storageAvailable)
    setProductDialogOpen(true)
  }

  function openEditDialog(item: MerchantProductFamily): void {
    if (!item.variationForm.supported) return
    rememberProductDialogTrigger()
    setSignerRestoredForDraft(false)
    saveMutation.reset()
    if (
      activeProductDraftTarget?.productAddressId === item.addressId &&
      activeProductDraftTarget.baseEventId === item.eventId &&
      editing?.addressId === item.addressId &&
      hasProductChanges
    ) {
      setProductDialogOpen(true)
      return
    }

    if (!persistCurrentProductDraft()) {
      setProductDialogOpen(true)
      return
    }
    const draftTarget = pubkey ? getProductDraftTarget(pubkey, item) : null
    const loaded = draftTarget
      ? productDraftStoreRef.current.load(draftTarget)
      : { draft: null, storageAvailable: false }
    const authored = pubkey
      ? loadProductVariationAuthoringState(
          getProductVariationAuthoringTarget(pubkey, item)
        )
      : { state: null, storageAvailable: false }
    const editingItem = authored.state
      ? {
          ...item,
          variationForm: mergeProductVariationAuthoringState(
            item.variationForm,
            authored.state
          ),
        }
      : item
    const loadedDraft = loaded.draft
      ? {
          ...loaded.draft,
          variations: reconcileProductVariationDraftResolution(
            item.variationForm,
            loaded.draft.variations
          ),
        }
      : null
    const requestId = editFulfillmentRequestRef.current + 1
    editFulfillmentRequestRef.current = requestId
    const restoredForm = loadedDraft
      ? reconcileProductFormShippingPreset(loadedDraft, hasPresetShippingZone)
      : null
    const projection = getProductFulfillmentProjection(item.product)
    setEditing(editingItem)
    setEditFulfillmentMarket(null)
    setActiveProductDraftTarget(draftTarget)
    setForm(restoredForm ?? productToForm(editingItem, hasPresetShippingZone))
    setEditFulfillmentResolution(
      projection.verification === "required"
        ? "resolving"
        : projection.verification === "ambiguous"
          ? "unresolved"
          : "ready"
    )

    if (
      projection.verification === "required" &&
      projection.eventMarketReference
    ) {
      void resolveOrganizerEventMarket(projection.eventMarketReference)
        .then((market) => {
          if (editFulfillmentRequestRef.current !== requestId) return
          const hydrated = getProductFulfillmentProjection(item.product, market)
          if (hydrated.verification !== "verified") {
            setEditFulfillmentResolution("unresolved")
            return
          }

          setEditFulfillmentMarket(market)
          if (
            restoredForm &&
            (restoredForm.fulfillment !== hydrated.intent ||
              (hydrated.handoffMode !== undefined &&
                restoredForm.eventHandoffMode !== hydrated.handoffMode))
          ) {
            setEditFulfillmentResolution("unresolved")
            return
          }
          if (!restoredForm) {
            setForm((current) => ({
              ...current,
              fulfillment: hydrated.intent,
              eventMarketReference: hydrated.eventMarketReference,
              eventHandoffMode:
                hydrated.handoffMode ?? current.eventHandoffMode,
            }))
          }
          setEditFulfillmentResolution("ready")
        })
        .catch(() => {
          if (editFulfillmentRequestRef.current === requestId) {
            setEditFulfillmentResolution("unresolved")
          }
        })
    }
    setDraftStorageAvailable(
      loaded.storageAvailable && authored.storageAvailable
    )
    setProductDialogOpen(true)
  }

  function chooseExistingProductShipping(): void {
    editFulfillmentRequestRef.current += 1
    setEditFulfillmentMarket(null)
    setEditFulfillmentResolution("ready")
    setForm((current) => ({
      ...current,
      format: "physical",
      fulfillment: "ship",
      eventMarketReference: "",
    }))
  }

  function verifyExistingProductLocalPickup(): void {
    editFulfillmentRequestRef.current += 1
    setEditFulfillmentMarket(null)
    setEditFulfillmentResolution("verifying_pickup")
    const candidateReference = editing
      ? getProductFulfillmentProjection(editing.product).eventMarketReference
      : ""
    setForm((current) => ({
      ...current,
      format: "physical",
      fulfillment: "local_pickup",
      eventMarketReference: current.eventMarketReference || candidateReference,
      usePresetShippingZone: false,
    }))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Products
          </h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-7 text-[var(--text-secondary)]">
            Create, update, and remove the products buyers see in your store.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge
            variant="secondary"
            className="border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
          >
            {itemCountLabel}
          </Badge>
          <Button onClick={openCreateDialog} disabled={!pubkey}>
            <Plus className="h-4 w-4" />
            Add product
          </Button>
        </div>
      </div>

      {!pubkey && (
        <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Connect your signer to create and manage listings.
        </div>
      )}

      <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-glass-inset)]">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search products"
              aria-label="Search products"
              className="pl-10"
            />
          </div>
          <Select value={selectedTag} onValueChange={setSelectedTag}>
            <SelectTrigger aria-label="Filter by tag">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {tagFilters.map(({ tag, count }) => (
                <SelectItem key={tag} value={tag}>
                  {tag} ({count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortOrder}
            onValueChange={(value) => setSortOrder(value as ProductSort)}
          >
            <SelectTrigger aria-label="Sort products">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated_desc">Newest</SelectItem>
              <SelectItem value="title_asc">Title A-Z</SelectItem>
              <SelectItem value="price_asc">Price low-high</SelectItem>
              <SelectItem value="price_desc">Price high-low</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {tagFilters.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant={selectedTag === "all" ? "secondary" : "outline"}
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => setSelectedTag("all")}
            >
              All
            </Button>
            {tagFilters.slice(0, 12).map(({ tag, count }) => (
              <Button
                key={tag}
                type="button"
                variant={selectedTag === tag ? "secondary" : "outline"}
                size="sm"
                className="h-8 max-w-full min-w-0 px-3 text-xs"
                onClick={() => setSelectedTag(tag)}
                title={tag}
              >
                <span className="min-w-0 max-w-[12rem] truncate">{tag}</span>
                <span className="shrink-0 font-mono text-[10px] opacity-80">
                  {count}
                </span>
              </Button>
            ))}
          </div>
        )}

        <div className="relative mt-3 flex min-h-8 items-center pr-44 text-xs text-[var(--text-muted)]">
          <span>{productStatusLabel}</span>
          <RefreshChip
            refreshing={productsQuery.isFetching}
            onRefresh={() => void productsQuery.refetch()}
            stale={merchantProductReadIncomplete}
            refreshingLabel="Updating listings..."
            className="absolute right-0 top-1/2 -translate-y-1/2"
          />
        </div>
        <SignedActionStatus
          state={
            isDeleting
              ? productDeliveryNotice?.action === "delete"
                ? "publishing"
                : "awaiting_signature"
              : deleteMutation.error
                ? "error"
                : "idle"
          }
          awaitingSignatureMessage={
            productSignerProgress?.kind === "deletion"
              ? getProductSignerRequestMessage(productSignerProgress)
              : "Confirm the deletion event in your signer. The listing will hide locally while relay delivery runs."
          }
          publishingMessage="The signed deletion is saved. Confirming its local tombstone before relay delivery."
          errorMessage={getPublishErrorMessage(deleteMutation.error, "delete")}
          className="mt-2"
        />
        {productDeliveryNotice && (
          <div className="mt-3">
            <ProductDeliveryStatusNotice
              notice={productDeliveryNotice}
              onDismiss={() => {
                setProductDeliveryNotice(null)
                setProductDeliveryRetry(null)
              }}
              onRetry={
                productDeliveryCanRetry ? retryProductDelivery : undefined
              }
            />
          </div>
        )}
      </section>

      <section className="space-y-4">
        {productsInitialLoading && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="min-h-[22rem] animate-pulse rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)]"
              />
            ))}
          </div>
        )}

        {productsQuery.error && (
          <div className="rounded-[1.4rem] border border-error/30 bg-error/10 p-4 text-sm text-error">
            Failed to load products:{" "}
            {productsQuery.error instanceof Error
              ? productsQuery.error.message
              : "Unknown error"}
          </div>
        )}

        {!productsInitialLoading && merchantProducts.length === 0 && (
          <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-secondary)]">
            <div className="text-lg font-semibold text-[var(--text-primary)]">
              No listings yet
            </div>
            <p className="mt-2 max-w-xl leading-6">
              Add your first product to publish a Market-visible listing from
              this signer.
            </p>
            <Button
              className="mt-4"
              onClick={openCreateDialog}
              disabled={!pubkey}
            >
              <Plus className="h-4 w-4" />
              Add product
            </Button>
          </div>
        )}

        {!productsInitialLoading &&
          merchantProducts.length > 0 &&
          visibleProducts.length === 0 && (
            <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
              No listings match the current search or category filter.
            </div>
          )}

        <div className="grid auto-rows-fr gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleProducts.map((item) => {
            const priceProduct =
              item.family?.priceSummary.minimum?.product ?? item.product
            const { primary, secondary } = getProductPriceDisplay(
              priceProduct,
              btcUsdRateQuery.data ?? null
            )
            const isConstrainedVariationFamily =
              item.product.type === "variable" &&
              item.variationForm.supported &&
              item.variations.length > 0

            if (!item.safety.marketVisible) {
              return (
                <div key={item.addressId} className="grid gap-2">
                  <ListingSafetySummary
                    item={item}
                    onEdit={
                      item.variationForm.supported
                        ? () => openEditDialog(item)
                        : undefined
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => {
                      const targetCount = 1 + item.variations.length
                      const ok = window.confirm(
                        targetCount > 1
                          ? `Delete "${item.product.title}" and its ${item.variations.length} variations?`
                          : `Delete "${item.product.title}"?`
                      )
                      if (ok) deleteMutation.mutate({ product: item })
                    }}
                  >
                    {isDeleting ? "..." : "Delete"}
                  </Button>
                </div>
              )
            }

            const isActive =
              item.safety.state === "active" || isConstrainedVariationFamily
            const zapBadge = getZapPolicyBadge(item.product)
            const stockDisplay = item.family
              ? getProductFamilyStockDisplay(item.family.inventorySummary)
              : getProductStockDisplay(item.product.stock)

            return (
              <div key={item.addressId} className="grid gap-2">
                {!isActive && (
                  <ListingSafetySummary
                    item={item}
                    onEdit={() => openEditDialog(item)}
                  />
                )}
                <ProductCard
                  title={item.product.title}
                  titleAside={
                    <div className="flex flex-col items-end gap-1">
                      {isActive && (
                        <StatusPill variant="success" className="text-[10px]">
                          {isConstrainedVariationFamily
                            ? `${item.variations.length} variants`
                            : "Active"}
                        </StatusPill>
                      )}
                      <StatusPill
                        variant={stockDisplay.variant}
                        className="text-[10px]"
                        noIcon={stockDisplay.variant === "neutral"}
                      >
                        {stockDisplay.label}
                      </StatusPill>
                      <DoubleSideStatusPill
                        left={zapBadge.left}
                        right={zapBadge.right}
                      />
                    </div>
                  }
                  merchantName="Your store"
                  images={getProductImageCandidates(item.product)}
                  primaryPrice={
                    item.family?.priceSummary.varies
                      ? `From ${primary}`
                      : primary
                  }
                  secondaryPrice={secondary}
                  imageLoading="lazy"
                  action={
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={!item.variationForm.supported}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (!item.variationForm.supported) return
                          openEditDialog(item)
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={isDeleting}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          const targetCount = 1 + item.variations.length
                          const ok = window.confirm(
                            targetCount > 1
                              ? `Delete "${item.product.title}" and its ${item.variations.length} variations?`
                              : `Delete "${item.product.title}"?`
                          )
                          if (ok) deleteMutation.mutate({ product: item })
                        }}
                      >
                        {isDeleting ? "..." : "Delete"}
                      </Button>
                    </div>
                  }
                />
              </div>
            )
          })}
        </div>
      </section>

      <Dialog
        open={productDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setProductDialogOpen(true)
            return
          }
          requestCloseProductDialog()
        }}
      >
        <DialogContent
          className={cn(
            "max-h-[90vh] overflow-y-auto",
            form.variations.enabled ? "sm:max-w-4xl" : "sm:max-w-2xl"
          )}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (isSaving) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const returnTarget = productDialogReturnFocusRef.current
            if (returnTarget?.isConnected) returnTarget.focus()
            productDialogReturnFocusRef.current = null
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? form.variations.enabled
                  ? "Edit product family"
                  : "Edit listing"
                : "Add product"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? form.variations.enabled
                  ? "Update the parent product and its size or color variations."
                  : "Update this product listing."
                : "Add a product to your store."}
            </DialogDescription>
          </DialogHeader>

          {editing && editFulfillmentChoiceRequired ? (
            <div
              className="grid gap-4 rounded-xl border border-warning/30 bg-warning/10 p-4"
              data-testid="product-fulfillment-resolution-guard"
            >
              <div className="grid gap-1.5">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {editFulfillmentResolution === "resolving"
                    ? "Verifying existing fulfillment"
                    : "Choose how this listing is fulfilled"}
                </p>
                <p
                  className="text-xs leading-5 text-[var(--text-secondary)]"
                  role="status"
                  aria-live="polite"
                >
                  {editFulfillmentResolution === "resolving"
                    ? "Checking the signed organizer collection and pickup option before this listing can be edited."
                    : "The existing collection and shipping references could not be classified safely. Confirm shipping to remove the event relationship, or verify a current local-pickup event before editing."}
                </p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestCloseProductDialog}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={chooseExistingProductShipping}
                >
                  Use shipping
                </Button>
                <Button
                  type="button"
                  onClick={verifyExistingProductLocalPickup}
                >
                  Verify local pickup
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (
                  isSaving ||
                  !draftOwnerPubkey ||
                  !signerReady ||
                  !productCanSubmit
                ) {
                  return
                }
                requestProductPublish({
                  merchantPubkey: draftOwnerPubkey,
                  form,
                  dTag:
                    editing?.dTag ??
                    `${slugify(form.title.trim()) || "product"}-${randomSuffix()}`,
                  existing: editing ?? undefined,
                })
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="product-title">Title</Label>
                <Input
                  id="product-title"
                  value={form.title}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, title: event.target.value }))
                  }
                  placeholder="Product title"
                  required
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="product-summary">Summary</Label>
                <Textarea
                  id="product-summary"
                  className="min-h-28 rounded-xl bg-[var(--surface-elevated)] ring-primary/20 transition"
                  value={form.summary}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      summary: event.target.value,
                    }))
                  }
                  placeholder="Short description shown to buyers"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="product-price">
                    {form.variations.enabled ? "Base price" : "Price"}
                  </Label>
                  <Input
                    id="product-price"
                    type="text"
                    inputMode={getProductAmountInputMode(form.currency)}
                    autoComplete="off"
                    className="tabular-nums"
                    value={form.price}
                    aria-invalid={!!productFormValidation.errors.price}
                    aria-describedby={
                      productFormValidation.errors.price
                        ? "product-price-error"
                        : undefined
                    }
                    onChange={(event) => {
                      if (!isPlainDecimalInput(event.target.value)) return
                      setForm((prev) => ({
                        ...prev,
                        price: event.target.value,
                      }))
                    }}
                    required
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="product-currency">Currency</Label>
                  <Select
                    value={form.currency}
                    onValueChange={(value) =>
                      setForm((prev) => ({ ...prev, currency: value }))
                    }
                  >
                    <SelectTrigger id="product-currency">
                      <SelectValue placeholder="Choose currency" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_PRODUCT_PRICE_CURRENCIES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <ProductFulfillmentEditor
                  intent={form.fulfillment}
                  reference={form.eventMarketReference}
                  handoffMode={form.eventHandoffMode}
                  merchantPickupTitle={form.merchantPickupTitle}
                  merchantPickupLocation={form.merchantPickupLocation}
                  merchantPickupGeohash={form.merchantPickupGeohash}
                  merchantPickupCountry={form.merchantPickupCountry}
                  market={localPickupQuery.data}
                  organizerInboxState={organizerInboxState}
                  availableMarkets={(
                    organizerEventMarketsQuery.data ?? []
                  ).filter((market) => market.state === "active")}
                  resolving={localPickupQuery.isFetching}
                  readFailed={localPickupQuery.isError}
                  participation={localPickupParticipation}
                  onIntentChange={(fulfillment) => {
                    if (
                      editFulfillmentResolution === "verifying_pickup" &&
                      fulfillment === "ship"
                    ) {
                      chooseExistingProductShipping()
                      return
                    }
                    setForm((prev) => ({
                      ...prev,
                      fulfillment,
                      format:
                        fulfillment === "digital" ? "digital" : "physical",
                      usePresetShippingZone:
                        fulfillment === "ship" && hasPresetShippingZone,
                      eventHandoffMode:
                        fulfillment === "local_pickup" &&
                        prev.fulfillment !== "local_pickup"
                          ? "merchant_handoff"
                          : prev.eventHandoffMode,
                    }))
                  }}
                  onReferenceChange={(eventMarketReference) =>
                    setForm((prev) => ({ ...prev, eventMarketReference }))
                  }
                  onHandoffModeChange={(eventHandoffMode) =>
                    setForm((prev) => ({ ...prev, eventHandoffMode }))
                  }
                  onMerchantPickupChange={(field, value) =>
                    setForm((prev) => ({ ...prev, [field]: value }))
                  }
                />

                <div className="grid gap-1.5">
                  <Label htmlFor="product-shipping">
                    Shipping ({getProductShippingCurrencyLabel(form.currency)})
                  </Label>
                  <Input
                    id="product-shipping"
                    type="text"
                    inputMode={getProductAmountInputMode(form.currency)}
                    autoComplete="off"
                    className="tabular-nums"
                    value={
                      form.fulfillment === "ship" && !productCoordinatesShipping
                        ? form.shippingCost
                        : ""
                    }
                    disabled={
                      productIsDigital ||
                      productIsLocalPickup ||
                      productCoordinatesShipping
                    }
                    aria-invalid={!!productFormValidation.errors.shippingCost}
                    aria-describedby="product-shipping-help"
                    onChange={(event) => {
                      if (!isPlainDecimalInput(event.target.value)) return
                      setForm((prev) => ({
                        ...prev,
                        shippingCost: event.target.value,
                      }))
                    }}
                    placeholder={
                      productIsDigital
                        ? "Not required"
                        : productIsLocalPickup
                          ? "Set by event pickup"
                          : productCoordinatesShipping
                            ? "Set after order"
                            : "0 or fixed amount"
                    }
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label htmlFor="product-stock">
                    {form.variations.enabled
                      ? "Default stock quantity"
                      : "Stock quantity"}
                  </Label>
                  <Input
                    id="product-stock"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    className="tabular-nums"
                    value={form.stock}
                    aria-invalid={!!productFormValidation.errors.stock}
                    aria-describedby="product-stock-help"
                    onChange={(event) => {
                      if (!isPlainStockInput(event.target.value)) return
                      setForm((prev) => ({
                        ...prev,
                        stock: event.target.value,
                      }))
                    }}
                    placeholder="Not tracked"
                  />
                </div>
                <div
                  id="product-stock-help"
                  className={cn(
                    "self-end text-pretty text-xs leading-5 sm:col-span-2 sm:pb-2",
                    productFormValidation.errors.stock
                      ? "text-error"
                      : "text-[var(--text-muted)]"
                  )}
                >
                  {productFormValidation.errors.stock ??
                    (form.variations.enabled
                      ? "Used by every variation unless you enter a row override. Leave blank to publish without stock tracking."
                      : "Leave blank to publish without stock tracking. Enter 0 to mark the listing sold out.")}
                </div>
                {productFormValidation.errors.price && (
                  <p
                    id="product-price-error"
                    className="text-pretty text-xs leading-5 text-error sm:col-span-4"
                  >
                    {productFormValidation.errors.price}
                  </p>
                )}
                <div
                  id="product-shipping-help"
                  className={cn(
                    "text-pretty text-xs leading-5 sm:col-span-4",
                    productFormValidation.errors.shippingCost
                      ? "text-error"
                      : "text-[var(--text-muted)]"
                  )}
                >
                  {productFormValidation.errors.shippingCost ??
                    (productIsLocalPickup
                      ? "Pickup cost comes from the verified organizer option."
                      : getProductShippingCostHelpText(
                          form.shippingCost,
                          form.format,
                          form.currency,
                          form.shippingPricingMode
                        ))}
                </div>
                <label
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-sm sm:col-span-4",
                    productIsDigital || productIsLocalPickup
                      ? "cursor-not-allowed border-dashed border-[var(--border)] bg-[var(--surface-elevated)] opacity-60"
                      : "cursor-pointer",
                    productCoordinatesShipping
                      ? "border-warning/40 bg-warning/10"
                      : "border-[var(--border)] bg-[var(--surface-elevated)]"
                  )}
                  aria-disabled={productIsDigital || productIsLocalPickup}
                >
                  <input
                    type="checkbox"
                    checked={productCoordinatesShipping}
                    disabled={productIsDigital || productIsLocalPickup}
                    aria-labelledby="product-coordinate-shipping-label"
                    aria-describedby="product-coordinate-shipping-help"
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        shippingPricingMode: event.target.checked
                          ? "coordinate_after_order"
                          : "fixed",
                      }))
                    }
                    className="mt-1 h-4 w-4 rounded border-[var(--border)] accent-secondary-500 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="grid gap-1">
                    <span
                      id="product-coordinate-shipping-label"
                      className="font-medium text-[var(--text-primary)]"
                    >
                      Coordinate shipping with the buyer after the order
                    </span>
                    <span
                      id="product-coordinate-shipping-help"
                      className={cn(
                        "text-pretty text-xs leading-5",
                        productCoordinatesShipping
                          ? "text-warning"
                          : "text-[var(--text-muted)]"
                      )}
                    >
                      {productIsDigital
                        ? "Digital products do not need shipping coordination."
                        : productIsLocalPickup
                          ? "Local pickup uses the organizer's signed public option."
                          : "Only choose this if you cannot set a checkout amount. Fast checkout will be unavailable, and you’ll need to follow up on every order message before the buyer can pay."}
                    </span>
                  </span>
                </label>
                <label
                  className={cn(
                    "flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm sm:col-span-4",
                    presetShippingZoneUnavailable
                      ? "cursor-not-allowed border-dashed opacity-60"
                      : "cursor-pointer"
                  )}
                  aria-disabled={presetShippingZoneUnavailable}
                >
                  <input
                    type="checkbox"
                    checked={
                      !productIsDigital &&
                      !productIsLocalPickup &&
                      !productCoordinatesShipping &&
                      hasPresetShippingZone &&
                      form.usePresetShippingZone
                    }
                    disabled={presetShippingZoneUnavailable}
                    aria-describedby="product-preset-shipping-help"
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        usePresetShippingZone: event.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4 rounded border-[var(--border)] accent-secondary-500 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="grid gap-1">
                    <span className="font-medium text-[var(--text-primary)]">
                      Use my preset shipping zone for this product
                    </span>
                    <span
                      id="product-preset-shipping-help"
                      className="text-xs leading-5 text-[var(--text-muted)]"
                    >
                      {productIsDigital
                        ? "Digital products do not need shipping zones."
                        : productIsLocalPickup
                          ? "Local pickup does not evaluate buyer shipping destinations."
                          : productCoordinatesShipping
                            ? "Shipping destinations will be agreed with the buyer after the order."
                            : hasPresetShippingZone
                              ? form.usePresetShippingZone
                                ? "Direct checkout will use your published shipping countries and postal rules."
                                : "Use custom destinations for this product instead of the published preset."
                              : "No preset shipping zone is available. Add custom destinations for this product below."}
                    </span>
                  </span>
                </label>

                {customShippingZoneActive && (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:col-span-4">
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Custom shipping destinations
                      </div>
                      <p className="text-xs leading-5 text-[var(--text-muted)]">
                        These destinations are emitted on this product listing
                        only and do not change your preset Shipping tab
                        settings.
                      </p>
                    </div>
                    <div className="mt-3 max-h-[22rem] overflow-y-auto p-1">
                      <ShippingDestinationsEditor
                        compact
                        config={form.customShippingConfig}
                        emptyText="No custom destinations added yet."
                        onChange={(customShippingConfig) =>
                          setForm((prev) => ({
                            ...prev,
                            customShippingConfig,
                          }))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.publicZapEnabled}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        publicZapEnabled: event.target.checked,
                      }))
                    }
                    className="mt-1 h-4 w-4 rounded border-[var(--border)] accent-secondary-500"
                  />
                  <span className="grid gap-1">
                    <span className="font-medium text-[var(--text-primary)]">
                      Enable public zaps for purchases
                    </span>
                    <span className="text-xs leading-5 text-[var(--text-muted)]">
                      When disabled, checkout uses a private Lightning invoice
                      for this product.
                    </span>
                  </span>
                </label>

                <div className="grid gap-1.5">
                  <Label htmlFor="product-zap-message-policy">
                    Zap message policy
                  </Label>
                  <Select
                    value={form.zapMessagePolicy}
                    disabled={!form.publicZapEnabled}
                    onValueChange={(value) =>
                      setForm((prev) => ({
                        ...prev,
                        zapMessagePolicy: value as ProductZapMessagePolicy,
                      }))
                    }
                  >
                    <SelectTrigger id="product-zap-message-policy">
                      <SelectValue placeholder="Choose policy" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="generic_only">Generic only</SelectItem>
                      <SelectItem value="custom">
                        Allow shopper custom message
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="text-xs leading-5 text-[var(--text-muted)]">
                    {form.publicZapEnabled
                      ? "Generic public zaps may include item count, but never product names, product IDs, order metadata, contact details, private notes, wallet data, payment evidence, or buyer identity."
                      : "This listing will publish a private-invoice checkout policy; buyers cannot choose public zap checkout for this product."}
                  </div>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="product-image">Image URL</Label>
                <Input
                  id="product-image"
                  type="url"
                  value={form.imageUrl}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      imageUrl: event.target.value,
                    }))
                  }
                  placeholder="https://..."
                  required
                />
                <div className="text-xs leading-5 text-[var(--text-muted)]">
                  Products without images are not shown in Market.
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="product-tags">Tags</Label>
                <ProductTagEditor
                  id="product-tags"
                  value={form.tags}
                  onChange={(tags) => setForm((prev) => ({ ...prev, tags }))}
                  catalogTags={tagFilters}
                  errorMessage={productTagFieldError}
                  placeholder="gear, hardware, demo"
                />
              </div>
              <fieldset className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <legend className="px-1 text-sm font-semibold text-[var(--text-primary)]">
                  Product options
                </legend>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={form.variations.enabled}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        variations: reconcileProductVariationForm({
                          ...previous.variations,
                          enabled: event.target.checked,
                        }),
                      }))
                    }
                    className="mt-1 h-4 w-4 rounded border-[var(--border)] accent-secondary-500"
                  />
                  <span className="grid gap-1">
                    <span className="font-medium text-[var(--text-primary)]">
                      This product has options
                    </span>
                    <span className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
                      Define the values that distinguish one listing from
                      another, then choose which combinations are available.
                    </span>
                  </span>
                </label>

                {productVariationRemovalCount > 0 && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-pretty text-xs leading-5 text-warning"
                  >
                    Saving will remove {productVariationRemovalCount} previously
                    published combination
                    {productVariationRemovalCount === 1 ? "" : "s"} from this
                    product.
                  </p>
                )}

                {form.variations.enabled && (
                  <>
                    <div className="grid gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-[var(--text-primary)]">
                            Option definitions
                          </div>
                          <p className="mt-1 text-pretty text-xs text-[var(--text-muted)]">
                            Values within one option are alternatives. Separate
                            options combine.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            form.variations.axes.length >=
                            MAX_PRODUCT_VARIATION_AXES
                          }
                          onClick={() =>
                            setForm((previous) => ({
                              ...previous,
                              variations: addProductVariationAxis(
                                previous.variations
                              ),
                            }))
                          }
                        >
                          Add option
                        </Button>
                      </div>

                      {form.variations.axes.map((axis) => (
                        <div
                          key={axis.id}
                          className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:grid-cols-[minmax(8rem,0.45fr)_minmax(0,1fr)_auto] sm:items-end"
                        >
                          <div className="grid gap-1.5">
                            <Label
                              htmlFor={`product-variation-axis-${axis.id}`}
                            >
                              Option name
                            </Label>
                            <Input
                              id={`product-variation-axis-${axis.id}`}
                              value={axis.key}
                              aria-invalid={
                                !axis.key.trim() ||
                                form.variations.axes.some(
                                  (candidate) =>
                                    candidate.id !== axis.id &&
                                    candidate.key
                                      .trim()
                                      .toLocaleLowerCase("en-US") ===
                                      axis.key.trim().toLocaleLowerCase("en-US")
                                )
                              }
                              aria-describedby="product-variations-help"
                              placeholder="Enter a name"
                              onChange={(event) =>
                                setForm((previous) => ({
                                  ...previous,
                                  variations: updateProductVariationAxis(
                                    previous.variations,
                                    axis.id,
                                    "key",
                                    event.target.value
                                  ),
                                }))
                              }
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label
                              htmlFor={`product-variation-values-${axis.id}`}
                            >
                              Values
                            </Label>
                            <Input
                              id={`product-variation-values-${axis.id}`}
                              value={axis.values}
                              aria-invalid={
                                !!productFormValidation.errors.variations
                              }
                              aria-describedby="product-variations-help"
                              placeholder="Separate values with commas"
                              onChange={(event) =>
                                setForm((previous) => ({
                                  ...previous,
                                  variations: updateProductVariationAxis(
                                    previous.variations,
                                    axis.id,
                                    "values",
                                    event.target.value
                                  ),
                                }))
                              }
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`Remove ${axis.key.trim() || "unnamed option"}`}
                            onClick={() =>
                              setForm((previous) => ({
                                ...previous,
                                variations: removeProductVariationAxis(
                                  previous.variations,
                                  axis.id
                                ),
                              }))
                            }
                          >
                            Remove option
                          </Button>
                        </div>
                      ))}
                    </div>

                    <div
                      id="product-variations-help"
                      className={cn(
                        "text-xs leading-5",
                        productVariationGenerationMessage
                          ? "text-warning"
                          : productFormValidation.errors.variations
                            ? "text-error"
                            : "text-[var(--text-muted)]"
                      )}
                    >
                      {productVariationGenerationMessage ??
                        productFormValidation.errors.variations ??
                        "Separate values with commas. Every possible combination appears in the availability matrix."}
                    </div>

                    {productVariationMatrix.length > 0 && (
                      <ProductCombinationMatrix
                        axes={form.variations.axes}
                        combinations={productVariationMatrix}
                        invalid={productVariationCombinations.length === 0}
                        onIncludeAll={() =>
                          setForm((previous) => ({
                            ...previous,
                            variations: generateProductVariationRows(
                              previous.variations
                            ),
                          }))
                        }
                        onIncludedChange={(identity, included) =>
                          setForm((previous) => ({
                            ...previous,
                            variations: setProductVariationCombinationIncluded(
                              previous.variations,
                              identity,
                              included
                            ),
                          }))
                        }
                        validationMessageId="product-variations-help"
                      />
                    )}

                    {productVariationCombinations.length > 0 && (
                      <div className="grid gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-medium text-[var(--text-primary)]">
                            Available combinations
                          </div>
                          <Badge
                            variant="secondary"
                            className="border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-secondary)]"
                          >
                            {productVariationCombinations.length}
                          </Badge>
                        </div>
                        <p className="text-pretty text-xs leading-5 text-[var(--text-muted)]">
                          Set fields here only when a combination differs from
                          the base product. Only available combinations are
                          published.
                        </p>
                        <div
                          data-product-variation-rows
                          className="relative grid max-h-[32rem] gap-3 overflow-y-auto pr-1"
                        >
                          {productVariationCombinations.map(
                            (combination, index) => (
                              <div
                                key={combination.identity}
                                className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                                      {combination.label}
                                    </div>
                                    <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                                      {combination.specifications
                                        .map(
                                          (specification) =>
                                            `${specification.key}: ${specification.value}`
                                        )
                                        .join(" · ")}
                                    </div>
                                  </div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      setForm((previous) => ({
                                        ...previous,
                                        variations:
                                          setProductVariationCombinationIncluded(
                                            previous.variations,
                                            combination.identity,
                                            false
                                          ),
                                      }))
                                    }
                                  >
                                    Mark unavailable
                                  </Button>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-3">
                                  <div className="grid gap-1">
                                    <Label
                                      htmlFor={`product-variation-title-${index}`}
                                      className="text-xs"
                                    >
                                      Combination title
                                    </Label>
                                    <Input
                                      id={`product-variation-title-${index}`}
                                      value={combination.title}
                                      placeholder={`${form.title || "Product"} - ${combination.label}`}
                                      onChange={(event) =>
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "title",
                                              event.target.value
                                            ),
                                        }))
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label
                                      htmlFor={`product-variation-price-${index}`}
                                      className="text-xs"
                                    >
                                      Price ({form.currency})
                                    </Label>
                                    <Input
                                      id={`product-variation-price-${index}`}
                                      type="text"
                                      inputMode={getProductAmountInputMode(
                                        form.currency
                                      )}
                                      autoComplete="off"
                                      className="tabular-nums"
                                      value={combination.price}
                                      placeholder={form.price || "Base price"}
                                      onChange={(event) => {
                                        if (
                                          !isPlainDecimalInput(
                                            event.target.value
                                          )
                                        ) {
                                          return
                                        }
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "price",
                                              event.target.value
                                            ),
                                        }))
                                      }}
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label
                                        htmlFor={`product-variation-stock-${index}`}
                                        className="text-xs"
                                      >
                                        Stock
                                      </Label>
                                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                                        <input
                                          type="checkbox"
                                          checked={combination.inheritStock}
                                          onChange={(event) =>
                                            setForm((previous) => ({
                                              ...previous,
                                              variations:
                                                updateProductVariationInheritance(
                                                  previous.variations,
                                                  combination.identity,
                                                  "inheritStock",
                                                  event.target.checked
                                                ),
                                            }))
                                          }
                                        />
                                        Base
                                      </label>
                                    </div>
                                    <Input
                                      id={`product-variation-stock-${index}`}
                                      type="text"
                                      inputMode="numeric"
                                      autoComplete="off"
                                      className="tabular-nums"
                                      value={combination.stock}
                                      disabled={combination.inheritStock}
                                      placeholder={form.stock || "Not tracked"}
                                      onChange={(event) => {
                                        if (
                                          !isPlainStockInput(event.target.value)
                                        ) {
                                          return
                                        }
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "stock",
                                              event.target.value
                                            ),
                                        }))
                                      }}
                                    />
                                  </div>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-3">
                                  <div className="grid gap-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label
                                        htmlFor={`product-variation-images-${index}`}
                                        className="text-xs"
                                      >
                                        Image URLs
                                      </Label>
                                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                                        <input
                                          type="checkbox"
                                          checked={combination.inheritImages}
                                          onChange={(event) =>
                                            setForm((previous) => ({
                                              ...previous,
                                              variations:
                                                updateProductVariationInheritance(
                                                  previous.variations,
                                                  combination.identity,
                                                  "inheritImages",
                                                  event.target.checked
                                                ),
                                            }))
                                          }
                                        />
                                        Base
                                      </label>
                                    </div>
                                    <Textarea
                                      id={`product-variation-images-${index}`}
                                      value={combination.imageUrls}
                                      disabled={combination.inheritImages}
                                      placeholder="One HTTPS URL per line"
                                      rows={2}
                                      onChange={(event) =>
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "imageUrls",
                                              event.target.value
                                            ),
                                        }))
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label
                                      htmlFor={`product-variation-format-${index}`}
                                      className="text-xs"
                                    >
                                      Format
                                    </Label>
                                    <Select
                                      value={combination.format}
                                      onValueChange={(value) =>
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "format",
                                              value
                                            ),
                                        }))
                                      }
                                    >
                                      <SelectTrigger
                                        id={`product-variation-format-${index}`}
                                      >
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="inherit">
                                          Base format
                                        </SelectItem>
                                        <SelectItem value="physical">
                                          Physical
                                        </SelectItem>
                                        <SelectItem value="digital">
                                          Digital
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="grid gap-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <Label
                                        htmlFor={`product-variation-shipping-${index}`}
                                        className="text-xs"
                                      >
                                        Shipping ({form.currency})
                                      </Label>
                                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                                        <input
                                          type="checkbox"
                                          checked={combination.inheritShipping}
                                          onChange={(event) =>
                                            setForm((previous) => ({
                                              ...previous,
                                              variations:
                                                updateProductVariationInheritance(
                                                  previous.variations,
                                                  combination.identity,
                                                  "inheritShipping",
                                                  event.target.checked
                                                ),
                                            }))
                                          }
                                        />
                                        Base
                                      </label>
                                    </div>
                                    <Input
                                      id={`product-variation-shipping-${index}`}
                                      value={combination.shippingCost}
                                      disabled={combination.inheritShipping}
                                      inputMode={getProductAmountInputMode(
                                        form.currency
                                      )}
                                      placeholder="Coordinate after order"
                                      onChange={(event) => {
                                        if (
                                          !isPlainDecimalInput(
                                            event.target.value
                                          )
                                        ) {
                                          return
                                        }
                                        setForm((previous) => ({
                                          ...previous,
                                          variations:
                                            updateProductVariationOverride(
                                              previous.variations,
                                              combination.identity,
                                              "shippingCost",
                                              event.target.value
                                            ),
                                        }))
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          )}
                        </div>
                        <p className="text-xs leading-5 text-[var(--text-muted)]">
                          Each changed product, shipping detail, or removal may
                          require its own signer approval.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </fieldset>
              {remoteSignerRecovery ? (
                <ProductSignerRecoveryNotice
                  draftStorageAvailable={draftStorageAvailable}
                  reconnecting={authStatus === "restoring"}
                  restoreFailed={!!remoteSignerRecovery.restoreError}
                  changingSigner={signerChangePending}
                  changeSignerError={signerChangeError}
                  onReconnect={reconnectProductSigner}
                  onUseDifferentSigner={useDifferentProductSigner}
                />
              ) : (
                <SignedActionStatus
                  state={
                    isSaving
                      ? productSignerRequestsComplete ||
                        productDeliveryNotice?.action === "publish"
                        ? "publishing"
                        : "awaiting_signature"
                      : saveMutation.error
                        ? "error"
                        : !productFormValidation.canPublish || hasProductChanges
                          ? "dirty"
                          : "idle"
                  }
                  dirtyMessage={productStatusMessage}
                  awaitingSignatureMessage={
                    productSignerProgress
                      ? getProductSignerRequestMessage(productSignerProgress)
                      : form.variations.enabled
                        ? "Confirm each changed product listing in your signer. The family will save locally before relay delivery runs."
                        : "Confirm the product listing in your signer. It will save locally while relay delivery runs."
                  }
                  publishingMessage={
                    form.variations.enabled
                      ? "All signer approvals are complete. Saving and delivering the signed product family to relays."
                      : "All signer approvals are complete. Saving and delivering the signed listing to relays."
                  }
                  errorMessage={getPublishErrorMessage(
                    saveMutation.error,
                    "publish"
                  )}
                />
              )}

              {!remoteSignerRecovery && signerRestoredForDraft && (
                <div
                  ref={signerRestoredNoticeRef}
                  role="status"
                  tabIndex={-1}
                  className="rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm leading-6 text-[var(--text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  Signer reconnected. Review your draft, then choose{" "}
                  {editing ? "Save changes" : "Publish product"} when ready.
                </div>
              )}

              {hasProductChanges && !remoteSignerRecovery && (
                <p
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "text-pretty text-xs leading-5",
                    draftStorageAvailable
                      ? "text-[var(--text-muted)]"
                      : "text-error"
                  )}
                >
                  {draftStorageAvailable
                    ? "Draft saved on this device. Close this window and reopen it to continue."
                    : "Local draft storage is unavailable. Keep this page open; switching product forms is blocked to protect these changes."}
                </p>
              )}

              <DialogFooter>
                {hasProductChanges && (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={discardProductChanges}
                    disabled={isSaving}
                  >
                    Discard changes
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={requestCloseProductDialog}
                  disabled={isSaving}
                >
                  Close
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !pubkey || !signerReady || isSaving || !productCanSubmit
                  }
                >
                  {remoteSignerRecovery
                    ? "Reconnect signer to continue"
                    : isSaving
                      ? "Waiting for signer..."
                      : editing
                        ? "Save changes"
                        : "Publish product"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ProductInboxReadinessDialog
        open={pendingProductPublish !== null}
        status={inboxReadiness.status}
        checking={inboxReadiness.isLoading || inboxReadiness.isRefetching}
        error={inboxReadiness.error}
        onKeepEditing={() => setPendingProductPublish(null)}
        onPublish={publishPendingProduct}
        onRetry={inboxReadiness.refetch}
        onSetup={openPrivateInboxSetup}
      />
    </div>
  )
}
