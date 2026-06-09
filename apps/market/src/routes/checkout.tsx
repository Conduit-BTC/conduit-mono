import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  ShoppingCart,
  Store,
  Zap,
} from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { NDKEvent, NDKUser, giftWrap } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  SHIPPING_COUNTRIES,
  appendConduitClientTag,
  cacheParsedOrderMessage,
  config,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  fetchZapInvoice,
  formatNpub,
  getPriceSats,
  getShippingCostSats,
  hasWebLN,
  getNdk,
  getShippingOptions,
  getShippingDestinationEligibility,
  normalizePubkey,
  normalizeLightningInvoice,
  parseOrderMessageRumorEvent,
  publishWithPlanner,
  pubkeyToNpub,
  validateLightningInvoiceForPayment,
  waitForZapReceipt,
  useAuth,
  useProfile,
  type PricingRateInput,
  type ParsedShippingOption,
  type ShippingAddressSchema,
} from "@conduit/core"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Combobox,
  Input,
  Label,
  Textarea,
} from "@conduit/ui"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../components/MerchantIdentity"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { type CartItem, useCart } from "../hooks/useCart"
import { useWallet } from "../hooks/useWallet"
import { requireAuth } from "../lib/auth"
import { LightningStrikeOverlay } from "../components/LightningStrikeOverlay"
import { PaymentTracker } from "../components/PaymentTracker"
import {
  isFastCheckoutEligible,
  getFastCheckoutUnavailableReasons,
  getShippingCheckoutState,
  getShippingStepBlockingMessage,
  getValidationErrorFields,
  shippingFieldLabel,
  validateShippingFields,
  type ShippingFormState,
  type ShippingFieldKey,
  type ShippingCheckoutState,
  type ShippingValidationError,
} from "../lib/checkout-validation"
import {
  buildCheckoutPricingIntent,
  buildDefaultZapContent,
  buildPendingCheckoutManualInvoice,
  getCheckoutRecoveryPlan,
  getLnurlReadyForCheckoutPayment,
  getCheckoutShippingCost,
  requestCheckoutLnurlInvoice,
  type CheckoutPaymentStage,
  type CheckoutPricingIntent,
  type PendingCheckoutManualInvoice,
  type CheckoutZapVisibility,
} from "../lib/checkout-payment"
import {
  savePaymentAttempt,
  updatePaymentAttempt,
} from "../lib/payment-attempts"
import { payCheckoutInvoice } from "../lib/payment-rails"
import { getProductPriceDisplay } from "../lib/pricing"

type CheckoutStep =
  | "shipping"
  | "payment"
  | "signing"
  | "sending"
  | "sent"
  | "paying"
  | "paid"

type CheckoutSearch = {
  merchant?: string
}

/** Priced "ok" intent — the only shape we proceed to payment with. */
type OkPricingIntent = Extract<CheckoutPricingIntent, { status: "ok" }>

/**
 * Everything needed to (re)attempt payment for an order that has ALREADY been
 * delivered to the merchant. Captured right after the order rumor publishes so
 * a post-delivery failure can retry invoice + payment against the same
 * `orderId` without republishing the order.
 */
type FastCheckoutPaymentContext = {
  orderId: string
  pricingIntent: OkPricingIntent
  /** Delivery notice from the order publish, reused in success copy. */
  orderDeliveryNotice: string | null
}

/**
 * Frozen view of a completed order, used to hold the completed tracker + order
 * summary after the live cart has been cleared (so the paid cart can't be
 * re-paid on refresh/navigation).
 */
type CheckoutCompletionSnapshot = {
  orderId: string
  merchantPubkey: string
  items: CartItem[]
  totalSats: number
}

// Shipping is session-scoped: pre-fills within a browser session, never
// persisted permanently to localStorage.
const CHECKOUT_STORAGE_KEY = "conduit:checkout-shipping"
const ZAP_RECEIPT_WAIT_MS = 5_000
const CHECKOUT_PRICE_REFRESH_TIMEOUT_MS = 5_000
const CHECKOUT_PRICE_REFRESH_RETRY_MS = 30_000

type CheckoutPricingRefreshState =
  | "ready"
  | "refreshing"
  | "stale_retryable"
  | "unavailable"

type BuyerMessageDeliveryResult = {
  buyerSelfCopyError: string | null
  localCacheError: string | null
}

const DEFAULT_SHIPPING_FORM: ShippingFormState = {
  firstName: "",
  lastName: "",
  street: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
  name: "",
  phone: "",
  email: "",
}

const COUNTRY_COMBOBOX_OPTIONS = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
  meta: country.code,
  searchText: `${country.code} ${country.name}`,
}))

// ─── Session storage ──────────────────────────────────────────────────────────

function readSessionShipping(): ShippingFormState {
  if (typeof window === "undefined") return DEFAULT_SHIPPING_FORM
  try {
    const raw = sessionStorage.getItem(CHECKOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_SHIPPING_FORM
    return {
      ...DEFAULT_SHIPPING_FORM,
      ...(JSON.parse(raw) as Partial<ShippingFormState>),
    }
  } catch {
    return DEFAULT_SHIPPING_FORM
  }
}

function writeSessionShipping(value: ShippingFormState): void {
  if (typeof window === "undefined") return
  try {
    sessionStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // ignore
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/checkout")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => ({
    merchant:
      typeof search.merchant === "string"
        ? (normalizePubkey(search.merchant) ?? search.merchant)
        : undefined,
  }),
  component: CheckoutPage,
})

// ─── Small presentational helpers ────────────────────────────────────────────

function CartIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ShoppingCart className={className} />
}

function LightningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Zap className={className} />
}

function OrderIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <ReceiptText className={className} />
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Check className={className} />
}

function SpinnerIcon({ className = "h-5 w-5" }: { className?: string }) {
  return <LoaderCircle className={className} />
}

function CheckoutBreadcrumb({
  current,
  includesShippingStep = true,
  onShippingClick,
}: {
  current: "order" | "shipping" | "send-order"
  includesShippingStep?: boolean
  onShippingClick?: () => void
}) {
  const linkClassName =
    "transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
  const currentClassName = "text-[var(--text-primary)]"

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]"
    >
      <Link to="/products" className={linkClassName}>
        Shop
      </Link>
      <span>/</span>
      <Link to="/cart" className={linkClassName}>
        Cart
      </Link>
      {current === "order" && (
        <>
          <span>/</span>
          <span className={currentClassName}>Order</span>
        </>
      )}
      {current !== "order" && includesShippingStep && (
        <>
          <span>/</span>
          {current === "send-order" && onShippingClick ? (
            <button
              type="button"
              onClick={onShippingClick}
              className={linkClassName}
            >
              Shipping
            </button>
          ) : (
            <span
              className={current === "shipping" ? currentClassName : undefined}
            >
              Shipping
            </span>
          )}
        </>
      )}
      {current === "send-order" && (
        <>
          <span>/</span>
          <span className={currentClassName}>Send Order</span>
        </>
      )}
    </nav>
  )
}

function getCountryLabel(code: string): string {
  const country = SHIPPING_COUNTRIES.find((option) => option.code === code)
  return country ? `${country.name} (${country.code})` : code
}

function getCartShippingOptionSnapshots(
  items: CartItem[]
): ParsedShippingOption[] {
  return items
    .filter((item) => item.format !== "digital")
    .filter(
      (item) =>
        item.shippingOptionId &&
        item.shippingOptionDTag &&
        item.shippingCountryRules &&
        item.shippingCountryRules.length > 0
    )
    .map((item) => ({
      id: item.shippingOptionId!,
      pubkey: item.merchantPubkey,
      dTag: item.shippingOptionDTag!,
      title: "Product shipping zone",
      currency: item.sourceShippingCost?.normalizedCurrency ?? "SATS",
      price: item.sourceShippingCost?.amount ?? item.shippingCostSats ?? 0,
      countries:
        item.shippingCountries ??
        item.shippingCountryRules?.map((rule) => rule.code) ??
        [],
      countryRules: item.shippingCountryRules!,
      service: "standard",
      createdAt: 0,
    }))
}

// ─── Order summary sidebar ────────────────────────────────────────────────────

function OrderSummary({
  items,
  merchantPubkey,
  btcUsdRate,
}: {
  items: CartItem[]
  merchantPubkey: string
  btcUsdRate: PricingRateInput
}) {
  const { data: merchantProfile } = useProfile(merchantPubkey)
  const merchantName = getMerchantDisplayName(merchantProfile, merchantPubkey)
  const merchantStoreRef = pubkeyToNpub(merchantPubkey)
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)
  const shippingCost = getCheckoutShippingCost(items, btcUsdRate)
  const itemSubtotalSats = items.reduce((sum, item) => {
    const sats = getPriceSats(item, btcUsdRate)
    return sats ? sum + sats.sats * item.quantity : sum
  }, 0)
  const totalSats = itemSubtotalSats + shippingCost.totalSats
  const allItemsPriced = items.every((item) => getPriceSats(item, btcUsdRate))
  const itemSubtotalPrice = getProductPriceDisplay(
    allItemsPriced
      ? {
          price: itemSubtotalSats,
          currency: "SATS",
          priceSats: itemSubtotalSats,
        }
      : { price: 0, currency: "UNSUPPORTED" },
    btcUsdRate
  )
  const totalPrice = getProductPriceDisplay(
    allItemsPriced
      ? { price: totalSats, currency: "SATS", priceSats: totalSats }
      : { price: 0, currency: "UNSUPPORTED" },
    btcUsdRate
  )
  const shippingLabel =
    shippingCost.status === "not_required"
      ? "Not required (digital)"
      : shippingCost.status === "included"
        ? "Included"
        : shippingCost.status === "manual"
          ? "Coordinated with merchant"
          : getProductPriceDisplay(
              {
                price: shippingCost.totalSats,
                currency: "SATS",
                priceSats: shippingCost.totalSats,
              },
              btcUsdRate
            ).primary

  return (
    <aside className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
      <div className="border-b border-[var(--border)] pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
            Order summary
          </h2>
          <div className="text-sm text-[var(--text-secondary)]">
            {totalItems} item{totalItems === 1 ? "" : "s"}
          </div>
        </div>
        <Link
          to="/store/$pubkey"
          params={{ pubkey: merchantStoreRef }}
          className="mt-4 flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 transition-colors hover:border-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
          aria-label={`Visit ${merchantName} store`}
        >
          <Avatar className="h-12 w-12 shrink-0 border border-[var(--border)]">
            <AvatarImage src={merchantProfile?.picture} alt={merchantName} />
            <AvatarFallback>
              <MerchantAvatarFallback />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase text-[var(--text-muted)]">
              Merchant
            </div>
            <div className="mt-1 truncate text-base font-semibold text-[var(--text-primary)]">
              {merchantName}
            </div>
          </div>
        </Link>
      </div>

      <div className="mt-4 space-y-4">
        {items.map((item) => {
          const linePrice = getProductPriceDisplay(
            {
              price: item.price * item.quantity,
              currency: item.currency,
              priceSats:
                typeof item.priceSats === "number"
                  ? item.priceSats * item.quantity
                  : undefined,
              sourcePrice: item.sourcePrice
                ? {
                    ...item.sourcePrice,
                    amount: item.sourcePrice.amount * item.quantity,
                  }
                : undefined,
            },
            btcUsdRate
          )
          return (
            <div
              key={item.productId}
              className="grid grid-cols-[72px_minmax(0,1fr)_auto] gap-3 border-b border-[var(--border)] pb-4 last:border-b-0 last:pb-0"
            >
              <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
                <img
                  src={item.image ?? "/images/placeholders/product.png"}
                  alt={item.title}
                  className="aspect-square h-full w-full object-cover"
                  loading="lazy"
                  onError={(e) => {
                    ;(e.currentTarget as HTMLImageElement).src =
                      "/images/placeholders/product.png"
                  }}
                />
              </div>
              <div className="min-w-0">
                <div className="line-clamp-2 text-base font-medium leading-7 text-[var(--text-primary)]">
                  {item.title}
                </div>
                {item.tags && item.tags.length > 0 && (
                  <div className="mt-1 line-clamp-1 text-xs text-[var(--text-muted)]">
                    {item.tags.slice(0, 4).join(", ")}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-[var(--text-primary)]">
                  {linePrice.primary}
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  Qty {item.quantity}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
        <div className="flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
          <span>
            Subtotal ({items.reduce((sum, item) => sum + item.quantity, 0)} item
            {items.reduce((sum, item) => sum + item.quantity, 0) === 1
              ? ""
              : "s"}
            )
          </span>
          <span>{itemSubtotalPrice.primary}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--text-secondary)]">
          <span>Shipping</span>
          <span>{shippingLabel}</span>
        </div>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div className="text-lg font-semibold text-[var(--text-primary)]">
            Due to merchant
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold text-secondary-400">
              {totalPrice.primary}
            </div>
            {totalPrice.secondary && (
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {totalPrice.secondary}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

// ─── Fast checkout eligibility ────────────────────────────────────────────────

/**
 * Returns true when all preconditions for the fast zap path are met:
 *   - buyer has a Lightning payment path
 *   - merchant profile has a lud16 address
 *   - the LNURL endpoint declares allowsNostr (zap support)
 *
 * The `lnurlAllowsNostr` flag must be resolved ahead of time (async probe).
 */
// ─── Checkout page ────────────────────────────────────────────────────────────

function CheckoutPage() {
  const { pubkey } = useAuth()
  const cart = useCart()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const btcUsdRateQuery = useBtcUsdRate()
  const wallet = useWallet()

  const [step, setStep] = useState<CheckoutStep>("shipping")
  const [shipping, setShipping] = useState<ShippingFormState>(() =>
    readSessionShipping()
  )
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [shippingAttempted, setShippingAttempted] = useState(false)
  const [shippingErrors, setShippingErrors] = useState<
    ShippingValidationError[]
  >([])
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [showSentGlow, setShowSentGlow] = useState(false)
  const [paymentStage, setPaymentStage] = useState<CheckoutPaymentStage | null>(
    null
  )
  // paidNotice is retained as a state setter for future surfaces (e.g.
  // showing the merchant zap-receipt observation in an order detail view).
  // The buyer-facing tracker conveys success/retry-needed via per-step
  // status, so we don't render the raw notice string here.
  const [paidNotice, setPaidNotice] = useState<string | null>(null)
  // -- Payment tracker state (CND-2A) -------------------------------------
  // Booleans mirror the async boundaries inside `payNow()` so the in-page
  // PaymentTracker can render explicit per-step status (waiting/in-progress/
  // complete/failed/retry_needed). Kept as discrete state rather than
  // derived from `paymentStage` because the buyer-visible "funds moved"
  // claim must only flip after `nwcPayInvoice` resolves.
  const [overlayPlaying, setOverlayPlaying] = useState(false)
  const [trackerOrderDelivered, setTrackerOrderDelivered] = useState(false)
  const [trackerPaymentMoved, setTrackerPaymentMoved] = useState(false)
  const [trackerProofStatus, setTrackerProofStatus] = useState<
    "pending" | "sent" | "retry_needed" | undefined
  >(undefined)
  const [trackerFinished, setTrackerFinished] = useState(false)
  const [trackerError, setTrackerError] = useState<string | null>(null)
  // Context for the already-delivered fast-checkout order. Present once the
  // order rumor has been published; lets a post-delivery payment failure retry
  // invoice + payment against the SAME order instead of republishing it (which
  // would create a duplicate merchant order). Cleared at the start of payNow.
  const deliveredOrderContextRef = useRef<FastCheckoutPaymentContext | null>(
    null
  )
  const [deliveredOrderContext, setDeliveredOrderContext] =
    useState<FastCheckoutPaymentContext | null>(null)
  // Frozen snapshot of the just-completed order. We clear the live cart the
  // moment payment settles (so a paid cart can never be re-paid on refresh),
  // then render the held completed tracker + summary from this snapshot.
  const [completedSnapshot, setCompletedSnapshot] =
    useState<CheckoutCompletionSnapshot | null>(null)
  // Synchronous re-entrancy guard for the payment flow. A `step`/`disabled`
  // check can't prevent a double-click because the state change doesn't commit
  // until React re-renders; this ref flips synchronously inside the click's
  // first tick so a second click is rejected before it can publish a duplicate
  // order or re-pay an invoice (CND-89).
  const paymentInFlightRef = useRef(false)
  const [zapVisibility, setZapVisibility] =
    useState<CheckoutZapVisibility>("public_zap")
  const [zapContent, setZapContent] = useState("")
  const [zapContentEdited, setZapContentEdited] = useState(false)
  const [weblnAvailable, setWeblnAvailable] = useState(false)
  const [pendingManualInvoice, setPendingManualInvoice] =
    useState<PendingCheckoutManualInvoice | null>(null)
  const [pricingRefreshPending, setPricingRefreshPending] = useState(false)
  const [pricingRefreshFailedAt, setPricingRefreshFailedAt] = useState<
    number | null
  >(null)
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const refetchBtcUsdRate = btcUsdRateQuery.refetch
  const btcUsdRateIsFetching = btcUsdRateQuery.isFetching

  // LNURL probe state
  const [lnurlPayAvailable, setLnurlPayAvailable] = useState(false)
  const [lnurlAllowsNostr, setLnurlAllowsNostr] = useState(false)
  const [lnurlProbing, setLnurlProbing] = useState(false)

  const selectedMerchant =
    search.merchant ??
    (Array.from(new Set(cart.items.map((item) => item.merchantPubkey)))
      .length === 1
      ? cart.items[0]?.merchantPubkey
      : undefined)

  const checkoutItems = useMemo(() => {
    if (!selectedMerchant) return []
    return cart.items.filter((item) => item.merchantPubkey === selectedMerchant)
  }, [cart.items, selectedMerchant])

  // True when every item in the cart is a digital product (no shipping needed)
  const isAllDigital = useMemo(
    () =>
      checkoutItems.length > 0 &&
      checkoutItems.every((item) => item.format === "digital"),
    [checkoutItems]
  )

  const productShippingOptions = useMemo(
    () => getCartShippingOptionSnapshots(checkoutItems),
    [checkoutItems]
  )
  const physicalItemsMissingShippingZone = checkoutItems.some(
    (item) => item.format !== "digital" && !item.shippingOptionId
  )
  const physicalItemsMissingShippingSnapshot = checkoutItems.some(
    (item) =>
      item.format !== "digital" &&
      (!item.shippingOptionId ||
        !item.shippingOptionDTag ||
        !item.shippingCountryRules ||
        item.shippingCountryRules.length === 0)
  )
  const hasCompleteCartShippingSnapshot =
    !isAllDigital &&
    checkoutItems.length > 0 &&
    !physicalItemsMissingShippingSnapshot

  // Fetch merchant's published shipping zones (kind-30406)
  const shippingOptionsQuery = useQuery({
    queryKey: ["shippingOptions", selectedMerchant],
    queryFn: () => getShippingOptions(selectedMerchant!),
    enabled:
      !!selectedMerchant &&
      !isAllDigital &&
      !physicalItemsMissingShippingZone &&
      !hasCompleteCartShippingSnapshot,
    staleTime: 5 * 60 * 1000,
  })
  const merchantShippingOptions = shippingOptionsQuery.data ?? []

  const checkoutShippingCost = useMemo(
    () => getCheckoutShippingCost(checkoutItems, btcUsdRate),
    [btcUsdRate, checkoutItems]
  )
  const total = useMemo(() => {
    const itemSubtotal = checkoutItems.reduce((sum, item) => {
      const sats = getPriceSats(item, btcUsdRate)
      return sats ? sum + sats.sats * item.quantity : sum
    }, 0)
    return itemSubtotal + checkoutShippingCost.totalSats
  }, [btcUsdRate, checkoutItems, checkoutShippingCost.totalSats])
  const hasUnpricedCheckoutItems = useMemo(
    () => checkoutItems.some((item) => !getPriceSats(item, btcUsdRate)),
    [btcUsdRate, checkoutItems]
  )

  const { data: merchantProfile } = useProfile(selectedMerchant ?? null)
  const merchantLud16 = merchantProfile?.lud16
  const merchantName =
    merchantProfile?.displayName ||
    merchantProfile?.name ||
    (selectedMerchant ? formatNpub(selectedMerchant, 8) : "this merchant")

  useEffect(() => {
    if (zapContentEdited || checkoutItems.length === 0) return
    setZapContent(
      buildDefaultZapContent({ items: checkoutItems, merchantName })
    )
  }, [checkoutItems, merchantName, zapContentEdited])

  useEffect(() => {
    const check = () => setWeblnAvailable(hasWebLN())
    check()
    const timer = window.setTimeout(check, 1000)
    window.addEventListener("focus", check)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", check)
    }
  }, [])

  // Probe merchant's LNURL for Nostr zap support when merchant profile arrives
  useEffect(() => {
    setLnurlPayAvailable(false)
    setLnurlAllowsNostr(false)

    if (!merchantLud16) {
      setLnurlProbing(false)
      return
    }

    let cancelled = false
    setLnurlProbing(true)

    fetchLnurlPayMetadata(merchantLud16)
      .then((meta) => {
        if (!cancelled) {
          setLnurlPayAvailable(true)
          setLnurlAllowsNostr(meta.allowsNostr)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLnurlPayAvailable(false)
          setLnurlAllowsNostr(false)
        }
      })
      .finally(() => {
        if (!cancelled) setLnurlProbing(false)
      })

    return () => {
      cancelled = true
    }
  }, [merchantLud16])

  useEffect(() => {
    if (lnurlPayAvailable && !lnurlAllowsNostr) {
      setZapVisibility("private_checkout")
    }
  }, [lnurlAllowsNostr, lnurlPayAvailable])

  const pricingPreview = useMemo(
    () => buildCheckoutPricingIntent(checkoutItems, btcUsdRate, Date.now()),
    [btcUsdRate, checkoutItems]
  )
  const pricingPreviewIsStale =
    pricingPreview.status === "error" && pricingPreview.code === "stale_quote"
  const pricingRefreshState: CheckoutPricingRefreshState =
    pricingPreview.status === "ok"
      ? "ready"
      : pricingPreview.code === "stale_quote"
        ? pricingRefreshPending || btcUsdRateIsFetching
          ? "refreshing"
          : "stale_retryable"
        : "unavailable"

  const refreshCheckoutPricing = useCallback(
    async (force = false): Promise<void> => {
      if (pricingRefreshPending) return

      const now = Date.now()
      if (
        !force &&
        pricingRefreshFailedAt !== null &&
        now - pricingRefreshFailedAt < CHECKOUT_PRICE_REFRESH_RETRY_MS
      ) {
        return
      }

      setPricingRefreshPending(true)
      try {
        const refetched = await Promise.race([
          refetchBtcUsdRate().then((result) => result.data ?? null),
          new Promise<null>((resolve) =>
            window.setTimeout(
              () => resolve(null),
              CHECKOUT_PRICE_REFRESH_TIMEOUT_MS
            )
          ),
        ])
        const next = buildCheckoutPricingIntent(
          checkoutItems,
          refetched,
          Date.now()
        )
        setPricingRefreshFailedAt(next.status === "ok" ? null : Date.now())
      } catch {
        setPricingRefreshFailedAt(Date.now())
      } finally {
        setPricingRefreshPending(false)
      }
    },
    [
      checkoutItems,
      pricingRefreshFailedAt,
      pricingRefreshPending,
      refetchBtcUsdRate,
    ]
  )

  useEffect(() => {
    if (!pricingPreviewIsStale) {
      if (pricingRefreshFailedAt !== null) setPricingRefreshFailedAt(null)
      return
    }
    void refreshCheckoutPricing(false)
  }, [pricingPreviewIsStale, pricingRefreshFailedAt, refreshCheckoutPricing])

  const shippingOptionsForEligibility =
    merchantShippingOptions.length > 0
      ? merchantShippingOptions
      : productShippingOptions
  const destinationEligibility = isAllDigital
    ? ({ eligible: true } as const)
    : getShippingDestinationEligibility(
        {
          country: shipping.country,
          postalCode: shipping.postalCode,
        },
        shippingOptionsForEligibility
      )

  const shippingCheckoutState: ShippingCheckoutState = getShippingCheckoutState(
    {
      isAllDigital,
      shippingLookupPending: shippingOptionsQuery.isLoading,
      physicalItemsMissingShippingZone,
      shippingOptionsAvailable: shippingOptionsForEligibility.length > 0,
      destinationEligibility,
    }
  )

  const shippingEligibleForFastCheckout =
    shippingCheckoutState === "not_required" ||
    shippingCheckoutState === "allowed"

  const canTrySavedNwcWallet =
    !!wallet.connection &&
    wallet.status !== "unsupported" &&
    wallet.status !== "error"
  const canAttemptLightningPayment = canTrySavedNwcWallet || weblnAvailable
  const requiresPublicZap = zapVisibility === "public_zap"
  const lnurlReadyForSelectedPayment = getLnurlReadyForCheckoutPayment({
    visibility: zapVisibility,
    lnurlPayAvailable,
    lnurlAllowsNostr,
  })
  const fastEligibilityInput = {
    walletPayCapable: canAttemptLightningPayment,
    merchantLud16,
    lnurlAllowsNostr: lnurlReadyForSelectedPayment,
    requiresNostrZap: requiresPublicZap,
    pricingReady: pricingPreview.status === "ok",
    shippingEligible: shippingEligibleForFastCheckout,
    shippingState: shippingCheckoutState,
    shippingPriced: checkoutShippingCost.status !== "manual",
  }
  const fastEligible = isFastCheckoutEligible(fastEligibilityInput)
  const fastUnavailableReasons =
    getFastCheckoutUnavailableReasons(fastEligibilityInput)
  const fastUnavailableReasonsWithoutPricing =
    getFastCheckoutUnavailableReasons({
      ...fastEligibilityInput,
      pricingReady: true,
    })
  const pricingOnlyFastCheckoutBlocker =
    pricingPreviewIsStale && fastUnavailableReasonsWithoutPricing.length === 0
  const showFastCheckoutSurface = fastEligible || pricingOnlyFastCheckoutBlocker
  const shippingStatusMessage = (() => {
    switch (shippingCheckoutState) {
      case "not_required":
        return "This cart does not require shipping."
      case "loading":
        return "Checking merchant shipping rules before direct payment is offered."
      case "missing_product_zone":
        return "One product is missing product-level shipping-zone data, so direct payment is disabled."
      case "no_published_rule":
        return "No published merchant shipping rule was found yet. You can still send the order first."
      case "allowed":
        return "This destination is covered by the merchant shipping zone."
      case "country_unsupported":
        return "Zap out is unavailable for this destination. You can still send the order first."
      case "postal_restricted":
        return "Zap out is unavailable for this postal code. You can still send the order first."
    }
  })()

  const visibleCheckoutStep: CheckoutStep =
    isAllDigital && step === "shipping" ? "payment" : step

  function updateShipping<K extends keyof ShippingFormState>(
    field: K,
    value: ShippingFormState[K]
  ): void {
    setShipping((current) => {
      const next = { ...current, [field]: value }
      writeSessionShipping(next)
      return next
    })
    // Re-validate on field change if an attempt has been made
    if (shippingAttempted) {
      setShippingErrors(validateShippingFields({ ...shipping, [field]: value }))
    }
  }

  function continueToPayment(): void {
    setShippingAttempted(true)
    const errors = validateShippingFields(shipping)
    setShippingErrors(errors)
    const blockingMessage = getShippingStepBlockingMessage({
      hasUnpricedCheckoutItems,
      shippingErrors: errors,
    })
    if (blockingMessage) {
      setError(blockingMessage)
      return
    }
    setError(null)
    setStep("payment")
  }

  useEffect(() => {
    if (!showSentGlow) return
    const id = window.setTimeout(() => setShowSentGlow(false), 650)
    return () => window.clearTimeout(id)
  }, [showSentGlow])

  // Clear inline error when all validation errors are resolved
  useEffect(() => {
    if (
      shippingAttempted &&
      shippingErrors.length === 0 &&
      error === "Fix the highlighted fields to continue."
    ) {
      setError(null)
    }
  }, [error, shippingAttempted, shippingErrors.length])

  // Skip shipping step for all-digital carts
  useEffect(() => {
    if (isAllDigital && step === "shipping") {
      setStep("payment")
    }
  }, [isAllDigital, step])

  // ─── Build shipping address from form state ──────────────────────────────

  function buildShippingAddress(): ShippingAddressSchema | undefined {
    if (isAllDigital) return undefined
    return {
      name: `${shipping.firstName.trim()} ${shipping.lastName.trim()}`.trim(),
      street: [shipping.street.trim(), shipping.line2.trim()]
        .filter(Boolean)
        .join(", "),
      city: shipping.city.trim(),
      state: (shipping.state ?? "").trim() || undefined,
      postalCode: shipping.postalCode.trim(),
      country: shipping.country.trim().toUpperCase(),
    }
  }

  function buildContactNote(): string | undefined {
    const lines = [
      note.trim() || undefined,
      shipping.phone.trim() ? `Phone: ${shipping.phone.trim()}` : undefined,
      shipping.email.trim() ? `Email: ${shipping.email.trim()}` : undefined,
    ].filter(Boolean) as string[]
    return lines.length > 0 ? lines.join("\n") : undefined
  }

  async function copyPendingInvoice(): Promise<void> {
    if (!pendingManualInvoice) return
    try {
      await navigator.clipboard.writeText(pendingManualInvoice.invoice)
    } catch (e) {
      console.warn("Failed to copy invoice", e)
    }
  }

  function setDeliveredOrderContextValue(
    ctx: FastCheckoutPaymentContext | null
  ): void {
    deliveredOrderContextRef.current = ctx
    setDeliveredOrderContext(ctx)
  }

  function retryPendingManualInvoicePayment(): void {
    const ctx = deliveredOrderContextRef.current ?? deliveredOrderContext
    if (!ctx) {
      setError(
        "This order was already sent. Use the invoice shown here, or view the order from Orders."
      )
      return
    }

    setOverlayPlaying(true)
    void payDeliveredOrder(ctx)
  }

  function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
  }

  function prepareBuyerRumor(rumor: NDKEvent, buyerPubkey: string): void {
    rumor.pubkey = buyerPubkey
    if (rumor.id) return

    try {
      rumor.id = rumor.getEventHash()
    } catch (error) {
      console.warn("Failed to derive buyer order rumor id", error)
    }
  }

  async function cacheBuyerOrderRumor(rumor: NDKEvent): Promise<string | null> {
    try {
      if (!rumor.id) throw new Error("Missing buyer order rumor id")
      const parsed = parseOrderMessageRumorEvent(rumor)
      await cacheParsedOrderMessage(parsed)
      return null
    } catch (error) {
      console.warn("Failed to cache buyer order message", error)
      return getErrorMessage(error, "Failed to cache buyer order message")
    }
  }

  function getDeliveryNotice(
    delivery: BuyerMessageDeliveryResult,
    label: string
  ): string | null {
    if (delivery.localCacheError && delivery.buyerSelfCopyError) {
      return `${label} was accepted by Nostr delivery relays for merchant pickup, but order history recovery needs retry.`
    }
    if (delivery.localCacheError) {
      return `${label} was accepted by Nostr delivery relays for merchant pickup. Order history may update after relay sync.`
    }
    if (delivery.buyerSelfCopyError) {
      return `${label} was accepted by Nostr delivery relays for merchant pickup and saved locally. Buyer relay backup needs retry.`
    }
    return null
  }

  async function publishWrappedToMerchantAndSelf(
    rumor: NDKEvent,
    ndk: ReturnType<typeof getNdk>,
    merchantPubkey: string,
    buyerPubkey: string
  ): Promise<BuyerMessageDeliveryResult> {
    prepareBuyerRumor(rumor, buyerPubkey)

    const merchantUser = new NDKUser({ pubkey: merchantPubkey })
    const buyerUser = new NDKUser({ pubkey: buyerPubkey })
    const [wrappedToMerchant, wrappedToSelf] = await Promise.all([
      giftWrap(rumor, merchantUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      }),
      giftWrap(rumor, buyerUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      }),
    ])

    await publishWithPlanner(wrappedToMerchant, {
      intent: "recipient_event",
      authorPubkey: buyerPubkey,
      recipientPubkeys: [merchantPubkey],
      refreshRelayLists: true,
      deliveryMode: "critical",
    })

    let buyerSelfCopyError: string | null = null
    try {
      await publishWithPlanner(wrappedToSelf, {
        intent: "recipient_event",
        authorPubkey: buyerPubkey,
        recipientPubkeys: [buyerPubkey],
        refreshRelayLists: true,
        deliveryMode: "critical",
      })
    } catch (selfCopyError) {
      console.warn("Buyer self-copy publish failed", selfCopyError)
      buyerSelfCopyError = getErrorMessage(
        selfCopyError,
        "Buyer self-copy publish failed"
      )
    }

    const localCacheError = await cacheBuyerOrderRumor(rumor)
    return { buyerSelfCopyError, localCacheError }
  }

  // ─── Order-first path (existing flow) ───────────────────────────────────

  async function placeOrder(): Promise<void> {
    if (!pubkey || !selectedMerchant || checkoutItems.length === 0) return
    if (pendingManualInvoice) return
    if (deliveredOrderContextRef.current) {
      setError(
        "This order has already been sent to the merchant. Continue payment or view it from Orders instead."
      )
      setStep("payment")
      return
    }

    setError(null)
    setPaidNotice(null)
    setStep("signing")

    try {
      if (hasUnpricedCheckoutItems) {
        throw new Error(
          "One or more items cannot be converted to sats right now. Refresh prices before ordering."
        )
      }

      const orderId = crypto.randomUUID()
      const currency = "SATS"
      const items = checkoutItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        priceAtPurchase: getPriceSats(item, btcUsdRate)?.sats ?? 0,
        currency,
        shippingCostSats: getShippingCostSats(item, btcUsdRate)?.sats,
        sourceShippingCost: item.sourceShippingCost,
        shippingOptionId: item.shippingOptionId,
        shippingOptionDTag: item.shippingOptionDTag,
        shippingCountries: item.shippingCountries,
        shippingCountryRules: item.shippingCountryRules,
        sourcePrice: item.sourcePrice,
      }))

      const payload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: pubkey,
        items,
        subtotal: total,
        currency,
        shippingCostSats:
          checkoutShippingCost.status === "manual"
            ? undefined
            : checkoutShippingCost.totalSats,
        shippingCostStatus: checkoutShippingCost.status,
        shippingAddress: buildShippingAddress(),
        note: buildContactNote(),
        createdAt: Date.now(),
      }

      const ndk = getNdk()
      const rumor = new NDKEvent(ndk)
      rumor.kind = EVENT_KINDS.ORDER
      rumor.created_at = Math.floor(Date.now() / 1000)
      rumor.tags = [
        ["p", selectedMerchant],
        ["type", "order"],
        ["order", orderId],
        ["amount", String(total)],
        ["currency", currency],
      ]
      for (const item of checkoutItems) {
        rumor.tags.push(["item", item.productId, String(item.quantity)])
        if (item.shippingOptionId) {
          rumor.tags.push(["shipping", item.shippingOptionId])
        }
      }
      rumor.tags = appendConduitClientTag(rumor.tags, "market")
      rumor.content = JSON.stringify(payload)

      setStep("sending")

      const [delivery] = await Promise.all([
        publishWrappedToMerchantAndSelf(rumor, ndk, selectedMerchant, pubkey),
        new Promise((resolve) => window.setTimeout(resolve, 900)),
      ])
      const deliveryNotice = getDeliveryNotice(delivery, "Order")
      if (deliveryNotice) setPaidNotice(deliveryNotice)

      cart.clearMerchant(selectedMerchant)
      setSentOrderId(orderId)
      setShowSentGlow(true)
      setStep("sent")
      void navigate({ to: "/orders", replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send order")
      setStep("payment")
    }
  }

  // ─── Fast zap path ───────────────────────────────────────────────────────

  async function getFreshPricingIntent() {
    const initial = buildCheckoutPricingIntent(
      checkoutItems,
      btcUsdRateQuery.data ?? null
    )
    if (initial.status === "ok" || initial.code !== "stale_quote") {
      return initial
    }

    const refetched = await Promise.race([
      btcUsdRateQuery.refetch().then((result) => result.data ?? null),
      new Promise<null>((resolve) =>
        window.setTimeout(
          () => resolve(null),
          CHECKOUT_PRICE_REFRESH_TIMEOUT_MS
        )
      ),
    ])

    return buildCheckoutPricingIntent(checkoutItems, refetched)
  }

  /**
   * Pay (or re-pay) an order that has ALREADY been delivered to the merchant.
   *
   * This is the payment half of fast checkout: LNURL -> invoice -> NWC pay ->
   * proof. It never publishes an order, so calling it again after a
   * post-delivery / pre-payment failure retries payment against the same
   * `orderId` instead of creating a duplicate merchant order (CND-89).
   *
   * On terminal success (or funds-moved-but-proof-failed) it clears the live
   * cart immediately and freezes a snapshot so the completed tracker holds
   * without leaving a paid cart re-payable.
   */
  async function payDeliveredOrder(
    ctx: FastCheckoutPaymentContext
  ): Promise<void> {
    if (!pubkey || !selectedMerchant) return
    if (!merchantLud16) {
      setTrackerError("Merchant does not have a Lightning address.")
      setTrackerFinished(true)
      return
    }
    // Reject a concurrent attempt (e.g. double-clicked "Try payment again").
    if (paymentInFlightRef.current) return
    paymentInFlightRef.current = true

    // Fresh payment attempt: reset the payment-portion tracker state but leave
    // `orderDelivered` true (the order is already with the merchant).
    setError(null)
    setPaidNotice(null)
    setPendingManualInvoice(null)
    setTrackerError(null)
    setTrackerFinished(false)
    setTrackerPaymentMoved(false)
    setTrackerProofStatus(undefined)
    setPaymentStage("requesting_invoice")
    setStep("paying")

    const { orderId, pricingIntent } = ctx
    const currency = "SATS"
    let paymentMoved = false
    let recoveryNotice = ctx.orderDeliveryNotice

    try {
      const ndk = getNdk()
      const lnurlMeta = await fetchLnurlPayMetadata(merchantLud16)
      const isPublicZapPayment = zapVisibility === "public_zap"
      if (isPublicZapPayment && !lnurlMeta.allowsNostr) {
        throw new Error(
          "Merchant Lightning Address does not advertise Nostr zap support."
        )
      }

      if (
        pricingIntent.totalMsats < lnurlMeta.minSendable ||
        pricingIntent.totalMsats > lnurlMeta.maxSendable
      ) {
        throw new Error(
          `Order amount (${pricingIntent.totalMsats} msats) is outside merchant's accepted range ` +
            `(${lnurlMeta.minSendable}-${lnurlMeta.maxSendable} msats).`
        )
      }

      const invoiceRequest = await requestCheckoutLnurlInvoice(
        {
          visibility: zapVisibility,
          lnurlCallback: lnurlMeta.callback,
          amountMsats: pricingIntent.totalMsats,
          lnurl: lnurlMeta.lnurl,
          recipientPubkey: selectedMerchant,
          zapContent,
          explicitRelayUrls: ndk.explicitRelayUrls ?? [],
          publicRelayUrls: config.publicRelayUrls,
        },
        {
          fetchLnurlInvoice,
          fetchZapInvoice,
          signZapRequest: async (draft) => {
            const zapRequest = new NDKEvent(ndk)
            zapRequest.kind = draft.kind
            zapRequest.created_at = draft.createdAt
            zapRequest.content = draft.content
            zapRequest.tags = draft.tags

            await zapRequest.sign(ndk.signer)
            return {
              id: zapRequest.id,
              rawEvent: zapRequest.rawEvent(),
            }
          },
        }
      )
      const { invoice, zapRelayUrls, zapRequestId } = invoiceRequest

      const invoiceValidation = validateLightningInvoiceForPayment({
        invoice,
        expectedAmountMsats: pricingIntent.totalMsats,
      })
      if (!invoiceValidation.ok) {
        throw new Error(invoiceValidation.reason)
      }

      setPaymentStage("paying_invoice")
      const payResult = await payCheckoutInvoice({
        invoice,
        amountMsats: pricingIntent.totalMsats,
        walletConnection: wallet.connection,
        tryNwc: canTrySavedNwcWallet,
        timeoutMs: 60_000,
        appId: "market",
        metadata: {
          app: "conduit-market",
          action: isPublicZapPayment ? "checkout-zap" : "private-checkout",
          amountMsats: pricingIntent.totalMsats,
        },
      })

      if (payResult.status === "manual_required") {
        setPendingManualInvoice(
          buildPendingCheckoutManualInvoice({
            orderId,
            merchantPubkey: selectedMerchant,
            amountMsats: pricingIntent.totalMsats,
            amountSats: pricingIntent.totalSats,
            invoice,
            zapRequestId,
            reason: payResult.reason,
            deliveryNotice: recoveryNotice,
            diagnostics: payResult.diagnostics,
          })
        )
        setSentOrderId(orderId)
        setError(null)
        setStep("payment")
        return
      }

      paymentMoved = true
      setTrackerPaymentMoved(true)
      setTrackerProofStatus("pending")

      try {
        await savePaymentAttempt({
          id: orderId,
          orderId,
          buyerPubkey: pubkey,
          merchantPubkey: selectedMerchant,
          amountMsats: pricingIntent.totalMsats,
          currency: "SATS",
          invoice,
          paymentHash: payResult.paymentHash,
          preimage: payResult.preimage,
          feeMsats: payResult.feeMsats,
          zapRequestId,
          proofDeliveryStatus: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (e) {
        console.warn("Failed to persist payment attempt", e)
      }

      setPaymentStage("sending_receipt")
      const proofPayload = {
        orderId,
        rail: "lightning",
        action: isPublicZapPayment ? "zap" : "private_checkout",
        amount: pricingIntent.totalSats,
        currency,
        invoice,
        preimage: payResult.preimage,
        paymentHash: payResult.paymentHash,
        feeMsats: payResult.feeMsats,
        ...(zapRequestId ? { zapRequestId } : {}),
        proofDeliveryStatus: "pending",
        note: `Payment for order ${orderId}`,
      }

      const proofRumor = new NDKEvent(ndk)
      proofRumor.kind = EVENT_KINDS.ORDER
      proofRumor.created_at = Math.floor(Date.now() / 1000)
      proofRumor.tags = [
        ["p", selectedMerchant],
        ["type", "payment_proof"],
        ["order", orderId],
        ["amount", String(pricingIntent.totalSats)],
        ["currency", currency],
        ["rail", "lightning"],
      ]
      proofRumor.tags = appendConduitClientTag(proofRumor.tags, "market")
      proofRumor.content = JSON.stringify(proofPayload)

      let proofDelivered = true
      try {
        const proofDelivery = await publishWrappedToMerchantAndSelf(
          proofRumor,
          ndk,
          selectedMerchant,
          pubkey
        )
        recoveryNotice =
          getDeliveryNotice(proofDelivery, "Payment proof") ?? recoveryNotice
        setTrackerProofStatus("sent")
        await updatePaymentAttempt(orderId, {
          proofDeliveryStatus: "sent",
        }).catch((e) => {
          console.warn("Failed to update payment proof status", e)
        })
      } catch {
        proofDelivered = false
        setTrackerProofStatus("retry_needed")
        await updatePaymentAttempt(orderId, {
          proofDeliveryStatus: "retry_needed",
        }).catch((e) => {
          console.warn("Failed to mark payment proof retry", e)
        })
      }

      let receipt = null
      if (invoiceRequest.shouldWaitForZapReceipt && zapRequestId) {
        setPaymentStage("checking_receipt")
        receipt = await waitForZapReceipt({
          zapRequestId,
          recipientPubkey: selectedMerchant,
          expectedAmountMsats: pricingIntent.totalMsats,
          expectedLnurl: lnurlMeta.lnurl,
          lnurlNostrPubkey: lnurlMeta.nostrPubkey,
          relayUrls: zapRelayUrls,
          timeoutMs: ZAP_RECEIPT_WAIT_MS,
        }).catch((e) => {
          console.warn("Failed to observe zap receipt", e)
          return null
        })
        if (receipt) {
          await updatePaymentAttempt(orderId, {
            zapReceiptId: receipt.id,
          }).catch((e) => {
            console.warn("Failed to persist zap receipt id", e)
          })
        }
      }

      // Terminal success. Clear the live cart immediately (a paid cart must
      // never be re-payable on refresh) and freeze a snapshot so the completed
      // tracker + order summary hold until the buyer chooses where to go.
      setCompletedSnapshot({
        orderId,
        merchantPubkey: selectedMerchant,
        items: checkoutItems,
        totalSats: pricingIntent.totalSats,
      })
      cart.clearMerchant(selectedMerchant)
      setSentOrderId(orderId)
      setShowSentGlow(true)
      setPaidNotice(
        proofDelivered
          ? (recoveryNotice ??
              (receipt
                ? "Payment sent, proof accepted by Nostr delivery relays for merchant pickup, and the merchant zap receipt was observed."
                : isPublicZapPayment
                  ? "Payment sent and proof accepted by Nostr delivery relays for merchant pickup. Awaiting merchant confirmation."
                  : "Payment sent and private proof accepted by Nostr delivery relays for merchant pickup. Awaiting merchant confirmation."))
          : "Payment sent. Proof delivery needs retry."
      )
      setTrackerFinished(true)
      setStep("paid")
      void navigate({ to: "/orders", replace: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Payment failed"
      if (paymentMoved) {
        // Funds moved but a tail step (proof publish / receipt) threw. Still
        // terminal success for the cart: clear it and hold the completed view.
        setCompletedSnapshot({
          orderId,
          merchantPubkey: selectedMerchant,
          items: checkoutItems,
          totalSats: pricingIntent.totalSats,
        })
        cart.clearMerchant(selectedMerchant)
        setSentOrderId(orderId)
        setPaidNotice("Payment sent. Proof delivery needs retry.")
        setShowSentGlow(true)
        setTrackerProofStatus("retry_needed")
        setTrackerFinished(true)
        setStep("paid")
        void navigate({ to: "/orders", replace: true })
      } else {
        // Post-delivery, pre-payment failure. The order is already with the
        // merchant, so recovery retries payment against THIS order; it must
        // not publish another. The cart stays live so a retry can re-price.
        setTrackerError(
          `Order accepted by Nostr delivery relays for merchant pickup, but payment did not complete. ${message}`
        )
        setTrackerFinished(true)
      }
    } finally {
      // NB: do not reset `paymentStage` here. On a terminal failure the tracker
      // derives which row to mark "failed" from the stage that was active when
      // the flow stopped (getPaymentTrackerRows); nulling it would always blame
      // the invoice row even when the failure was during payment. The stage is
      // re-initialised at the start of the next attempt.
      paymentInFlightRef.current = false
    }
  }

  async function payNow(): Promise<void> {
    const deliveredCtx = deliveredOrderContextRef.current
    if (deliveredCtx) {
      await payDeliveredOrder(deliveredCtx)
      return
    }

    if (!pubkey || !selectedMerchant || checkoutItems.length === 0) return
    if (pendingManualInvoice) return
    const webLnAvailableNow = hasWebLN()
    if (webLnAvailableNow !== weblnAvailable)
      setWeblnAvailable(webLnAvailableNow)
    const canAttemptPaymentNow = canTrySavedNwcWallet || webLnAvailableNow
    if (!canAttemptPaymentNow) {
      setError("Connect a Lightning wallet or browser payment method.")
      return
    }
    if (!merchantLud16) {
      setError("Merchant does not have a Lightning address.")
      return
    }
    // Reject a concurrent attempt: a double-clicked "Pay now" must not publish
    // the order twice (CND-89). The ref flips synchronously, before the first
    // `setStep("paying")` re-render commits.
    if (paymentInFlightRef.current) return
    paymentInFlightRef.current = true

    setError(null)
    setPaidNotice(null)
    setPendingManualInvoice(null)
    setPaymentStage("checking_order_delivery")
    setTrackerOrderDelivered(false)
    setTrackerPaymentMoved(false)
    setTrackerProofStatus(undefined)
    setTrackerFinished(false)
    setTrackerError(null)
    setDeliveredOrderContextValue(null)
    setCompletedSnapshot(null)
    setStep("paying")

    try {
      if (hasUnpricedCheckoutItems) {
        throw new Error(
          "One or more items cannot be converted to sats right now. Refresh prices before ordering."
        )
      }

      if (checkoutShippingCost.status === "manual") {
        throw new Error(
          "Shipping cost is coordinated with the merchant for one or more items. Send the order first."
        )
      }

      if (!shippingEligibleForFastCheckout) {
        throw new Error(
          getFastCheckoutUnavailableReasons({
            ...fastEligibilityInput,
            shippingEligible: false,
          }).find((reason) => reason.includes("shipping")) ??
            "Order flow needs current shipping rules before direct payment."
        )
      }

      const pricingIntent = await getFreshPricingIntent()
      if (pricingIntent.status !== "ok") {
        throw new Error(pricingIntent.reason)
      }

      const orderId = crypto.randomUUID()
      const currency = "SATS"
      const ndk = getNdk()
      const orderPayload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: pubkey,
        items: pricingIntent.items,
        subtotal: pricingIntent.totalSats,
        currency,
        shippingCostSats: pricingIntent.shippingCost.totalSats,
        shippingCostStatus: pricingIntent.shippingCost.status,
        shippingAddress: buildShippingAddress(),
        note: buildContactNote(),
        createdAt: Date.now(),
        pricingQuote: pricingIntent.quote,
      }

      const orderRumor = new NDKEvent(ndk)
      orderRumor.kind = EVENT_KINDS.ORDER
      orderRumor.created_at = Math.floor(Date.now() / 1000)
      orderRumor.tags = [
        ["p", selectedMerchant],
        ["type", "order"],
        ["order", orderId],
        ["amount", String(pricingIntent.totalSats)],
        ["currency", currency],
      ]
      for (const item of checkoutItems) {
        orderRumor.tags.push(["item", item.productId, String(item.quantity)])
        if (item.shippingOptionId) {
          orderRumor.tags.push(["shipping", item.shippingOptionId])
        }
      }
      orderRumor.tags = appendConduitClientTag(orderRumor.tags, "market")
      orderRumor.content = JSON.stringify(orderPayload)

      const orderDelivery = await publishWrappedToMerchantAndSelf(
        orderRumor,
        ndk,
        selectedMerchant,
        pubkey
      )
      const orderDeliveryNotice = getDeliveryNotice(orderDelivery, "Order")
      setTrackerOrderDelivered(true)

      // The order is now with the merchant. Capture its context so a payment
      // failure retries against THIS order rather than publishing a duplicate.
      const ctx: FastCheckoutPaymentContext = {
        orderId,
        pricingIntent,
        orderDeliveryNotice,
      }
      setDeliveredOrderContextValue(ctx)
      // Hand off to the payment half. Release the guard first so payDeliveredOrder
      // can re-acquire it; there is no await between here and its synchronous
      // guard check, so no second click can interleave.
      paymentInFlightRef.current = false
      await payDeliveredOrder(ctx)
    } catch (e) {
      // Failure before the order reached the merchant. No order was published,
      // so a full retry (or order-first fallback) can't create a duplicate.
      // Keep `paymentStage` ("checking_order_delivery") so the tracker marks the
      // order-delivery row as failed rather than a later row.
      const message = e instanceof Error ? e.message : "Payment failed"
      setTrackerError(message)
      setTrackerFinished(true)
      paymentInFlightRef.current = false
    }
  }

  // --- Full-screen transition states --------------------------------------
  // Note: `paying` and `paid` are NOT handled here. They render inline inside
  // the main checkout grid so the OrderSummary stays visible alongside the
  // PaymentTracker (CND-2A: replace dead-air interrupt with in-page tracker).

  if (step === "sending") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,var(--primary-500),var(--primary-600))] px-8 py-14 text-center text-white shadow-[0_24px_60px_color-mix(in_srgb,var(--primary-500)_40%,transparent)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--text-inverse)_20%,transparent)] bg-[color-mix(in_srgb,var(--text-inverse)_10%,transparent)]">
            <SpinnerIcon className="h-8 w-8 animate-spin" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight">
            Sending your order...
          </h1>
          <div className="mx-auto mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-black/15">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-white" />
          </div>
          <p className="mx-auto mt-8 max-w-md text-sm leading-7 text-white/85">
            Your order is being sent to Nostr delivery relays for merchant
            pickup. This may take a few seconds depending on your signer and
            relay connection.
          </p>
        </section>
      </div>
    )
  }

  if (step === "signing") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-3xl rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] px-8 py-14 text-center shadow-[var(--shadow-xl)] sm:px-12">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
            <KeyRound className="h-8 w-8" />
          </div>
          <h1 className="mt-8 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Awaiting signature...
          </h1>
          <div className="mx-auto mt-8 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-[var(--surface-elevated)]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-secondary-400" />
          </div>
          <p className="mx-auto mt-8 max-w-md text-sm leading-7 text-[var(--text-secondary)]">
            Confirm this order in your signer to continue. Once the signature is
            approved, Conduit will send the order request to the merchant.
          </p>
        </section>
      </div>
    )
  }

  if (step === "paid") {
    // Render inline (within the main grid) -- handled below alongside the
    // active payment tracker so OrderSummary remains visible. We intentionally
    // do not early-return here.
  }

  if (step === "sent") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="relative w-full max-w-3xl overflow-hidden rounded-[2rem] border border-[var(--border)] bg-[var(--surface)] px-8 py-14 text-center sm:px-12">
          <div
            aria-hidden="true"
            className={[
              "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--tertiary-500)_35%,transparent),transparent_55%),linear-gradient(180deg,color-mix(in_srgb,var(--primary-500)_22%,transparent),color-mix(in_srgb,var(--primary-600)_18%,transparent))] transition-opacity duration-700",
              showSentGlow ? "opacity-100" : "opacity-0",
            ].join(" ")}
          />
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-300">
            <CheckIcon className="h-8 w-8" />
          </div>
          <h1 className="relative mt-8 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Order request submitted
          </h1>
          <div className="relative mx-auto mt-8 h-1 w-full max-w-sm rounded-full bg-secondary-500/50" />
          <p className="relative mx-auto mt-8 max-w-xl text-lg leading-9 text-[var(--text-primary)]">
            {paidNotice ??
              "Your order request has been sent to the merchant. They will review it and follow up with confirmation and payment details."}
          </p>
          <p className="relative mx-auto mt-4 max-w-lg text-sm leading-7 text-[var(--text-secondary)]">
            You can review this order from Orders, keep browsing products, or
            check back later for the merchant response.
          </p>
          {sentOrderId && (
            <div className="relative mt-6 text-xs font-mono text-[var(--text-muted)]">
              {sentOrderId}
            </div>
          )}
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild variant="outline" className="h-11 px-5 text-sm">
              <Link to="/orders">
                <OrderIcon className="h-4 w-4" />
                View orders
              </Link>
            </Button>
            <Button asChild className="h-11 px-5 text-sm">
              <Link to="/products">
                <Store className="h-4 w-4" />
                Browse more products
              </Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  // ─── Empty / multi-merchant guards ──────────────────────────────────────

  if (!selectedMerchant && cart.items.length > 0) {
    return (
      <div className="space-y-6">
        <CheckoutBreadcrumb current="order" />
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Choose a store cart before ordering
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Orders are sent one store at a time. Head back to your cart and pick
            the store you want to review first.
          </p>
          <div className="mt-6">
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/cart">
                <CartIcon className="h-4 w-4" />
                Back to cart
              </Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  // While paying / completed we intentionally keep the order visible even if
  // the cart is being cleared, so the tracker holds (CND-89).
  if (checkoutItems.length === 0 && step !== "paying" && step !== "paid") {
    return (
      <div className="space-y-6">
        <CheckoutBreadcrumb current="order" />
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-8 sm:p-10">
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Cart is empty
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            This cart is empty now. Head back to the marketplace and add
            products before starting an order again.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild className="h-11 px-4 text-sm">
              <Link to="/products">Continue shopping</Link>
            </Button>
            <Button asChild variant="outline" className="h-11 px-4 text-sm">
              <Link to="/cart">Back to cart</Link>
            </Button>
          </div>
        </section>
      </div>
    )
  }

  // ─── Field-level error helpers ───────────────────────────────────────────

  const errorFields = getValidationErrorFields(shippingErrors)

  function fieldError(field: ShippingFieldKey): string | undefined {
    return shippingErrors.find((e) => e.field === field)?.message
  }

  function fieldInvalid(field: ShippingFieldKey): boolean {
    return shippingAttempted && errorFields.includes(field)
  }

  function fieldClassName(field: ShippingFieldKey): string | undefined {
    return fieldInvalid(field)
      ? "border-error/50 focus:border-error focus:ring-error/30"
      : undefined
  }

  // ─── Main checkout form ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <CheckoutBreadcrumb
        current={visibleCheckoutStep === "payment" ? "send-order" : "shipping"}
        includesShippingStep={!isAllDigital}
        onShippingClick={
          visibleCheckoutStep === "payment" &&
          !isAllDigital &&
          !pendingManualInvoice
            ? () => setStep("shipping")
            : undefined
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,520px)]">
        <section className="space-y-5">
          {/* ── Shipping step ─────────────────────────────────────────────── */}
          {visibleCheckoutStep === "shipping" && (
            <>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Shipping
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  Add delivery details for this order. Merchant follow-up and
                  payment requests are sent through your Nostr account after the
                  order is sent.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Delivery details
                </div>

                <div className="mt-5 grid gap-4">
                  {shippingAttempted && shippingErrors.length > 0 && (
                    <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
                      {shippingErrors.length === 1
                        ? shippingErrors[0]!.message
                        : `${shippingErrors.length} fields need attention: ${shippingErrors.map((e) => shippingFieldLabel(e.field)).join(", ")}`}
                    </div>
                  )}

                  {/* Country */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-country">
                      Country <span className="text-error">*</span>
                    </Label>
                    <Combobox
                      id="ship-country"
                      value={shipping.country}
                      selectedLabel={getCountryLabel(shipping.country)}
                      options={COUNTRY_COMBOBOX_OPTIONS}
                      invalid={fieldInvalid("country")}
                      onValueChange={(countryCode) =>
                        updateShipping("country", countryCode)
                      }
                      placeholder="Search countries..."
                      searchPlaceholder="Search countries..."
                      emptyText="No supported countries found."
                      triggerClassName="h-10 rounded-xl bg-[var(--surface-elevated)]"
                      contentClassName="rounded-xl border-[var(--border-overlay)] bg-[var(--surface-overlay)]"
                    />
                    {fieldInvalid("country") && (
                      <p className="text-xs text-error">
                        {fieldError("country")}
                      </p>
                    )}
                  </div>

                  {/* Name */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-first-name">
                        First name <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-first-name"
                        value={shipping.firstName}
                        onChange={(e) =>
                          updateShipping("firstName", e.target.value)
                        }
                        autoComplete="given-name"
                        placeholder="Jane"
                        aria-invalid={fieldInvalid("firstName")}
                        className={fieldClassName("firstName")}
                      />
                      {fieldInvalid("firstName") && (
                        <p className="text-xs text-error">
                          {fieldError("firstName")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-last-name">
                        Last name <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-last-name"
                        value={shipping.lastName}
                        onChange={(e) =>
                          updateShipping("lastName", e.target.value)
                        }
                        autoComplete="family-name"
                        placeholder="Doe"
                        aria-invalid={fieldInvalid("lastName")}
                        className={fieldClassName("lastName")}
                      />
                      {fieldInvalid("lastName") && (
                        <p className="text-xs text-error">
                          {fieldError("lastName")}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Street */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-street">
                      Street address <span className="text-error">*</span>
                    </Label>
                    <Input
                      id="ship-street"
                      value={shipping.street}
                      onChange={(e) => updateShipping("street", e.target.value)}
                      autoComplete="address-line1"
                      placeholder="123 Main St"
                      aria-invalid={fieldInvalid("street")}
                      className={fieldClassName("street")}
                    />
                    {fieldInvalid("street") && (
                      <p className="text-xs text-error">
                        {fieldError("street")}
                      </p>
                    )}
                  </div>

                  {/* Line 2 */}
                  <div className="grid gap-1.5">
                    <Label htmlFor="ship-line2">
                      Apt, suite, etc. (optional)
                    </Label>
                    <Input
                      id="ship-line2"
                      value={shipping.line2}
                      onChange={(e) => updateShipping("line2", e.target.value)}
                      autoComplete="address-line2"
                      placeholder="Unit 4B"
                    />
                  </div>

                  {/* Postal / City / State */}
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-postal">
                        Postal code <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-postal"
                        value={shipping.postalCode}
                        onChange={(e) =>
                          updateShipping("postalCode", e.target.value)
                        }
                        autoComplete="postal-code"
                        placeholder="78701"
                        aria-invalid={fieldInvalid("postalCode")}
                        className={fieldClassName("postalCode")}
                      />
                      {fieldInvalid("postalCode") && (
                        <p className="text-xs text-error">
                          {fieldError("postalCode")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-city">
                        City <span className="text-error">*</span>
                      </Label>
                      <Input
                        id="ship-city"
                        value={shipping.city}
                        onChange={(e) => updateShipping("city", e.target.value)}
                        autoComplete="address-level2"
                        placeholder="Austin"
                        aria-invalid={fieldInvalid("city")}
                        className={fieldClassName("city")}
                      />
                      {fieldInvalid("city") && (
                        <p className="text-xs text-error">
                          {fieldError("city")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ship-state">Region</Label>
                      <Input
                        id="ship-state"
                        value={shipping.state}
                        onChange={(e) =>
                          updateShipping("state", e.target.value)
                        }
                        autoComplete="address-level1"
                        placeholder="TX"
                      />
                    </div>
                  </div>

                  {/* Contact */}
                  <div className="border-t border-[var(--border)] pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Contact
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        (optional)
                      </div>
                    </div>
                    <div className="mt-4 grid gap-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-phone">Phone</Label>
                        <Input
                          id="ship-phone"
                          value={shipping.phone}
                          onChange={(e) =>
                            updateShipping("phone", e.target.value)
                          }
                          autoComplete="tel"
                          placeholder="+1 555 123 4567"
                          aria-invalid={fieldInvalid("phone")}
                          className={fieldClassName("phone")}
                        />
                        {fieldInvalid("phone") && (
                          <p className="text-xs text-error">
                            {fieldError("phone")}
                          </p>
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-email">Email</Label>
                        <Input
                          id="ship-email"
                          value={shipping.email}
                          onChange={(e) =>
                            updateShipping("email", e.target.value)
                          }
                          autoComplete="email"
                          placeholder="jane@example.com"
                          aria-invalid={fieldInvalid("email")}
                          className={fieldClassName("email")}
                        />
                        {fieldInvalid("email") && (
                          <p className="text-xs text-error">
                            {fieldError("email")}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {!isAllDigital && (
                    <div
                      className={[
                        "rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3 text-xs leading-5 text-[var(--text-secondary)]",
                        shippingCheckoutState === "loading"
                          ? "animate-pulse"
                          : "",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2">
                        {shippingCheckoutState === "loading" && (
                          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-secondary-400" />
                        )}
                        <span>{shippingStatusMessage}</span>
                      </div>
                    </div>
                  )}

                  <Button
                    className="mt-2 h-11 w-full text-sm"
                    onClick={continueToPayment}
                  >
                    Continue to Send Order
                  </Button>

                  <p className="text-xs leading-6 text-[var(--text-muted)]">
                    Your order details will be sent to the merchant through your
                    signed Nostr account so they can follow up with payment and
                    fulfillment.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ── Payment step ──────────────────────────────────────────────── */}
          {visibleCheckoutStep === "payment" && (
            <>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
                  Send Order
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  {fastEligible
                    ? wallet.status === "pay-capable"
                      ? "Your wallet is connected and ready. Zap out now, or send the order first and pay later."
                      : "Zap out is available for this merchant, or you can send the order first and pay later."
                    : pricingOnlyFastCheckoutBlocker
                      ? "Conduit is refreshing the price conversion before offering zap out. You can still send the order first."
                      : "Send the order to the merchant first. They can confirm shipping and reply with payment details."}
                </p>
              </div>

              {isAllDigital && (
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-400">
                      <CheckIcon className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Digital delivery
                      </div>
                      <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                        This merchant cart contains only digital products, so no
                        shipping address is needed. Merchant follow-up still
                        happens through your Nostr account after the order is
                        sent.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                {/* Zap out banner */}
                {lnurlProbing && (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                      <SpinnerIcon className="h-4 w-4 animate-spin" />
                      Checking merchant payment capabilities...
                    </div>
                  </div>
                )}

                {!lnurlProbing && showFastCheckoutSurface && (
                  <div className="rounded-2xl border border-secondary-500/30 bg-secondary-500/8 p-5">
                    <div className="flex items-center gap-2">
                      {pricingOnlyFastCheckoutBlocker ? (
                        <SpinnerIcon className="h-4 w-4 animate-spin text-secondary-400" />
                      ) : (
                        <LightningIcon className="h-4 w-4 text-secondary-400" />
                      )}
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        {pricingOnlyFastCheckoutBlocker
                          ? "Refreshing Lightning total"
                          : "Zap out with Lightning"}
                      </div>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                      {pricingOnlyFastCheckoutBlocker
                        ? "The cart total is visible, but direct payment needs a fresh conversion before funds can move. Conduit is refreshing it now."
                        : requiresPublicZap
                          ? "Conduit will deliver the order, request a public zap invoice, and try your connected wallet first. If that path is unreachable before funds move, you can still pay the invoice with another Lightning wallet."
                          : "Conduit will deliver the order, request a private LNURL invoice, and try your connected wallet first. If that path is unreachable before funds move, you can still pay the invoice with another Lightning wallet."}
                    </p>
                  </div>
                )}

                {!lnurlProbing && fastEligible && (
                  <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      Zap visibility
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        aria-pressed={zapVisibility === "public_zap"}
                        disabled={!lnurlAllowsNostr}
                        onClick={() => setZapVisibility("public_zap")}
                        className={[
                          "rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                          zapVisibility === "public_zap"
                            ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] text-[var(--text-primary)]"
                            : !lnurlAllowsNostr
                              ? "cursor-not-allowed border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] opacity-70"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        ].join(" ")}
                      >
                        <span className="block font-medium">Public zap</span>
                        <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                          {lnurlAllowsNostr
                            ? "Include an editable public zap comment."
                            : "This merchant wallet does not advertise public zap receipts."}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={zapVisibility === "private_checkout"}
                        onClick={() => setZapVisibility("private_checkout")}
                        className={[
                          "rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                          zapVisibility === "private_checkout"
                            ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] text-[var(--text-primary)]"
                            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        ].join(" ")}
                      >
                        <span className="block font-medium">
                          Private invoice
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                          Request a normal LNURL invoice without a public zap
                          request or public zap receipt.
                        </span>
                      </button>
                    </div>
                    {zapVisibility === "public_zap" && (
                      <div className="mt-4 grid gap-1.5">
                        <Label htmlFor="zap-content">Public zap comment</Label>
                        <Textarea
                          id="zap-content"
                          value={zapContent}
                          onChange={(e) => {
                            setZapContent(e.target.value)
                            setZapContentEdited(true)
                          }}
                          rows={1}
                          maxLength={280}
                          className="min-h-[2.75rem] rounded-xl bg-[var(--surface)] py-2.5 focus-visible:border-primary-500 focus-visible:ring-primary-500/30"
                        />
                        <p className="text-xs leading-6 text-[var(--text-muted)]">
                          Public zap receipts can expose this comment. Shipping
                          address, contact details, private notes, wallet data,
                          payment evidence, and order IDs are never added here.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* What happens next (order-first) */}
                {!showFastCheckoutSurface && !lnurlProbing && (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      What happens next
                    </div>
                    <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--text-secondary)]">
                      <li>
                        1. Your order is sent to the merchant through Nostr.
                      </li>
                      <li>
                        2. The merchant reviews the order and replies with
                        payment details.
                      </li>
                      <li>
                        3. You track order updates from the merchant in your
                        order history.
                      </li>
                    </ul>
                    {fastUnavailableReasons.length > 0 && (
                      <div className="mt-4 border-t border-[var(--border)] pt-4">
                        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
                          Zap out unavailable
                        </div>
                        <ul className="mt-3 space-y-2 text-xs leading-5 text-[var(--text-secondary)]">
                          {fastUnavailableReasons.map((reason) => (
                            <li key={reason}>- {reason}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {wallet.status === "disconnected" && (
                      <div className="mt-4 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">
                        <Link
                          to="/wallet"
                          className="underline underline-offset-2 hover:text-[var(--text-secondary)]"
                        >
                          Connect a Lightning wallet
                        </Link>{" "}
                        to unlock zap out on future orders.
                      </div>
                    )}
                  </div>
                )}

                {/* Order note */}
                <div className="mt-6 grid gap-1.5">
                  <Label htmlFor="order-note">Order note (optional)</Label>
                  <Textarea
                    id="order-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Anything the merchant should know before they confirm the order?"
                    rows={2}
                    className="min-h-[4.5rem] rounded-xl bg-[var(--surface-elevated)] py-2.5 focus-visible:border-primary-500 focus-visible:ring-primary-500/30"
                  />
                </div>

                {error && (
                  <div className="mt-5 rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">
                    {error}
                  </div>
                )}

                {pendingManualInvoice && (
                  <div className="mt-5 rounded-2xl border border-secondary-500/40 bg-secondary-500/8 p-5">
                    <div className="flex items-center gap-2">
                      <LightningIcon className="h-4 w-4 text-secondary-400" />
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Order accepted by Nostr delivery relays for merchant
                        pickup. Pay the Lightning invoice to finish.
                      </div>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                      Automatic payment did not complete. Open or copy this
                      invoice with your wallet; Conduit will not mark the order
                      paid until payment proof is available.
                    </p>
                    {pendingManualInvoice.reason && (
                      <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                        Automatic payment fallback reason:{" "}
                        {pendingManualInvoice.reason}
                      </p>
                    )}
                    {pendingManualInvoice.deliveryNotice && (
                      <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                        {pendingManualInvoice.deliveryNotice}
                      </p>
                    )}
                    {pendingManualInvoice.diagnostics &&
                      pendingManualInvoice.diagnostics.length > 0 && (
                        <div className="mt-4 space-y-2">
                          {pendingManualInvoice.diagnostics.map(
                            (diagnostic) => (
                              <div
                                key={`${diagnostic.code}:${diagnostic.relayHosts?.join(",") ?? ""}`}
                                className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-xs leading-5 text-[var(--warning)]"
                              >
                                <div className="font-medium">
                                  {diagnostic.title}
                                </div>
                                <div className="mt-1">{diagnostic.detail}</div>
                                <div className="mt-1 font-medium">
                                  {diagnostic.action}
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      <Button asChild className="h-10 px-4 text-sm">
                        <a
                          href={`lightning:${normalizeLightningInvoice(
                            pendingManualInvoice.invoice
                          )}`}
                        >
                          <ExternalLink className="h-4 w-4" />
                          Open in wallet
                        </a>
                      </Button>
                      <Button
                        variant="outline"
                        className="h-10 px-4 text-sm"
                        onClick={copyPendingInvoice}
                      >
                        <Copy className="h-4 w-4" />
                        Copy invoice
                      </Button>
                    </div>
                    <div className="mt-4 max-h-28 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-secondary)]">
                      {pendingManualInvoice.invoice}
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="mt-6 flex flex-wrap gap-3">
                  {pendingManualInvoice ? (
                    <>
                      <Button
                        variant="outline"
                        className="h-11 px-4 text-sm"
                        onClick={retryPendingManualInvoicePayment}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Try automatic payment again
                      </Button>
                      <Button
                        asChild
                        variant="ghost"
                        className="h-11 px-4 text-sm"
                      >
                        <Link to="/orders">View orders</Link>
                      </Button>
                    </>
                  ) : (
                    <>
                      {fastEligible && (
                        <Button
                          className="h-11 px-5 text-sm"
                          onClick={() => {
                            // Show the lightning-strike animation immediately
                            // so the buyer gets click feedback within ~100ms
                            // while order publish + invoice flow runs.
                            setOverlayPlaying(true)
                            void payNow()
                          }}
                        >
                          <LightningIcon className="h-4 w-4" />
                          Zap out
                        </Button>
                      )}
                      {pricingOnlyFastCheckoutBlocker && !fastEligible && (
                        <Button
                          className="h-11 px-5 text-sm"
                          disabled={pricingRefreshState === "refreshing"}
                          onClick={() => void refreshCheckoutPricing(true)}
                        >
                          {pricingRefreshState === "refreshing" ? (
                            <>
                              <SpinnerIcon className="h-4 w-4 animate-spin" />
                              Refreshing total...
                            </>
                          ) : (
                            <>
                              <LightningIcon className="h-4 w-4" />
                              Refresh total
                            </>
                          )}
                        </Button>
                      )}

                      <Button
                        variant={
                          fastEligible || pricingOnlyFastCheckoutBlocker
                            ? "outline"
                            : "primary"
                        }
                        className="h-11 px-5 text-sm"
                        onClick={placeOrder}
                      >
                        <OrderIcon className="h-4 w-4" />
                        Send order
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Inline payment tracker -- replaces the old purple full-page
              interrupt. Renders in the left column so the OrderSummary on
              the right stays visible during payment. (CND-2A) */}
          {(step === "paying" || step === "paid") &&
            (() => {
              const trackerInput = {
                stage: paymentStage,
                orderDelivered: trackerOrderDelivered,
                paymentMoved: trackerPaymentMoved,
                proofStatus: trackerProofStatus,
                finished: trackerFinished,
                errorMessage: trackerError,
              }
              const plan = getCheckoutRecoveryPlan(trackerInput)
              const canRetry = plan.canRetryPayment || plan.canRepublishOrder
              // After payment settles the cart is cleared, so read the held
              // total from the snapshot rather than the (now empty) cart.
              const amountSats =
                step === "paid" && completedSnapshot
                  ? completedSnapshot.totalSats
                  : total
              return (
                <PaymentTracker
                  input={trackerInput}
                  amountLabel={
                    amountSats > 0
                      ? `${amountSats.toLocaleString()} sats`
                      : undefined
                  }
                  busy={!trackerFinished}
                  onTryAgain={
                    canRetry
                      ? () => {
                          // Order already delivered -> retry payment only.
                          // Otherwise re-run the full flow (nothing published).
                          if (plan.canRetryPayment) {
                            const ctx =
                              deliveredOrderContextRef.current ??
                              deliveredOrderContext
                            if (ctx) {
                              setOverlayPlaying(true)
                              void payDeliveredOrder(ctx)
                            } else {
                              setTrackerError(
                                "This order was already sent. Return to Orders to continue."
                              )
                            }
                          } else {
                            setOverlayPlaying(true)
                            void payNow()
                          }
                        }
                      : undefined
                  }
                  onPayLater={
                    plan.canSendOrderPayLater
                      ? () => {
                          setTrackerError(null)
                          setTrackerFinished(false)
                          void placeOrder()
                        }
                      : undefined
                  }
                  onBackToCheckout={
                    plan.canReturnToCheckout
                      ? () => {
                          setError(trackerError)
                          setTrackerError(null)
                          setTrackerFinished(false)
                          setStep("payment")
                        }
                      : undefined
                  }
                />
              )
            })()}
        </section>

        <OrderSummary
          items={
            step === "paid" && completedSnapshot
              ? completedSnapshot.items
              : checkoutItems
          }
          merchantPubkey={
            (step === "paid" && completedSnapshot
              ? completedSnapshot.merchantPubkey
              : selectedMerchant)!
          }
          btcUsdRate={btcUsdRate}
        />
      </div>

      <LightningStrikeOverlay
        open={overlayPlaying}
        onComplete={() => setOverlayPlaying(false)}
      />
    </div>
  )
}
