import {
  AlertCircle,
  AlertTriangle,
  Check,
  KeyRound,
  LoaderCircle,
  ReceiptText,
  ShoppingCart,
  Store,
  Zap,
} from "lucide-react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  SHIPPING_COUNTRIES,
  appendConduitClientTag,
  createOrderLifecycle,
  fetchLnurlPayMetadata,
  getPriceSats,
  getTelemetryAmountBucket,
  getTelemetryCountBucket,
  hasWebLN,
  getNdk,
  getShippingOptions,
  normalizePubkey,
  pubkeyToNpub,
  recordBrowserTelemetryEvent,
  validateAddressConsistency,
  useAuth,
  useProfile,
  type AddressValidityResult,
  type CommercePriceLike,
  type OrderAddressValidity,
  type OrderGuestContact,
  type OrderLifecycleItem,
  type OrderShippingZoneEligibility,
  type Profile,
  type PricingRateInput,
  type ShopperPriceDisplay,
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
  Nip05TrustIndicator,
  getMerchantDisplayName,
  getProfileNip05,
} from "../components/MerchantIdentity"
import { SignerSwitch } from "../components/SignerSwitch"
import { type CartItem, useCart } from "../hooks/useCart"
import { useMerchantTrustContext } from "../hooks/useMerchantTrustContext"
import { useShopperPricing } from "../hooks/useShopperPricing"
import {
  useWallet,
  type WalletBalanceState,
  type WalletBudgetState,
} from "../hooks/useWallet"
import {
  getCartShippingDestinationEligibility,
  getCartShippingOptionsAvailable,
  hasPhysicalItemsMissingShippingSnapshot,
  hasPhysicalItemsMissingShippingZone,
} from "../lib/cart-shipping-options"
import { getCartPublicZapPolicy } from "../lib/cart-model"
import { LightningStrikeOverlay } from "../components/LightningStrikeOverlay"
import {
  isFastCheckoutEligible,
  getFastCheckoutUnavailableReasons,
  getShippingCheckoutState,
  getShippingStepBlockingMessage,
  getShippingPhoneDescribedBy,
  getShippingRegionRequirement,
  getValidationErrorFields,
  sanitizeShippingPhoneInput,
  SHIPPING_EMAIL_ERROR_ID,
  SHIPPING_PHONE_ERROR_ID,
  SHIPPING_PHONE_HELP_COPY,
  SHIPPING_PHONE_HELP_ID,
  shippingFieldLabel,
  validateGuestContactFields,
  validateGuestShippingFields,
  validateShippingFields,
  type ShippingFormState,
  type ShippingFieldKey,
  type ShippingCheckoutState,
  type ShippingValidationError,
} from "../lib/checkout-validation"
import {
  clearCheckoutShippingSession,
  readCheckoutShippingSession,
  writeCheckoutShippingSession,
} from "../lib/checkout-session"
import {
  buildCheckoutPricingIntent,
  buildDefaultZapContent,
  getCheckoutPublicZapSigner,
  getLnurlReadyForCheckoutPayment,
  getCheckoutShippingCost,
  getCheckoutZapVisibility,
  isCheckoutPublicZapMode,
  isPublicZapContentEditable,
  type CheckoutZapMode,
} from "../lib/checkout-payment"
import { isAnonZapSignerConfigured } from "../lib/anon-zap-signer"
import {
  getDeliveryNotice,
  publishBuyerOrderMessage,
} from "../lib/order-publish"
import {
  clearSessionGuestOrderSigningIdentity,
  createSessionGuestOrderSigningIdentity,
} from "../lib/guest-order-identity"
import {
  runOrderPayment,
  type OrderPaymentContext,
} from "../lib/order-payment-service"

import {
  formatBalanceFreshness,
  getKnownWalletPaymentConstraint,
  type WalletPaymentConstraint,
} from "../lib/wallet-readiness"

type PriceFormatter = (price: CommercePriceLike) => ShopperPriceDisplay

type CheckoutStep =
  "shipping" | "payment" | "signing" | "sending" | "sent" | "paying" | "paid"

type CheckoutSearch = {
  merchant?: string
}

type CheckoutTelemetryMode = "checkout" | "order_first" | CheckoutZapMode

/** Priced "ok" intent — the only shape we proceed to payment with. */
const CHECKOUT_PRICE_REFRESH_TIMEOUT_MS = 5_000
const CHECKOUT_PRICE_REFRESH_RETRY_MS = 30_000

type CheckoutPricingRefreshState =
  "ready" | "refreshing" | "stale_retryable" | "unavailable"

const SHIPPING_VALIDATION_FIELDS: ShippingFieldKey[] = [
  "country",
  "firstName",
  "lastName",
  "street",
  "postalCode",
  "city",
  "state",
  "phone",
  "email",
]

function isValidationField(
  field: keyof ShippingFormState
): field is ShippingFieldKey {
  return SHIPPING_VALIDATION_FIELDS.includes(field as ShippingFieldKey)
}

const COUNTRY_COMBOBOX_OPTIONS = SHIPPING_COUNTRIES.map((country) => ({
  value: country.code,
  label: country.name,
  meta: country.code,
  searchText: `${country.code} ${country.name}`,
}))

// ─── Session storage ──────────────────────────────────────────────────────────

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/checkout")({
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

function CheckoutWalletReadiness({
  balance,
  budget,
  constraint,
  formatSats,
}: {
  balance: WalletBalanceState
  budget: WalletBudgetState
  constraint: WalletPaymentConstraint | null
  formatSats: (sats: number) => string
}) {
  const balanceValue =
    balance.status === "available" && balance.balanceMsats !== null
      ? formatSats(Math.floor(balance.balanceMsats / 1_000))
      : balance.status === "checking"
        ? "Checking..."
        : balance.status === "error"
          ? "Unable to refresh"
          : balance.status === "unavailable"
            ? "Not advertised"
            : "Not checked yet"
  const balanceFreshness = formatBalanceFreshness(balance.fetchedAt)
  const budgetValue =
    budget.status === "available" && budget.remainingMsats !== null
      ? `${formatSats(Math.floor(budget.remainingMsats / 1_000))} remaining`
      : budget.status === "checking"
        ? "Checking..."
        : budget.status === "error"
          ? "Unable to refresh"
          : budget.status === "unavailable"
            ? null
            : "Not checked yet"

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <div className="font-medium text-[var(--text-muted)]">
            Wallet balance
          </div>
          <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
            {balanceValue}
          </div>
          {balanceFreshness && (
            <div className="mt-1 text-[var(--text-muted)]">
              {balanceFreshness}
            </div>
          )}
        </div>
        {budgetValue && (
          <div>
            <div className="font-medium text-[var(--text-muted)]">
              App budget
            </div>
            <div className="mt-1 text-sm font-medium text-[var(--text-primary)]">
              {budgetValue}
            </div>
            {budget.fetchedAt && (
              <div className="mt-1 text-[var(--text-muted)]">
                {formatBalanceFreshness(budget.fetchedAt)}
              </div>
            )}
          </div>
        )}
      </div>
      {constraint && (
        <div className="mt-4 rounded-xl border border-[color-mix(in_srgb,var(--warning)_55%,transparent)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)] p-3 text-xs leading-5 text-[var(--text-secondary)]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
            <div>
              <div className="font-medium text-[var(--warning)]">
                Automatic wallet payment will be skipped
              </div>
              <div className="mt-1">
                {constraint.detail} We&apos;ll send the order and show a
                Lightning invoice so you can pay manually.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
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

function getCheckoutTelemetryProductType(items: CartItem[]): string {
  const hasDigital = items.some((item) => item.format === "digital")
  const hasPhysical = items.some((item) => item.format !== "digital")

  if (hasDigital && hasPhysical) return "mixed"
  if (hasDigital) return "digital"
  if (hasPhysical) return "physical"
  return "unknown"
}

function getCheckoutTelemetryItemCountBucket(items: CartItem[]): string {
  return getTelemetryCountBucket(
    items.reduce((sum, item) => sum + item.quantity, 0)
  )
}

function getCheckoutTelemetryBaseProperties(
  items: CartItem[],
  mode: CheckoutTelemetryMode,
  amountSats?: number
) {
  return {
    amount_bucket:
      amountSats === undefined
        ? "unknown"
        : getTelemetryAmountBucket(amountSats),
    count_bucket: getCheckoutTelemetryItemCountBucket(items),
    mode,
    product_type: getCheckoutTelemetryProductType(items),
    surface: "checkout",
  }
}

// ─── Order summary sidebar ────────────────────────────────────────────────────

function CheckoutMerchantIdentityLink({
  merchantPubkey,
  merchantProfile,
  merchantName,
  className = "",
}: {
  merchantPubkey: string
  merchantProfile: Profile | undefined
  merchantName: string
  className?: string
}) {
  const merchantNip05 = getProfileNip05(merchantProfile)
  const merchantStoreRef = pubkeyToNpub(merchantPubkey)

  return (
    <Link
      to="/store/$pubkey"
      params={{ pubkey: merchantStoreRef }}
      className={[
        "flex min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 transition-colors hover:border-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]",
        className,
      ].join(" ")}
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
        {merchantNip05 && (
          <div
            className="mt-1 truncate text-xs font-medium text-[var(--text-muted)]"
            title={merchantNip05}
          >
            <Nip05TrustIndicator
              pubkey={merchantPubkey}
              nip05={merchantNip05}
            />
          </div>
        )}
      </div>
    </Link>
  )
}

function OrderSummary({
  items,
  merchantPubkey,
  btcUsdRate,
  formatPrice,
}: {
  items: CartItem[]
  merchantPubkey: string
  btcUsdRate: PricingRateInput
  formatPrice: PriceFormatter
}) {
  const { data: merchantProfile } = useProfile(merchantPubkey)
  const merchantName = getMerchantDisplayName(merchantProfile, merchantPubkey)
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)
  const pricing = buildCheckoutPricingIntent(items, btcUsdRate)
  const pricingUnavailable = {
    state: "invalid" as const,
    primary:
      pricing.status === "error" && pricing.code === "stale_quote"
        ? "Price conversion is stale"
        : "Price conversion unavailable",
    secondary: null,
    displayCurrency: "BITCOIN" as const,
    sats: null,
    approximate: false,
    source: null,
  }
  const itemSubtotalPrice =
    pricing.status === "ok"
      ? formatPrice({
          price: pricing.itemSubtotalSats,
          currency: "SATS",
          priceSats: pricing.itemSubtotalSats,
        })
      : pricingUnavailable
  const totalPrice =
    pricing.status === "ok"
      ? formatPrice({
          price: pricing.totalSats,
          currency: "SATS",
          priceSats: pricing.totalSats,
        })
      : pricingUnavailable
  const shippingCost =
    pricing.status === "ok"
      ? pricing.shippingCost
      : getCheckoutShippingCost(items, btcUsdRate)
  const shippingLabel =
    shippingCost.status === "not_required"
      ? "Not required (digital)"
      : shippingCost.status === "included"
        ? "Included"
        : shippingCost.status === "manual"
          ? "Coordinated with merchant"
          : pricing.status !== "ok"
            ? pricingUnavailable.primary
            : formatPrice({
                price: shippingCost.totalSats,
                currency: "SATS",
                priceSats: shippingCost.totalSats,
              }).primary

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
        <CheckoutMerchantIdentityLink
          merchantPubkey={merchantPubkey}
          merchantProfile={merchantProfile}
          merchantName={merchantName}
          className="mt-4"
        />
      </div>

      <div className="mt-4 space-y-4">
        {items.map((item) => {
          const linePrice = formatPrice({
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
          })
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
                {linePrice.secondary && (
                  <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {linePrice.secondary}
                  </div>
                )}
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
  const { pubkey, status: authStatus } = useAuth()
  const cart = useCart()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const shopperPricing = useShopperPricing()
  const btcUsdRateQuery = shopperPricing.rateQuery
  const wallet = useWallet({ refreshBalance: true })

  const [step, setStep] = useState<CheckoutStep>("shipping")
  const [shipping, setShipping] = useState<ShippingFormState>(() =>
    readCheckoutShippingSession()
  )
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [shippingAttempted, setShippingAttempted] = useState(false)
  const [shippingErrors, setShippingErrors] = useState<
    ShippingValidationError[]
  >([])
  const [touchedShippingFields, setTouchedShippingFields] = useState<
    Set<ShippingFieldKey>
  >(() => new Set())
  const [sentOrderId, setSentOrderId] = useState<string | null>(null)
  const [showSentGlow, setShowSentGlow] = useState(false)
  // paidNotice carries any non-critical delivery notice from the order publish.
  const [paidNotice, setPaidNotice] = useState<string | null>(null)
  // Lightning-strike click feedback while the order publishes before navigation.
  const [overlayPlaying, setOverlayPlaying] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  // Synchronous re-entrancy guard for the payment flow. A `step`/`disabled`
  // check can't prevent a double-click because the state change doesn't commit
  // until React re-renders; this ref flips synchronously inside the click's
  // first tick so a second click is rejected before it can publish a duplicate
  // order (CND-89).
  const paymentInFlightRef = useRef(false)
  const anonZapSignerAvailable = isAnonZapSignerConfigured()
  const defaultPublicZapMode: CheckoutZapMode = anonZapSignerAvailable
    ? "anonymous_public_zap"
    : "public_zap_as_shopper"
  const [zapMode, setZapMode] = useState<CheckoutZapMode>(defaultPublicZapMode)
  const [zapContent, setZapContent] = useState("")
  const [zapContentEdited, setZapContentEdited] = useState(false)
  const [weblnAvailable, setWeblnAvailable] = useState(false)
  const [pricingRefreshPending, setPricingRefreshPending] = useState(false)
  const [pricingRefreshFailedAt, setPricingRefreshFailedAt] = useState<
    number | null
  >(null)
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const refetchBtcUsdRate = btcUsdRateQuery.refetch
  const btcUsdRateIsFetching = btcUsdRateQuery.isFetching
  const signerConnected = authStatus === "connected" && !!pubkey
  const signedBuyerPubkey = signerConnected ? pubkey : null
  const authPending = authStatus === "restoring" || authStatus === "connecting"
  const isGuestCheckout = !signerConnected && !authPending

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
  const publicZapPolicy = useMemo(
    () => getCartPublicZapPolicy(checkoutItems),
    [checkoutItems]
  )
  const publicZapPolicyMessage =
    publicZapPolicy.disabledProductIds.length > 0
      ? "At least one product in this cart does not allow public zaps, so checkout will use a private invoice."
      : publicZapPolicy.missingPolicyProductIds.length > 0
        ? "At least one product is missing public zap policy metadata, so checkout will use a private invoice."
        : null
  const guestZapMode: CheckoutZapMode =
    anonZapSignerAvailable &&
    lnurlAllowsNostr &&
    publicZapPolicy.publicZapsAllowed
      ? "anonymous_public_zap"
      : "private_checkout"
  const selectedZapMode = isGuestCheckout ? guestZapMode : zapMode

  const zapVisibility = getCheckoutZapVisibility(selectedZapMode)
  const zapContentEditable = isPublicZapContentEditable(
    selectedZapMode,
    publicZapPolicy.effectiveZapMessagePolicy
  )
  const shopperZapContentEditable =
    publicZapPolicy.effectiveZapMessagePolicy === "custom"
  const publicZapModeDescription = publicZapPolicyMessage
    ? publicZapPolicyMessage
    : !lnurlAllowsNostr
      ? "This merchant wallet does not advertise public zap receipts."
      : shopperZapContentEditable
        ? "Include an editable public zap comment."
        : "Use the merchant's generic public zap comment."
  const anonZapModeDescription = !anonZapSignerAvailable
    ? "Anon Conduit Shopper signing is not configured yet."
    : "Use a fixed item-count message without identifying the shopper."

  // True when every item in the cart is a digital product (no shipping needed)
  const isAllDigital = useMemo(
    () =>
      checkoutItems.length > 0 &&
      checkoutItems.every((item) => item.format === "digital"),
    [checkoutItems]
  )
  const requiresCheckoutDetailsStep = !isAllDigital || isGuestCheckout
  const liveShippingErrors = useMemo(() => {
    if (isAllDigital) {
      return isGuestCheckout ? validateGuestContactFields(shipping) : []
    }
    return isGuestCheckout
      ? validateGuestShippingFields(shipping)
      : validateShippingFields(shipping)
  }, [isAllDigital, isGuestCheckout, shipping])

  const physicalItemsMissingShippingZone =
    hasPhysicalItemsMissingShippingZone(checkoutItems)
  const physicalItemsMissingShippingSnapshot =
    hasPhysicalItemsMissingShippingSnapshot(checkoutItems)
  const hasCompleteCartShippingSnapshot =
    !isAllDigital &&
    checkoutItems.length > 0 &&
    !physicalItemsMissingShippingSnapshot

  // Fetch merchant's published shipping zones (kind-30406)
  const { data: shippingOptionsData, isLoading: shippingOptionsIsLoading } =
    useQuery({
      queryKey: ["shippingOptions", selectedMerchant],
      queryFn: () => getShippingOptions(selectedMerchant!),
      enabled:
        !!selectedMerchant &&
        !isAllDigital &&
        !physicalItemsMissingShippingZone &&
        !hasCompleteCartShippingSnapshot,
      staleTime: 5 * 60 * 1000,
    })
  const merchantShippingOptions = shippingOptionsData ?? []
  const shippingOptionsAvailable = getCartShippingOptionsAvailable(
    checkoutItems,
    merchantShippingOptions
  )

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
  const merchantTrust = useMerchantTrustContext({
    merchantPubkey: selectedMerchant ?? null,
    viewerPubkey: signedBuyerPubkey,
  })
  const merchantProfile = merchantTrust.profile
  const merchantLud16 = merchantProfile?.lud16
  const merchantName = merchantTrust.merchantName
  const selectZapMode = useCallback(
    (nextMode: CheckoutZapMode) => {
      setZapMode(nextMode)
      setZapContent(
        buildDefaultZapContent({
          items: checkoutItems,
          merchantName,
          mode: nextMode,
        })
      )
      setZapContentEdited(false)
    },
    [checkoutItems, merchantName]
  )

  useEffect(() => {
    if (zapContentEdited || checkoutItems.length === 0) return
    setZapContent(
      buildDefaultZapContent({
        items: checkoutItems,
        merchantName,
        mode: selectedZapMode,
      })
    )
  }, [checkoutItems, merchantName, selectedZapMode, zapContentEdited])

  useEffect(() => {
    if (isGuestCheckout) return
    if (
      !publicZapPolicy.publicZapsAllowed &&
      isCheckoutPublicZapMode(zapMode)
    ) {
      setZapMode("private_checkout")
    }
  }, [isGuestCheckout, publicZapPolicy.publicZapsAllowed, zapMode])

  useEffect(() => {
    if (isGuestCheckout) return
    if (zapMode === "anonymous_public_zap" && !anonZapSignerAvailable) {
      setZapMode("public_zap_as_shopper")
      setZapContentEdited(false)
    }
  }, [anonZapSignerAvailable, isGuestCheckout, zapMode])

  useEffect(() => {
    if (!zapContentEditable && zapContentEdited) {
      setZapContentEdited(false)
    }
  }, [zapContentEditable, zapContentEdited])

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
    if (isGuestCheckout) return
    if (lnurlPayAvailable && !lnurlAllowsNostr) {
      setZapMode("private_checkout")
    }
  }, [isGuestCheckout, lnurlAllowsNostr, lnurlPayAvailable])

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

  const destinationEligibility = isAllDigital
    ? ({ eligible: true } as const)
    : getCartShippingDestinationEligibility(
        {
          country: shipping.country,
          postalCode: shipping.postalCode,
        },
        checkoutItems,
        merchantShippingOptions
      )

  const shippingCheckoutState: ShippingCheckoutState = getShippingCheckoutState(
    {
      isAllDigital,
      shippingLookupPending: shippingOptionsIsLoading,
      physicalItemsMissingShippingZone,
      shippingOptionsAvailable,
      destinationEligibility,
    }
  )

  const shippingEligibleForFastCheckout =
    shippingCheckoutState === "not_required" ||
    shippingCheckoutState === "allowed"

  // Merchant shipping-zone coverage recorded on the order lifecycle. Distinct
  // from buyer-input address validity (CND-127); `null` eligibility is unknown.
  const shippingZoneEligibility: OrderShippingZoneEligibility = isAllDigital
    ? "not_required"
    : destinationEligibility.eligible === true
      ? "eligible"
      : destinationEligibility.eligible === false
        ? "ineligible"
        : "unknown"

  const currentAddressValidity = computeAddressValidity(buildShippingAddress())
  const shippingRegionRequirement = getShippingRegionRequirement(
    shipping.country
  )
  const walletPaymentConstraint = getKnownWalletPaymentConstraint({
    amountMsats:
      pricingPreview.status === "ok" ? pricingPreview.totalMsats : null,
    balance: wallet.balance,
    budget: wallet.budget,
    methods: wallet.info?.methods,
    formatSatsAmount: (sats) => shopperPricing.formatSatsAmount(sats).primary,
  })
  const canTrySavedNwcWallet =
    !!wallet.connection &&
    wallet.status !== "unsupported" &&
    wallet.status !== "error" &&
    !walletPaymentConstraint
  const canAttemptLightningPayment = canTrySavedNwcWallet || weblnAvailable
  const requiresPublicZap = isCheckoutPublicZapMode(selectedZapMode)
  const lnurlReadyForSelectedPayment =
    getLnurlReadyForCheckoutPayment({
      visibility: zapVisibility,
      lnurlPayAvailable,
      lnurlAllowsNostr,
    }) &&
    (!requiresPublicZap || publicZapPolicy.publicZapsAllowed)
  const allowsManualLightningFallback =
    !!merchantLud16 && lnurlReadyForSelectedPayment
  const fastEligibilityInput = {
    walletPayCapable: canAttemptLightningPayment,
    merchantLud16,
    lnurlAllowsNostr: lnurlReadyForSelectedPayment,
    allowsManualFallback: allowsManualLightningFallback,
    requiresNostrZap: requiresPublicZap,
    pricingReady: pricingPreview.status === "ok",
    shippingEligible: shippingEligibleForFastCheckout,
    shippingState: shippingCheckoutState,
    shippingPriced: checkoutShippingCost.status !== "manual",
    addressValidForDirectPayment: currentAddressValidity.canDirectPay,
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
  const addressStatusMessage = (() => {
    if (currentAddressValidity.status === "not_required") {
      return "This cart does not require delivery details."
    }
    if (!currentAddressValidity.canSubmitOrder) {
      if (
        currentAddressValidity.issues.some((issue) => issue.code === "required")
      ) {
        return "Complete required delivery details before sending the order."
      }
      return (
        currentAddressValidity.issues[0]?.message ??
        "Fix address/contact details before sending the order."
      )
    }
    if (currentAddressValidity.warnings.length > 0) {
      return (
        currentAddressValidity.warnings[0]?.message ??
        "We could not fully validate this address locally. Review it carefully before paying; the merchant may need to confirm details."
      )
    }
    if (currentAddressValidity.level === "locality_consistent") {
      return "Address format and locality look consistent."
    }
    if (currentAddressValidity.level === "postal_region_consistent") {
      return "Address format and region look consistent."
    }
    return "Address format looks plausible. Deliverability is not verified."
  })()
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
        return currentAddressValidity.canDirectPay
          ? "Merchant shipping zone covers this destination."
          : "Merchant shipping zone may cover this destination, but address validity still needs attention."
      case "country_unsupported":
        return "Zap out is unavailable for this destination. You can still send the order first."
      case "postal_restricted":
        return "Zap out is unavailable for this postal code. You can still send the order first."
    }
  })()

  const visibleCheckoutStep: CheckoutStep =
    !requiresCheckoutDetailsStep && step === "shipping" ? "payment" : step

  function recordCheckoutStepResult(input: {
    checkoutMode: CheckoutTelemetryMode
    rail?: string
    status: string
    stepName: string
    amountSats?: number
  }): void {
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "checkout_step_result",
      properties: {
        ...getCheckoutTelemetryBaseProperties(
          checkoutItems,
          input.checkoutMode,
          input.amountSats
        ),
        rail: input.rail ?? "none",
        status: input.status,
        step: input.stepName,
      },
    })
  }

  function recordCheckoutSuccess(input: {
    checkoutMode: CheckoutTelemetryMode
    rail?: string
    status: string
    amountSats: number
  }): void {
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "checkout_success",
      properties: {
        ...getCheckoutTelemetryBaseProperties(
          checkoutItems,
          input.checkoutMode,
          input.amountSats
        ),
        rail: input.rail ?? "none",
        status: input.status,
      },
    })
  }

  function recordCheckoutResult(input: {
    amountSats?: number
    checkoutMode: CheckoutTelemetryMode
    rail?: string
    status: string
  }): void {
    recordBrowserTelemetryEvent({
      app: "market",
      eventName: "checkout_result",
      properties: {
        ...getCheckoutTelemetryBaseProperties(
          checkoutItems,
          input.checkoutMode,
          input.amountSats
        ),
        network: "browser",
        rail: input.rail ?? "none",
        status: input.status,
      },
    })
  }

  function validateCheckoutDetails(
    nextShipping: ShippingFormState
  ): ShippingValidationError[] {
    if (isAllDigital) {
      return isGuestCheckout ? validateGuestContactFields(nextShipping) : []
    }
    return isGuestCheckout
      ? validateGuestShippingFields(nextShipping)
      : validateShippingFields(nextShipping)
  }

  function updateShipping<K extends keyof ShippingFormState>(
    field: K,
    value: ShippingFormState[K]
  ): void {
    const normalizedValue =
      field === "phone"
        ? (sanitizeShippingPhoneInput(String(value)) as ShippingFormState[K])
        : value
    const next = { ...shipping, [field]: normalizedValue }
    setShipping(next)
    writeCheckoutShippingSession(next)
    setShippingErrors(validateCheckoutDetails(next))
    if (isValidationField(field)) {
      markShippingFieldTouched(field)
    }
  }

  function continueToPayment(): void {
    setShippingAttempted(true)
    setTouchedShippingFields(new Set(SHIPPING_VALIDATION_FIELDS))
    const errors = liveShippingErrors
    setShippingErrors(errors)
    const blockingMessage = getShippingStepBlockingMessage({
      hasUnpricedCheckoutItems,
      shippingErrors: errors,
    })
    if (blockingMessage) {
      recordCheckoutStepResult({
        checkoutMode: "checkout",
        status: "blocked",
        stepName: "shipping",
      })
      setError(blockingMessage)
      return
    }
    recordCheckoutStepResult({
      checkoutMode: "checkout",
      status: "success",
      stepName: "shipping",
    })
    setError(null)
    setStep("payment")
  }

  function markShippingFieldTouched(field: ShippingFieldKey): void {
    setTouchedShippingFields((current) => {
      if (current.has(field)) return current
      const next = new Set(current)
      next.add(field)
      return next
    })
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

  // Skip checkout details only when no shipping address or guest contact is needed.
  useEffect(() => {
    if (!requiresCheckoutDetailsStep && step === "shipping") {
      setStep("payment")
    }
  }, [requiresCheckoutDetailsStep, step])

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

  function buildBuyerNote(): string | undefined {
    return note.trim() || undefined
  }

  function buildGuestContact(): OrderGuestContact | undefined {
    if (!isGuestCheckout) return undefined
    const email = shipping.email.trim()
    const phone = shipping.phone.trim()
    if (!email || !phone) return undefined
    return { email, phone }
  }

  /**
   * Address validity gate (CND-127). Digital-only orders never require an
   * address. For physical orders we run the local, offline consistency check;
   * the caller blocks direct payment when the result is blocking.
   */
  function computeAddressValidity(
    addr: ShippingAddressSchema | undefined
  ): AddressValidityResult {
    if (isAllDigital || !addr) {
      return {
        status: "not_required",
        level: "not_required",
        issues: [],
        warnings: [],
        normalized: {
          name: "",
          street: "",
          city: "",
          postalCode: "",
          country: "",
        },
        canSubmitOrder: true,
        canDirectPay: true,
        profiledCountry: true,
      }
    }
    return validateAddressConsistency({
      name: addr.name,
      street: addr.street,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode,
      country: addr.country,
      email: shipping.email,
      phone: shipping.phone,
    })
  }

  function buildLifecycleItems(
    items: Array<{
      productId: string
      title?: string
      format: "physical" | "digital"
      quantity: number
      priceAtPurchase: number
      currency: string
      shippingCostSats?: number
      shippingOptionId?: string
      shippingOptionDTag?: string
      shippingCountryRules?: Array<{
        code: string
        restrictTo: string[]
        exclude: string[]
      }>
      sourcePrice?: {
        amount: number
        currency: string
        normalizedCurrency: string
      }
    }>
  ): OrderLifecycleItem[] {
    return items.map((item) => ({
      productId: item.productId,
      title: item.title,
      format: item.format,
      quantity: item.quantity,
      priceAtPurchase: item.priceAtPurchase,
      currency: item.currency,
      shippingCostSats: item.shippingCostSats,
      shippingOptionId: item.shippingOptionId,
      shippingOptionDTag: item.shippingOptionDTag,
      shippingCountryRules: item.shippingCountryRules?.map((rule) => ({
        code: rule.code,
        restrictTo: [...rule.restrictTo],
        exclude: [...rule.exclude],
      })),
      sourcePrice: item.sourcePrice
        ? {
            amount: item.sourcePrice.amount,
            currency: item.sourcePrice.currency,
            normalizedCurrency: item.sourcePrice.normalizedCurrency,
          }
        : undefined,
    }))
  }

  // ─── Order-first path (existing flow) ───────────────────────────────────

  async function placeOrder(): Promise<void> {
    if (!signedBuyerPubkey || !selectedMerchant || checkoutItems.length === 0)
      return
    if (paymentInFlightRef.current) return
    paymentInFlightRef.current = true

    let publishedOrderId: string | null = null
    let orderDelivered = false
    let orderTotalSats = total

    setError(null)
    setPaidNotice(null)
    setStep("signing")

    try {
      const checkoutPricing = await getFreshPricingIntent()
      if (checkoutPricing.status !== "ok") {
        throw new Error(checkoutPricing.reason)
      }
      orderTotalSats = checkoutPricing.totalSats
      recordCheckoutStepResult({
        checkoutMode: "order_first",
        status: "started",
        stepName: "order_submit",
        amountSats: orderTotalSats,
      })

      const orderId = crypto.randomUUID()
      publishedOrderId = orderId
      const currency = "SATS"
      const items = checkoutPricing.items

      const payload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey: signedBuyerPubkey,
        buyerIdentityKind: "signed_in" as const,
        items,
        subtotal: orderTotalSats,
        currency,
        shippingCostSats:
          checkoutPricing.shippingCost.status === "manual"
            ? undefined
            : checkoutPricing.shippingCost.totalSats,
        shippingCostStatus: checkoutPricing.shippingCost.status,
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
        ["amount", String(orderTotalSats)],
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
        publishBuyerOrderMessage(
          rumor,
          ndk,
          selectedMerchant,
          signedBuyerPubkey
        ),
        new Promise((resolve) => window.setTimeout(resolve, 900)),
      ])
      orderDelivered = true
      clearCheckoutShippingSession()
      const deliveryNotice = getDeliveryNotice(delivery, "Order")
      if (deliveryNotice) setPaidNotice(deliveryNotice)

      // Pay-later order: create a durable lifecycle so Orders shows it
      // immediately. Address validity is recorded but not a hard block here —
      // no funds move at checkout; the merchant requests payment later.
      const shippingAddress = buildShippingAddress()
      const addressValidity = computeAddressValidity(shippingAddress)
      await createOrderLifecycle({
        orderId,
        buyerPubkey: signedBuyerPubkey,
        buyerIdentityKind: "signed_in",
        merchantPubkey: selectedMerchant,
        checkoutMode: "pay_later",
        merchantLightningAddress: merchantLud16 ?? undefined,
        items: buildLifecycleItems(items),
        itemSubtotalSats: checkoutPricing.itemSubtotalSats,
        shippingCostSats:
          checkoutPricing.shippingCost.status === "manual"
            ? 0
            : checkoutPricing.shippingCost.totalSats,
        totalSats: orderTotalSats,
        totalMsats: orderTotalSats * 1000,
        currency: "SATS",
        shippingAddress: shippingAddress ?? undefined,
        contactNote: buildContactNote(),
        addressValidity: addressValidity.status as OrderAddressValidity,
        shippingZoneEligibility,
        orderDeliveryStatus: "sent",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        deliveryNotice: deliveryNotice ?? undefined,
      })

      cart.clearMerchant(selectedMerchant, { emitTelemetry: false })
      setSentOrderId(orderId)
      setShowSentGlow(true)
      setStep("sent")
      paymentInFlightRef.current = false
      recordCheckoutSuccess({
        amountSats: orderTotalSats,
        checkoutMode: "order_first",
        status: "order_sent",
      })
      recordCheckoutResult({
        amountSats: orderTotalSats,
        checkoutMode: "order_first",
        status: "success",
      })
      void navigate({
        to: "/orders",
        search: { order: orderId },
        replace: true,
      })
    } catch (e) {
      if (orderDelivered && publishedOrderId) {
        cart.clearMerchant(selectedMerchant, { emitTelemetry: false })
        setPaidNotice(
          "Your order was sent, but local order tracking could not be saved on this device. Check Orders or message the merchant before trying again."
        )
        setSentOrderId(publishedOrderId)
        setShowSentGlow(true)
        setStep("sent")
        paymentInFlightRef.current = false
        recordCheckoutSuccess({
          amountSats: orderTotalSats,
          checkoutMode: "order_first",
          status: "order_sent_local_tracking_failed",
        })
        recordCheckoutResult({
          amountSats: orderTotalSats,
          checkoutMode: "order_first",
          status: "success_local_tracking_failed",
        })
        void navigate({
          to: "/orders",
          search: { order: publishedOrderId },
          replace: true,
        })
        return
      }

      recordCheckoutStepResult({
        amountSats: orderTotalSats,
        checkoutMode: "order_first",
        status: "failed",
        stepName: "order_submit",
      })
      recordCheckoutResult({
        amountSats: orderTotalSats,
        checkoutMode: "order_first",
        status: "failed",
      })
      setError(e instanceof Error ? e.message : "Failed to send order")
      setStep("payment")
      paymentInFlightRef.current = false
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
   * Fast zap / direct payment. Publishes the order, creates the durable order
   * lifecycle record, hands payment to the route-independent service, and
   * navigates to `/orders?order=<id>` immediately (CND-122). Checkout is no
   * longer relied upon after navigation — the service drives invoice/pay/proof
   * and writes progress to the lifecycle record, which Orders renders live.
   *
   * A signed-in buyer with no automatic NWC/WebLN rail still proceeds: the order
   * is created and the service surfaces the invoice for an external wallet on
   * Orders (CND-120).
   */
  async function payNow(): Promise<void> {
    if (!selectedMerchant || checkoutItems.length === 0) return
    if (!signedBuyerPubkey && !isGuestCheckout) return
    const requestedCheckoutMode = selectedZapMode
    let publishedOrderId: string | null = null
    let publishedTotalSats: number | null = null
    let orderDelivered = false
    let guestOrderIdToClear: string | null = null

    const webLnAvailableNow = hasWebLN()
    if (webLnAvailableNow !== weblnAvailable)
      setWeblnAvailable(webLnAvailableNow)
    if (!merchantLud16) {
      recordCheckoutStepResult({
        checkoutMode: requestedCheckoutMode,
        rail: "lightning",
        status: "blocked",
        stepName: "direct_payment",
      })
      recordCheckoutResult({
        amountSats: total,
        checkoutMode: requestedCheckoutMode,
        rail: "lightning",
        status: "blocked",
      })
      setError("Merchant does not have a Lightning address.")
      return
    }
    // Synchronous re-entrancy guard: a double-clicked "Zap out" must not publish
    // the order twice (CND-89).
    if (paymentInFlightRef.current) return
    paymentInFlightRef.current = true

    setError(null)
    setPaidNotice(null)
    setStep("sending")
    recordCheckoutStepResult({
      amountSats: total,
      checkoutMode: requestedCheckoutMode,
      status: "started",
      stepName: "direct_payment",
    })

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

      // Address validity gate (CND-127): block zap-out only on hard input
      // errors. Local confidence gaps are shown as warnings that buyers can
      // consciously override.
      const shippingAddress = buildShippingAddress()
      const addressValidity = computeAddressValidity(shippingAddress)
      if (!addressValidity.canDirectPay) {
        throw new Error(
          addressValidity.issues[0]?.message ??
            "Enter a locally consistent delivery address before direct payment."
        )
      }

      const pricingIntent = await getFreshPricingIntent()
      if (pricingIntent.status !== "ok") {
        throw new Error(pricingIntent.reason)
      }
      const checkoutMode = requestedCheckoutMode
      const checkoutPricing = pricingIntent
      const effectiveZapContent =
        checkoutMode === "private_checkout" ? "" : zapContent
      const requiresPublicZap = isCheckoutPublicZapMode(checkoutMode)
      const finalWalletPaymentConstraint = getKnownWalletPaymentConstraint({
        amountMsats: checkoutPricing.totalMsats,
        balance: wallet.balance,
        budget: wallet.budget,
        methods: wallet.info?.methods,
        formatSatsAmount: (sats) =>
          shopperPricing.formatSatsAmount(sats).primary,
      })
      const shouldTrySavedNwcWallet =
        !isGuestCheckout &&
        !!wallet.connection &&
        wallet.status !== "unsupported" &&
        wallet.status !== "error" &&
        !finalWalletPaymentConstraint

      const orderId = crypto.randomUUID()
      publishedOrderId = orderId
      publishedTotalSats = checkoutPricing.totalSats
      const guestIdentity = signedBuyerPubkey
        ? null
        : createSessionGuestOrderSigningIdentity(orderId, selectedMerchant)
      guestOrderIdToClear = guestIdentity ? orderId : null
      const buyerPubkey = signedBuyerPubkey ?? guestIdentity?.pubkey
      if (!buyerPubkey) throw new Error("Buyer order identity is unavailable.")
      const buyerIdentityKind = guestIdentity
        ? ("guest_ephemeral" as const)
        : ("signed_in" as const)
      const guestContact = buildGuestContact()
      if (guestIdentity && !guestContact) {
        throw new Error("Phone and email are required for guest checkout.")
      }
      const orderCreatedAt = guestIdentity?.createdAt ?? Date.now()
      const currency = "SATS"
      const ndk = getNdk()
      const orderPayload = {
        id: orderId,
        merchantPubkey: selectedMerchant,
        buyerPubkey,
        buyerIdentityKind,
        items: checkoutPricing.items,
        subtotal: checkoutPricing.totalSats,
        currency,
        shippingCostSats: checkoutPricing.shippingCost.totalSats,
        shippingCostStatus: checkoutPricing.shippingCost.status,
        shippingAddress,
        guestContact,
        note: guestIdentity ? buildBuyerNote() : buildContactNote(),
        createdAt: orderCreatedAt,
        pricingQuote: checkoutPricing.quote,
      }

      const orderRumor = new NDKEvent(ndk)
      orderRumor.kind = EVENT_KINDS.ORDER
      orderRumor.created_at = Math.floor(Date.now() / 1000)
      orderRumor.tags = [
        ["p", selectedMerchant],
        ["type", "order"],
        ["order", orderId],
        ["amount", String(checkoutPricing.totalSats)],
        ["currency", currency],
      ]
      for (const item of checkoutPricing.items) {
        orderRumor.tags.push(["item", item.productId, String(item.quantity)])
        if (item.shippingOptionId) {
          orderRumor.tags.push(["shipping", item.shippingOptionId])
        }
      }
      orderRumor.tags = appendConduitClientTag(orderRumor.tags, "market")
      orderRumor.content = JSON.stringify(orderPayload)

      const orderDelivery = await publishBuyerOrderMessage(
        orderRumor,
        ndk,
        selectedMerchant,
        guestIdentity ?? buyerPubkey
      )
      orderDelivered = true
      clearCheckoutShippingSession()
      const orderDeliveryNotice = getDeliveryNotice(orderDelivery, "Order")

      const canAutoPay =
        !guestIdentity && (shouldTrySavedNwcWallet || webLnAvailableNow)
      // The order is now durably with the merchant. Persist the lifecycle so
      // Orders can render it immediately, then hand payment to the service.
      await createOrderLifecycle({
        orderId,
        createdAt: orderCreatedAt,
        buyerPubkey,
        buyerIdentityKind,
        merchantPubkey: selectedMerchant,
        checkoutMode: requiresPublicZap
          ? checkoutMode
          : canAutoPay
            ? checkoutMode
            : "external_wallet",
        publicZapSigner: getCheckoutPublicZapSigner(checkoutMode) ?? undefined,
        merchantLightningAddress: merchantLud16,
        items: buildLifecycleItems(checkoutPricing.items),
        itemSubtotalSats: checkoutPricing.itemSubtotalSats,
        shippingCostSats: checkoutPricing.shippingCost.totalSats,
        totalSats: checkoutPricing.totalSats,
        totalMsats: checkoutPricing.totalMsats,
        currency: "SATS",
        pricingQuote: checkoutPricing.quote
          ? {
              rate: checkoutPricing.quote.rate,
              fetchedAt: checkoutPricing.quote.fetchedAt,
              source: String(checkoutPricing.quote.source),
              fiatSource: checkoutPricing.quote.fiatSource
                ? String(checkoutPricing.quote.fiatSource)
                : undefined,
            }
          : undefined,
        zapContent: effectiveZapContent,
        // The merchant receives guest fulfillment/contact data inside the
        // encrypted order. Do not retain another plaintext copy in IndexedDB.
        shippingAddress: guestIdentity
          ? undefined
          : (shippingAddress ?? undefined),
        contactNote: guestIdentity ? undefined : buildContactNote(),
        guestContact: undefined,
        addressValidity: addressValidity.status as OrderAddressValidity,
        shippingZoneEligibility,
        orderDeliveryStatus: "sent",
        invoiceStatus: "not_requested",
        paymentStatus: "not_started",
        proofDeliveryStatus: "not_started",
        zapReceiptStatus: "not_applicable",
        deliveryNotice: orderDeliveryNotice ?? undefined,
      })

      cart.clearMerchant(selectedMerchant, { emitTelemetry: false })
      recordCheckoutSuccess({
        amountSats: checkoutPricing.totalSats,
        checkoutMode,
        rail: "lightning",
        status: "order_sent",
      })
      recordCheckoutResult({
        amountSats: checkoutPricing.totalSats,
        checkoutMode,
        rail: "lightning",
        status: "success",
      })

      // Fire-and-forget: the service continues after we navigate away. With no
      // automatic rail it stops at manual_required and the external-wallet QR
      // appears on Orders (CND-120).
      const serviceCtx: OrderPaymentContext = {
        orderId,
        buyerPubkey,
        buyerIdentity: guestIdentity ?? undefined,
        merchantPubkey: selectedMerchant,
        merchantLud16,
        zapMode: checkoutMode,
        zapContent: effectiveZapContent,
        totalSats: checkoutPricing.totalSats,
        totalMsats: checkoutPricing.totalMsats,
        items: checkoutPricing.items.map((item) => ({
          productAddress: item.productId,
          quantity: item.quantity,
        })),
        anonZapPreparation:
          checkoutMode === "anonymous_public_zap"
            ? {
                localPricing: checkoutPricing,
                destination: {
                  country: shippingAddress?.country ?? shipping.country,
                  postalCode:
                    shippingAddress?.postalCode ?? shipping.postalCode,
                },
              }
            : undefined,
        walletConnection: guestIdentity ? null : wallet.connection,
        tryNwc: !guestIdentity && shouldTrySavedNwcWallet,
        tryWebln: !guestIdentity,
        formatSatsAmount: (sats) =>
          shopperPricing.formatSatsAmount(sats).primary,
      }

      void runOrderPayment(serviceCtx)

      paymentInFlightRef.current = false
      void navigate({
        to: "/orders",
        search: { order: orderId },
        replace: true,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Payment failed"
      // Once the order is delivered, later failures (like local lifecycle
      // persistence) must not return the buyer to a retry path that republishes.
      if (orderDelivered && publishedOrderId) {
        const deliveredAmountSats = publishedTotalSats ?? total
        cart.clearMerchant(selectedMerchant, { emitTelemetry: false })
        setPaidNotice(
          "Your order was sent, but local order tracking could not be saved on this device. Check Orders or message the merchant before trying again."
        )
        setSentOrderId(publishedOrderId)
        setShowSentGlow(true)
        setStep("sent")
        paymentInFlightRef.current = false
        recordCheckoutSuccess({
          amountSats: deliveredAmountSats,
          checkoutMode: requestedCheckoutMode,
          rail: "lightning",
          status: "order_sent_local_tracking_failed",
        })
        recordCheckoutResult({
          amountSats: deliveredAmountSats,
          checkoutMode: requestedCheckoutMode,
          rail: "lightning",
          status: "success_local_tracking_failed",
        })
        void navigate({
          to: "/orders",
          search: { order: publishedOrderId },
          replace: true,
        })
        return
      }

      // Failure before the order reached the merchant. No order was published,
      // so a full retry can't create a duplicate.
      recordCheckoutStepResult({
        amountSats: total,
        checkoutMode: requestedCheckoutMode,
        status: "failed",
        stepName: "direct_payment",
      })
      recordCheckoutResult({
        amountSats: total,
        checkoutMode: requestedCheckoutMode,
        rail: "lightning",
        status: "failed",
      })
      if (!orderDelivered && guestOrderIdToClear) {
        clearSessionGuestOrderSigningIdentity(guestOrderIdToClear)
      }
      setError(message)
      setStep("payment")
      paymentInFlightRef.current = false
    }
  }

  // --- Full-screen transition states --------------------------------------
  // Note: `paying` and `paid` are NOT handled here. They render inline inside
  // the main checkout grid so the OrderSummary stays visible alongside the
  // PaymentTracker (CND-2A: replace dead-air interrupt with in-page tracker).

  // The fast-zap lightning-strike is `fixed inset-0 z-50` click feedback. It
  // must sit ABOVE whichever screen is mounted (including the "Sending your
  // order…" transition), so it renders alongside every early return rather
  // than only inside the main checkout grid — otherwise `setStep("sending")`
  // swaps the grid out before the storm ever mounts.
  const lightningOverlay = (
    <LightningStrikeOverlay
      open={overlayPlaying}
      onComplete={() => setOverlayPlaying(false)}
    />
  )

  if (authPending) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <section className="w-full max-w-xl rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <SpinnerIcon className="mx-auto h-8 w-8 animate-spin text-secondary-400" />
          <h1 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
            Restoring checkout
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
            Checking whether this browser has a connected signer before choosing
            the checkout path.
          </p>
        </section>
      </div>
    )
  }

  if (step === "sending") {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        {lightningOverlay}
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

  const errorFields = getValidationErrorFields(liveShippingErrors)

  function fieldError(field: ShippingFieldKey): string | undefined {
    return liveShippingErrors.find((e) => e.field === field)?.message
  }

  function fieldInvalid(field: ShippingFieldKey): boolean {
    return (
      (shippingAttempted || touchedShippingFields.has(field)) &&
      errorFields.includes(field)
    )
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
        includesShippingStep={requiresCheckoutDetailsStep}
        onShippingClick={
          visibleCheckoutStep === "payment" && requiresCheckoutDetailsStep
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
                  {isAllDigital ? "Contact" : "Shipping"}
                </h1>
                <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                  {isGuestCheckout
                    ? isAllDigital
                      ? "Add phone and email so the merchant can follow up on this guest order."
                      : "Add delivery and contact details so the merchant can fulfill this guest order."
                    : "Add delivery details for this order. Merchant follow-up and payment requests are sent through your Nostr account after the order is sent."}
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

                  {!isAllDigital && (
                    <>
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
                            onBlur={() => markShippingFieldTouched("firstName")}
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
                            onBlur={() => markShippingFieldTouched("lastName")}
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
                          onChange={(e) =>
                            updateShipping("street", e.target.value)
                          }
                          onBlur={() => markShippingFieldTouched("street")}
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
                          onChange={(e) =>
                            updateShipping("line2", e.target.value)
                          }
                          autoComplete="address-line2"
                          placeholder="Unit 4B"
                        />
                      </div>

                      {/* Postal / City / State */}
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="grid gap-1.5">
                          <Label htmlFor="ship-postal">
                            Postal/ZIP code{" "}
                            <span className="text-error">*</span>
                          </Label>
                          <Input
                            id="ship-postal"
                            value={shipping.postalCode}
                            onChange={(e) =>
                              updateShipping("postalCode", e.target.value)
                            }
                            onBlur={() =>
                              markShippingFieldTouched("postalCode")
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
                            onChange={(e) =>
                              updateShipping("city", e.target.value)
                            }
                            onBlur={() => markShippingFieldTouched("city")}
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
                          <Label htmlFor="ship-state">
                            {shippingRegionRequirement.label}
                            {shippingRegionRequirement.required && (
                              <>
                                {" "}
                                <span className="text-error">*</span>
                              </>
                            )}
                          </Label>
                          <Input
                            id="ship-state"
                            value={shipping.state}
                            onChange={(e) =>
                              updateShipping("state", e.target.value)
                            }
                            onBlur={() => markShippingFieldTouched("state")}
                            autoComplete="address-level1"
                            placeholder="TX"
                            aria-invalid={fieldInvalid("state")}
                            className={fieldClassName("state")}
                          />
                          {fieldInvalid("state") && (
                            <p className="text-xs text-error">
                              {fieldError("state")}
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Contact */}
                  <div className="border-t border-[var(--border)] pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-[var(--text-primary)]">
                        Contact
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {isGuestCheckout ? "required" : "(optional)"}
                      </div>
                    </div>
                    <div className="mt-4 grid gap-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-phone">
                          Phone
                          {isGuestCheckout && (
                            <>
                              {" "}
                              <span className="text-error">*</span>
                            </>
                          )}
                        </Label>
                        <Input
                          id="ship-phone"
                          type="tel"
                          inputMode="tel"
                          value={shipping.phone}
                          onChange={(e) =>
                            updateShipping("phone", e.target.value)
                          }
                          onBlur={() => markShippingFieldTouched("phone")}
                          autoComplete="tel"
                          placeholder="+1 555 123 4567"
                          aria-invalid={fieldInvalid("phone")}
                          aria-required={isGuestCheckout}
                          required={isGuestCheckout}
                          aria-describedby={getShippingPhoneDescribedBy(
                            fieldInvalid("phone")
                          )}
                          className={fieldClassName("phone")}
                        />
                        <p
                          id={SHIPPING_PHONE_HELP_ID}
                          className="text-xs text-[var(--text-muted)]"
                        >
                          {SHIPPING_PHONE_HELP_COPY}
                        </p>
                        {fieldInvalid("phone") && (
                          <p
                            id={SHIPPING_PHONE_ERROR_ID}
                            className="text-xs text-error"
                          >
                            {fieldError("phone")}
                          </p>
                        )}
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="ship-email">
                          Email
                          {isGuestCheckout && (
                            <>
                              {" "}
                              <span className="text-error">*</span>
                            </>
                          )}
                        </Label>
                        <Input
                          id="ship-email"
                          type="email"
                          value={shipping.email}
                          onChange={(e) =>
                            updateShipping("email", e.target.value)
                          }
                          onBlur={() => markShippingFieldTouched("email")}
                          autoComplete="email"
                          placeholder="jane@example.com"
                          aria-invalid={fieldInvalid("email")}
                          aria-required={isGuestCheckout}
                          aria-describedby={
                            fieldInvalid("email")
                              ? SHIPPING_EMAIL_ERROR_ID
                              : undefined
                          }
                          required={isGuestCheckout}
                          className={fieldClassName("email")}
                        />
                        {fieldInvalid("email") && (
                          <p
                            id={SHIPPING_EMAIL_ERROR_ID}
                            className="text-xs text-error"
                          >
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
                      <div className="grid gap-2">
                        <div className="flex items-start gap-2">
                          {!currentAddressValidity.canSubmitOrder ? (
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
                          ) : currentAddressValidity.warnings.length > 0 ? (
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                          ) : (
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                          )}
                          <div>
                            <div className="font-medium text-[var(--text-primary)]">
                              Address/contact
                            </div>
                            <div>{addressStatusMessage}</div>
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          {shippingCheckoutState === "loading" ? (
                            <SpinnerIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-secondary-400" />
                          ) : (shippingCheckoutState === "not_required" ||
                              shippingCheckoutState === "allowed") &&
                            currentAddressValidity.canDirectPay ? (
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                          ) : (
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                          )}
                          <div>
                            <div className="font-medium text-[var(--text-primary)]">
                              Merchant shipping zone
                            </div>
                            <div>{shippingStatusMessage}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <Button
                    className="mt-2 h-11 w-full text-sm"
                    onClick={continueToPayment}
                  >
                    Continue to Send Order
                  </Button>

                  <p
                    className="text-xs leading-6 text-[var(--text-muted)]"
                    role={isGuestCheckout ? "note" : undefined}
                  >
                    {isGuestCheckout
                      ? "Your order details will be sent privately with a temporary key that this client uses only for this order and its payment report. Keep this tab open until the payment is reported; merchant follow-up uses the required phone and email contact details."
                      : "Your order details will be sent to the merchant through your signed Nostr account so they can follow up with payment and fulfillment."}
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
                  {isGuestCheckout
                    ? "Send the order with a temporary guest key, then pay the Lightning invoice with your wallet."
                    : fastEligible
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
                        shipping address is needed.{" "}
                        {isGuestCheckout
                          ? "The merchant will use your required phone and email contact details for follow-up."
                          : "Merchant follow-up happens through the order thread after the order is sent."}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <CheckoutMerchantIdentityLink
                merchantPubkey={selectedMerchant!}
                merchantProfile={merchantProfile}
                merchantName={merchantName}
                className="lg:hidden"
              />

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
                        : isGuestCheckout
                          ? selectedZapMode === "anonymous_public_zap"
                            ? "Conduit will deliver the private order with a guest key and request an Anon-signed public zap invoice. Payment stays in your Lightning wallet."
                            : "Conduit will deliver the private order with a guest key and request a Lightning invoice. Payment stays in your Lightning wallet."
                          : walletPaymentConstraint
                            ? selectedZapMode === "anonymous_public_zap"
                              ? "Conduit will deliver the private order and request an Anon-signed public zap invoice. Your connected wallet will be skipped for this total."
                              : selectedZapMode === "public_zap_as_shopper"
                                ? "Conduit will deliver the order and request a shopper-signed public zap invoice. Your connected wallet will be skipped for this total."
                                : "Conduit will deliver the order and request a private LNURL invoice. Your connected wallet will be skipped for this total."
                            : selectedZapMode === "anonymous_public_zap"
                              ? "Conduit will deliver the private order, request an Anon-signed public zap invoice, and try your connected wallet first. If that path is unreachable before funds move, you can still pay the invoice with another Lightning wallet."
                              : selectedZapMode === "public_zap_as_shopper"
                                ? "Conduit will deliver the order, request a shopper-signed public zap invoice, and try your connected wallet first. If that path is unreachable before funds move, you can still pay the invoice with another Lightning wallet."
                                : "Conduit will deliver the order, request a private LNURL invoice, and try your connected wallet first. If that path is unreachable before funds move, you can still pay the invoice with another Lightning wallet."}
                    </p>
                    {!isGuestCheckout &&
                      wallet.connection &&
                      !pricingOnlyFastCheckoutBlocker && (
                        <CheckoutWalletReadiness
                          balance={wallet.balance}
                          budget={wallet.budget}
                          constraint={walletPaymentConstraint}
                          formatSats={(sats) =>
                            shopperPricing.formatSatsAmount(sats).primary
                          }
                        />
                      )}
                  </div>
                )}

                {!isGuestCheckout && !lnurlProbing && fastEligible && (
                  <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                      Zap visibility
                    </div>
                    <div className="mt-4 grid gap-2 lg:grid-cols-3">
                      <button
                        type="button"
                        aria-pressed={zapMode === "anonymous_public_zap"}
                        disabled={
                          !anonZapSignerAvailable ||
                          !lnurlAllowsNostr ||
                          !publicZapPolicy.publicZapsAllowed
                        }
                        onClick={() => selectZapMode("anonymous_public_zap")}
                        className={[
                          "rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                          zapMode === "anonymous_public_zap"
                            ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] text-[var(--text-primary)]"
                            : !anonZapSignerAvailable ||
                                !lnurlAllowsNostr ||
                                !publicZapPolicy.publicZapsAllowed
                              ? "cursor-not-allowed border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] opacity-70"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        ].join(" ")}
                      >
                        <span className="block font-medium">
                          Anonymous public zap
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                          {anonZapModeDescription}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={zapMode === "public_zap_as_shopper"}
                        disabled={
                          !lnurlAllowsNostr ||
                          !publicZapPolicy.publicZapsAllowed
                        }
                        onClick={() => selectZapMode("public_zap_as_shopper")}
                        className={[
                          "rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                          zapMode === "public_zap_as_shopper"
                            ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)] text-[var(--text-primary)]"
                            : !lnurlAllowsNostr ||
                                !publicZapPolicy.publicZapsAllowed
                              ? "cursor-not-allowed border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] opacity-70"
                              : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                        ].join(" ")}
                      >
                        <span className="block font-medium">
                          Public zap as shopper
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">
                          {publicZapModeDescription}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={zapMode === "private_checkout"}
                        onClick={() => selectZapMode("private_checkout")}
                        className={[
                          "rounded-xl border px-4 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                          zapMode === "private_checkout"
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
                    {requiresPublicZap && (
                      <div className="mt-4 grid gap-1.5">
                        {zapContentEditable ? (
                          <>
                            <Label htmlFor="zap-content">
                              Public zap comment
                            </Label>
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
                              Public zap receipts can expose this comment.
                              Shipping address, contact details, private notes,
                              wallet data, payment evidence, and order IDs are
                              never added here.
                            </p>
                          </>
                        ) : (
                          <>
                            <span className="text-sm font-medium text-[var(--text-primary)]">
                              Public zap message
                            </span>
                            <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
                              {zapContent}
                            </p>
                            <p className="text-xs leading-6 text-[var(--text-muted)]">
                              {selectedZapMode === "anonymous_public_zap"
                                ? "Anonymous zaps always use this fixed item-count message."
                                : "The merchant requires the generic item-count message for this cart."}
                            </p>
                          </>
                        )}
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
                        {isGuestCheckout
                          ? "2. Pay the invoice shown here and send the receipt before closing this tab."
                          : "2. The merchant reviews the order and replies with payment details."}
                      </li>
                      <li>
                        {isGuestCheckout
                          ? "3. The merchant follows up using the phone and email contact details submitted at checkout."
                          : "3. You track order updates from the merchant in your order history."}
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
                  <div
                    role="alert"
                    aria-live="polite"
                    className="mt-5 rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error"
                  >
                    {error}
                  </div>
                )}

                {/* Action buttons */}
                <div className="mt-6 flex flex-wrap gap-3">
                  {fastEligible && (
                    <Button
                      className="h-11 px-5 text-sm"
                      onClick={() => {
                        if (canAttemptLightningPayment) {
                          setOverlayPlaying(true)
                        }
                        void payNow()
                      }}
                    >
                      <LightningIcon className="h-4 w-4" />
                      {isGuestCheckout
                        ? "Send order and show invoice"
                        : walletPaymentConstraint && !weblnAvailable
                          ? "Send order and show invoice"
                          : "Zap out"}
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

                  {isGuestCheckout && !fastEligible && (
                    <Button
                      variant={
                        pricingOnlyFastCheckoutBlocker ? "outline" : "primary"
                      }
                      className="h-11 px-5 text-sm"
                      onClick={() => setConnectOpen(true)}
                    >
                      <KeyRound className="h-4 w-4" />
                      Connect signer to send order
                    </Button>
                  )}

                  {!isGuestCheckout && (
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
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <OrderSummary
          items={checkoutItems}
          merchantPubkey={selectedMerchant!}
          btcUsdRate={btcUsdRate}
          formatPrice={shopperPricing.formatPrice}
        />
      </div>

      {lightningOverlay}
      <SignerSwitch
        open={connectOpen}
        onOpenChange={setConnectOpen}
        hideTrigger
      />
    </div>
  )
}
