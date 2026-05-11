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
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
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
  appendConduitClientTag,
  formatNpub,
  getProfileDisplayLabel,
  getProfileName,
  publishWithPlanner,
  requireNdkConnected,
  useAuth,
  useProfile,
  type PricingRateInput,
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
import { MerchantAvatarFallback } from "../../components/MerchantIdentity"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import {
  compareCommercePrices,
  getComparablePriceValue,
} from "../../lib/pricing"
import { useProgressiveProducts } from "../../hooks/useProgressiveProducts"
import {
  filterProductsByFacets,
  getCategoryFacetOptions,
  normalizeFacetValues,
} from "../../lib/facets"

type SortOption = "newest" | "price_asc" | "price_desc"

function isPriceSort(sort: SortOption | undefined): boolean {
  return sort === "price_asc" || sort === "price_desc"
}

type StoreSearch = {
  q?: string
  sort?: SortOption
  tag?: string[]
}

export const Route = createFileRoute("/store/$pubkey")({
  component: StorefrontPage,
  validateSearch: (raw: Record<string, unknown>): StoreSearch => {
    const tags = normalizeFacetValues(raw.tag).map((tag) => tag.toLowerCase())

    return {
      q: typeof raw.q === "string" ? raw.q : undefined,
      sort: (["newest", "price_asc", "price_desc"] as const).includes(
        raw.sort as SortOption
      )
        ? (raw.sort as SortOption)
        : undefined,
      tag: tags.length > 0 ? Array.from(new Set(tags)) : undefined,
    }
  },
})

function sortProducts(
  products: Product[],
  sort: SortOption | undefined,
  btcUsdRate: PricingRateInput
): Product[] {
  switch (sort) {
    case "price_asc":
      return [...products].sort(
        (a, b) =>
          compareCommercePrices(a, b, btcUsdRate, "asc") ||
          b.createdAt - a.createdAt
      )
    case "price_desc":
      return [...products].sort(
        (a, b) =>
          compareCommercePrices(a, b, btcUsdRate, "desc") ||
          b.createdAt - a.createdAt
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
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const [localSearch, setLocalSearch] = useState(search.q ?? "")
  const [searchDirty, setSearchDirty] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const productsQuery = useProgressiveProducts({
    scope: "storefront",
    merchantPubkey: pubkey,
    textQuery: search.q,
  })
  const profileQuery = useProfile(pubkey, {
    relayHints: productsQuery.profileRelayHintsByPubkey[pubkey],
  })
  const profile = profileQuery.data
  const storeProducts = productsQuery.products
  const selectedTags = useMemo(() => search.tag ?? [], [search.tag])
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags])
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

  const merchantProfileName = getProfileName(profile)
  const merchantIdentityPending = !merchantProfileName
  const merchantName =
    merchantProfileName ||
    getProfileDisplayLabel(profile, pubkey, {
      lookupSettled: false,
      pendingLabel: `Store ${formatNpub(pubkey, 8)}`,
      chars: 8,
    })
  const merchantAbout = profile?.about?.trim()
  const categoryFacetOptions = useMemo(
    () =>
      getCategoryFacetOptions(storeProducts, {
        q: search.q,
        tags: selectedTags,
      }),
    [search.q, selectedTags, storeProducts]
  )

  const updateSearch = useCallback(
    (updates: Partial<StoreSearch>) => {
      navigate({
        search: (prev) => {
          const next = { ...prev, ...updates }
          for (const key of Object.keys(next) as (keyof StoreSearch)[]) {
            const value = next[key]
            if (
              value === undefined ||
              value === "" ||
              (Array.isArray(value) && value.length === 0)
            ) {
              delete next[key]
            }
          }
          return next
        },
        replace: true,
      })
    },
    [navigate]
  )

  const productCount = storeProducts.length
  const isFollowing = followOverride ?? followQuery.data === true
  const isFollowBusy = followState !== "idle"

  const toggleTag = (tag: string) => {
    if (selectedTagSet.has(tag)) {
      updateSearch({
        tag: selectedTags.filter((selectedTag) => selectedTag !== tag),
      })
      return
    }

    updateSearch({ tag: [...selectedTags, tag] })
  }

  const matchingProducts = useMemo(() => {
    return filterProductsByFacets(storeProducts, {
      q: search.q,
      tags: selectedTags,
    })
  }, [search.q, selectedTags, storeProducts])

  const hasUnavailablePriceForSort = useMemo(() => {
    if (!isPriceSort(search.sort)) return false
    return matchingProducts.some(
      (product) => getComparablePriceValue(product, btcUsdRate) === null
    )
  }, [btcUsdRate, matchingProducts, search.sort])

  const filteredProducts = useMemo(
    () => sortProducts(matchingProducts, search.sort, btcUsdRate),
    [btcUsdRate, matchingProducts, search.sort]
  )

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
  }, [normalizedSearch, searchDirty, updateSearch])

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
      event.tags = appendConduitClientTag(nextTags, "market")

      await event.sign(ndk.signer)
      await publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: viewerPubkey,
      })

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
        <span className="text-[var(--text-primary)]">
          {merchantIdentityPending ? (
            <span className="inline-block max-w-full animate-pulse truncate align-middle">
              {merchantName}
            </span>
          ) : (
            merchantName
          )}
        </span>
      </div>

      <section className="overflow-hidden rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)]">
        <div className="relative px-5 py-6 sm:px-6 sm:py-7">
          <div className="relative space-y-5">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <Avatar className="h-24 w-24 self-start border border-[var(--border)] shadow-[var(--shadow-lg)] sm:h-28 sm:w-28">
                  <AvatarImage
                    src={profile?.picture}
                    alt={merchantName}
                    className="object-cover"
                  />
                  <AvatarFallback>
                    <MerchantAvatarFallback iconClassName="h-8 w-8 sm:h-10 sm:w-10" />
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-[0.22em] text-[var(--text-muted)]">
                    Store
                  </div>
                  {merchantIdentityPending ? (
                    <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.6rem]">
                      <span className="inline-block max-w-full animate-pulse truncate">
                        {merchantName}
                      </span>
                    </h1>
                  ) : (
                    <h1 className="mt-2 truncate text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[2.6rem]">
                      {merchantName}
                    </h1>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1 font-medium text-[var(--text-primary)]">
                      {profile?.nip05 || formatNpub(pubkey, 8)}
                      <CopyButton value={pubkey} label="Copy pubkey" />
                    </span>
                    <span className="hidden text-[var(--text-muted)] sm:inline">
                      Created Apr 2024
                    </span>
                  </div>
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

            <div className="border-t border-[var(--border)] pt-5">
              <RichProfileText
                text={
                  merchantAbout ||
                  "Browse this merchant's current listings and add products directly to your cart."
                }
                className="max-w-4xl text-sm leading-7 text-[var(--text-secondary)]"
              />
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
                {(selectedTags.length > 0 || search.q || search.sort) && (
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
                </div>

                <div className="relative mt-3">
                  <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5 xl:flex-col xl:items-stretch">
                      {categoryFacetOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => toggleTag(option.value)}
                          aria-pressed={option.selected}
                          className={[
                            "inline-flex items-center rounded-full border px-3 py-2 text-left text-sm font-medium capitalize transition-colors xl:rounded-xl",
                            option.selected
                              ? "border-primary-500/70 bg-primary-500 font-semibold text-white shadow-[0_12px_28px_color-mix(in_srgb,var(--primary-500)_24%,transparent)]"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                          ].join(" ")}
                        >
                          <span>{option.label}</span>
                          <span className="ml-1.5 self-center text-[0.82em] font-medium leading-none tabular-nums text-[var(--text-muted)]">
                            [{option.count}]
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
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
                  <SelectItem value="price_asc">Price: Low to High</SelectItem>
                  <SelectItem value="price_desc">Price: High to Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="relative min-h-[1.625rem] pr-32 sm:pr-36">
            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span>
                {filteredProducts.length} product
                {filteredProducts.length === 1 ? "" : "s"}
              </span>
              {selectedTags.length > 0 && (
                <span className="text-[var(--text-muted)]">
                  in {selectedTags.join(", ")}
                </span>
              )}
            </div>
            <span
              aria-hidden={
                !(productsQuery.isHydrating && filteredProducts.length > 0)
              }
              className={[
                "absolute right-0 top-0 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-opacity duration-150",
                productsQuery.isHydrating && filteredProducts.length > 0
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              ].join(" ")}
            >
              <LoaderCircle className="h-3 w-3 animate-spin text-secondary-300" />
              Updating store
            </span>
            {hasUnavailablePriceForSort && (
              <div className="mt-2 text-xs text-[var(--text-muted)]">
                Listings without a rate-backed sats price are shown last.
              </div>
            )}
          </div>

          {productsQuery.isInitialLoading && (
            <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <li key={index} className="h-full">
                  <ProductGridCardSkeleton />
                </li>
              ))}
            </ul>
          )}

          {!!productsQuery.error && (
            <div className="rounded-xl border border-error/20 bg-error/10 p-4 text-sm text-error">
              Failed to load this storefront.
            </div>
          )}

          {!productsQuery.isInitialLoading &&
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
              {filteredProducts.map((product, index) => (
                <li key={product.id} className="h-full">
                  <ProductGridCard
                    product={product}
                    merchantName={merchantName}
                    merchantNamePending={merchantIdentityPending}
                    imageLoading={index < 4 ? "eager" : "lazy"}
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
                        priceSats: product.priceSats,
                        sourcePrice: product.sourcePrice,
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
                        priceSats: product.priceSats,
                        sourcePrice: product.sourcePrice,
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
