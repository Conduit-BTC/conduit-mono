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
import { useQueryClient } from "@tanstack/react-query"
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
  getCommerceReadRelayUrls,
  getTelemetryCountBucket,
  normalizePubkey,
  publishContactListUpdate,
  pubkeyToNpub,
  recordBrowserTelemetryEvent,
  useAuth,
  type PricingRateInput,
  type Product,
} from "@conduit/core"
import { SignerSwitch } from "../../components/SignerSwitch"
import { RichProfileText } from "../../components/RichProfileText"
import {
  ProductGridCard,
  ProductGridCardSkeleton,
} from "../../components/ProductGridCard"
import { CopyButton } from "../../components/CopyButton"
import {
  MerchantAvatarFallback,
  Nip05TrustIndicator,
  getProfileNip05,
} from "../../components/MerchantIdentity"
import { MerchantTrustSummary } from "../../components/MerchantTrustSummary"
import { useBtcUsdRate } from "../../hooks/useBtcUsdRate"
import { useCart } from "../../hooks/useCart"
import { useMerchantTrustContext } from "../../hooks/useMerchantTrustContext"
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
type CategoryFacetOption = ReturnType<typeof getCategoryFacetOptions>[number]

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

function CategoryFacetButton({
  option,
  onToggle,
  className = "",
}: {
  option: CategoryFacetOption
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={option.selected}
      className={[
        "inline-flex min-w-0 max-w-full items-center rounded-full border px-3 py-2 text-left text-sm font-medium capitalize transition-colors",
        option.selected
          ? "border-primary-500/70 bg-primary-500 font-semibold text-white shadow-[0_12px_28px_color-mix(in_srgb,var(--primary-500)_24%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
        className,
      ].join(" ")}
    >
      <span className="min-w-0 truncate">{option.label}</span>
      <span
        className={[
          "ml-1.5 shrink-0 self-center text-[0.82em] font-medium leading-none tabular-nums",
          option.selected ? "text-white/80" : "text-[var(--text-muted)]",
        ].join(" ")}
      >
        [{option.count}]
      </span>
    </button>
  )
}

function StorefrontPage() {
  const { pubkey: pubkeyParam } = Route.useParams()
  const pubkey = normalizePubkey(pubkeyParam) ?? pubkeyParam
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
  const profileRelayHints = useMemo(
    () =>
      Array.from(
        new Set([
          ...getCommerceReadRelayUrls(),
          ...(productsQuery.profileRelayHintsByPubkey[pubkey] ?? []),
        ])
      ),
    [productsQuery.profileRelayHintsByPubkey, pubkey]
  )
  const storeProducts = productsQuery.products
  const productCount = storeProducts.length
  const merchantTrust = useMerchantTrustContext({
    merchantPubkey: pubkey,
    viewerPubkey,
    listingCount: productCount,
    profileRelayHints,
  })
  const profile = merchantTrust.profile
  const selectedTags = useMemo(() => search.tag ?? [], [search.tag])
  const selectedTagSet = useMemo(() => new Set(selectedTags), [selectedTags])
  const [followState, setFollowState] = useState<
    "idle" | "saving_follow" | "saving_unfollow"
  >("idle")
  const [followOverride, setFollowOverride] = useState<boolean | null>(null)
  const [followError, setFollowError] = useState<string | null>(null)

  const merchantIdentityPending = merchantTrust.merchantNamePending
  const merchantName = merchantTrust.merchantName
  const merchantAbout = profile?.about?.trim()
  const profileNip05 = getProfileNip05(profile)
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

  const recordStorefrontSearch = useCallback(
    (query: string, tags: string[] = selectedTags) => {
      const nextQuery = query || undefined
      const resultCount = filterProductsByFacets(storeProducts, {
        q: nextQuery,
        tags,
      }).length

      recordBrowserTelemetryEvent({
        app: "market",
        eventName: "market_browse_action",
        properties: {
          action: nextQuery ? "storefront_search" : "storefront_search_clear",
          result_count_bucket: getTelemetryCountBucket(resultCount),
          status: "success",
          surface: "storefront",
        },
      })
    },
    [selectedTags, storeProducts]
  )

  const isFollowing =
    followOverride ?? merchantTrust.viewerFollowsMerchant === true
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
      if ((normalizedSearch || undefined) !== search.q) {
        recordStorefrontSearch(normalizedSearch)
      }
      updateSearch({ q: normalizedSearch || undefined })
    }, 260)

    return () => window.clearTimeout(timeoutId)
  }, [
    normalizedSearch,
    recordStorefrontSearch,
    search.q,
    searchDirty,
    updateSearch,
  ])

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if ((normalizedSearch || undefined) !== search.q) {
      recordStorefrontSearch(normalizedSearch)
    }
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
    setFollowError(null)
    try {
      await publishContactListUpdate({
        ownerPubkey: viewerPubkey,
        targetPubkey: pubkey,
        shouldFollow: nextShouldFollow,
        appId: "market",
      })

      setFollowOverride(nextShouldFollow)
      await queryClient.invalidateQueries({
        queryKey: ["merchant-trust-social", viewerPubkey, pubkey],
      })
      setFollowState("idle")
    } catch (error) {
      setFollowOverride(null)
      setFollowError(
        error instanceof Error
          ? error.message
          : "Could not update this follow list."
      )
      setFollowState("idle")
    }
  }

  async function handleShareStore(): Promise<void> {
    const canonicalStorePath = `/store/${encodeURIComponent(pubkeyToNpub(pubkey))}`
    const shareUrl =
      typeof window !== "undefined"
        ? new URL(
            `${canonicalStorePath}${window.location.search}`,
            window.location.origin
          ).toString()
        : `https://conduit.market${canonicalStorePath}`
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
        <span className="block min-w-0 max-w-full truncate text-[var(--text-primary)]">
          {merchantIdentityPending ? (
            <span className="inline-block max-w-full animate-pulse truncate align-middle">
              {merchantName}
            </span>
          ) : (
            merchantName
          )}
        </span>
      </div>

      <section className="max-w-full overflow-hidden rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)]">
        <div className="relative px-5 py-6 sm:px-6 sm:py-7">
          <div className="relative space-y-5">
            <div className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-5">
              <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-[28rem] sm:gap-4 lg:basis-[34rem]">
                <Avatar className="h-20 w-20 shrink-0 self-start border border-[var(--border)] shadow-[var(--shadow-lg)] sm:h-28 sm:w-28">
                  <AvatarImage
                    src={profile?.picture}
                    alt={merchantName}
                    className="object-cover"
                  />
                  <AvatarFallback>
                    <MerchantAvatarFallback iconClassName="h-8 w-8 sm:h-10 sm:w-10" />
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    {merchantIdentityPending ? (
                      <h1 className="min-w-0 max-w-full truncate pb-1 text-3xl font-semibold leading-[1.16] tracking-tight text-[var(--text-primary)] sm:text-[2.6rem]">
                        <span className="inline-block max-w-full animate-pulse truncate pb-1 leading-[1.16]">
                          {merchantName}
                        </span>
                      </h1>
                    ) : (
                      <h1 className="min-w-0 max-w-full truncate pb-1 text-3xl font-semibold leading-[1.16] tracking-tight text-[var(--text-primary)] sm:text-[2.6rem]">
                        {merchantName}
                      </h1>
                    )}
                    <button
                      type="button"
                      className="inline-flex size-10 shrink-0 items-center justify-center text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
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
                  <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--text-secondary)]">
                    <span className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 font-medium text-[var(--text-primary)] sm:max-w-[22rem]">
                      <span className="block min-w-0 truncate">
                        {profileNip05 ? (
                          <Nip05TrustIndicator
                            pubkey={pubkey}
                            nip05={profileNip05}
                          />
                        ) : (
                          formatNpub(pubkey, 8)
                        )}
                      </span>
                      <span className="shrink-0">
                        <CopyButton value={pubkey} label="Copy pubkey" />
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex w-full min-w-0 max-w-full flex-wrap items-center justify-start gap-3 sm:ml-auto sm:w-auto sm:justify-end">
                <Button
                  variant="outline"
                  className="h-11 max-w-full shrink-0 border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm text-[var(--text-primary)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]"
                  onClick={handleSendMessage}
                >
                  <MessageCircle className="h-4 w-4" />
                  Send message
                </Button>
                <Button
                  variant={isFollowing ? "outline" : "primary"}
                  className={[
                    "group h-11 max-w-full shrink-0 px-4 text-sm",
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
              </div>
              {followError && (
                <p className="max-w-sm text-left text-xs leading-5 text-[var(--warning)] sm:ml-auto sm:text-right">
                  {followError}
                </p>
              )}
            </div>

            <MerchantTrustSummary trust={merchantTrust} />

            <div className="border-t border-[var(--border)] pt-5">
              <RichProfileText
                text={
                  merchantAbout ||
                  "Browse this merchant's current listings and add items directly to your cart."
                }
                className="max-w-4xl text-sm leading-7 text-[var(--text-secondary)]"
              />
            </div>
          </div>
        </div>
      </section>
      <div className="grid min-w-0 max-w-full items-start gap-5 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
        <aside className="hidden md:sticky md:top-24 md:block md:self-start">
          <div className="space-y-5 md:max-h-[calc(100vh-7rem)] md:overflow-y-auto md:pr-1">
            <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Categories
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
                <div className="relative">
                  <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                    <div className="flex flex-col items-stretch gap-1.5 pt-0.5">
                      {categoryFacetOptions.map((option) => (
                        <CategoryFacetButton
                          key={option.value}
                          option={option}
                          onToggle={() => toggleTag(option.value)}
                          className="w-full rounded-xl"
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0 max-w-full self-start overflow-hidden">
          {categoryFacetOptions.length > 0 && (
            <div className="mb-4 min-w-0 max-w-full overflow-hidden rounded-[1.25rem] border border-[var(--border)] bg-[var(--surface)] p-4 md:hidden">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Categories
                </div>
                {selectedTags.length > 0 && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                    onClick={() => updateSearch({ tag: undefined })}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="max-h-[4.75rem] max-w-full overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className="flex max-w-full flex-wrap items-center gap-1.5 pt-0.5">
                  {categoryFacetOptions.map((option) => (
                    <CategoryFacetButton
                      key={option.value}
                      option={option}
                      onToggle={() => toggleTag(option.value)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="grid min-w-0 max-w-full gap-3 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
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

          <div className="relative mt-4 min-h-[1.625rem] pr-32 sm:pr-36">
            <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span>
                {filteredProducts.length} listing
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
            <ul className="mt-4 grid min-w-0 max-w-full auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <li key={index} className="h-full">
                  <ProductGridCardSkeleton />
                </li>
              ))}
            </ul>
          )}

          {!!productsQuery.error && (
            <div className="mt-4 rounded-xl border border-error/20 bg-error/10 p-4 text-sm text-error">
              Failed to load this storefront.
            </div>
          )}

          {!productsQuery.isInitialLoading &&
            storeProducts.length > 0 &&
            filteredProducts.length === 0 && (
              <div className="mt-4 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6">
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  No listings match this store view
                </div>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                  Try clearing the store search or category filter to see the
                  merchant’s other listings.
                </p>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    onClick={() => {
                      recordStorefrontSearch("", [])
                      setLocalSearch("")
                      setSearchDirty(false)
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
            <ul className="mt-4 grid min-w-0 max-w-full auto-rows-fr list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
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
                        sourceShippingCost: product.sourceShippingCost,
                        image: product.images[0]?.url,
                        tags: product.tags,
                        format: product.format,
                        shippingCostSats: product.shippingCostSats,
                        shippingOptionId: product.shippingOptionId,
                        shippingOptionDTag: product.shippingOptionDTag,
                        shippingCountries: product.shippingCountries,
                        shippingCountryRules: product.shippingCountryRules,
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
                        sourceShippingCost: product.sourceShippingCost,
                        image: product.images[0]?.url,
                        tags: product.tags,
                        format: product.format,
                        shippingCostSats: product.shippingCostSats,
                        shippingOptionId: product.shippingOptionId,
                        shippingOptionDTag: product.shippingOptionDTag,
                        shippingCountries: product.shippingCountries,
                        shippingCountryRules: product.shippingCountryRules,
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
