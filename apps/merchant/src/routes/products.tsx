import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { Plus, Search } from "lucide-react"
import {
  EVENT_KINDS,
  SHIPPING_COUNTRIES,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
  appendConduitClientTag,
  buildProductListingEventDraft,
  canonicalizeProductPrice,
  evaluateListingSafety,
  getCachedMerchantStorefront,
  getListingSafetyDisplay,
  getShippingOptionAddress,
  getMerchantStorefront,
  getProductImageCandidates,
  getProductPriceDisplay,
  publishWithPlanner,
  requireNdkConnected,
  type CommerceResult,
  type ListingSafetyEvaluation,
  type ProductSchema,
  type ProductZapMessagePolicy,
  useAuth,
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
  Input,
  Label,
  ProductCard,
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
import { ShippingDestinationsEditor } from "../components/ShippingDestinationsEditor"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { requireAuth } from "../lib/auth"
import {
  canonicalizeProductShippingCost,
  getProductPriceInputStep,
  getProductShippingCostHelpText,
  getProductShippingCurrencyLabel,
  normalizePublishableProductPrice,
} from "../lib/productPriceForm"
import {
  isShippingComplete,
  loadShippingConfig,
  type ShippingConfig,
} from "../lib/readiness"

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
  product: ProductSchema
  safety: ListingSafetyEvaluation
}

type ProductFormState = {
  title: string
  summary: string
  price: string
  currency: string
  format: "physical" | "digital"
  shippingCost: string
  usePresetShippingZone: boolean
  customShippingConfig: ShippingConfig
  publicZapEnabled: boolean
  zapMessagePolicy: ProductZapMessagePolicy
  imageUrl: string
  tags: string
}

type ProductSort = "updated_desc" | "title_asc" | "price_asc" | "price_desc"

function createEmptyProductForm(
  usePresetShippingZone = true
): ProductFormState {
  return {
    title: "",
    summary: "",
    price: "0",
    currency: "USD",
    format: "physical",
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
  product: ProductSchema,
  presetAvailable = true
): ProductFormState {
  const source = product.sourcePrice
  const sourceShippingCost = product.sourceShippingCost
  return {
    title: product.title,
    summary: product.summary ?? "",
    price: String(source?.amount ?? product.price),
    currency: source?.normalizedCurrency ?? product.currency,
    format: product.format,
    shippingCost:
      typeof sourceShippingCost?.amount === "number"
        ? String(sourceShippingCost.amount)
        : typeof product.shippingCostSats === "number"
          ? String(product.shippingCostSats)
          : "",
    usePresetShippingZone: presetAvailable && !!product.shippingOptionId,
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
  usePresetShippingZone: boolean,
  customShippingConfig: ShippingConfig
): Pick<
  ProductSchema,
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingCountries"
  | "shippingCountryRules"
> {
  const shippingConfig = usePresetShippingZone
    ? loadShippingConfig(merchantPubkey)
    : customShippingConfig
  if (!isShippingComplete(shippingConfig)) return {}

  return {
    ...(usePresetShippingZone
      ? {
          shippingOptionId: getShippingOptionAddress(merchantPubkey),
          shippingOptionDTag: CONDUIT_DEFAULT_SHIPPING_OPTION_D_TAG,
        }
      : {}),
    shippingCountries: shippingConfig.countries.map((country) => country.code),
    shippingCountryRules: shippingConfig.countries.map((country) => ({
      code: country.code,
      name: country.name,
      restrictTo: country.restrictTo,
      exclude: country.exclude,
    })),
  }
}

function parseTags(tagsCsv: string): string[] {
  return tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
}

function getPublishErrorMessage(
  error: unknown,
  action: "publish" | "delete"
): string {
  const fallback =
    action === "delete"
      ? "Failed to delete listing"
      : "Failed to publish listing"
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
    case "product_reference":
      return "Public zap: product reference"
    case "generic_only":
      return "Public zap: generic"
  }
}

function ListingSafetySummary({
  item,
  onEdit,
}: {
  item: MerchantProduct
  onEdit: () => void
}) {
  const display = getListingSafetyDisplay(item.safety)
  const isActive = item.safety.state === "active"
  const isPolicyWarning = item.safety.state === "flagged"
  const zapPolicyLabel = getZapPolicyLabel(item.product)

  if (isActive) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2">
        <StatusPill variant="success" className="text-[10px]">
          {display.label}
        </StatusPill>
        <span className="text-xs text-[var(--text-secondary)]">
          {zapPolicyLabel}
        </span>
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
      <Button variant="outline" size="sm" className="mt-3" onClick={onEdit}>
        {isPolicyWarning ? "Review listing" : "Fix listing"}
      </Button>
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
  return {
    data: result.data.map((record) => ({
      eventId: record.eventId,
      addressId: record.addressId,
      dTag: record.dTag,
      eventCreatedAt: record.eventCreatedAt,
      product: record.product,
      safety: record.safety ?? evaluateListingSafety(record.product),
    })),
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
      product: record.product,
      safety: record.safety ?? evaluateListingSafety(record.product),
    })),
    meta: result.meta,
  }
}

async function publishProduct(
  merchantPubkey: string,
  form: ProductFormState,
  existing?: MerchantProduct
): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signerPubkey = (await ndk.signer.user()).pubkey
  if (signerPubkey !== merchantPubkey) {
    throw new Error("Active signer does not match current merchant pubkey")
  }

  const title = form.title.trim()
  if (!title) throw new Error("Title is required")

  const price = Number(form.price)
  const isDigital = form.format === "digital"
  const shippingCostInput = isDigital ? "" : form.shippingCost.trim()
  const shippingCostAmount =
    shippingCostInput.length > 0 ? Number(shippingCostInput) : undefined

  const currency = form.currency.trim().toUpperCase() || "USD"
  const normalizedPrice = normalizePublishableProductPrice(price, currency)
  const shippingCost = canonicalizeProductShippingCost(
    shippingCostAmount,
    currency
  )
  const shippingMetadata = isDigital
    ? {}
    : buildShippingMetadata(
        signerPubkey,
        form.usePresetShippingZone,
        form.customShippingConfig
      )
  const hasShippingZone =
    (shippingMetadata.shippingCountries?.length ?? 0) > 0 ||
    (shippingMetadata.shippingCountryRules?.length ?? 0) > 0
  if (
    !isDigital &&
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
  if (!/^https:\/\//.test(imageUrl)) {
    throw new Error("Image URL must start with https://")
  }

  const dTag =
    existing?.dTag ?? `${slugify(title) || "product"}-${randomSuffix()}`
  const now = Date.now()
  const tags = parseTags(form.tags)

  const product: ProductSchema = canonicalizeProductPrice({
    id: `30402:${signerPubkey}:${dTag}`,
    pubkey: signerPubkey,
    title,
    summary: summary || undefined,
    price: normalizedPrice,
    currency,
    type: "simple",
    format: form.format,
    ...shippingCost,
    ...shippingMetadata,
    visibility: "public",
    stock: undefined,
    images: [{ url: imageUrl }],
    tags,
    publicZapEnabled: form.publicZapEnabled,
    zapMessagePolicy: form.zapMessagePolicy,
    publicZapPolicyKnown: true,
    location: undefined,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  })

  const event = new NDKEvent(ndk)
  const draft = buildProductListingEventDraft({
    product,
    dTag,
    clientAppId: "merchant",
  })
  event.kind = draft.kind
  event.created_at = Math.floor(now / 1000)
  event.content = draft.content
  event.tags = draft.tags

  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: signerPubkey,
    authenticatedPubkey: signerPubkey,
    deliveryMode: "critical",
  })
}

async function deleteProduct(
  merchantPubkey: string,
  product: MerchantProduct
): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  if (product.product.pubkey !== merchantPubkey) {
    throw new Error(
      "Product pubkey mismatch; refusing to publish deletion event"
    )
  }

  const deletion = new NDKEvent(ndk)
  deletion.kind = EVENT_KINDS.DELETION
  deletion.created_at = Math.floor(Date.now() / 1000)
  const tags: string[][] = [
    ["e", product.eventId],
    ["k", String(EVENT_KINDS.PRODUCT)],
    ["p", product.product.pubkey],
  ]
  if (product.dTag) {
    tags.push(["a", `30402:${product.product.pubkey}:${product.dTag}`])
  }
  deletion.tags = appendConduitClientTag(tags, "merchant")
  deletion.content = `Delete product ${product.addressId}`

  await deletion.sign(ndk.signer)
  await publishWithPlanner(deletion, {
    intent: "author_event",
    authorPubkey: merchantPubkey,
    authenticatedPubkey: merchantPubkey,
    deliveryMode: "critical",
  })
}

function ProductsPage() {
  const { pubkey } = useAuth()
  const queryClient = useQueryClient()
  const btcUsdRateQuery = useBtcUsdRate()
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<MerchantProduct | null>(null)
  const [productDialogOpen, setProductDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedTag, setSelectedTag] = useState("all")
  const [sortOrder, setSortOrder] = useState<ProductSort>("updated_desc")

  const productsQuery = useQuery({
    queryKey: ["merchant-products-live", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchMerchantProducts(pubkey!),
    refetchInterval: 15_000,
  })
  const cachedProductsQuery = useQuery({
    queryKey: ["merchant-products", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchCachedMerchantProducts(pubkey!),
    staleTime: 5_000,
  })
  const merchantProducts = useMemo(
    () => productsQuery.data?.data ?? cachedProductsQuery.data?.data ?? [],
    [cachedProductsQuery.data?.data, productsQuery.data?.data]
  )
  const shippingConfig = loadShippingConfig(pubkey)
  const hasPresetShippingZone = isShippingComplete(shippingConfig)

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      form: ProductFormState
      existing?: MerchantProduct
    }) => {
      await publishProduct(pubkey!, payload.form, payload.existing)
    },
    onSuccess: async () => {
      setEditing(null)
      setForm(createEmptyProductForm(hasPresetShippingZone))
      setProductDialogOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ["merchant-products", pubkey ?? "none"],
      })
      await queryClient.invalidateQueries({
        queryKey: ["merchant-products-live", pubkey ?? "none"],
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (product: MerchantProduct) => {
      await deleteProduct(pubkey!, product)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["merchant-products", pubkey ?? "none"],
      })
      await queryClient.invalidateQueries({
        queryKey: ["merchant-products-live", pubkey ?? "none"],
      })
    },
  })

  const isSaving = saveMutation.isPending
  const isDeleting = deleteMutation.isPending
  const savedProductForm = useMemo(
    () =>
      editing
        ? productToForm(editing.product, hasPresetShippingZone)
        : createEmptyProductForm(hasPresetShippingZone),
    [editing, hasPresetShippingZone]
  )
  const hasProductChanges = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedProductForm),
    [form, savedProductForm]
  )
  const productsInitialLoading =
    productsQuery.isLoading && cachedProductsQuery.isLoading

  const tagFilters = useMemo(() => {
    const tagCounts = new Map<string, number>()
    for (const item of merchantProducts) {
      for (const tag of item.product.tags) {
        const normalized = tag.trim()
        if (!normalized) continue
        tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1)
      }
    }

    return Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [merchantProducts])

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
            (a.product.priceSats ?? a.product.price) -
            (b.product.priceSats ?? b.product.price)
          )
        case "price_desc":
          return (
            (b.product.priceSats ?? b.product.price) -
            (a.product.priceSats ?? a.product.price)
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
  const productIsDigital = form.format === "digital"
  const customShippingZoneActive =
    !productIsDigital && (!hasPresetShippingZone || !form.usePresetShippingZone)
  const presetShippingZoneUnavailable =
    productIsDigital || !hasPresetShippingZone

  function closeProductDialog(): void {
    setProductDialogOpen(false)
    setEditing(null)
    setForm(createEmptyProductForm(hasPresetShippingZone))
    saveMutation.reset()
  }

  function openCreateDialog(): void {
    saveMutation.reset()
    setEditing(null)
    setForm(createEmptyProductForm(hasPresetShippingZone))
    setProductDialogOpen(true)
  }

  function openEditDialog(item: MerchantProduct): void {
    saveMutation.reset()
    setEditing(item)
    setForm(productToForm(item.product, hasPresetShippingZone))
    setProductDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Products
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Manage your listings
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Publish, update, and remove kind {EVENT_KINDS.PRODUCT} listings for
            this merchant signer.
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
                className="h-8 px-3 text-xs"
                onClick={() => setSelectedTag(tag)}
              >
                {tag}
                <span className="font-mono text-[10px] opacity-80">
                  {count}
                </span>
              </Button>
            ))}
          </div>
        )}

        <div className="mt-3 min-h-5 text-xs text-[var(--text-muted)]">
          {productStatusLabel}
        </div>
        <SignedActionStatus
          state={
            isDeleting
              ? "awaiting_signature"
              : deleteMutation.error
                ? "error"
                : "idle"
          }
          awaitingSignatureMessage="Confirm the deletion event in your signer. The listing will disappear after relay publish finishes."
          errorMessage={getPublishErrorMessage(deleteMutation.error, "delete")}
          className="mt-2"
        />
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
            const { primary, secondary } = getProductPriceDisplay(
              item.product,
              btcUsdRateQuery.data ?? null
            )

            if (!item.safety.marketVisible) {
              return (
                <ListingSafetySummary
                  key={item.addressId}
                  item={item}
                  onEdit={() => openEditDialog(item)}
                />
              )
            }

            return (
              <div key={item.addressId} className="grid gap-2">
                <ListingSafetySummary
                  item={item}
                  onEdit={() => openEditDialog(item)}
                />
                <ProductCard
                  title={item.product.title}
                  merchantName="Your store"
                  images={getProductImageCandidates(item.product)}
                  primaryPrice={primary}
                  secondaryPrice={secondary}
                  imageLoading="lazy"
                  action={
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
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
                          const ok = window.confirm(
                            `Delete "${item.product.title}"?`
                          )
                          if (ok) deleteMutation.mutate(item)
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
          closeProductDialog()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit listing" : "Add product"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update this kind 30402 product listing."
                : "Publish a Market-visible kind 30402 listing from this signer."}
            </DialogDescription>
          </DialogHeader>

          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveMutation.mutate({ form, existing: editing ?? undefined })
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
                  setForm((prev) => ({ ...prev, summary: event.target.value }))
                }
                placeholder="Short description shown to buyers"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div className="grid gap-1.5">
                <Label htmlFor="product-price">Price</Label>
                <Input
                  id="product-price"
                  type="number"
                  min="0"
                  step={getProductPriceInputStep(form.currency)}
                  value={form.price}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, price: event.target.value }))
                  }
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

              <div className="grid gap-1.5">
                <Label htmlFor="product-format">Fulfillment</Label>
                <Select
                  value={form.format}
                  onValueChange={(value) =>
                    setForm((prev) => {
                      const format = value as ProductFormState["format"]
                      return {
                        ...prev,
                        format,
                        shippingCost:
                          format === "digital" ? "" : prev.shippingCost,
                        usePresetShippingZone:
                          format === "digital" ? false : hasPresetShippingZone,
                        customShippingConfig:
                          format === "digital"
                            ? { countries: [] }
                            : prev.customShippingConfig,
                      }
                    })
                  }
                >
                  <SelectTrigger id="product-format">
                    <SelectValue placeholder="Choose fulfillment" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="physical">Physical</SelectItem>
                    <SelectItem value="digital">Digital</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="product-shipping">
                  Shipping ({getProductShippingCurrencyLabel(form.currency)})
                </Label>
                <Input
                  id="product-shipping"
                  type="number"
                  min="0"
                  step={getProductPriceInputStep(form.currency)}
                  value={form.shippingCost}
                  disabled={productIsDigital}
                  aria-describedby="product-shipping-help"
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      shippingCost: event.target.value,
                    }))
                  }
                  placeholder={
                    productIsDigital ? "Not required" : "Leave blank"
                  }
                />
              </div>
              <div
                id="product-shipping-help"
                className="text-xs leading-5 text-[var(--text-muted)] sm:col-span-4"
              >
                {getProductShippingCostHelpText(
                  form.shippingCost,
                  form.format,
                  form.currency
                )}
              </div>
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
                      only and do not change your preset Shipping tab settings.
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
                    When disabled, checkout uses a private Lightning invoice for
                    this product.
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
                    <SelectItem value="product_reference">
                      Allow product reference
                    </SelectItem>
                    <SelectItem value="custom">
                      Allow shopper custom message
                    </SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-xs leading-5 text-[var(--text-muted)]">
                  {form.publicZapEnabled
                    ? "Generic public zaps never include product names, quantities, order metadata, contact details, private notes, or wallet data."
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
              <Input
                id="product-tags"
                aria-describedby="product-tags-help"
                value={form.tags}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, tags: event.target.value }))
                }
                placeholder="gear, hardware, demo"
              />
              <div
                id="product-tags-help"
                className="text-xs leading-5 text-[var(--text-muted)]"
              >
                Separate tags with commas. Tags are custom and help buyers
                filter listings.
              </div>
            </div>

            <SignedActionStatus
              state={
                isSaving
                  ? "awaiting_signature"
                  : saveMutation.error
                    ? "error"
                    : hasProductChanges
                      ? "dirty"
                      : "idle"
              }
              dirtyMessage={
                editing
                  ? "Save changes to publish this listing update."
                  : "Publish this product to create a signed kind 30402 listing."
              }
              awaitingSignatureMessage="Confirm the product listing in your signer. It will close after relay publish finishes."
              errorMessage={getPublishErrorMessage(
                saveMutation.error,
                "publish"
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeProductDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!pubkey || isSaving || !hasProductChanges}
              >
                {isSaving
                  ? "Waiting for signer..."
                  : editing
                    ? "Save changes"
                    : "Publish product"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
