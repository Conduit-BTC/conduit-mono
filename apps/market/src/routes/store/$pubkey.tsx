import {
  Check,
  Link as LinkIcon,
  LoaderCircle,
  MessageCircle,
  Search,
  UserCheck,
  UserMinus,
  UserPlus,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  formatNpub,
  requireNdkConnected,
  useAuth,
  useProfile,
  type Product,
} from "@conduit/core"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { SignerSwitch } from "../../components/SignerSwitch"
import { RichProfileText } from "../../components/RichProfileText"
import {
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { CopyButton } from "../../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../../components/MerchantIdentity"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import { getComparablePriceValue } from "../../lib/pricing"
import { fetchStoreProducts } from "../../lib/storeProducts"

type SortOption = "newest" | "price_asc" | "price_desc"

type StoreSearch = {
  q?: string
  sort?: SortOption
  tag?: string
}

export const Route = createFileRoute("/store/$pubkey")({
  component: StorefrontPage,
  validateSearch: (raw: Record<string, unknown>): StoreSearch => ({
    q: typeof raw.q === "string" ? raw.q : undefined,
    sort: (["newest", "price_asc", "price_desc"] as const).includes(
      raw.sort as SortOption
    )
      ? (raw.sort as SortOption)
      : undefined,
    tag:
      typeof raw.tag === "string" && raw.tag.trim() !== ""
        ? raw.tag.trim().toLowerCase()
        : undefined,
  }),
})

function sortProducts(
  products: Product[],
  sort: SortOption | undefined,
  btcUsdRate: number | null
): Product[] {
  switch (sort) {
    case "price_asc":
      return [...products].sort(
        (a, b) =>
          (getComparablePriceValue(a, btcUsdRate) ?? a.price) -
          (getComparablePriceValue(b, btcUsdRate) ?? b.price)
      )
    case "price_desc":
      return [...products].sort(
        (a, b) =>
          (getComparablePriceValue(b, btcUsdRate) ?? b.price) -
          (getComparablePriceValue(a, btcUsdRate) ?? a.price)
      )
    case "newest":
    default:
      return [...products].sort((a, b) => b.createdAt - a.createdAt)
  }
}

function StorefrontPage() {
  const { pubkey } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const queryClient = useQueryClient()
  const cart = useCart()
  const { pubkey: viewerPubkey, status } = useAuth()
  const { data: profile } = useProfile(pubkey)
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data?.rate ?? null
  const [localSearch, setLocalSearch] = useState(search.q ?? "")
  const [searchDirty, setSearchDirty] = useState(false)
  const [showAllTags, setShowAllTags] = useState(false)
  const [tagCloudOverflows, setTagCloudOverflows] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const tagCloudRef = useRef<HTMLDivElement | null>(null)
  const productsQuery = useQuery({
    queryKey: ["store-products", pubkey],
    queryFn: () => fetchStoreProducts(pubkey),
  })
  const storeProducts = productsQuery.data?.data ?? []
  const followQuery = useQuery({
    queryKey: ["following-store", viewerPubkey ?? "none", pubkey],
    enabled:
      status === "connected" && !!viewerPubkey && viewerPubkey !== pubkey,
    queryFn: async () => {
      const ndk = await requireNdkConnected()
      const events = await ndk.fetchEvents({
        kinds: [3],
        authors: [viewerPubkey!],
        limit: 10,
      })
      const event = Array.from(events).sort(
        (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
      )[0]

      return Array.from(event?.tags ?? []).some(
        (tag) => tag[0] === "p" && tag[1] === pubkey
      )
    },
  })
  const [followState, setFollowState] = useState<
    "idle" | "saving_follow" | "saving_unfollow"
  >("idle")
  const [followOverride, setFollowOverride] = useState<boolean | null>(null)

  const merchantName = getMerchantDisplayName(profile, pubkey)
  const merchantAbout = profile?.about?.trim()
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const product of storeProducts) {
      for (const tag of product.tags) tagSet.add(tag.toLowerCase())
    }
    return Array.from(tagSet).sort()
  }, [storeProducts])

  const updateSearch = (updates: Partial<StoreSearch>) => {
    navigate({
      search: (prev) => {
        const next = { ...prev, ...updates }
        for (const key of Object.keys(next) as (keyof StoreSearch)[]) {
          const value = next[key]
          if (value === undefined || value === "") {
            delete next[key]
          }
        }
        return next
      },
      replace: true,
    })
  }

  const productCount = storeProducts.length
  const isFollowing = followOverride ?? followQuery.data === true
  const isFollowBusy = followState !== "idle"
  const canShowPriceSort = useMemo(() => {
    const products = storeProducts
    if (products.length <= 1) return true
    const currencies = new Set(
      products.map((product) => product.currency.trim().toUpperCase())
    )
    if (currencies.size <= 1) return true
    return products.every(
      (product) => getComparablePriceValue(product, btcUsdRate) !== null
    )
  }, [btcUsdRate, storeProducts])

  const filteredProducts = useMemo(() => {
    let result = storeProducts

    if (search.q) {
      const query = search.q.toLowerCase()
      result = result.filter(
        (product) =>
          product.title.toLowerCase().includes(query) ||
          (product.summary?.toLowerCase().includes(query) ?? false)
      )
    }

    if (search.tag) {
      result = result.filter((product) =>
        product.tags.some((tag) => tag.toLowerCase() === search.tag)
      )
    }

    const effectiveSort = canShowPriceSort ? search.sort : undefined
    return sortProducts(result, effectiveSort, btcUsdRate)
  }, [
    btcUsdRate,
    canShowPriceSort,
    search.q,
    search.sort,
    search.tag,
    storeProducts,
  ])

  useEffect(() => {
    if (
      !canShowPriceSort &&
      (search.sort === "price_asc" || search.sort === "price_desc")
    ) {
      updateSearch({ sort: undefined })
    }
  }, [canShowPriceSort, search.sort, updateSearch])

  useEffect(() => {
    const element = tagCloudRef.current
    if (!element) return

    const measure = () => {
      setTagCloudOverflows(element.scrollHeight > 76)
    }

    measure()

    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    resizeObserver?.observe(element)
    window.addEventListener("resize", measure)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [allTags, search.tag, showAllTags])

  useEffect(() => {
    setLocalSearch(search.q ?? "")
    setSearchDirty(false)
  }, [search.q])

  const normalizedSearch = localSearch.trim()
  const pendingSearch =
    searchDirty &&
    normalizedSearch.length >= 3 &&
    normalizedSearch !== (search.q ?? "")

  useEffect(() => {
    if (!searchDirty) return
    if (normalizedSearch.length > 0 && normalizedSearch.length < 3) return

    const timeoutId = window.setTimeout(() => {
      updateSearch({ q: normalizedSearch || undefined })
    }, 260)

    return () => window.clearTimeout(timeoutId)
  }, [normalizedSearch, searchDirty])

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    updateSearch({ q: normalizedSearch || undefined })
    setSearchDirty(false)
  }

  function handleSendMessage(): void {
    if (status !== "connected") {
      setConnectOpen(true)
      return
    }

    navigate({
      to: "/messages",
      search: {
        tab: "merchants",
        merchant: pubkey,
      },
    })
  }

  async function handleFollow(): Promise<void> {
    if (status !== "connected" || !viewerPubkey || viewerPubkey === pubkey) {
      setConnectOpen(true)
      return
    }
    if (isFollowBusy) return

    const nextShouldFollow = !isFollowing
    setFollowState(nextShouldFollow ? "saving_follow" : "saving_unfollow")
    try {
      const ndk = await requireNdkConnected()
      if (!ndk.signer) throw new Error("Signer not connected")

      const existingEvents = await ndk.fetchEvents({
        kinds: [3],
        authors: [viewerPubkey],
        limit: 10,
      })
      const latest = Array.from(existingEvents).sort(
        (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
      )[0]

      const nextTags = Array.from(latest?.tags ?? [])
      const alreadyFollowing = nextTags.some(
        (tag) => tag[0] === "p" && tag[1] === pubkey
      )
      if (nextShouldFollow && !alreadyFollowing) {
        nextTags.push(["p", pubkey])
      }
      if (!nextShouldFollow && alreadyFollowing) {
        for (let index = nextTags.length - 1; index >= 0; index -= 1) {
          const tag = nextTags[index]
          if (tag[0] === "p" && tag[1] === pubkey) {
            nextTags.splice(index, 1)
          }
        }
      }

      const event = new NDKEvent(ndk)
      event.kind = 3
      event.created_at = Math.floor(Date.now() / 1000)
      event.content = latest?.content ?? ""
      event.tags = nextTags

      await event.sign(ndk.signer)
      await event.publish()

      setFollowOverride(nextShouldFollow)
      await queryClient.invalidateQueries({
        queryKey: ["following-store", viewerPubkey, pubkey],
      })
      setFollowState("idle")
    } catch {
      setFollowOverride(null)
      setFollowState("idle")
    }
  }

  async function handleShareStore(): Promise<void> {
    const shareUrl =
      typeof window !== "undefined"
        ? window.location.href
        : `https://conduit.market/store/${pubkey}`
    const canUseNativeShare =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches

    if (canUseNativeShare) {
      try {
        await navigator.share({
          title: merchantName,
          text: `Browse ${merchantName} on Conduit`,
          url: shareUrl,
        })
        return
      } catch {
        return
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl)
      setShareCopied(true)
      window.setTimeout(() => setShareCopied(false), 1600)
    } catch {
      setShareCopied(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Link
          to="/products"
          className="transition-colors hover:text-[var(--text-primary)]"
        >
          Shop
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">{merchantName}</span>
      </div>

      <section className="overflow-hidden rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)]">
        <div className="relative px-5 py-6 sm:px-6 sm:py-7">
          <div className="relative">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end">
                <Avatar className="h-24 w-24 shrink-0 border border-[var(--border)] shadow-[var(--shadow-lg)] sm:h-28 sm:w-28">
                  <AvatarImage src={profile?.picture} alt={merchantName} />
                  <AvatarFallback>
                    <MerchantAvatarFallback iconClassName="h-8 w-8 sm:h-10 sm:w-10" />
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                    Store
                  </div>
                  <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.6rem]">
                    {merchantName}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                      {profile?.nip05 || formatNpub(pubkey, 8)}
                      <CopyButton value={pubkey} label="Copy pubkey" />
                    </span>
                    <span className="hidden text-[var(--text-muted)] sm:inline">
                      Created Apr 2024
                    </span>
                  </div>
                  <RichProfileText
                    text={
                      merchantAbout ||
                      "Browse this merchant's current listings and add products directly to your cart."
                    }
                    className="mt-3 max-w-[56ch] text-sm leading-7 text-[var(--text-secondary)]"
                  />
                </div>
              </div>

              <div className="flex flex-col items-start gap-4 xl:items-end">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-left xl:min-w-[132px] xl:text-right">
                  <div className="text-lg font-semibold leading-none text-[var(--text-primary)]">
                    {productCount}
                  </div>
                  <div className="mt-2 text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Listings
                  </div>
                </div>

                <div className="flex flex-nowrap items-center gap-3 xl:justify-end">
                  <Button
                    variant="outline"
                    className="h-11 shrink-0 whitespace-nowrap border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm text-[var(--text-primary)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]"
                    onClick={handleSendMessage}
                  >
                    <MessageCircle className="h-4 w-4" />
                    Send message
                  </Button>
                  <Button
                    variant={isFollowing ? "outline" : "primary"}
                    className={[
                      "group h-11 shrink-0 whitespace-nowrap px-4 text-sm",
                      isFollowing
                        ? "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-glass-inset)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]"
                        : "",
                    ].join(" ")}
                    onClick={() => void handleFollow()}
                    disabled={isFollowBusy}
                  >
                    {isFollowBusy ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : isFollowing ? (
                      <span className="relative grid h-4 w-4 place-items-center">
                        <UserCheck className="col-start-1 row-start-1 h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
                        <UserMinus className="col-start-1 row-start-1 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                      </span>
                    ) : (
                      <UserPlus className="h-4 w-4" />
                    )}
                    {isFollowBusy ? (
                      followState === "saving_unfollow" ? (
                        "Unfollowing…"
                      ) : (
                        "Following…"
                      )
                    ) : isFollowing ? (
                      <span className="grid">
                        <span className="col-start-1 row-start-1 transition-opacity duration-150 group-hover:opacity-0">
                          Following
                        </span>
                        <span className="col-start-1 row-start-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                          Unfollow
                        </span>
                      </span>
                    ) : (
                      "Follow"
                    )}
                  </Button>
                  <button
                    type="button"
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                    onClick={handleShareStore}
                    aria-label={
                      shareCopied ? "Store link copied" : "Copy store link"
                    }
                    title={shareCopied ? "Copied" : "Copy store link"}
                  >
                    {shareCopied ? (
                      <Check className="h-[18px] w-[18px] text-success" />
                    ) : (
                      <LinkIcon className="h-[18px] w-[18px]" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <div className="grid items-start gap-6 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="xl:sticky xl:top-24 xl:self-start">
          <div className="space-y-5 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto xl:pr-1">
            <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Filters
                </div>
                {(search.tag || search.q || search.sort) && (
                  <button
                    type="button"
                    className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    onClick={() => {
                      setLocalSearch("")
                      updateSearch({
                        q: undefined,
                        tag: undefined,
                        sort: undefined,
                      })
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Category
                  </div>
                  {tagCloudOverflows && (
                    <button
                      type="button"
                      className={[
                        "text-xs font-medium text-secondary-400 transition-[opacity,color] duration-200 hover:text-secondary-300 xl:hidden",
                        showAllTags
                          ? "opacity-100"
                          : "pointer-events-none opacity-0",
                      ].join(" ")}
                      onClick={() => setShowAllTags(false)}
                    >
                      Collapse
                    </button>
                  )}
                </div>

                <div className="relative mt-3">
                  <div
                    ref={tagCloudRef}
                    className={[
                      "overflow-hidden transition-[max-height] duration-300 ease-out xl:max-h-none xl:overflow-visible",
                      showAllTags || !tagCloudOverflows
                        ? "max-h-64"
                        : "max-h-[4.75rem]",
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5 xl:flex-col xl:items-stretch">
                      <button
                        type="button"
                        onClick={() => updateSearch({ tag: undefined })}
                        className={[
                          "rounded-full border px-3 py-2 text-left text-sm transition-colors xl:rounded-xl",
                          !search.tag
                            ? "border-primary-500/70 bg-primary-500 font-semibold text-white shadow-[0_12px_28px_color-mix(in_srgb,var(--primary-500)_24%,transparent)]"
                            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        ].join(" ")}
                      >
                        All products
                      </button>
                      {allTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() =>
                            updateSearch({
                              tag: search.tag === tag ? undefined : tag,
                            })
                          }
                          className={[
                            "rounded-full border px-3 py-2 text-left text-sm font-medium capitalize transition-colors xl:rounded-xl",
                            search.tag === tag
                              ? "border-primary-500/70 bg-primary-500 font-semibold text-white shadow-[0_12px_28px_color-mix(in_srgb,var(--primary-500)_24%,transparent)]"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                          ].join(" ")}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>

                  {!showAllTags && tagCloudOverflows && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-center justify-center bg-gradient-to-b from-transparent via-[var(--background)]/90 to-[var(--background)] transition-opacity duration-200 xl:hidden">
                      <button
                        type="button"
                        className="pointer-events-auto rounded-full bg-[var(--text-primary)] px-3 py-1 text-xs font-medium text-[var(--text-inverse)] shadow-md transition-[opacity,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                        onClick={() => setShowAllTags(true)}
                      >
                        Expand categories
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="space-y-4">
          <div className="grid gap-3 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
            <form
              className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3"
              onSubmit={submitSearch}
            >
              <Search className="h-4 w-4 text-[var(--text-muted)]" />
              <input
                value={localSearch}
                onChange={(event) => {
                  setLocalSearch(event.target.value)
                  setSearchDirty(true)
                }}
                placeholder="Search items in this store"
                className="h-11 w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              <div className="text-[var(--text-muted)]">
                {pendingSearch ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : null}
              </div>
            </form>

            <div className="flex min-w-0 w-full items-center gap-2">
              <span className="min-w-[2.5rem] text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                Sort
              </span>
              <Select
                value={search.sort ?? "newest"}
                onValueChange={(value) =>
                  updateSearch({
                    sort:
                      value === "newest" ? undefined : (value as SortOption),
                  })
                }
              >
                <SelectTrigger className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="price_asc" disabled={!canShowPriceSort}>
                    Price: Low to High
                  </SelectItem>
                  <SelectItem value="price_desc" disabled={!canShowPriceSort}>
                    Price: High to Low
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-[var(--text-secondary)]">
              {filteredProducts.length} product
              {filteredProducts.length === 1 ? "" : "s"}
              {search.tag && (
                <span className="ml-2 text-[var(--text-muted)]">
                  in {search.tag}
                </span>
              )}
            </div>
            {!canShowPriceSort && (
              <div className="text-xs text-[var(--text-muted)]">
                Price sorting is available when listings share a currency or a
                BTC/USD display rate exists.
              </div>
            )}
          </div>

          {productsQuery.isLoading && (
            <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <li key={index} className="h-full">
                  <ProductGridCardSkeleton />
                </li>
              ))}
            </ul>
          )}

          {productsQuery.error && (
            <div className="rounded-xl border border-error/20 bg-error/10 p-4 text-sm text-error">
              Failed to load this storefront.
            </div>
          )}

          {!productsQuery.isLoading &&
            storeProducts.length > 0 &&
            filteredProducts.length === 0 && (
              <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6">
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  No products match this store view
                </div>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                  Try clearing the store search or category filter to see the
                  merchant’s other listings.
                </p>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setLocalSearch("")
                      updateSearch({
                        q: undefined,
                        tag: undefined,
                        sort: undefined,
                      })
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              </div>
            )}

          {filteredProducts.length > 0 && (
            <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
              {filteredProducts.map((product) => (
                <li key={product.id} className="h-full">
                  <ProductGridCard
                    product={product}
                    btcUsdRate={btcUsdRate}
                    cartQuantity={
                      cart.items.find((item) => item.productId === product.id)
                        ?.quantity ?? 0
                    }
                    onAddToCart={() =>
                      cart.addItem({
                        productId: product.id,
                        merchantPubkey: product.pubkey,
                        title: product.title,
                        price: product.price,
                        currency: product.currency,
                        image: product.images[0]?.url,
                        tags: product.tags,
                      })
                    }
                    onIncrement={() =>
                      cart.addItem({
                        productId: product.id,
                        merchantPubkey: product.pubkey,
                        title: product.title,
                        price: product.price,
                        currency: product.currency,
                        image: product.images[0]?.url,
                        tags: product.tags,
                      })
                    }
                    onDecrement={() => {
                      const existing = cart.items.find(
                        (item) => item.productId === product.id
                      )
                      if (!existing) return
                      if (existing.quantity <= 1) {
                        cart.removeItem(product.id)
                        return
                      }
                      cart.setQuantity(product.id, existing.quantity - 1)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <SignerSwitch
        open={connectOpen}
        onOpenChange={setConnectOpen}
        hideTrigger
      />
    </div>
  )
}
