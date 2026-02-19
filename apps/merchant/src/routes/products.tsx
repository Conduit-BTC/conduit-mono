import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS, parseProductEvent, requireNdkConnected, type ProductSchema, useAuth } from "@conduit/core"
import { Badge, Button, Input, Label } from "@conduit/ui"
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

function getTagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
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

function toEventCreatedAtSeconds(event: Pick<NDKEvent, "created_at">): number {
  return event.created_at ?? 0
}

type DeletionTimestamps = {
  byEventId: Map<string, number>
  byAddressId: Map<string, number>
}

function setLatestTimestamp(map: Map<string, number>, key: string, value: number): void {
  const existing = map.get(key) ?? -1
  if (value >= existing) map.set(key, value)
}

function collectProductAddresses(events: NDKEvent[]): string[] {
  const addresses = new Set<string>()
  for (const event of events) {
    const dTag = getTagValue(event.tags ?? [], "d")
    if (!dTag) continue
    addresses.add(`30402:${event.pubkey}:${dTag}`)
  }
  return Array.from(addresses)
}

async function fetchDeletionTimestamps(
  merchantPubkey: string,
  productEventIds: string[],
  productAddresses: string[]
): Promise<DeletionTimestamps> {
  const ndk = await requireNdkConnected()
  const byEventId = new Map<string, number>()
  const byAddressId = new Map<string, number>()

  const filters: NDKFilter[] = []
  if (productEventIds.length > 0) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchantPubkey],
      "#e": productEventIds,
      limit: 300,
    })
  }
  if (productAddresses.length > 0) {
    filters.push({
      kinds: [EVENT_KINDS.DELETION],
      authors: [merchantPubkey],
      "#a": productAddresses,
      limit: 300,
    })
  }

  const deletionEvents: NDKEvent[] = []
  for (const filter of filters) {
    const fetched = Array.from(await ndk.fetchEvents(filter)) as NDKEvent[]
    deletionEvents.push(...fetched)
  }

  // Fallback for relays that ignore tag-scoped deletion queries.
  if (deletionEvents.length === 0) {
    const fallback = Array.from(
      await ndk.fetchEvents({
        kinds: [EVENT_KINDS.DELETION],
        authors: [merchantPubkey],
        limit: 300,
      })
    ) as NDKEvent[]
    deletionEvents.push(...fallback)
  }

  for (const deletion of deletionEvents) {
    const deletedAt = toEventCreatedAtSeconds(deletion)
    for (const tag of deletion.tags ?? []) {
      const tagName = tag[0]
      const tagValue = tag[1]
      if (!tagValue) continue
      if (tagName === "e") setLatestTimestamp(byEventId, tagValue, deletedAt)
      if (tagName === "a") setLatestTimestamp(byAddressId, tagValue, deletedAt)
    }
  }

  return { byEventId, byAddressId }
}

function isDeletedByNip09(
  event: Pick<NDKEvent, "id" | "created_at">,
  addressId: string,
  deletionTimestamps: DeletionTimestamps
): boolean {
  const createdAt = toEventCreatedAtSeconds(event)
  if (event.id) {
    const deletedAt = deletionTimestamps.byEventId.get(event.id) ?? -1
    if (deletedAt >= createdAt) return true
  }
  const deletedAtAddress = deletionTimestamps.byAddressId.get(addressId) ?? -1
  return deletedAtAddress >= createdAt
}

async function fetchMerchantProducts(merchantPubkey: string): Promise<MerchantProduct[]> {
  const ndk = await requireNdkConnected()
  const events = Array.from(
    await ndk.fetchEvents({
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [merchantPubkey],
      limit: 200,
    })
  ) as NDKEvent[]

  events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
  const productEventIds = events.map((event) => event.id).filter(Boolean) as string[]
  const productAddresses = collectProductAddresses(events)
  const deletionTimestamps = await fetchDeletionTimestamps(merchantPubkey, productEventIds, productAddresses)

  const byAddress = new Map<string, MerchantProduct>()
  for (const event of events) {
    try {
      const parsed = parseProductEvent(event)
      const dTag = getTagValue(event.tags ?? [], "d")
      const addressId = dTag ? `30402:${event.pubkey}:${dTag}` : parsed.id
      if (isDeletedByNip09(event, addressId, deletionTimestamps)) continue
      const dedupeKey = dTag ?? parsed.id
      const candidate: MerchantProduct = {
        eventId: event.id,
        addressId,
        dTag,
        eventCreatedAt: toEventCreatedAtSeconds(event),
        product: parsed,
      }

      const existing = byAddress.get(dedupeKey)
      if (!existing || candidate.eventCreatedAt >= existing.eventCreatedAt) {
        byAddress.set(dedupeKey, candidate)
      }
    } catch {
      // ignore malformed product events
    }
  }

  return Array.from(byAddress.values()).sort((a, b) => b.product.updatedAt - a.product.updatedAt)
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
  if (!Number.isFinite(price) || price < 0) throw new Error("Price must be a non-negative number")

  const currency = form.currency.trim().toUpperCase() || "USD"
  const summary = form.summary.trim()
  const imageUrl = form.imageUrl.trim()
  if (imageUrl && !/^https:\/\//.test(imageUrl)) {
    throw new Error("Image URL must start with https://")
  }

  const dTag = existing?.dTag ?? `${slugify(title) || "product"}-${randomSuffix()}`
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

  await event.sign(ndk.signer)
  await event.publish()
}

async function deleteProduct(merchantPubkey: string, product: MerchantProduct): Promise<void> {
  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")
  if (product.product.pubkey !== merchantPubkey) {
    throw new Error("Product pubkey mismatch; refusing to publish deletion event")
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
  deletion.tags = tags
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

  const saveMutation = useMutation({
    mutationFn: async (payload: { form: ProductFormState; existing?: MerchantProduct }) => {
      await publishProduct(pubkey!, payload.form, payload.existing)
    },
    onSuccess: async () => {
      setEditing(null)
      setForm(EMPTY_FORM)
      await queryClient.invalidateQueries({ queryKey: ["merchant-products", pubkey ?? "none"] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (product: MerchantProduct) => {
      await deleteProduct(pubkey!, product)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["merchant-products", pubkey ?? "none"] })
    },
  })

  const isSaving = saveMutation.isPending
  const isDeleting = deleteMutation.isPending

  const itemCountLabel = useMemo(() => {
    if (!productsQuery.data) return "0 listings"
    const count = productsQuery.data.length
    return `${count} listing${count === 1 ? "" : "s"}`
  }, [productsQuery.data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-medium text-[var(--text-primary)]">Products</h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Publish and manage kind {EVENT_KINDS.PRODUCT} listings for this merchant pubkey.
          </p>
        </div>
        <Badge variant="secondary" className="border-[var(--border)]">
          {itemCountLabel}
        </Badge>
      </div>

      {!pubkey && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to manage listings.
        </div>
      )}

      <section className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {editing ? "Edit listing" : "Create listing"}
          </div>
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

        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            saveMutation.mutate({ form, existing: editing ?? undefined })
          }}
        >
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="product-title">Title</Label>
            <Input
              id="product-title"
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="Product title"
              required
            />
          </div>

          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="product-summary">Summary</Label>
            <textarea
              id="product-summary"
              className="min-h-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none ring-primary/20 transition focus:ring-2"
              value={form.summary}
              onChange={(e) => setForm((prev) => ({ ...prev, summary: e.target.value }))}
              placeholder="Short description shown to buyers"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="product-price">Price</Label>
            <Input
              id="product-price"
              type="number"
              min="0"
              step="0.01"
              value={form.price}
              onChange={(e) => setForm((prev) => ({ ...prev, price: e.target.value }))}
              required
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="product-currency">Currency</Label>
            <Input
              id="product-currency"
              value={form.currency}
              onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value.toUpperCase() }))}
              placeholder="USD"
              maxLength={12}
            />
          </div>

          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="product-image">Image URL</Label>
            <Input
              id="product-image"
              type="url"
              value={form.imageUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, imageUrl: e.target.value }))}
              placeholder="https://..."
            />
          </div>

          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="product-tags">Tags (comma separated)</Label>
            <Input
              id="product-tags"
              value={form.tags}
              onChange={(e) => setForm((prev) => ({ ...prev, tags: e.target.value }))}
              placeholder="gear, hardware, demo"
            />
          </div>

          {saveMutation.error && (
            <div className="md:col-span-2 rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error">
              {saveMutation.error instanceof Error ? saveMutation.error.message : "Failed to publish product"}
            </div>
          )}

          <div className="md:col-span-2 flex items-center justify-end gap-2">
            <Button type="submit" disabled={!pubkey || isSaving}>
              {isSaving ? "Saving…" : editing ? "Save changes" : "Publish product"}
            </Button>
          </div>
        </form>
      </section>

      {productsQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">Loading products…</div>
      )}

      {productsQuery.error && (
        <div className="rounded-md border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load products:{" "}
          {productsQuery.error instanceof Error ? productsQuery.error.message : "Unknown error"}
        </div>
      )}

      {productsQuery.data && productsQuery.data.length === 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No listings yet. Publish your first product above.
        </div>
      )}

      {productsQuery.data && productsQuery.data.length > 0 && (
        <div className="space-y-3">
          {productsQuery.data.map((item) => (
            <article key={item.addressId} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-medium text-[var(--text-primary)]">{item.product.title}</h2>
                  <div className="mt-1 text-xs text-[var(--text-secondary)] font-mono">{item.addressId}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-[var(--text-primary)]">
                    {item.product.price} {item.product.currency}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    {new Date(item.product.updatedAt).toLocaleString()}
                  </div>
                </div>
              </div>

              {item.product.summary && (
                <p className="mt-3 text-sm text-[var(--text-secondary)]">{item.product.summary}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {item.product.tags.map((tag) => (
                  <Badge key={`${item.addressId}-${tag}`} variant="outline" className="border-[var(--border)]">
                    {tag}
                  </Badge>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
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
        </div>
      )}
    </div>
  )
}
