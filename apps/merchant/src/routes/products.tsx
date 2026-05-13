import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { Plus, Search } from "lucide-react"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  canonicalizeProductPrice,
  getCachedMerchantStorefront,
  getMerchantStorefront,
  getProductImageCandidates,
  getProductPriceDisplay,
  hasMarketVisibleProductImage,
  publishWithPlanner,
  requireNdkConnected,
  type CommerceResult,
  type ProductSchema,
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
} from "@conduit/ui"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { requireAuth } from "../lib/auth"
import {
  assertPublishableProductPrice,
  getProductPriceInputStep,
} from "../lib/productPriceForm"

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
}

type ProductFormState = {
  title: string
  summary: string
  price: string
  currency: string
  imageUrl: string
  tags: string
}

type ProductSort = "updated_desc" | "title_asc" | "price_asc" | "price_desc"

const EMPTY_FORM: ProductFormState = {
  title: "",
  summary: "",
  price: "0",
  currency: "USD",
  imageUrl: "",
  tags: "",
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

function productToForm(product: ProductSchema): ProductFormState {
  const source = product.sourcePrice
  return {
    title: product.title,
    summary: product.summary ?? "",
    price: String(source?.amount ?? product.price),
    currency: source?.normalizedCurrency ?? product.currency,
    imageUrl: product.images[0]?.url ?? "",
    tags: product.tags.join(", "),
  }
}

function parseTags(tagsCsv: string): string[] {
  return tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
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

  const currency = form.currency.trim().toUpperCase() || "USD"
  assertPublishableProductPrice(price, currency)
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
    price,
    currency,
    type: "simple",
    format: "physical",
    visibility: "public",
    stock: undefined,
    images: [{ url: imageUrl }],
    tags,
    location: undefined,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  })

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.PRODUCT
  event.created_at = Math.floor(now / 1000)
  event.content = JSON.stringify(product)
  event.tags = [
    ["d", dTag],
    ["title", product.title],
    ["price", String(price), currency],
  ]

  if (product.summary) event.tags.push(["summary", product.summary])
  if (imageUrl) event.tags.push(["image", imageUrl])
  for (const tag of tags) event.tags.push(["t", tag])
  event.tags = appendConduitClientTag(event.tags, "merchant")

  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: signerPubkey,
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

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      form: ProductFormState
      existing?: MerchantProduct
    }) => {
      await publishProduct(pubkey!, payload.form, payload.existing)
    },
    onSuccess: async () => {
      setEditing(null)
      setForm(EMPTY_FORM)
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

  function closeProductDialog(): void {
    setProductDialogOpen(false)
    setEditing(null)
    setForm(EMPTY_FORM)
    saveMutation.reset()
  }

  function openCreateDialog(): void {
    saveMutation.reset()
    setEditing(null)
    setForm(EMPTY_FORM)
    setProductDialogOpen(true)
  }

  function openEditDialog(item: MerchantProduct): void {
    saveMutation.reset()
    setEditing(item)
    setForm(productToForm(item.product))
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
            const marketVisible = hasMarketVisibleProductImage(item.product)

            if (!marketVisible) {
              return (
                <article
                  key={item.addressId}
                  className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
                >
                  <div className="font-semibold text-[var(--text-primary)]">
                    {item.product.title}
                  </div>
                  <div className="mt-2 leading-6">
                    Missing a valid image URL. This listing is hidden from
                    Market until it is fixed.
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => openEditDialog(item)}
                  >
                    Fix listing
                  </Button>
                </article>
              )
            }

            return (
              <ProductCard
                key={item.addressId}
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
              <textarea
                id="product-summary"
                className="min-h-28 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none ring-primary/20 transition focus:ring-2"
                value={form.summary}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, summary: event.target.value }))
                }
                placeholder="Short description shown to buyers"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
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
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="SAT">SAT</SelectItem>
                    <SelectItem value="SATS">SATS</SelectItem>
                    <SelectItem value="BTC">BTC</SelectItem>
                  </SelectContent>
                </Select>
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
                value={form.tags}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, tags: event.target.value }))
                }
                placeholder="gear, hardware, demo"
              />
            </div>

            {saveMutation.error && (
              <div className="rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">
                {saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : "Failed to publish product"}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeProductDialog}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!pubkey || isSaving}>
                {isSaving
                  ? "Saving..."
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
