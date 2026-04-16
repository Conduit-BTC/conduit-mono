import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  getMerchantStorefront,
  requireNdkConnected,
  type CommerceResult,
  type ProductSchema,
  useAuth,
} from "@conduit/core"
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"

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
  return {
    title: product.title,
    summary: product.summary ?? "",
    price: String(product.price),
    currency: product.currency,
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
    limit: 200,
    sort: "updated_at_desc",
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
  if (!Number.isFinite(price) || price < 0)
    throw new Error("Price must be a non-negative number")

  const currency = form.currency.trim().toUpperCase() || "USD"
  const summary = form.summary.trim()
  const imageUrl = form.imageUrl.trim()
  if (imageUrl && !/^https:\/\//.test(imageUrl)) {
    throw new Error("Image URL must start with https://")
  }

  const dTag =
    existing?.dTag ?? `${slugify(title) || "product"}-${randomSuffix()}`
  const now = Date.now()
  const tags = parseTags(form.tags)

  const product: ProductSchema = {
    id: `30402:${signerPubkey}:${dTag}`,
    pubkey: signerPubkey,
    title,
    summary: summary || undefined,
    price,
    currency,
    type: "simple",
    visibility: "public",
    stock: undefined,
    images: imageUrl ? [{ url: imageUrl }] : [],
    tags,
    location: undefined,
    createdAt: existing?.product.createdAt ?? now,
    updatedAt: now,
  }

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.PRODUCT
  event.created_at = Math.floor(now / 1000)
  event.content = JSON.stringify(product)
  event.tags = [
    ["d", dTag],
    ["title", product.title],
    ["price", String(product.price), product.currency],
  ]

  if (product.summary) event.tags.push(["summary", product.summary])
  if (imageUrl) event.tags.push(["image", imageUrl])
  for (const tag of tags) event.tags.push(["t", tag])
  event.tags = appendConduitClientTag(event.tags, "merchant")

  await event.sign(ndk.signer)
  await event.publish()
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
  await deletion.publish()
}

function ProductsPage() {
  const { pubkey } = useAuth()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ProductFormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<MerchantProduct | null>(null)

  const productsQuery = useQuery({
    queryKey: ["merchant-products", pubkey ?? "none"],
    enabled: !!pubkey,
    queryFn: () => fetchMerchantProducts(pubkey!),
    refetchInterval: 15_000,
  })
  const merchantProducts = productsQuery.data?.data ?? []
  const merchantProductsMeta = productsQuery.data?.meta ?? null

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
      await queryClient.invalidateQueries({
        queryKey: ["merchant-products", pubkey ?? "none"],
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
    },
  })

  const isSaving = saveMutation.isPending
  const isDeleting = deleteMutation.isPending

  const itemCountLabel = useMemo(() => {
    const count = merchantProducts.length
    return `${count} listing${count === 1 ? "" : "s"}`
  }, [merchantProducts])

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
          {editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null)
                setForm(EMPTY_FORM)
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </div>

      {!pubkey && (
        <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Connect your signer to create and manage listings.
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className="xl:sticky xl:top-28">
          <div className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
            <div className="mb-4">
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                {editing ? "Edit listing" : "Create listing"}
              </div>
              <div className="mt-2 text-xl font-semibold text-[var(--text-primary)]">
                {editing ? editing.product.title : "New product"}
              </div>
            </div>

            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                saveMutation.mutate({ form, existing: editing ?? undefined })
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="product-title">Title</Label>
                <Input
                  id="product-title"
                  value={form.title}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, title: e.target.value }))
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
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, summary: e.target.value }))
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
                    step="0.01"
                    value={form.price}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, price: e.target.value }))
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
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, imageUrl: e.target.value }))
                  }
                  placeholder="https://..."
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="product-tags">Tags</Label>
                <Input
                  id="product-tags"
                  value={form.tags}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, tags: e.target.value }))
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

              <div className="pt-2">
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!pubkey || isSaving}
                >
                  {isSaving
                    ? "Saving…"
                    : editing
                      ? "Save changes"
                      : "Publish product"}
                </Button>
              </div>
            </form>
          </div>
        </section>

        <section className="space-y-4">
          {productsQuery.isLoading && (
            <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
              Loading products...
            </div>
          )}

          {merchantProductsMeta && (
            <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--text-secondary)]">
              Source: {merchantProductsMeta.source.replace("_", " ")}
              {merchantProductsMeta.stale ? " / stale view" : ""}
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

          {!productsQuery.isLoading && merchantProducts.length === 0 && (
            <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
              No listings yet. Publish your first product from the panel on the
              left.
            </div>
          )}

          {merchantProducts.map((item) => (
            <article
              key={item.addressId}
              className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                      {item.product.title}
                    </h2>
                    <Badge
                      variant="secondary"
                      className="border-[var(--border)] bg-[var(--surface-elevated)]"
                    >
                      {item.product.currency}
                    </Badge>
                  </div>
                  <div className="mt-2 break-all text-xs font-mono text-[var(--text-muted)]">
                    {item.addressId}
                  </div>
                </div>

                <div className="text-left sm:text-right">
                  <div className="text-lg font-semibold text-[var(--text-primary)]">
                    {item.product.price} {item.product.currency}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    Updated {new Date(item.product.updatedAt).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-[112px_minmax(0,1fr)]">
                <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                  {item.product.images[0]?.url ? (
                    <img
                      src={item.product.images[0].url}
                      alt={item.product.title}
                      className="h-28 w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-28 items-center justify-center text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                      No image
                    </div>
                  )}
                </div>

                <div>
                  {item.product.summary && (
                    <p className="text-sm leading-7 text-[var(--text-secondary)]">
                      {item.product.summary}
                    </p>
                  )}

                  {item.product.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {item.product.tags.map((tag) => (
                        <Badge
                          key={`${item.addressId}-${tag}`}
                          variant="outline"
                          className="border-[var(--border)] bg-[var(--surface)]"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing(item)
                    setForm(productToForm(item.product))
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isDeleting}
                  onClick={() => {
                    const ok = window.confirm(`Delete "${item.product.title}"?`)
                    if (ok) deleteMutation.mutate(item)
                  }}
                >
                  {isDeleting ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}
