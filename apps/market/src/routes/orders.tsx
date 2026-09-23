import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  appendConduitClientTag,
  clearProtectedReadAuthenticationSuppression,
  config,
  db,
  encodeEventMarketNaddr,
  deriveProtectedReadPresentationState,
  EVENT_KINDS,
  formatNpub,
  formatPubkey,
  getNdk,
  getOrderLifecycle,
  getProductImageCandidates,
  getOrderPublicZapSigner,
  getWalletDisplayLabels,
  getWalletNetworkFromLightningConfig,
  hasWebLN,
  listOrderLifecycles,
  ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
  pruneExpiredGuestOrderData,
  prepareProtectedReadRefreshState,
  patchOrderLifecycle,
  pubkeyToNpub,
  replaceOrderPaymentTarget,
  retryOrderRelayDelivery,
  resolveWalletPaymentInstance,
  selectProtectedReadRows,
  useAuth,
  useProfile,
  useProfiles,
  type CommercePriceLike,
  type OrderLifecycle,
  type OrderPaymentTarget,
  type ShopperPriceDisplay,
  type ShopperPriceDisplayOptions,
} from "@conduit/core"
import { reportCommerceGmvEstimate } from "@conduit/core/commerce-gmv"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  OrderMessagesWidget,
  ProtectedInboxNotice,
  SearchInput,
  SignerRecoveryNotice,
  RefreshChip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  StatusStepper,
} from "@conduit/ui"
import {
  Check,
  ChevronRight,
  LoaderCircle,
  MapPin,
  MessageCircle,
  ReceiptText,
  RotateCw,
  ShoppingBag,
} from "lucide-react"
import { ConversationProfilePicture } from "../components/ConversationProfilePicture"
import { useCart } from "../hooks/useCart"
import { groupCartPurchases } from "../lib/cart-model"
import { CopyButton } from "../components/CopyButton"
import { ExternalWalletPanel } from "../components/ExternalWalletPanel"
import { EventActorName } from "../components/EventActorIdentity"
import { getMerchantDisplayName } from "../components/MerchantIdentity"
import {
  PAYMENT_TARGET_SELECT_TRIGGER_CLASS_NAME,
  PaymentTargetSelectContent,
  PaymentTargetSelectValue,
} from "../components/PaymentTargetSelectContent"
import {
  SparkFeeApprovalDialog,
  useSparkFeeApproval,
} from "../components/SparkFeeApprovalDialog"
import {
  fetchBuyerConversations,
  fetchCachedBuyerConversations,
  type BuyerConversation,
} from "../lib/orderConversations"
import { fetchStoreProducts } from "../lib/storeProducts"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { useWallets } from "../hooks/useWallets"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  canClaimManualInvoiceReport,
  deriveManualInvoiceAccess,
  deriveOrderHeaderStatus,
  getOrderFilterPhase,
  getOrderPaymentFailureDetail,
  getOrderPaymentMethodLabel,
  isBuyerOrderPaid,
  isZeroCostPickupOrder,
  type OrderHeaderStatus,
  type OrderViewModel,
} from "../lib/order-view"
import { verifyPickupCartFreshness } from "../lib/event-market-adapter"
import {
  assertCartPickupHandlerReady,
  getOrganizerPickupClaimCode,
  getPickupHandoffSummary,
} from "../lib/pickup-handoff"
import { getNwcPaymentReadiness } from "../lib/wallet-payment-coordinator"
import {
  authorizeCheckoutWithAnonSigner,
  signAuthorizedAnonZapCheckout,
} from "../lib/anon-zap-signer"
import {
  canObserveOrderPublicZapReceipt,
  getOrderPaymentState,
  isOrderPaymentRunning,
  isMerchantInvoicePaymentActionBound,
  observeOrderPublicZapReceipt,
  prepareMerchantInvoicePaymentAction,
  resendOrderProof,
  runOrderPrivateFallback,
  runOrderPayment,
  runOrderPaymentWithUpdatedAddress,
  runOrderPaymentWithRenewedInvoice,
  submitExternalPaymentProof,
  subscribeOrderPayment,
  validateMerchantInvoicePaymentAction,
  type OrderPaymentContext,
} from "../lib/order-payment-service"
import {
  checkOrderPaymentAddressUpdate,
  type OrderPaymentAddressUpdate,
} from "../lib/order-payment-address"
import {
  getNextOrderPaymentLeaseExpiry,
  reconcileOrderPaymentForDisplay,
} from "../lib/order-payment-recovery"
import {
  getEventActorIdentityView,
  normalizeEventActorPubkey,
} from "../lib/event-actor-identity"

type PriceFormatter = (
  price: CommercePriceLike,
  options?: ShopperPriceDisplayOptions
) => ShopperPriceDisplay
import {
  clearSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "../lib/guest-order-identity"
import {
  doesCartMatchOrderAttempt,
  forgetCheckoutOrderAttempt,
  hasCheckoutPaymentProgress,
  requiresAcceptedOrderPaymentContinuation,
} from "../lib/checkout-order-attempt"
import {
  doesAuthorizedAnonZapPricingMatchOrder,
  type CheckoutZapMode,
} from "../lib/checkout-payment"
import { publishBuyerOrderMessage } from "../lib/order-publish"
import {
  getCheckoutPaymentTargetOptions,
  getCheckoutPaymentTargetValue,
} from "../lib/checkout-payment-target"

type OrdersSearch = {
  order?: string
  focus?: "payment"
}

const ORDERS_SEARCH_DEFAULT: OrdersSearch = {}

function getRetryZapMode(lifecycle: OrderLifecycle): CheckoutZapMode {
  if (
    lifecycle.checkoutMode === "anonymous_public_zap" ||
    lifecycle.checkoutMode === "public_zap_as_shopper" ||
    lifecycle.checkoutMode === "private_checkout"
  ) {
    return lifecycle.checkoutMode
  }
  const signer =
    lifecycle.publicZapSigner ?? getOrderPublicZapSigner(lifecycle.checkoutMode)
  if (signer === "anon") return "anonymous_public_zap"
  if (signer === "shopper") return "public_zap_as_shopper"
  return "private_checkout"
}

export const Route = createFileRoute("/orders")({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const order = search.order
    if (typeof order !== "string" || order.length === 0) {
      return ORDERS_SEARCH_DEFAULT
    }
    return search.focus === "payment" ? { order, focus: "payment" } : { order }
  },
  component: OrdersPage,
})

const TONE_VARIANT: Record<
  OrderHeaderStatus["tone"],
  "warning" | "success" | "info" | "error" | "neutral"
> = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  neutral: "neutral",
}

/** A merged order: durable local lifecycle and/or relay conversation. */
interface OrderRow {
  orderId: string
  merchantPubkey: string
  lifecycle?: OrderLifecycle
  conversation?: BuyerConversation
  vm: OrderViewModel
  headerStatus: OrderHeaderStatus
  updatedAt: number
}

function formatOrderTotal(
  vm: OrderViewModel,
  formatSats: (sats: number) => string
): string {
  return isZeroCostPickupOrder(vm) ? "Free · 0 sats" : formatSats(vm.totalSats!)
}

function OrderHeaderPill({ status }: { status: OrderHeaderStatus }) {
  const showCustomSpinner = status.showSpinner

  return (
    <span className="inline-flex items-center gap-2">
      <StatusPill
        variant={TONE_VARIANT[status.tone]}
        className="capitalize"
        noIcon={showCustomSpinner}
      >
        {showCustomSpinner ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : null}
        {status.primaryLabel}
      </StatusPill>
      <span className="text-xs text-[var(--text-secondary)]">
        · {status.detailLabel}
      </span>
    </span>
  )
}

function StatusNotice({
  variant,
  title,
  detail,
  children,
}: {
  variant: "warning" | "success" | "info" | "error" | "neutral"
  title: string
  detail?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill variant={variant}>{title}</StatusPill>
          {detail ? (
            <span className="text-sm text-[var(--text-secondary)]">
              {detail}
            </span>
          ) : null}
        </div>
        <div>{children}</div>
      </div>
    </section>
  )
}

function MerchantAvatar({
  pubkey,
  name,
  picture,
}: {
  pubkey: string
  name: string
  picture?: string
}) {
  return (
    <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
      <ConversationProfilePicture
        src={picture}
        alt={name || formatNpub(pubkey, 8)}
      />
    </div>
  )
}

function OrderListCard({
  row,
  merchantName,
  merchantPicture,
  active,
  formatSats,
  onClick,
}: {
  row: OrderRow
  merchantName: string
  merchantPicture?: string
  active: boolean
  formatSats: (sats: number) => string
  onClick: () => void
}) {
  const itemTitle = row.vm.items[0]?.displayTitle ?? "Order"
  return (
    <button
      type="button"
      onClick={onClick}
      data-order-id={row.orderId}
      className={[
        "w-full rounded-[1.1rem] border p-3 text-left transition-[border-color,background-color]",
        active
          ? // Selected: subtle purple wash from the primary token.
            "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <MerchantAvatar
          pubkey={row.merchantPubkey}
          name={merchantName}
          picture={merchantPicture}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {merchantName}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {new Date(row.updatedAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
            {itemTitle}
          </div>
          {typeof row.vm.totalSats === "number" && (
            <div className="mt-0.5 text-sm font-medium text-secondary-300">
              {formatOrderTotal(row.vm, formatSats)}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <StatusPill
              variant={TONE_VARIANT[row.headerStatus.tone]}
              className="capitalize"
              noIcon={row.headerStatus.showSpinner}
            >
              {row.headerStatus.showSpinner ? (
                <LoaderCircle className="h-3 w-3 animate-spin" />
              ) : null}
              {row.headerStatus.primaryLabel}
            </StatusPill>
            {row.headerStatus.actionNeeded && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

function MobileOrderFilterPills({
  tab,
  onChange,
}: {
  tab: PhaseTab
  onChange: (tab: PhaseTab) => void
}) {
  const options: Array<{ value: PhaseTab; label: string }> = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "in_progress", label: "In Progress" },
    { value: "completed", label: "Completed" },
  ]

  return (
    <div className="py-1">
      <div
        className="flex gap-2 overflow-x-auto overscroll-x-contain px-1 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage:
            "linear-gradient(to right, black 0, black calc(100% - 12px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, black 0, black calc(100% - 12px), transparent 100%)",
        }}
      >
        {options.map((option) => {
          const active = tab === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={[
                "shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-[border-color,background-color,color]",
                active
                  ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_12%,transparent)] text-[var(--text-primary)]"
                  : "border-[var(--border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,transparent)] text-[var(--text-secondary)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              ].join(" ")}
              aria-pressed={active}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MobileOrdersScroller({
  rows,
  selectedOrderId,
  merchantName,
  formatSats,
  onSelect,
}: {
  rows: OrderRow[]
  selectedOrderId: string | null
  merchantName: (pk: string) => string
  formatSats: (sats: number) => string
  onSelect: (orderId: string) => void
}) {
  const cardRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  // Keep the natural order; scroll the selected order into view instead.
  useEffect(() => {
    if (!selectedOrderId) return
    cardRefs.current.get(selectedOrderId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    })
  }, [selectedOrderId])

  return (
    <section className="min-w-0 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
      {rows.length === 0 ? (
        <div className="rounded-[1.25rem] border border-dashed border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
          No orders match this filter.
        </div>
      ) : (
        <div
          className="min-w-0 overflow-x-auto overscroll-x-contain touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            maskImage:
              "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, black 0, black calc(100% - 20px), transparent 100%)",
          }}
        >
          <div className="flex min-w-max gap-3 pb-1 pr-14 snap-x snap-mandatory">
            {rows.map((row) => {
              const active = row.orderId === selectedOrderId
              return (
                <button
                  key={row.orderId}
                  type="button"
                  ref={(el) => {
                    if (el) cardRefs.current.set(row.orderId, el)
                    else cardRefs.current.delete(row.orderId)
                  }}
                  onClick={() => onSelect(row.orderId)}
                  className={[
                    "w-[16.5rem] shrink-0 snap-start rounded-[1.25rem] border p-4 text-left transition-[border-color,background-color,transform]",
                    active
                      ? "border-[color-mix(in_srgb,var(--primary-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_7%,transparent)]"
                      : "border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {merchantName(row.merchantPubkey)}
                      </div>
                      <div className="mt-1 truncate text-sm text-[var(--text-secondary)]">
                        {row.vm.items[0]?.displayTitle ?? "Order"}
                      </div>
                    </div>
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <StatusPill
                      variant={TONE_VARIANT[row.headerStatus.tone]}
                      className="capitalize"
                      noIcon={row.headerStatus.showSpinner}
                    >
                      {row.headerStatus.showSpinner ? (
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                      ) : null}
                      {row.headerStatus.primaryLabel}
                    </StatusPill>
                    {typeof row.vm.totalSats === "number" && (
                      <span className="text-xs font-medium text-secondary-300">
                        {formatOrderTotal(row.vm, formatSats)}
                      </span>
                    )}
                    {row.headerStatus.actionNeeded ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

function OrderItemsSection({
  vm,
  productsById,
  formatPrice,
  formatSats,
}: {
  vm: OrderViewModel
  productsById: Map<
    string,
    Awaited<ReturnType<typeof fetchStoreProducts>>["data"][number]
  >
  formatPrice: PriceFormatter
  formatSats: (sats: number) => string
}) {
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <ShoppingBag className="h-4 w-4" /> Items
      </h3>
      <div className="mt-3 space-y-3">
        {vm.items.map((item, index) => {
          const product = productsById.get(item.productId)
          const image = product
            ? getProductImageCandidates(product)[0]
            : undefined
          const price = formatPrice(
            {
              price: item.priceAtPurchase,
              currency: item.currency,
              priceSats:
                item.currency === "SATS" ? item.priceAtPurchase : undefined,
              sourcePrice: item.sourcePrice,
            },
            {
              allowZero:
                isZeroCostPickupOrder(vm) &&
                item.fulfillment?.type === "pickup",
            }
          )
          return (
            <div
              key={`${item.productId}-${index}`}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]">
                  {image ? (
                    <img
                      src={image.url}
                      alt={image.alt ?? product?.title ?? item.displayTitle}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="text-[var(--text-primary)]">
                    {product?.title ?? item.displayTitle}
                  </div>
                  {(item.selectedSpecifications?.length ?? 0) > 0 ? (
                    <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                      {item.selectedSpecifications
                        ?.map(
                          (specification) =>
                            `${specification.key}: ${specification.value}`
                        )
                        .join(" · ")}
                    </div>
                  ) : null}
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    Qty {item.quantity}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right text-[var(--text-secondary)]">
                <div>{price.primary}</div>
                {price.secondary && (
                  <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                    {price.secondary}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {typeof vm.totalSats === "number" ? (
        <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4 text-sm">
          <span className="font-medium text-[var(--text-secondary)]">
            Total
          </span>
          <span className="text-base font-semibold text-[var(--text-primary)]">
            {formatOrderTotal(vm, formatSats)}
          </span>
        </div>
      ) : null}
    </section>
  )
}

function OrderTimeline({
  vm,
  formatSats,
}: {
  vm: OrderViewModel
  formatSats: (sats: number) => string
}) {
  const rows = useMemo(
    () => buildOrderTimeline(vm, formatSats),
    [formatSats, vm]
  )
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        Order progress
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Here's where your order stands.
      </p>
      <div className="mt-5">
        <StatusStepper rows={rows} ariaLabel="Order progress" />
      </div>
    </section>
  )
}

function OrderDetail({
  row,
  buyerPubkey,
  guestIdentity,
  accountPubkey,
  authenticatedPubkey,
  paymentFocused = false,
  signerReady,
}: {
  row: OrderRow
  buyerPubkey: string
  guestIdentity?: GuestOrderSigningIdentity | null
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  paymentFocused?: boolean
  signerReady: boolean
}) {
  const { vm, headerStatus } = row
  const currentViewRef = useRef(vm)
  const viewMountedRef = useRef(false)
  useLayoutEffect(() => {
    viewMountedRef.current = true
    currentViewRef.current = vm
  }, [vm])
  useLayoutEffect(
    () => () => {
      viewMountedRef.current = false
      currentViewRef.current = { ...currentViewRef.current, orderId: "" }
    },
    []
  )
  const { authGeneration, isAuthGenerationCurrent, isGuestGenerationCurrent } =
    useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const shouldContinueBuyerSession = () =>
    guestIdentity
      ? isGuestGenerationCurrent(authGeneration)
      : isAuthGenerationCurrent(authGeneration)
  const actionsReady = !!guestIdentity || signerReady
  const shouldContinueAccountRead = () =>
    authGenerationRef.current === authGeneration
  const zeroCostPickupOrder = isZeroCostPickupOrder(vm)
  const cart = useCart()
  const wallets = useWallets()
  const shopperPricing = useShopperPricing()
  const formatSats = (sats: number) =>
    shopperPricing.formatSatsAmount(sats).primary
  const { data: profile } = useProfile(row.merchantPubkey, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    maxUnresolvedRefetches: 1,
  })
  const merchantName = getMerchantDisplayName(profile, row.merchantPubkey)
  const eventActorPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          vm.pickupFulfillments.map(
            (pickup) => getPickupHandoffSummary(pickup).handlerPubkey
          )
        )
      ),
    [vm.pickupFulfillments]
  )
  const eventActorProfiles = useProfiles(eventActorPubkeys, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    enabled: eventActorPubkeys.length > 0,
    priority: "visible",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 2,
  })
  const eventActorIdentity = useCallback(
    (pubkey: string) =>
      getEventActorIdentityView({
        pubkey,
        profile: eventActorProfiles.data[normalizeEventActorPubkey(pubkey)],
      }),
    [eventActorProfiles.data]
  )
  const [busy, setBusy] = useState(false)
  const [privateFallbackOpen, setPrivateFallbackOpen] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [paymentAddressUpdate, setPaymentAddressUpdate] =
    useState<OrderPaymentAddressUpdate | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [replyText, setReplyText] = useState("")
  const persistedRetryTarget = row.lifecycle?.paymentTarget ?? null
  const persistedRetryTargetType = persistedRetryTarget?.type ?? null
  const persistedRetryWalletId =
    persistedRetryTarget?.type === "wallet"
      ? persistedRetryTarget.walletId
      : null
  const persistedRetryProviderId =
    persistedRetryTarget?.type === "wallet"
      ? persistedRetryTarget.providerId
      : null
  const [retryTarget, setRetryTarget] = useState<OrderPaymentTarget | null>(
    persistedRetryTarget
  )
  const [priorInvoiceIndex, setPriorInvoiceIndex] = useState("0")
  const sparkFeeApproval = useSparkFeeApproval()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!actionsReady && sparkFeeApproval.quote) sparkFeeApproval.decline()
  }, [actionsReady, sparkFeeApproval])

  useEffect(() => {
    if (
      persistedRetryTargetType === "wallet" &&
      persistedRetryWalletId !== null &&
      persistedRetryProviderId !== null
    ) {
      setRetryTarget({
        type: "wallet",
        walletId: persistedRetryWalletId,
        providerId: persistedRetryProviderId,
      })
      return
    }
    if (persistedRetryTargetType === "manual") {
      setRetryTarget({ type: "manual" })
      return
    }
    if (persistedRetryTargetType === "webln") {
      setRetryTarget({ type: "webln" })
      return
    }
    setRetryTarget(null)
  }, [
    persistedRetryProviderId,
    persistedRetryTargetType,
    persistedRetryWalletId,
    vm.orderId,
  ])

  const productsQuery = useQuery({
    queryKey: [
      "selected-order-products",
      row.merchantPubkey,
      authenticatedPubkey ?? "guest",
    ],
    enabled: !!row.merchantPubkey,
    queryFn: ({ signal }) =>
      fetchStoreProducts(
        row.merchantPubkey,
        accountPubkey,
        authenticatedPubkey,
        () => !signal.aborted && shouldContinueAccountRead()
      ),
  })
  const productsById = useMemo(() => {
    const map = new Map<
      string,
      Awaited<ReturnType<typeof fetchStoreProducts>>["data"][number]
    >()
    for (const product of productsQuery.data?.data ?? [])
      map.set(product.id, product)
    return map
  }, [productsQuery.data])

  const walletNetwork = getWalletNetworkFromLightningConfig(
    config.lightningNetwork
  )
  const eligibleWallets = wallets.wallets.filter(
    (candidate) =>
      candidate.network === walletNetwork &&
      candidate.capabilities.includes("pay_invoice")
  )
  const eligibleWalletDisplayLabels = getWalletDisplayLabels(eligibleWallets)
  const weblnAvailable = !guestIdentity && hasWebLN()
  const retryTargetOptions = getCheckoutPaymentTargetOptions({
    eligibleWallets,
    selectedTarget: retryTarget ?? { type: "manual" },
    weblnAvailable,
  })
  const retryTargetValue = retryTarget
    ? getCheckoutPaymentTargetValue(retryTarget)
    : ""
  const retryWalletTarget = retryTarget?.type === "wallet" ? retryTarget : null
  const paymentWallet = resolveWalletPaymentInstance(wallets.wallets, {
    walletId: retryWalletTarget?.walletId,
    providerId: retryWalletTarget?.providerId,
    network: walletNetwork,
  })
  const retryWalletTargetIsStale =
    retryWalletTarget !== null && paymentWallet === null
  const nwcSnapshot =
    paymentWallet?.providerId === "nwc"
      ? wallets.nwcSnapshots[paymentWallet.id]
      : null
  const nwcReadiness =
    paymentWallet?.providerId === "nwc" && nwcSnapshot
      ? getNwcPaymentReadiness({
          snapshot: nwcSnapshot,
          walletNetwork: paymentWallet.network,
          configuredNetwork: walletNetwork,
        })
      : null
  const canTryNwc =
    !guestIdentity &&
    paymentWallet?.providerId === "nwc" &&
    nwcReadiness?.ready === true
  const canTrySpark =
    !guestIdentity &&
    paymentWallet?.providerId === "spark" &&
    wallets.runtime[paymentWallet.id]?.status === "ready"
  const selectedStoredPaymentTarget: OrderPaymentTarget | null =
    retryTarget?.type === "wallet" && !paymentWallet ? null : retryTarget

  function buildServiceCtx(): OrderPaymentContext | null {
    if (!actionsReady) return null
    if (zeroCostPickupOrder) return null
    const lc = row.lifecycle
    if (!lc) return null
    if (!lc.merchantLightningAddress) return null
    const paymentTarget =
      retryTarget?.type === "wallet" &&
      paymentWallet &&
      (canTryNwc || canTrySpark)
        ? retryTarget
        : retryTarget?.type === "webln" && weblnAvailable
          ? retryTarget
          : retryTarget?.type === "manual"
            ? retryTarget
            : null
    if (!paymentTarget) return null
    return {
      orderId: vm.orderId,
      buyerPubkey,
      accountPubkey: authenticatedPubkey,
      authenticatedPubkey,
      shouldContinue: shouldContinueBuyerSession,
      shouldContinuePaymentAuthority: () =>
        viewMountedRef.current &&
        isGeneralPaymentRetryEligible(currentViewRef.current),
      buyerIdentity: guestIdentity ?? undefined,
      merchantPubkey: row.merchantPubkey,
      merchantLud16: lc.merchantLightningAddress ?? null,
      zapMode: getRetryZapMode(lc),
      zapContent: lc.zapContent ?? "",
      totalSats: lc.totalSats,
      totalMsats: lc.totalMsats,
      items: lc.items.map((item) => ({
        productAddress: item.productId,
        quantity: item.quantity,
      })),
      paymentTarget,
      approveFee:
        paymentWallet?.providerId === "spark"
          ? sparkFeeApproval.requestApproval
          : undefined,
      formatSatsAmount: formatSats,
    }
  }

  async function persistTargetAndBuildServiceCtx(): Promise<OrderPaymentContext> {
    if (!selectedStoredPaymentTarget) {
      throw new Error("Choose how to pay before trying again.")
    }
    assertGeneralPaymentRetryEligible()
    const replacement = await replaceOrderPaymentTarget(
      vm.orderId,
      selectedStoredPaymentTarget,
      () =>
        viewMountedRef.current &&
        isGeneralPaymentRetryEligible(currentViewRef.current) &&
        shouldContinueAccountRead()
    )
    if (replacement.status !== "updated") {
      if (
        !viewMountedRef.current ||
        !isGeneralPaymentRetryEligible(currentViewRef.current) ||
        !shouldContinueAccountRead()
      ) {
        throw new Error(
          "This order or account no longer has authority to change the payment target."
        )
      }
      throw new Error(
        replacement.status === "missing"
          ? "Order payment state is unavailable."
          : "Payment state changed in another tab. Refresh before trying again."
      )
    }
    const ctx = buildServiceCtx()
    if (!ctx) {
      throw new Error(
        "The selected payment target is unavailable. Choose another option."
      )
    }
    return ctx
  }

  const withBusy = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!actionsReady) {
        setRecoveryError(
          "Reconnect your signer, review this order, then try again."
        )
        return
      }
      setBusy(true)
      setRecoveryError(null)
      try {
        await fn()
      } catch (error) {
        setRecoveryError(
          error instanceof Error ? error.message : "Payment recovery failed."
        )
      } finally {
        setBusy(false)
      }
    },
    [actionsReady]
  )

  async function verifyRetryFreshness(): Promise<void> {
    const pickupFreshness = await verifyPickupCartFreshness(
      row.lifecycle?.items ?? [],
      row.lifecycle?.merchantPubkey ?? row.merchantPubkey,
      authenticatedPubkey,
      () => authGenerationRef.current === authGeneration
    )
    if (!pickupFreshness.fresh) throw new Error(pickupFreshness.reason)
    await assertCartPickupHandlerReady(row.lifecycle?.items ?? [], undefined, {
      requestingAccountPubkey: authenticatedPubkey,
      authenticatedPubkey,
      shouldContinue: shouldContinueBuyerSession,
    })
  }

  async function retryPayment(): Promise<void> {
    assertGeneralPaymentRetryEligible()
    await verifyRetryFreshness()
    assertGeneralPaymentRetryEligible()
    const ctx = await persistTargetAndBuildServiceCtx()
    const lifecycle = await getOrderLifecycle(vm.orderId)
    assertGeneralPaymentRetryEligible()
    if (
      lifecycle &&
      vm.phase !== "cancelled" &&
      vm.phase !== "completed" &&
      !vm.merchantInvoiceAction
    ) {
      const check = await checkOrderPaymentAddressUpdate(lifecycle, ctx)
      if (check.status === "updated") {
        setPaymentAddressUpdate(check.update)
        return
      }
      if (check.status === "current_address_unusable") {
        throw new Error(
          "The merchant's current profile no longer has a usable Lightning address. No invoice was requested."
        )
      }
      if (check.status === "current_address_changed") {
        throw new Error(
          "The merchant's payment address changed. This order cannot safely switch addresses. Contact the merchant before retrying. No invoice was requested."
        )
      }
      if (check.status === "unavailable") {
        setRecoveryError(
          "We couldn't check for an updated merchant address. This retry uses the saved address."
        )
      }
    }
    await runRetryPayment(ctx)
    // The completed attempt's saved result supersedes the address-check notice.
    setRecoveryError(null)
  }

  async function renewExpiredInvoice(): Promise<void> {
    assertGeneralPaymentRetryEligible()
    await verifyRetryFreshness()
    if (!vm.invoice) {
      throw new Error("The expired invoice is no longer available.")
    }
    const expectedInvoice = vm.invoice
    const ctx = buildServiceCtx()
    if (
      !ctx ||
      ctx.paymentTarget.type !== "manual" ||
      retryTarget?.type !== "manual"
    ) {
      throw new Error("Choose manual payment to renew this invoice.")
    }
    const lifecycle = await getOrderLifecycle(vm.orderId)
    if (
      !lifecycle ||
      lifecycle.invoice?.toLowerCase() !== expectedInvoice.toLowerCase() ||
      lifecycle.paymentTarget?.type !== "manual" ||
      lifecycle.paymentTarget.type !== retryTarget.type ||
      (lifecycle.checkoutMode !== ctx.zapMode &&
        !(
          lifecycle.checkoutMode === "external_wallet" &&
          ctx.zapMode === "private_checkout"
        )) ||
      lifecycle.publicZapSigner !== undefined ||
      currentViewRef.current.invoice?.toLowerCase() !==
        expectedInvoice.toLowerCase()
    ) {
      throw new Error("Order payment details changed. Refresh before retrying.")
    }
    const shouldContinueView = () =>
      viewMountedRef.current &&
      currentViewRef.current.orderId === vm.orderId &&
      currentViewRef.current.invoice?.toLowerCase() ===
        expectedInvoice.toLowerCase() &&
      isGeneralPaymentRetryEligible(currentViewRef.current)
    await runOrderPaymentWithRenewedInvoice(
      {
        ...ctx,
        shouldContinueBeforePaymentClaim: shouldContinueView,
        shouldContinue: shouldContinueBuyerSession,
      },
      expectedInvoice,
      lifecycle.updatedAt
    )
  }

  async function runRetryPayment(
    ctx: OrderPaymentContext,
    update?: OrderPaymentAddressUpdate
  ): Promise<void> {
    const run = (context: OrderPaymentContext) =>
      update
        ? runOrderPaymentWithUpdatedAddress(
            {
              ...context,
              shouldContinueBeforePaymentClaim: () =>
                isGeneralPaymentRetryEligible(currentViewRef.current),
            },
            update
          )
        : runOrderPayment({
            ...context,
            shouldContinueBeforePaymentClaim: () =>
              isGeneralPaymentRetryEligible(currentViewRef.current),
          })
    if (ctx.zapMode !== "anonymous_public_zap") {
      await run(ctx)
      return
    }

    const authorization = await authorizeCheckoutWithAnonSigner({
      merchantPubkey: ctx.merchantPubkey,
      items: ctx.items,
    })
    if (
      !row.lifecycle ||
      !doesAuthorizedAnonZapPricingMatchOrder(
        row.lifecycle,
        authorization.pricing
      )
    ) {
      throw new Error(
        "Current signed listing pricing or fulfillment terms no longer match this order. No payment was attempted; use a private invoice or contact the merchant."
      )
    }
    const preparedAnonZap = await signAuthorizedAnonZapCheckout(authorization)
    await run({
      ...ctx,
      zapContent: preparedAnonZap.rawEvent.content,
      preparedAnonZap,
    })
  }

  async function finishAcceptedOrderRecovery(
    lifecycle = row.lifecycle
  ): Promise<void> {
    if (
      !lifecycle ||
      lifecycle.orderDeliveryStatus !== "sent" ||
      lifecycle.buyerPubkey !== buyerPubkey
    ) {
      throw new Error("The accepted order is unavailable for recovery.")
    }
    if (!shouldContinueBuyerSession()) {
      throw new Error(
        "The buyer session changed. Reopen this order to continue."
      )
    }
    const matchingPurchase = groupCartPurchases(cart.items).find(
      (purchase) =>
        purchase.merchantPubkey === lifecycle.merchantPubkey &&
        doesCartMatchOrderAttempt(purchase.items, lifecycle.items)
    )
    if (matchingPurchase) {
      const claim = await cart.capturePurchase(
        matchingPurchase.id,
        matchingPurchase.items
      )
      if (!shouldContinueBuyerSession()) {
        throw new Error(
          "The buyer session changed. Reopen this order to continue."
        )
      }
      await cart.consumePurchase(claim)
    }
    if (!shouldContinueBuyerSession()) {
      throw new Error(
        "The buyer session changed. Reopen this order to continue."
      )
    }
    const resolved = await patchOrderLifecycle(lifecycle.orderId, {
      checkoutRecoveryPending: false,
    })
    if (!resolved) {
      throw new Error("The accepted order recovery state could not be saved.")
    }
    if (!shouldContinueBuyerSession()) {
      await patchOrderLifecycle(lifecycle.orderId, {
        checkoutRecoveryPending: true,
      })
      throw new Error(
        "The buyer session changed. Reopen this order to continue."
      )
    }
    forgetCheckoutOrderAttempt(lifecycle.orderId)
    await queryClient.invalidateQueries({
      queryKey: ["order-lifecycles", buyerPubkey],
    })
  }

  async function retryStagedOrderDelivery(): Promise<void> {
    const lifecycle = row.lifecycle
    if (!lifecycle?.orderRelayDelivery) {
      throw new Error("The saved encrypted order is unavailable for retry.")
    }
    const retried = await retryOrderRelayDelivery(
      lifecycle.orderId,
      buyerPubkey,
      {
        allowGuest: !!guestIdentity,
        shouldContinue: shouldContinueBuyerSession,
      }
    )
    await queryClient.invalidateQueries({
      queryKey: ["order-lifecycles", buyerPubkey],
    })
    if (retried?.orderDeliveryStatus !== "sent") {
      throw new Error(
        "No merchant relay acknowledged the saved order yet. Retry the same order later."
      )
    }
    if (requiresAcceptedOrderPaymentContinuation(retried)) return
    await finishAcceptedOrderRecovery(retried)
  }

  async function continueAcceptedCheckoutPayment(): Promise<void> {
    const lifecycle = row.lifecycle
    if (!lifecycle || !requiresAcceptedOrderPaymentContinuation(lifecycle)) {
      throw new Error("This checkout no longer needs pre-payment recovery.")
    }

    await retryPayment()
    const current = await getOrderLifecycle(lifecycle.orderId)
    if (!current) {
      throw new Error("The saved checkout state could not be reloaded.")
    }
    if (!hasCheckoutPaymentProgress(current)) {
      throw new Error(
        "Payment did not start. This order remains recoverable; do not submit another order."
      )
    }
    await finishAcceptedOrderRecovery(current)
  }

  async function confirmPaymentAddressUpdate(): Promise<void> {
    const pending = paymentAddressUpdate
    if (!pending) return
    assertGeneralPaymentRetryEligible()
    if (
      vm.phase === "cancelled" ||
      vm.phase === "completed" ||
      vm.merchantInvoiceAction
    ) {
      throw new Error(
        "This order no longer accepts an updated payment address."
      )
    }
    await verifyRetryFreshness()
    assertGeneralPaymentRetryEligible()
    const ctx = buildServiceCtx()
    if (!ctx) {
      throw new Error(
        "Payment details are unavailable. Refresh before retrying."
      )
    }
    await runRetryPayment(ctx, pending)
    setPaymentAddressUpdate((current) => (current === pending ? null : current))
  }

  async function continuePrivateFallback(): Promise<void> {
    assertGeneralPaymentRetryEligible()
    await verifyRetryFreshness()
    const ctx = await persistTargetAndBuildServiceCtx()
    assertGeneralPaymentRetryEligible()
    await runOrderPrivateFallback({
      ...ctx,
      shouldContinueBeforePaymentClaim: () =>
        isGeneralPaymentRetryEligible(currentViewRef.current),
    })
    setPrivateFallbackOpen(false)
  }

  function isGeneralPaymentRetryEligible(current: OrderViewModel): boolean {
    return (
      current.orderId === vm.orderId &&
      current.phase !== "cancelled" &&
      current.phase !== "completed" &&
      current.merchantStatus !== "cancelled" &&
      current.merchantStatus !== "refund_requested" &&
      !isBuyerOrderPaid(current)
    )
  }

  function assertGeneralPaymentRetryEligible(): void {
    if (!isGeneralPaymentRetryEligible(currentViewRef.current)) {
      throw new Error("This order no longer accepts a new payment attempt.")
    }
  }

  const manualInvoiceAccess = deriveManualInvoiceAccess(
    row.lifecycle,
    vm.merchantStatus,
    vm.phase,
    vm.paymentStatus === "paid"
  )
  const merchantInvoiceReopenEvidence =
    vm.reopenedCancellationId && row.conversation?.messages
      ? {
          cancellationEventId: vm.reopenedCancellationId,
          messages: row.conversation.messages,
        }
      : undefined

  function beginMerchantInvoicePayment(): boolean {
    if (
      manualInvoiceAccess === "report_only" ||
      manualInvoiceAccess === "receipt_only" ||
      manualInvoiceAccess === "closed"
    ) {
      setRecoveryError("This order no longer accepts payment.")
      return false
    }
    const action = vm.merchantInvoiceAction
    if (!action) return true
    const validation = validateMerchantInvoicePaymentAction(
      row.lifecycle,
      action,
      { reopenEvidence: merchantInvoiceReopenEvidence }
    )
    if (!validation.ok) {
      setRecoveryError(validation.reason)
      return false
    }

    setRecoveryError(null)
    return true
  }

  async function prepareCurrentMerchantInvoice(): Promise<void> {
    if (!shouldContinueAccountRead()) {
      throw new Error("Your account changed. Reopen the order to continue.")
    }
    const action = vm.merchantInvoiceAction
    if (!action || action.status !== "payable") {
      throw new Error("This merchant invoice is no longer payable.")
    }
    await prepareMerchantInvoicePaymentAction(
      action,
      merchantInvoiceReopenEvidence
    )
  }

  async function reportExternalPayment(): Promise<void> {
    if (manualInvoiceAccess === "closed") {
      throw new Error("The merchant already confirmed this payment.")
    }
    const action = vm.merchantInvoiceAction
    const unboundPaidInvoice =
      action?.status === "blocked" && action.canReport ? action : undefined
    await submitExternalPaymentProof(
      vm.orderId,
      guestIdentity ?? undefined,
      unboundPaidInvoice,
      merchantInvoiceReopenEvidence,
      authenticatedPubkey ?? null,
      authenticatedPubkey ?? null,
      shouldContinueBuyerSession,
      (lifecycle) =>
        shouldContinueAccountRead() &&
        canClaimManualInvoiceReport(
          vm,
          currentViewRef.current,
          lifecycle,
          buyerPubkey
        )
    )
  }

  async function reportPriorExpiredInvoice(): Promise<void> {
    const prior =
      priorInvoiceChoices.find(
        ({ index }) => index === Number(priorInvoiceIndex)
      )?.entry ?? priorInvoiceChoices[0]?.entry
    if (
      !prior ||
      vm.publicZapSigner ||
      (row.lifecycle?.checkoutMode !== "private_checkout" &&
        row.lifecycle?.checkoutMode !== "external_wallet") ||
      row.lifecycle?.paymentTarget?.type !== "manual" ||
      (vm.invoice
        ? vm.invoiceStatus !== "manual_required" ||
          vm.paymentStatus !== "manual_required" ||
          vm.invoice.toLowerCase() === prior.invoice.toLowerCase()
        : vm.invoiceStatus !== "failed" || vm.paymentStatus !== "failed") ||
      vm.paymentStatus === "paid" ||
      vm.paymentStatus === "paying" ||
      vm.paymentStatus === "ambiguous" ||
      vm.phase === "completed" ||
      isBuyerOrderPaid(vm)
    )
      throw new Error("The previous invoice is no longer reportable.")
    await submitExternalPaymentProof(
      vm.orderId,
      guestIdentity ?? undefined,
      undefined,
      undefined,
      authenticatedPubkey ?? null,
      authenticatedPubkey ?? null,
      shouldContinueBuyerSession,
      (lifecycle) =>
        currentViewRef.current.orderId === vm.orderId &&
        (currentViewRef.current.invoice === undefined ||
          (currentViewRef.current.invoiceStatus === "manual_required" &&
            currentViewRef.current.paymentStatus === "manual_required" &&
            currentViewRef.current.invoice.toLowerCase() !==
              prior.invoice.toLowerCase())) &&
        currentViewRef.current.priorExpiredManualInvoices.some(
          (entry) =>
            entry.invoice.toLowerCase() === prior.invoice.toLowerCase() &&
            entry.paymentHash.toLowerCase() === prior.paymentHash.toLowerCase()
        ) &&
        lifecycle.buyerPubkey === buyerPubkey &&
        lifecycle.merchantPubkey === vm.merchantPubkey &&
        (lifecycle.invoice === undefined
          ? lifecycle.invoiceStatus === "failed" &&
            lifecycle.paymentStatus === "failed"
          : lifecycle.invoiceStatus === "manual_required" &&
            lifecycle.paymentStatus === "manual_required" &&
            lifecycle.invoice.toLowerCase() !== prior.invoice.toLowerCase()) &&
        lifecycle.checkoutMode !== "pay_later" &&
        lifecycle.publicZapSigner === undefined &&
        lifecycle.paymentTarget?.type === "manual" &&
        !lifecycle.paymentClaimId &&
        !lifecycle.proofDeliveryClaimId &&
        lifecycle.proofDeliveryStatus === "not_started" &&
        !["paid", "completed"].includes(currentViewRef.current.paymentStatus) &&
        !["paid", "completed"].includes(
          currentViewRef.current.merchantStatus ?? ""
        ),
      {
        invoice: prior.invoice,
        paymentHash: prior.paymentHash,
        expiresAt: prior.expiresAt,
      }
    )
  }

  const merchantInvoicePrepared =
    !!vm.merchantInvoiceAction &&
    vm.merchantInvoiceAction.status === "payable" &&
    isMerchantInvoicePaymentActionBound(
      row.lifecycle,
      vm.merchantInvoiceAction,
      merchantInvoiceReopenEvidence
    )
  const boundMerchantInvoiceExpiresAt =
    row.lifecycle?.checkoutMode === "pay_later" &&
    row.lifecycle.invoiceStatus === "manual_required" &&
    row.lifecycle.paymentStatus === "manual_required"
      ? (row.lifecycle.invoiceExpiresAt ?? null)
      : null

  const generalPaymentRetryEligible =
    vm.phase !== "cancelled" &&
    vm.phase !== "completed" &&
    vm.merchantStatus !== "cancelled" &&
    vm.merchantStatus !== "refund_requested" &&
    !isBuyerOrderPaid(vm)
  const showRetryPayment =
    !zeroCostPickupOrder &&
    vm.paymentStatus === "failed" &&
    generalPaymentRetryEligible
  const recoveredBeforeWallet =
    row.lifecycle?.lastError === ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR
  const paymentRecoveryError =
    recoveryError ??
    (!busy && showRetryPayment && !recoveredBeforeWallet
      ? getOrderPaymentFailureDetail(row.lifecycle, vm)
      : null)
  const showAnonPaymentRecovery =
    showRetryPayment &&
    vm.publicZapSigner === "anon" &&
    row.lifecycle?.invoiceStatus === "failed"
  const showAmbiguousPayment =
    !zeroCostPickupOrder && vm.paymentStatus === "ambiguous"
  const showExternalWallet =
    !zeroCostPickupOrder &&
    manualInvoiceAccess !== "closed" &&
    manualInvoiceAccess !== "report_only" &&
    manualInvoiceAccess !== "receipt_only" &&
    (vm.paymentStatus === "manual_required" || !!vm.merchantInvoiceAction)
  const priorInvoiceChoices = vm.priorExpiredManualInvoices
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        !vm.invoice || entry.invoice.toLowerCase() !== vm.invoice.toLowerCase()
    )
  const showPriorExpiredInvoiceReport =
    priorInvoiceChoices.length > 0 &&
    !vm.publicZapSigner &&
    (row.lifecycle?.checkoutMode === "private_checkout" ||
      row.lifecycle?.checkoutMode === "external_wallet") &&
    row.lifecycle?.paymentTarget?.type === "manual" &&
    (vm.invoice
      ? vm.invoiceStatus === "manual_required" &&
        vm.paymentStatus === "manual_required" &&
        priorInvoiceChoices.length > 0
      : vm.invoiceStatus === "failed" && vm.paymentStatus === "failed") &&
    vm.paymentStatus !== "paid" &&
    vm.paymentStatus !== "paying" &&
    vm.paymentStatus !== "ambiguous" &&
    vm.phase !== "completed" &&
    !isBuyerOrderPaid(vm)
  const autoDetectPublicReceipt =
    !zeroCostPickupOrder &&
    !!vm.publicZapSigner &&
    vm.zapReceiptStatus === "waiting"
  const publicReceiptNotObserved =
    !zeroCostPickupOrder &&
    !!vm.publicZapSigner &&
    vm.zapReceiptStatus === "receipt_not_observed"
  const showResendProof =
    !zeroCostPickupOrder &&
    vm.paymentStatus === "paid" &&
    (vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed")
  const showRetryOrderDelivery =
    row.lifecycle?.orderDeliveryStatus === "pending" &&
    !!row.lifecycle.orderRelayDelivery
  const showContinueAcceptedCheckout =
    !zeroCostPickupOrder &&
    !!row.lifecycle &&
    requiresAcceptedOrderPaymentContinuation(row.lifecycle)
  const showFinishAcceptedOrderRecovery =
    row.lifecycle?.orderDeliveryStatus === "sent" &&
    row.lifecycle.checkoutRecoveryPending === true &&
    !showContinueAcceptedCheckout
  const showPaymentRecoveryAction =
    showRetryPayment || showContinueAcceptedCheckout

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (guestIdentity) throw new Error("Guest orders cannot send messages")
      if (!signerReady) throw new Error("Reconnect your signer to send.")
      if (!replyText.trim()) throw new Error("Message is required")
      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Signer not connected")

      const rumor = new NDKEvent(ndk)
      rumor.kind = EVENT_KINDS.ORDER
      rumor.created_at = Math.floor(Date.now() / 1000)
      rumor.tags = appendConduitClientTag(
        [
          ["p", row.merchantPubkey],
          ["type", "message"],
          ["order", vm.orderId],
        ],
        "market"
      )
      rumor.content = JSON.stringify({
        note: replyText.trim(),
        orderId: vm.orderId,
        merchantPubkey: row.merchantPubkey,
        buyerPubkey,
        createdAt: Date.now(),
      })
      await publishBuyerOrderMessage(
        rumor,
        ndk,
        row.merchantPubkey,
        buyerPubkey,
        {
          accountPubkey: authenticatedPubkey ?? null,
          authenticatedPubkey: authenticatedPubkey ?? null,
          shouldContinue: shouldContinueBuyerSession,
        }
      )
    },
    onSuccess: async () => {
      setReplyText("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages", buyerPubkey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages-live", buyerPubkey],
        }),
      ])
    },
  })

  const messageMerchant = guestIdentity ? null : (
    <Button
      variant="outline"
      className="h-10 px-4 text-sm"
      onClick={() => setMessagesOpen(true)}
    >
      <MessageCircle className="h-4 w-4" />
      Message merchant
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Hero */}
      {!paymentFocused && (
        <>
          <section className="hidden rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 xl:block">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <MerchantAvatar
                  pubkey={row.merchantPubkey}
                  name={merchantName}
                  picture={profile?.picture}
                />
                <div className="min-w-0">
                  <Link
                    to="/store/$pubkey"
                    params={{ pubkey: pubkeyToNpub(row.merchantPubkey) }}
                    className="truncate text-lg font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                  >
                    {merchantName}
                  </Link>
                  <div className="mt-0.5 text-sm text-[var(--text-secondary)]">
                    {vm.items[0]?.displayTitle ?? "Order"}
                  </div>
                  {typeof vm.totalSats === "number" && (
                    <div className="text-sm font-medium text-secondary-300">
                      {formatOrderTotal(vm, formatSats)}
                    </div>
                  )}
                  <div className="mt-2">
                    <OrderHeaderPill status={headerStatus} />
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                {messageMerchant}
              </div>
            </div>
          </section>

          <section className="xl:hidden">
            <OrderItemsSection
              vm={vm}
              productsById={productsById}
              formatPrice={(price, options) =>
                shopperPricing.formatPrice(price, {
                  ...options,
                  settledSatsAreAuthoritative: true,
                })
              }
              formatSats={formatSats}
            />
          </section>
        </>
      )}

      {paymentFocused && !showExternalWallet && !headerStatus.actionNeeded && (
        <div>
          <OrderHeaderPill status={headerStatus} />
        </div>
      )}

      {showRetryOrderDelivery && (
        <StatusNotice
          variant="warning"
          title="Order delivery not confirmed"
          detail="Saved encrypted order"
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            No merchant relay ACK was recorded. Retry reuses the exact encrypted
            order and cannot create a second semantic order.
          </p>
          <Button
            variant="outline"
            className="mt-4 h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void withBusy(retryStagedOrderDelivery)}
          >
            <RotateCw className="h-4 w-4" />
            Retry saved order
          </Button>
          {recoveryError && (
            <p
              role="alert"
              className="mt-3 text-pretty text-sm text-[var(--destructive)]"
            >
              {recoveryError}
            </p>
          )}
        </StatusNotice>
      )}

      {showFinishAcceptedOrderRecovery && (
        <StatusNotice
          variant="warning"
          title="Order accepted by a delivery relay"
          detail="Merchant pickup pending"
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            The order must be finalized on this device before this cart can be
            submitted again. Relay acceptance does not prove the merchant has
            read it.
          </p>
          <Button
            variant="outline"
            className="mt-4 h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void withBusy(finishAcceptedOrderRecovery)}
          >
            <Check className="h-4 w-4" />
            Finish order recovery
          </Button>
          {recoveryError && (
            <p
              role="alert"
              className="mt-3 text-pretty text-sm text-[var(--destructive)]"
            >
              {recoveryError}
            </p>
          )}
        </StatusNotice>
      )}

      {showContinueAcceptedCheckout && (
        <StatusNotice
          variant="warning"
          title="Order accepted; payment has not started"
          detail="Continue this checkout"
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            A delivery relay accepted this order before checkout closed.
            Continue payment for this same order below. Relay acceptance does
            not prove the merchant has read it, and continuing will not send
            another order.
          </p>
        </StatusNotice>
      )}

      {(manualInvoiceAccess === "report_only" ||
        manualInvoiceAccess === "receipt_only") && (
        <StatusNotice
          variant="warning"
          title="Order no longer accepts payment"
          detail={
            vm.merchantStatus === "refund_requested"
              ? "Refund requested"
              : "Order cancelled"
          }
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            {manualInvoiceAccess === "receipt_only"
              ? "Do not pay this invoice. If your wallet already confirms payment, report it for merchant verification while Conduit continues checking for a public receipt."
              : "Do not pay this invoice. If your wallet already confirms a payment, report it so the merchant can verify what happened."}
          </p>
          {(manualInvoiceAccess === "report_only" ||
            manualInvoiceAccess === "receipt_only") && (
            <Button
              variant="outline"
              className="mt-4 h-10 px-4 text-sm"
              disabled={busy}
              onClick={() => void withBusy(reportExternalPayment)}
            >
              Report a payment already made
            </Button>
          )}
        </StatusNotice>
      )}

      {showPriorExpiredInvoiceReport && (
        <StatusNotice
          variant="warning"
          title="Report payment for an earlier invoice"
        >
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            Do not pay the new invoice if your wallet already paid an earlier
            one. Select the earlier invoice expiry date to report it for
            merchant verification.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="grid min-w-[15rem] gap-1.5">
              <label
                htmlFor={`prior-invoice-${vm.orderId}`}
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                Previously expired invoice
              </label>
              <Select
                value={String(
                  priorInvoiceChoices.find(
                    ({ index }) => index === Number(priorInvoiceIndex)
                  )?.index ??
                    priorInvoiceChoices[0]?.index ??
                    0
                )}
                onValueChange={setPriorInvoiceIndex}
                disabled={busy}
              >
                <SelectTrigger
                  id={`prior-invoice-${vm.orderId}`}
                  className="h-10 w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorInvoiceChoices.map(({ entry, index }) => (
                    <SelectItem
                      key={`${entry.paymentHash}-${entry.expiresAt}`}
                      value={String(index)}
                    >
                      Invoice {index + 1} . Expires{" "}
                      {new Date(entry.expiresAt * 1000).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              disabled={busy}
              onClick={() => void withBusy(reportPriorExpiredInvoice)}
            >
              Report selected earlier invoice payment
            </Button>
          </div>
        </StatusNotice>
      )}

      {!showExternalWallet &&
        showPriorExpiredInvoiceReport &&
        recoveryError && (
          <StatusNotice variant="warning" title="Payment report not sent">
            <p className="text-pretty text-sm text-[var(--text-secondary)]">
              {recoveryError}
            </p>
          </StatusNotice>
        )}

      {showExternalWallet && (
        <div className="space-y-3">
          <ExternalWalletPanel
            vm={vm}
            pricing={shopperPricing}
            busy={busy || !actionsReady}
            guestSession={!!guestIdentity}
            autoDetectReceipt={autoDetectPublicReceipt}
            onBeforeInvoiceUse={beginMerchantInvoicePayment}
            onPrepareMerchantInvoice={prepareCurrentMerchantInvoice}
            onRenewExpiredInvoice={
              (row.lifecycle?.checkoutMode === "private_checkout" ||
                row.lifecycle?.checkoutMode === "external_wallet") &&
              row.lifecycle.publicZapSigner === undefined &&
              row.lifecycle.paymentTarget?.type === "manual"
                ? () => withBusy(renewExpiredInvoice)
                : undefined
            }
            preparationScope={`${authGeneration}:${authenticatedPubkey ?? "guest"}:${buyerPubkey}:${vm.orderId}`}
            merchantInvoicePrepared={merchantInvoicePrepared}
            boundMerchantInvoiceExpiresAt={boundMerchantInvoiceExpiresAt}
            onMarkPaid={() => void withBusy(reportExternalPayment)}
          />
          {recoveryError && (
            <p
              role="alert"
              className="text-pretty text-sm text-[var(--destructive)]"
            >
              {recoveryError}
            </p>
          )}
        </div>
      )}

      {(showPaymentRecoveryAction ||
        showAmbiguousPayment ||
        showResendProof) && (
        <StatusNotice
          variant={TONE_VARIANT[headerStatus.tone]}
          title={headerStatus.primaryLabel}
          detail={headerStatus.detailLabel}
        >
          <div className="flex flex-wrap items-end gap-3">
            {showPaymentRecoveryAction && (
              <div className="grid min-w-[15rem] gap-1.5">
                <label
                  htmlFor={`retry-wallet-${vm.orderId}`}
                  className="text-xs font-medium text-[var(--text-secondary)]"
                >
                  Pay with
                </label>
                <Select
                  value={retryTargetValue}
                  onValueChange={(value) => {
                    const option = retryTargetOptions.find(
                      (candidate) => candidate.value === value
                    )
                    if (option) setRetryTarget(option.target)
                  }}
                  disabled={busy || wallets.loading}
                >
                  <SelectTrigger
                    id={`retry-wallet-${vm.orderId}`}
                    className={PAYMENT_TARGET_SELECT_TRIGGER_CLASS_NAME}
                  >
                    {wallets.loading ? (
                      <span className="flex items-center gap-2 text-[var(--text-muted)]">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        Loading saved wallets
                      </span>
                    ) : (
                      <PaymentTargetSelectValue
                        target={retryTarget}
                        eligibleWallets={eligibleWallets}
                        walletDisplayLabels={eligibleWalletDisplayLabels}
                        weblnAvailable={weblnAvailable}
                        placeholder="Choose a payment target"
                      />
                    )}
                  </SelectTrigger>
                  <PaymentTargetSelectContent
                    options={retryTargetOptions}
                    eligibleWallets={eligibleWallets}
                    walletDisplayLabels={eligibleWalletDisplayLabels}
                    staleWalletValue={
                      retryWalletTargetIsStale ? retryTargetValue : null
                    }
                    weblnAvailable={weblnAvailable}
                  />
                </Select>
              </div>
            )}
            {showPaymentRecoveryAction && (
              <Button
                className="h-11 px-4 text-sm"
                disabled={
                  busy ||
                  !actionsReady ||
                  wallets.loading ||
                  !selectedStoredPaymentTarget ||
                  !buildServiceCtx()
                }
                onClick={() =>
                  void withBusy(
                    showContinueAcceptedCheckout
                      ? continueAcceptedCheckoutPayment
                      : retryPayment
                  )
                }
              >
                <RotateCw className="h-4 w-4" />
                {showContinueAcceptedCheckout || recoveredBeforeWallet
                  ? "Continue payment"
                  : "Try payment again"}
              </Button>
            )}
            {showAnonPaymentRecovery && (
              <Button
                variant="outline"
                className="h-10 px-4 text-sm"
                disabled={
                  busy ||
                  !actionsReady ||
                  wallets.loading ||
                  !selectedStoredPaymentTarget ||
                  !buildServiceCtx()
                }
                onClick={() => setPrivateFallbackOpen(true)}
              >
                Use private invoice
              </Button>
            )}
            {showResendProof && (
              <Button
                variant="outline"
                className="h-10 px-4 text-sm"
                disabled={busy || !actionsReady}
                onClick={() =>
                  void withBusy(() =>
                    resendOrderProof(
                      vm.orderId,
                      guestIdentity ?? undefined,
                      authenticatedPubkey ?? null,
                      authenticatedPubkey ?? null,
                      shouldContinueBuyerSession
                    )
                  )
                }
              >
                <RotateCw className="h-4 w-4" />
                Resend receipt
              </Button>
            )}
            <span className="text-xs text-[var(--text-secondary)]">
              {wallets.loading
                ? "Wait while Conduit checks the Portable and Connected Wallets saved on this device."
                : publicReceiptNotObserved
                  ? "Conduit did not observe the matching public receipt. If your wallet shows payment, do not pay again. The receipt can still reconcile if it reaches the configured relays while this order remains available on this device."
                  : showAmbiguousPayment
                    ? "Your wallet may have received the payment request, but Conduit couldn't confirm whether funds moved. Check your wallet and merchant messages before trying again."
                    : showPaymentRecoveryAction && retryWalletTargetIsStale
                      ? "The previously selected saved wallet is unavailable. Explicitly choose another wallet, browser wallet, or manual payment."
                      : showPaymentRecoveryAction &&
                          !selectedStoredPaymentTarget
                        ? "Choose the exact wallet or manual payment path for this retry."
                        : showPaymentRecoveryAction && !buildServiceCtx()
                          ? "The saved payment target is unavailable. Unlock or reconnect it, or explicitly choose another option."
                          : showContinueAcceptedCheckout
                            ? "Continue payment for the accepted order. This does not resend the order."
                            : showRetryPayment
                              ? recoveredBeforeWallet
                                ? "Conduit closed before the invoice reached a wallet. Continuing reuses this order; no funds moved."
                                : showAnonPaymentRecovery
                                  ? "This older anonymous zap attempt failed before automatic fallback was available. No funds moved; retry it or continue with a private invoice."
                                  : "No funds moved. You can retry payment for this order."
                              : "Payment went through; the receipt didn't reach the merchant."}
            </span>
            {paymentRecoveryError && (
              <p
                role="alert"
                className="w-full text-sm text-[var(--destructive)]"
              >
                {paymentRecoveryError}
              </p>
            )}
            {showPaymentRecoveryAction && wallets.initializationError && (
              <div
                role="alert"
                className="w-full rounded-xl border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_6%,transparent)] p-3 text-sm leading-6 text-[var(--text-secondary)]"
              >
                <p className="font-medium text-[var(--text-primary)]">
                  Saved wallets could not be loaded
                </p>
                <p className="mt-1">
                  {wallets.initializationError} Browser wallet and manual
                  payment remain available.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 h-9 px-3 text-xs"
                  disabled={wallets.loading}
                  onClick={() => void wallets.retryInitialization()}
                >
                  {wallets.loading ? (
                    <>
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      Retrying
                    </>
                  ) : (
                    "Retry saved wallets"
                  )}
                </Button>
              </div>
            )}
          </div>
        </StatusNotice>
      )}

      <AlertDialog
        open={!!paymentAddressUpdate}
        onOpenChange={(open) => {
          if (!open) setPaymentAddressUpdate(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Merchant updated their payment address
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              Review the new address before retrying this order. The order total
              and payment method stay the same. If you selected a wallet,
              confirming may pay immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-[var(--text-secondary)]">Saved address</dt>
              <dd className="break-all">
                {paymentAddressUpdate?.previousAddress}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--text-secondary)]">Updated address</dt>
              <dd className="break-all">{paymentAddressUpdate?.newAddress}</dd>
            </div>
          </dl>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={busy || !actionsReady}
              onClick={() => setPaymentAddressUpdate(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !actionsReady}
              onClick={() => void withBusy(confirmPaymentAddressUpdate)}
            >
              Use updated address and retry
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={privateFallbackOpen}
        onOpenChange={setPrivateFallbackOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use a private invoice?</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              This keeps the existing order but replaces the failed anonymous
              zap attempt with a normal private Lightning invoice. If an
              automatic wallet is available, confirming may pay it immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPrivateFallbackOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                busy ||
                !actionsReady ||
                !selectedStoredPaymentTarget ||
                !buildServiceCtx()
              }
              onClick={() => {
                void withBusy(continuePrivateFallback)
              }}
            >
              Continue privately
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SparkFeeApprovalDialog
        controller={sparkFeeApproval}
        walletLabel={
          paymentWallet?.providerId === "spark"
            ? (eligibleWalletDisplayLabels.get(paymentWallet.id) ??
              paymentWallet.label)
            : undefined
        }
      />

      {paymentFocused ? (
        <div className="space-y-4">
          {!showExternalWallet && (
            <OrderTimeline vm={vm} formatSats={formatSats} />
          )}
          <OrderItemsSection
            vm={vm}
            productsById={productsById}
            formatPrice={(price, options) =>
              shopperPricing.formatPrice(price, {
                ...options,
                settledSatsAreAuthoritative: true,
              })
            }
            formatSats={formatSats}
          />
          <Button asChild variant="outline" className="h-10 w-full text-sm">
            <Link to="/orders" search={{ order: vm.orderId }}>
              View full order details
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <OrderTimeline vm={vm} formatSats={formatSats} />

          <div className="space-y-4">
            <div className="hidden xl:block">
              <OrderItemsSection
                vm={vm}
                productsById={productsById}
                formatPrice={(price, options) =>
                  shopperPricing.formatPrice(price, {
                    ...options,
                    settledSatsAreAuthoritative: true,
                  })
                }
                formatSats={formatSats}
              />
            </div>

            {/* Shipping address */}
            {vm.pickupFulfillments.map((pickup) => {
              const handoff = getPickupHandoffSummary(pickup)
              const pickupClaimCode = getOrganizerPickupClaimCode(
                row.orderId,
                pickup
              )
              const collectionRef = encodeEventMarketNaddr(
                pickup.collection.coordinate
              )
              return (
                <section
                  key={pickup.option.coordinate}
                  className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-secondary-500/30 bg-secondary-500/10 text-secondary-400">
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {handoff.label}
                      </h3>
                      <div className="mt-2 text-sm font-medium text-[var(--text-primary)]">
                        {pickup.option.title}
                      </div>
                      <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                        {pickup.option.location ??
                          pickup.option.geohash ??
                          "Public pickup location was not published."}
                      </div>
                      <div className="mt-2 text-xs text-[var(--text-muted)]">
                        Handled by{" "}
                        <EventActorName
                          identity={eventActorIdentity(handoff.handlerPubkey)}
                        />
                      </div>
                      {pickupClaimCode && (
                        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm">
                          <span className="text-[var(--text-secondary)]">
                            Pickup code
                          </span>
                          <span className="flex items-center gap-2 font-mono font-semibold tracking-wide text-[var(--text-primary)]">
                            {pickupClaimCode}
                            <CopyButton
                              value={pickupClaimCode}
                              npub={false}
                              label="Copy organizer pickup code"
                            />
                          </span>
                        </div>
                      )}
                      <Button asChild variant="outline" className="mt-4 h-9">
                        <Link
                          to="/events/$collectionRef"
                          params={{ collectionRef }}
                        >
                          View event catalog
                        </Link>
                      </Button>
                    </div>
                  </div>
                </section>
              )
            })}

            {/* Shipping address */}
            {vm.shippingAddress && (
              <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Shipping address
                  </h3>
                  {!guestIdentity && (
                    <Button
                      variant="ghost"
                      className="h-8 px-3 text-xs"
                      onClick={() => setMessagesOpen(true)}
                    >
                      Send correction
                    </Button>
                  )}
                </div>
                <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  <div className="text-[var(--text-primary)]">
                    {vm.shippingAddress.name}
                  </div>
                  <div>{vm.shippingAddress.street}</div>
                  <div>
                    {vm.shippingAddress.city}
                    {vm.shippingAddress.state
                      ? `, ${vm.shippingAddress.state}`
                      : ""}{" "}
                    {vm.shippingAddress.postalCode}
                  </div>
                  <div>{vm.shippingAddress.country}</div>
                </div>
              </section>
            )}

            {/* Order details (technical, collapsed) */}
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)]">
              <button
                type="button"
                onClick={() => setDetailsOpen((open) => !open)}
                aria-expanded={detailsOpen}
                aria-controls="market-order-details-panel"
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
              >
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                  Order details
                </span>
                <ChevronRight
                  className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${detailsOpen ? "rotate-90" : ""}`}
                />
              </button>
              {detailsOpen && (
                <div
                  id="market-order-details-panel"
                  className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm"
                >
                  <DetailRow label="Order ID">
                    <span className="font-mono text-xs">
                      {formatPubkey(vm.orderId, 8)}
                    </span>
                    <CopyButton value={vm.orderId} label="Copy order id" />
                  </DetailRow>
                  <DetailRow label="Merchant npub">
                    <span className="font-mono text-xs">
                      {formatNpub(row.merchantPubkey, 8)}
                    </span>
                    <CopyButton
                      value={row.merchantPubkey}
                      label="Copy pubkey"
                    />
                  </DetailRow>
                  {typeof vm.totalSats === "number" && (
                    <DetailRow
                      label={zeroCostPickupOrder ? "Total" : "Payment"}
                    >
                      <span>{formatOrderTotal(vm, formatSats)}</span>
                    </DetailRow>
                  )}
                  <DetailRow
                    label={zeroCostPickupOrder ? "Payment" : "Paid with"}
                  >
                    <span>{getOrderPaymentMethodLabel(vm)}</span>
                  </DetailRow>
                  <DetailRow label="Ordered">
                    <span>{new Date(vm.createdAt).toLocaleString()}</span>
                  </DetailRow>
                </div>
              )}
            </section>

            <section className="flex items-center gap-3 px-1 xl:hidden">
              <MerchantAvatar
                pubkey={row.merchantPubkey}
                name={merchantName}
                picture={profile?.picture}
              />
              <div className="min-w-0">
                <Link
                  to="/store/$pubkey"
                  params={{ pubkey: pubkeyToNpub(row.merchantPubkey) }}
                  className="truncate text-base font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                >
                  {merchantName}
                </Link>
              </div>
            </section>

            {/* Need help */}
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Need help?
              </h3>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {guestIdentity
                  ? vm.requiresPickup
                    ? "The merchant can use the email or phone submitted at checkout only if guest pickup recovery is needed."
                    : "The merchant will use the phone and email contact details submitted at checkout for questions and fulfillment updates."
                  : "Message the merchant for any questions or issues."}
              </p>
              {messageMerchant && <div className="mt-3">{messageMerchant}</div>}
            </section>
          </div>
        </div>
      )}

      {!guestIdentity && (
        <OrderMessagesWidget
          open={messagesOpen}
          onOpenChange={setMessagesOpen}
          subtitle={merchantName}
          messages={row.conversation?.messages ?? []}
          selfPubkey={buyerPubkey}
          replyValue={replyText}
          onReplyChange={setReplyText}
          onSend={() => replyMutation.mutate()}
          sending={replyMutation.isPending}
          readOnly={!signerReady}
          error={
            replyMutation.error instanceof Error
              ? replyMutation.error.message
              : replyMutation.error
                ? "Failed to send message"
                : null
          }
          placeholder="Message the merchant, then press Enter"
          resolveItem={(id) => {
            const product = productsById.get(id)
            return product
              ? {
                  title: product.title,
                  imageUrl: getProductImageCandidates(product)[0]?.url,
                }
              : undefined
          }}
          formatAmount={(amount, currency, sourcePrice) =>
            shopperPricing.formatPrice(
              {
                price: amount,
                currency,
                priceSats: currency === "SATS" ? amount : undefined,
                sourcePrice,
              },
              {
                allowZero: zeroCostPickupOrder,
                settledSatsAreAuthoritative: true,
              }
            )
          }
        />
      )}
    </div>
  )
}

function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="flex items-center gap-2 text-[var(--text-primary)]">
        {children}
      </span>
    </div>
  )
}

type PhaseTab = "all" | "pending" | "in_progress" | "completed"

function OrdersPage() {
  const {
    accountPubkey,
    authGeneration,
    connect,
    pubkey,
    remoteSignerRecovery,
    signerReadiness,
    status,
  } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const signerConnected =
    signerReadiness === "ready" &&
    status === "connected" &&
    !!accountPubkey &&
    pubkey === accountPubkey
  const hasAccount = !!accountPubkey
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const shopperPricing = useShopperPricing()
  const formatSats = (sats: number) =>
    shopperPricing.formatSatsAmount(sats).primary
  const { order: selectedFromUrl, focus } = Route.useSearch()
  const paymentFocused = focus === "payment" && !!selectedFromUrl
  const [searchValue, setSearchValue] = useState("")
  const [tab, setTab] = useState<PhaseTab>("all")
  const [changeOrderOpen, setChangeOrderOpen] = useState(false)
  const [signerReconnectPending, setSignerReconnectPending] = useState(false)
  const [, setGuestSessionEpoch] = useState(0)
  const guestIdentity =
    !hasAccount && selectedFromUrl
      ? getSessionGuestOrderSigningIdentity(selectedFromUrl)
      : null
  const activeBuyerPubkey = accountPubkey ?? guestIdentity?.pubkey ?? null
  useEffect(() => {
    if (!guestIdentity) return
    const delayMs = Math.max(0, guestIdentity.expiresAt - Date.now())
    const timer = window.setTimeout(() => {
      clearSessionGuestOrderSigningIdentity(guestIdentity.orderId)
      void pruneExpiredGuestOrderData()
        .catch(() => {})
        .finally(() => {
          setGuestSessionEpoch((epoch) => epoch + 1)
        })
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [guestIdentity])
  const lifecyclesQuery = useQuery({
    queryKey: [
      "order-lifecycles",
      activeBuyerPubkey ?? "none",
      selectedFromUrl ?? "all",
    ],
    enabled: !!activeBuyerPubkey,
    queryFn: async () => {
      if (hasAccount) {
        const rows = await listOrderLifecycles(activeBuyerPubkey!)
        return Promise.all(
          rows.map((lifecycle) => reconcileOrderPaymentForDisplay(lifecycle))
        )
      }
      if (!selectedFromUrl || !guestIdentity) return []
      const lifecycle = await db.orderLifecycles.get(selectedFromUrl)
      if (!lifecycle || lifecycle.buyerPubkey !== guestIdentity.pubkey)
        return []
      return [await reconcileOrderPaymentForDisplay(lifecycle)]
    },
    refetchInterval: 30_000,
  })
  const messagesQuery = useQuery({
    queryKey: ["buyer-messages-live", activeBuyerPubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchBuyerConversations(activeBuyerPubkey!),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedMessagesQuery = useQuery({
    queryKey: ["buyer-messages", activeBuyerPubkey ?? "none"],
    enabled: hasAccount,
    queryFn: () => fetchCachedBuyerConversations(activeBuyerPubkey!),
    staleTime: 5_000,
  })

  const refetchAll = useCallback(async () => {
    const refreshes: Promise<unknown>[] = [lifecyclesQuery.refetch()]
    if (signerConnected && activeBuyerPubkey) {
      clearProtectedReadAuthenticationSuppression(activeBuyerPubkey)
      refreshes.push(messagesQuery.refetch())
    }
    await Promise.all(refreshes)
  }, [activeBuyerPubkey, lifecyclesQuery, messagesQuery, signerConnected])

  const reconnectSigner = useCallback(async () => {
    setSignerReconnectPending(true)
    try {
      await connect({ mode: "restore" })
    } finally {
      setSignerReconnectPending(false)
    }
  }, [connect])

  useEffect(() => {
    const refetchAfterResume = () => {
      if (document.visibilityState === "hidden") return
      void refetchAll()
    }

    window.addEventListener("focus", refetchAfterResume)
    window.addEventListener("online", refetchAfterResume)
    document.addEventListener("visibilitychange", refetchAfterResume)
    return () => {
      window.removeEventListener("focus", refetchAfterResume)
      window.removeEventListener("online", refetchAfterResume)
      document.removeEventListener("visibilitychange", refetchAfterResume)
    }
  }, [refetchAll])

  const conversations = useMemo(
    () =>
      selectProtectedReadRows(
        messagesQuery.data?.data,
        cachedMessagesQuery.data?.data
      ),
    [cachedMessagesQuery.data, messagesQuery.data]
  )
  const messagesMeta = messagesQuery.data?.meta
  const protectedOrdersReadState = deriveProtectedReadPresentationState({
    visibleCount: conversations.length,
    pending: signerConnected && messagesQuery.isPending,
    error: messagesQuery.error,
    meta: messagesMeta,
  })
  const ordersRefreshState = prepareProtectedReadRefreshState({
    protectedReadState: protectedOrdersReadState,
    protectedReadRefreshing: messagesQuery.isFetching,
    protectedReadPaused: messagesQuery.isPaused,
    additionalSources: [
      {
        refreshing: lifecyclesQuery.isFetching,
        stale: lifecyclesQuery.isError || lifecyclesQuery.isPaused,
      },
    ],
  })
  const lifecycles = useMemo(
    () => lifecyclesQuery.data ?? [],
    [lifecyclesQuery.data]
  )
  const refetchLifecycles = lifecyclesQuery.refetch

  useEffect(() => {
    const nextLeaseExpiry = getNextOrderPaymentLeaseExpiry(lifecycles)
    if (nextLeaseExpiry === null) return

    const timer = window.setTimeout(
      () => {
        void refetchLifecycles()
      },
      Math.max(0, nextLeaseExpiry - Date.now() + 50)
    )
    return () => window.clearTimeout(timer)
  }, [lifecycles, refetchLifecycles])

  useEffect(() => {
    const resumeReceiptObservers = () => {
      if (document.visibilityState === "hidden") return
      for (const lifecycle of lifecycles) {
        if (isOrderPaymentRunning(lifecycle.orderId)) continue
        if (!canObserveOrderPublicZapReceipt(lifecycle)) continue
        const identity =
          guestIdentity?.orderId === lifecycle.orderId &&
          guestIdentity.pubkey === lifecycle.buyerPubkey &&
          guestIdentity.merchantPubkey === lifecycle.merchantPubkey
            ? guestIdentity
            : undefined
        void observeOrderPublicZapReceipt(
          lifecycle.orderId,
          identity,
          {},
          signerConnected ? activeBuyerPubkey : null,
          signerConnected ? activeBuyerPubkey : null,
          identity
            ? undefined
            : () => authGenerationRef.current === authGeneration,
          {
            mode:
              identity || signerConnected
                ? "observe_and_deliver"
                : "observe_only",
          }
        )
      }
    }

    resumeReceiptObservers()
    window.addEventListener("focus", resumeReceiptObservers)
    document.addEventListener("visibilitychange", resumeReceiptObservers)
    return () => {
      window.removeEventListener("focus", resumeReceiptObservers)
      document.removeEventListener("visibilitychange", resumeReceiptObservers)
    }
  }, [
    activeBuyerPubkey,
    authGeneration,
    guestIdentity,
    lifecycles,
    signerConnected,
  ])

  // Merge lifecycle records and relay conversations by orderId.
  const orders = useMemo<OrderRow[]>(() => {
    const byId = new Map<
      string,
      { lifecycle?: OrderLifecycle; conversation?: BuyerConversation }
    >()
    for (const lc of lifecycles) {
      byId.set(lc.orderId, { lifecycle: lc })
    }
    for (const conversation of conversations) {
      const entry = byId.get(conversation.orderId) ?? {}
      entry.conversation = conversation
      byId.set(conversation.orderId, entry)
    }
    const rows: OrderRow[] = []
    for (const [orderId, entry] of byId) {
      const merchantPubkey =
        entry.lifecycle?.merchantPubkey ??
        entry.conversation?.merchantPubkey ??
        ""
      const vm = buildOrderViewModel({
        orderId,
        merchantPubkey,
        lifecycle: entry.lifecycle,
        conversation: entry.conversation,
        messages: entry.conversation?.messages,
      })
      rows.push({
        orderId,
        merchantPubkey,
        lifecycle: entry.lifecycle,
        conversation: entry.conversation,
        vm,
        headerStatus: deriveOrderHeaderStatus(vm),
        updatedAt: vm.updatedAt,
      })
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations, lifecycles])

  useEffect(() => {
    for (const row of orders) {
      const lifecycle = row.lifecycle
      if (!lifecycle || !isBuyerOrderPaid(row.vm)) continue
      void reportCommerceGmvEstimate({
        orderId: lifecycle.orderId,
        orderCreatedAt: lifecycle.createdAt,
        invoicedAmountSats: lifecycle.totalSats,
      })
    }
  }, [lifecyclesQuery.dataUpdatedAt, messagesQuery.dataUpdatedAt, orders])

  const merchantPubkeys = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.merchantPubkey).filter(Boolean))),
    [orders]
  )
  const merchantProfilesQuery = useProfiles(merchantPubkeys, {
    accountPubkey: hasAccount ? activeBuyerPubkey : null,
    authenticatedPubkey: signerConnected ? activeBuyerPubkey : null,
    shouldContinue: () => authGenerationRef.current === authGeneration,
    enabled: merchantPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })
  const merchantName = useCallback(
    (pk: string) =>
      getMerchantDisplayName(merchantProfilesQuery.data?.[pk], pk),
    [merchantProfilesQuery.data]
  )

  const filteredOrders = useMemo(() => {
    const query = searchValue.trim().toLowerCase()
    return orders.filter((row) => {
      if (tab !== "all" && getOrderFilterPhase(row.vm) !== tab) return false
      if (!query) return true
      return (
        merchantName(row.merchantPubkey).toLowerCase().includes(query) ||
        row.orderId.toLowerCase().includes(query) ||
        row.merchantPubkey.toLowerCase().includes(query) ||
        row.headerStatus.primaryLabel.toLowerCase().includes(query) ||
        row.vm.items.some((item) =>
          item.displayTitle.toLowerCase().includes(query)
        )
      )
    })
  }, [tab, merchantName, orders, searchValue])

  const selectedOrderId = useMemo(() => {
    if (paymentFocused && selectedFromUrl) {
      return orders.some((order) => order.orderId === selectedFromUrl)
        ? selectedFromUrl
        : null
    }
    if (
      selectedFromUrl &&
      filteredOrders.some((o) => o.orderId === selectedFromUrl)
    ) {
      return selectedFromUrl
    }
    return filteredOrders[0]?.orderId ?? null
  }, [filteredOrders, orders, paymentFocused, selectedFromUrl])

  const selected = useMemo(
    () => orders.find((o) => o.orderId === selectedOrderId) ?? null,
    [orders, selectedOrderId]
  )
  const selectOrder = useCallback(
    (orderId: string) => {
      setChangeOrderOpen(false)
      void navigate({
        to: "/orders",
        search: { order: orderId },
        replace: true,
      })
    },
    [navigate]
  )

  // Attach the stored payment attempt to the selected order's view-model and
  // subscribe to the live payment service so progress refreshes without reload.
  const paymentAttemptQuery = useQuery({
    queryKey: ["buyer-payment-attempt", selected?.orderId ?? "none"],
    enabled:
      !!selected?.orderId &&
      (!paymentFocused || selected.orderId === selectedFromUrl),
    queryFn: async () =>
      (await db.paymentAttempts.get(selected!.orderId)) ?? null,
  })
  useEffect(() => {
    if (!selected?.orderId) return
    const refreshPaymentState = () => {
      void refetchLifecycles()
      void queryClient.invalidateQueries({
        queryKey: ["buyer-payment-attempt", selected.orderId],
      })
    }
    const unsub = subscribeOrderPayment(selected.orderId, refreshPaymentState)
    if (getOrderPaymentState(selected.orderId)) refreshPaymentState()
    return unsub
  }, [queryClient, refetchLifecycles, selected?.orderId])

  const selectedRow = useMemo<OrderRow | null>(() => {
    if (!selected) return null
    if (!paymentAttemptQuery.data) return selected
    const vm = buildOrderViewModel({
      orderId: selected.orderId,
      merchantPubkey: selected.merchantPubkey,
      lifecycle: selected.lifecycle,
      conversation: selected.conversation,
      messages: selected.conversation?.messages,
      paymentAttempt: paymentAttemptQuery.data,
    })
    return {
      ...selected,
      vm,
      headerStatus: deriveOrderHeaderStatus(vm),
    }
  }, [paymentAttemptQuery.data, selected])

  const hasOrders = orders.length > 0
  const focusedOrderPending =
    paymentFocused &&
    !selected &&
    (lifecyclesQuery.isPending ||
      (signerConnected &&
        (messagesQuery.isPending || protectedOrdersReadState === "pending")))
  const focusedOrderUnavailable =
    paymentFocused && signerConnected && !selected && !focusedOrderPending

  return (
    <div className="space-y-6">
      {paymentFocused && activeBuyerPubkey && (
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            {selected ? "Complete payment" : "Orders"}
          </h1>
          <RefreshChip
            refreshing={ordersRefreshState.refreshing}
            stale={ordersRefreshState.stale}
            onRefresh={refetchAll}
            doneDurationMs={900}
          />
        </div>
      )}
      {!paymentFocused && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
              Orders
            </h1>
            <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
              {signerConnected
                ? "Track your purchases, payment status, and shipping progress."
                : "Review this guest order and its locally saved checkout status. The merchant can use your submitted private recovery contact."}
            </p>
          </div>
          <RefreshChip
            refreshing={ordersRefreshState.refreshing}
            stale={ordersRefreshState.stale}
            onRefresh={refetchAll}
            doneDurationMs={900}
            disabled={!activeBuyerPubkey}
          />
        </div>
      )}

      {remoteSignerRecovery ? (
        <SignerRecoveryNotice
          description="Your locally saved orders, selected order, reply draft, and payment choice remain available. Reconnect, review the current order, then explicitly retry or send."
          reconnecting={signerReconnectPending || status === "restoring"}
          restoreFailed={!!remoteSignerRecovery.restoreError}
          restoreFailureDescription="That saved signer connection could not be restored. No message, receipt, or payment retry was sent."
          onReconnect={reconnectSigner}
        />
      ) : null}

      {!activeBuyerPubkey && (
        <EmptyState
          title={
            selectedFromUrl
              ? "Guest order session not found"
              : "Connect to view your orders"
          }
          body={
            selectedFromUrl
              ? "Guest checkout orders are tied to the browser session that created them. Return from checkout in the same tab before the session expires; the merchant can use the private recovery contact submitted at checkout."
              : "Order updates, invoices, and merchant replies are tied to your signer identity."
          }
        />
      )}

      {!paymentFocused &&
        signerConnected &&
        protectedOrdersReadState !== "pending" && (
          <ProtectedInboxNotice
            state={protectedOrdersReadState}
            subject="orders"
            decryptFailureCount={messagesMeta?.decryptFailures?.length ?? 0}
            onRetry={refetchAll}
            retrying={messagesQuery.isRefetching}
          />
        )}

      {activeBuyerPubkey &&
        !lifecyclesQuery.isPending &&
        !hasOrders &&
        (!signerConnected ||
          (!paymentFocused && protectedOrdersReadState === "complete")) && (
          <EmptyState
            title={hasAccount ? "No orders yet" : "Guest order not found"}
            body={
              hasAccount
                ? "Place your first order and it will appear here with live status."
                : "This guest order is not available in local order history on this device."
            }
            action={
              hasAccount ? (
                <Button asChild className="h-11 px-4 text-sm">
                  <Link to="/products">Browse products</Link>
                </Button>
              ) : undefined
            }
          />
        )}

      {activeBuyerPubkey && focusedOrderPending && (
        <div
          role="status"
          className="mx-auto w-full max-w-3xl py-8 text-center text-sm text-[var(--text-secondary)]"
        >
          Checking order
        </div>
      )}

      {activeBuyerPubkey && focusedOrderUnavailable && (
        <EmptyState
          title="Order unavailable"
          body="This order isn't available in the order data currently on this device or from the available relay reads. Refresh to check again, or return to your full order list."
          action={
            <Button asChild variant="outline" className="h-11 px-4 text-sm">
              <Link to="/orders">View all orders</Link>
            </Button>
          }
        />
      )}

      {activeBuyerPubkey && hasOrders && (!paymentFocused || selectedRow) && (
        <div
          className={
            paymentFocused
              ? "mx-auto max-w-3xl"
              : "grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]"
          }
        >
          {/* Desktop left rail */}
          {!paymentFocused && (
            <aside className="hidden xl:block">
              <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Your orders
                </div>
                <SearchBox value={searchValue} onChange={setSearchValue} />
                <MobileOrderFilterPills tab={tab} onChange={setTab} />
                <OrderList
                  rows={filteredOrders}
                  selectedOrderId={selectedOrderId}
                  merchantName={merchantName}
                  merchantPicture={(pk) =>
                    merchantProfilesQuery.data?.[pk]?.picture
                  }
                  formatSats={formatSats}
                  onSelect={selectOrder}
                />
              </section>
            </aside>
          )}

          {/* Mobile: filter pills + browse sheet + horizontal orders */}
          {!paymentFocused && (
            <div className="min-w-0 space-y-4 overflow-visible xl:hidden">
              <Sheet open={changeOrderOpen} onOpenChange={setChangeOrderOpen}>
                <div className="flex flex-wrap items-center gap-2 overflow-visible">
                  <div className="min-w-full flex-1 overflow-visible sm:min-w-[14rem]">
                    <MobileOrderFilterPills tab={tab} onChange={setTab} />
                  </div>
                  <SheetTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)]"
                    >
                      Browse
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </SheetTrigger>
                </div>
                <MobileOrdersScroller
                  rows={filteredOrders}
                  selectedOrderId={selectedOrderId}
                  merchantName={merchantName}
                  formatSats={formatSats}
                  onSelect={selectOrder}
                />
                <SheetContent
                  side="bottom"
                  className="h-[100dvh] overflow-y-auto"
                >
                  <SheetHeader>
                    <SheetTitle>Your orders</SheetTitle>
                  </SheetHeader>
                  <SearchBox value={searchValue} onChange={setSearchValue} />
                  <MobileOrderFilterPills tab={tab} onChange={setTab} />
                  <OrderList
                    rows={filteredOrders}
                    selectedOrderId={selectedOrderId}
                    merchantName={merchantName}
                    merchantPicture={(pk) =>
                      merchantProfilesQuery.data?.[pk]?.picture
                    }
                    formatSats={formatSats}
                    onSelect={selectOrder}
                  />
                </SheetContent>
              </Sheet>
            </div>
          )}

          {/* Detail */}
          <section className="min-w-0">
            {selectedRow ? (
              <OrderDetail
                key={`${activeBuyerPubkey}:${selectedRow.orderId}`}
                row={selectedRow}
                buyerPubkey={activeBuyerPubkey}
                guestIdentity={guestIdentity}
                accountPubkey={hasAccount ? activeBuyerPubkey : null}
                authenticatedPubkey={signerConnected ? activeBuyerPubkey : null}
                paymentFocused={paymentFocused}
                signerReady={signerConnected}
              />
            ) : (
              <div className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--text-secondary)]">
                Select an order to view its status.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <SearchInput
      aria-label="Search orders"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Search orders"
      containerClassName="mt-3"
      className="bg-[var(--surface-elevated)]"
    />
  )
}

function OrderList({
  rows,
  selectedOrderId,
  merchantName,
  merchantPicture,
  formatSats,
  onSelect,
}: {
  rows: OrderRow[]
  selectedOrderId: string | null
  merchantName: (pk: string) => string
  merchantPicture: (pk: string) => string | undefined
  formatSats: (sats: number) => string
  onSelect: (orderId: string) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-4 rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
        No orders match this filter.
      </div>
    )
  }
  return (
    <div className="mt-4 space-y-2">
      {rows.map((row) => (
        <OrderListCard
          key={row.orderId}
          row={row}
          merchantName={merchantName(row.merchantPubkey)}
          merchantPicture={merchantPicture(row.merchantPubkey)}
          active={row.orderId === selectedOrderId}
          formatSats={formatSats}
          onClick={() => onSelect(row.orderId)}
        />
      ))}
    </div>
  )
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
        <ReceiptText className="h-7 w-7" />
      </div>
      <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
        {title}
      </h2>
      <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
        {body}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </section>
  )
}
