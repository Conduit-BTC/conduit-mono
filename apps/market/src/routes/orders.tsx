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
  isQuantumRouterExecutionEnabled,
  db,
  DexieCheckoutSparkSettledRepository,
  encodeEventMarketNaddr,
  formatEventMarketPickupClaimCode,
  formatEventMarketPickupDate,
  getFutureMarketClaimRef,
  deriveProtectedReadPresentationState,
  EVENT_KINDS,
  formatNpub,
  formatPubkey,
  getAccountSigner,
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
  useAuth,
  useCommerceInbox,
  type PrivateMessageEvent,
  useProfile,
  useProfiles,
  type CommercePriceLike,
  type OrderLifecycle,
  type OrderPaymentTarget,
  type ShopperPriceDisplay,
  type ShopperPriceDisplayOptions,
} from "@conduit/core"
import { reportCommerceGmvEstimate } from "@conduit/core/commerce-gmv"
import {
  CommerceInboxRecovery,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  LightningStrikeOverlay,
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
  MessageCircle,
  ReceiptText,
  RotateCw,
  ShoppingBag,
} from "lucide-react"
import { ConversationProfilePicture } from "../components/ConversationProfilePicture"
import { CheckoutSparkFundingExpiry } from "../components/CheckoutSparkFundingExpiry"
import { CheckoutSparkExternalFunding } from "../components/CheckoutSparkExternalFunding"
import {
  performExternalInvoicePaymentAction,
  type ExternalInvoicePaymentAction,
  type ExternalInvoicePaymentActionResult,
} from "../components/invoice-payment-action"
import {
  applyCheckoutSparkFundingChoice,
  resolveCheckoutSparkFundingSelection,
} from "../components/checkout-spark-funding-selection"
import { CheckoutSparkPaymentReceipt } from "../components/CheckoutSparkPaymentReceipt"
import { CheckoutPaymentProgress } from "../components/CheckoutPaymentProgress"
import { CheckoutCoordinationSummary } from "../components/CheckoutCoordinationSummary"
import { MarketProjectTip } from "../components/MarketProjectTip"
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
import { type BuyerConversation } from "../lib/orderConversations"
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
import {
  presentSettledRouterHeaderStatus,
  presentSettledRouterTimeline,
} from "../lib/checkout-spark-settled-order-presentation"
import { assertCreatedEventMarketPickupTerms } from "../lib/order-pickup-retry"
import { assertCartPickupHandlerReady } from "../lib/pickup-handoff"
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
import { takeSparkPaymentHandoff } from "../lib/order-payment-handoff"
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
  isCurrentGuestOrderSigningIdentity,
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
import {
  getDeliveryNotice,
  publishBuyerOrderMessage,
} from "../lib/order-publish"
import {
  getCheckoutPaymentTargetOptions,
  getCheckoutPaymentTargetValue,
  resolveCheckoutPaymentTarget,
} from "../lib/checkout-payment-target"
import { assertLegacyOrderPaymentAllowed } from "../lib/checkout-spark-order-admission"
import {
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  getCheckoutSparkRecoveryDelivery,
} from "../lib/checkout-spark-recovery-handoff"
import {
  readCurrentCheckoutSparkSettledOrderControl,
  matchesCheckoutSparkSettledOrderControl,
  type CheckoutSparkSettledOrderControlState,
} from "../lib/checkout-spark-settled-order-control"
import { getCheckoutSparkSettledOutcomeMessage } from "../lib/checkout-spark-settled-outcome-message"
import { getCheckoutSparkSettledPreparation } from "../lib/checkout-spark-settled-preparation"
import { canContinueCheckoutSparkSettledRouteSession } from "../lib/checkout-spark-settled-route-session"
import {
  createCheckoutSparkSettledShopperRunner,
  type CheckoutSparkSettledShopperProgress,
} from "../lib/checkout-spark-settled-shopper-runner"
import { retireCheckoutSparkSettledShopper } from "../lib/checkout-spark-settled-retirement"
import type { CheckoutSparkExternalFundingInvoice } from "../lib/checkout-spark-settled-funding"
import { getSparkWalletManager } from "../lib/spark-sdk"
import {
  BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY,
  getCheckoutSparkBuyerSettlementQueryOptions,
  NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS,
  type CheckoutSparkPaymentReceipt as PaymentReceipt,
} from "../lib/checkout-spark-buyer-settlement"

type OrdersSearch = {
  order?: string
  focus?: "payment"
}

const ORDERS_SEARCH_DEFAULT: OrdersSearch = {}

type RouterConfirmation = {
  control: Exclude<
    CheckoutSparkSettledOrderControlState,
    { status: "blocked" | "complete" | "retired" }
  >
  external: boolean
  payerValue: string
  externalAction?: ExternalInvoicePaymentAction
}

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
  receipt?: PaymentReceipt | null
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
              allowZero: item.fulfillment?.type === "event_market_pickup",
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
  isRouterOrder,
}: {
  vm: OrderViewModel
  formatSats: (sats: number) => string
  isRouterOrder: boolean
}) {
  const rows = useMemo(
    () =>
      presentSettledRouterTimeline(
        buildOrderTimeline(vm, formatSats),
        isRouterOrder
      ),
    [formatSats, isRouterOrder, vm]
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
  historyIncomplete,
}: {
  row: OrderRow
  buyerPubkey: string
  guestIdentity?: GuestOrderSigningIdentity | null
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  paymentFocused?: boolean
  signerReady: boolean
  historyIncomplete: boolean
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
  function getCurrentRouterGuestIdentity(): GuestOrderSigningIdentity | null {
    const currentIdentity = guestIdentity
      ? getSessionGuestOrderSigningIdentity(vm.orderId)
      : null
    if (
      !guestIdentity ||
      !currentIdentity ||
      !isGuestGenerationCurrent(authGeneration) ||
      currentIdentity.pubkey !== guestIdentity.pubkey ||
      currentIdentity.createdAt !== guestIdentity.createdAt ||
      currentIdentity.expiresAt !== guestIdentity.expiresAt ||
      !isCurrentGuestOrderSigningIdentity(currentIdentity, {
        orderId: vm.orderId,
        merchantPubkey: row.merchantPubkey,
        pubkey: buyerPubkey,
      })
    ) {
      return null
    }
    return currentIdentity
  }
  const actionsReady = guestIdentity
    ? getCurrentRouterGuestIdentity() !== null
    : signerReady
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
        new Set([
          ...vm.futureMarketFulfillments.map((pickup) =>
            pickup.mode === "organizer_handoff"
              ? pickup.organizerPubkey
              : pickup.merchantPubkey
          ),
        ])
      ),
    [vm.futureMarketFulfillments]
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
  const routerActionInFlightRef = useRef(false)
  const routerApprovalGenerationRef = useRef(0)
  const [routerRunner] = useState(createCheckoutSparkSettledShopperRunner)
  const [routerProgress, setRouterProgress] =
    useState<CheckoutSparkSettledShopperProgress | null>(null)
  const [routerPausing, setRouterPausing] = useState(false)
  const [routerTarget, setRouterTarget] = useState<OrderPaymentTarget | null>(
    null
  )
  const [settledRouterOutcome, setSettledRouterOutcome] = useState<
    string | null
  >(null)
  const [externalFundingInvoice, setExternalFundingInvoice] = useState<
    | (CheckoutSparkExternalFundingInvoice & {
        authGeneration: number
        actionResult?: ExternalInvoicePaymentActionResult
      })
    | null
  >(null)
  const [privateFallbackOpen, setPrivateFallbackOpen] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [paymentAddressUpdate, setPaymentAddressUpdate] =
    useState<OrderPaymentAddressUpdate | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [replyText, setReplyText] = useState("")
  const [replyNotice, setReplyNotice] = useState<{
    buyerPubkey: string
    merchantPubkey: string
    orderId: string
    text: string | null
  } | null>(null)
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
  const declineSparkFeeRef = useRef(sparkFeeApproval.decline)
  useLayoutEffect(() => {
    declineSparkFeeRef.current = sparkFeeApproval.decline
  }, [sparkFeeApproval.decline])
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!actionsReady && sparkFeeApproval.quote) sparkFeeApproval.decline()
  }, [actionsReady, sparkFeeApproval])

  useEffect(() => {
    if (!actionsReady) {
      setExternalFundingInvoice(null)
      routerApprovalGenerationRef.current += 1
      void routerRunner.pause()
    }
  }, [actionsReady, routerRunner])

  useEffect(() => {
    setExternalFundingInvoice(null)
    setSettledRouterOutcome(null)
  }, [
    authGeneration,
    buyerPubkey,
    vm.orderId,
    row.lifecycle?.checkoutSparkRouterBinding?.planDigest,
  ])

  useLayoutEffect(() => {
    const pause = () => {
      routerApprovalGenerationRef.current += 1
      void routerRunner.pause()
      declineSparkFeeRef.current()
    }
    const pauseWhenHidden = () => {
      if (document.visibilityState !== "visible") pause()
    }
    document.addEventListener("visibilitychange", pauseWhenHidden)
    window.addEventListener("pagehide", pause)
    return () => {
      pause()
      document.removeEventListener("visibilitychange", pauseWhenHidden)
      window.removeEventListener("pagehide", pause)
    }
  }, [
    routerRunner,
    authGeneration,
    buyerPubkey,
    vm.orderId,
    row.lifecycle?.checkoutSparkRouterBinding?.planDigest,
  ])

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

  const routerBinding = row.lifecycle?.checkoutSparkRouterBinding
  function isRouterSavedStateCurrent(): boolean {
    return (
      authGenerationRef.current === authGeneration &&
      shouldContinueBuyerSession() &&
      currentViewRef.current.orderId === vm.orderId &&
      currentViewRef.current.merchantPubkey === row.merchantPubkey &&
      (guestIdentity
        ? getCurrentRouterGuestIdentity() !== null
        : authenticatedPubkey === buyerPubkey)
    )
  }
  const settledRouterQuery = useQuery({
    queryKey: [
      "checkout-spark-settled-order-control",
      vm.orderId,
      routerBinding?.planDigest ?? "none",
      buyerPubkey,
      authGeneration,
    ],
    enabled: routerBinding !== undefined && isRouterSavedStateCurrent(),
    queryFn: ({ signal }) => readSettledRouterControl(signal),
    refetchOnWindowFocus: false,
  })
  const settledRouterControl = isRouterSavedStateCurrent()
    ? (settledRouterQuery.data ?? null)
    : null
  const settledControlRefreshAt =
    settledRouterControl?.status === "pay_funding"
      ? settledRouterControl.fundingExpiresAt
      : settledRouterControl?.status === "route_payout"
        ? settledRouterControl.sendWindowEndsAt
        : null
  const refetchSettledRouterControl = settledRouterQuery.refetch
  useEffect(() => {
    if (settledControlRefreshAt === null) return
    let timer = 0
    const refreshAtCutoff = () => {
      const remaining = settledControlRefreshAt - Date.now()
      if (remaining <= 0) {
        void refetchSettledRouterControl()
        return
      }
      timer = window.setTimeout(
        refreshAtCutoff,
        Math.min(remaining, 2_147_483_647)
      )
    }
    refreshAtCutoff()
    return () => window.clearTimeout(timer)
  }, [settledControlRefreshAt, refetchSettledRouterControl])
  const fundingWalletId =
    settledRouterControl?.status === "pay_funding"
      ? settledRouterControl.walletId
      : null
  const routerPayerWallets = eligibleWallets.filter((candidate) => {
    if (candidate.id === fundingWalletId) return false
    if (candidate.providerId === "spark") {
      return wallets.runtime[candidate.id]?.status === "ready"
    }
    if (candidate.providerId === "nwc") {
      const snapshot = wallets.nwcSnapshots[candidate.id]
      return (
        !!snapshot &&
        getNwcPaymentReadiness({
          snapshot,
          walletNetwork: candidate.network,
          configuredNetwork: walletNetwork,
        }).ready
      )
    }
    return false
  })
  const routerPayerOptions = getCheckoutPaymentTargetOptions({
    eligibleWallets: routerPayerWallets,
    // A stale WebLN choice must not stay payable after the browser rail drops.
    selectedTarget: { type: "manual" },
    // Router funding is device-local, independent of a Nostr account signer.
    weblnAvailable: hasWebLN(),
  })
  const routerFundingSelection = resolveCheckoutSparkFundingSelection({
    selection: routerTarget,
    defaultTarget: resolveCheckoutPaymentTarget({
      selection: null,
      eligibleWallets: routerPayerWallets,
      weblnAvailable: hasWebLN(),
    }),
    options: routerPayerOptions,
    guestSession: !!guestIdentity,
  })
  const routerTargetValue =
    routerFundingSelection.selectedOption?.value ??
    (routerTarget ? getCheckoutPaymentTargetValue(routerTarget) : "")
  const routerSelectedOption = routerFundingSelection.selectedOption
  const routerSelectedTarget = routerSelectedOption?.target
  const routerPayerWallet =
    routerSelectedTarget?.type === "wallet"
      ? routerPayerWallets.find(
          (wallet) => wallet.id === routerSelectedTarget.walletId
        )
      : null

  async function readSettledRouterControl(signal?: AbortSignal) {
    return readCurrentCheckoutSparkSettledOrderControl({
      signal,
      isCurrent: isRouterSavedStateCurrent,
      async read(assertCurrent) {
        const lifecycle = await getOrderLifecycle(vm.orderId)
        assertCurrent()
        const binding = lifecycle?.checkoutSparkRouterBinding
        const preparation = binding
          ? getCheckoutSparkSettledPreparation(binding.checkoutId)
          : null
        const snapshot = binding
          ? await new DexieCheckoutSparkSettledRepository().load(
              binding.checkoutId,
              binding.planDigest
            )
          : ({ status: "absent" } as const)
        assertCurrent()
        const initialRecovery = preparation?.recoveryHandoffId
          ? getCheckoutSparkRecoveryDelivery(preparation.recoveryHandoffId)
          : null
        const manager = getSparkWalletManager()
        const currentGuestIdentity = getCurrentRouterGuestIdentity()
        return {
          lifecycle,
          preparation,
          snapshot,
          buyerPubkey:
            currentGuestIdentity || authenticatedPubkey === buyerPubkey
              ? buyerPubkey
              : null,
          guestIdentity: currentGuestIdentity,
          initialRecoverySenderPubkey:
            initialRecovery?.record.senderPubkey ?? null,
          initialRecoveryAcked: Boolean(
            initialRecovery?.deliveryProgress.acknowledgedRelayRefs.length
          ),
          now: Date.now(),
          routerWalletOpen: Boolean(
            binding && manager?.isOpen(binding.walletId)
          ),
        }
      },
    })
  }

  function canContinueRouterSession(): boolean {
    return canContinueCheckoutSparkSettledRouteSession({
      enabled: isQuantumRouterExecutionEnabled(),
      mounted: viewMountedRef.current,
      visible: document.visibilityState === "visible",
      actionsReady,
      identityCurrent: guestIdentity
        ? getCurrentRouterGuestIdentity() !== null
        : authenticatedPubkey === buyerPubkey &&
          isAuthGenerationCurrent(authGeneration),
      orderId: vm.orderId,
      view: currentViewRef.current,
    })
  }

  function canContinueRouterCleanupSession(): boolean {
    const current = currentViewRef.current
    return (
      isQuantumRouterExecutionEnabled() &&
      viewMountedRef.current &&
      actionsReady &&
      authGenerationRef.current === authGeneration &&
      (guestIdentity
        ? getCurrentRouterGuestIdentity() !== null
        : authenticatedPubkey === buyerPubkey &&
          isAuthGenerationCurrent(authGeneration)) &&
      current.orderId === vm.orderId &&
      current.merchantPubkey === row.merchantPubkey &&
      current.phase !== "cancelled" &&
      current.merchantStatus !== "cancelled" &&
      current.merchantStatus !== "refund_requested" &&
      // Completed/paid presentation permits inspection, never another send.
      current.checkoutSparkRouted === true
    )
  }

  async function checkSettledRouterCleanup(): Promise<void> {
    if (routerActionInFlightRef.current) return
    routerActionInFlightRef.current = true
    setSettledRouterOutcome(null)
    try {
      if (!canContinueRouterCleanupSession()) {
        throw new Error(
          "The original buyer session must be active to check wallet cleanup."
        )
      }
      const current = await readSettledRouterControl()
      const displayed = settledRouterControl
      if (
        !canContinueRouterCleanupSession() ||
        current.status !== "complete" ||
        !current.retirement ||
        displayed?.status !== "complete" ||
        !displayed.retirement ||
        current.retirement.checkoutId !== displayed.retirement.checkoutId ||
        current.retirement.planDigest !== displayed.retirement.planDigest ||
        current.retirement.network !== displayed.retirement.network ||
        current.retirement.checkoutId !== routerBinding?.checkoutId ||
        current.retirement.planDigest !== routerBinding.planDigest
      ) {
        throw new Error(
          "Saved wallet cleanup eligibility changed. Refresh this order before checking again."
        )
      }
      const currentGuestIdentity = getCurrentRouterGuestIdentity()
      const result = await retireCheckoutSparkSettledShopper({
        ...current.retirement,
        orderId: vm.orderId,
        merchantPubkey: row.merchantPubkey,
        buyerPubkey,
        guestIdentity: currentGuestIdentity,
        currentGuestIdentity: getCurrentRouterGuestIdentity,
        currentBuyerPubkey: () =>
          !guestIdentity && canContinueRouterCleanupSession()
            ? buyerPubkey
            : null,
        shouldContinue: canContinueRouterCleanupSession,
      })
      if (canContinueRouterCleanupSession()) {
        setSettledRouterOutcome(
          result.status === "retired"
            ? null
            : result.status === "retirement_pending"
              ? "Wallet cleanup is still pending. Saved recovery remains available."
              : "Wallet cleanup could not be verified. Saved recovery remains available."
        )
      }
    } finally {
      routerActionInFlightRef.current = false
      await Promise.all([
        settledRouterQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: [BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY, buyerPubkey],
        }),
      ])
    }
  }

  function canUseRouterExternalInvoice(
    invoice: CheckoutSparkExternalFundingInvoice
  ) {
    if (
      invoice.buyerPubkey !== buyerPubkey ||
      invoice.orderId !== vm.orderId ||
      invoice.checkoutId !== routerBinding?.checkoutId ||
      invoice.planDigest !== routerBinding.planDigest ||
      !canContinueRouterSession()
    )
      return false
    try {
      const now = Date.now()
      const saved = getCheckoutSparkSettledPreparation(invoice.checkoutId)
      return (
        saved?.planDigest === invoice.planDigest &&
        saved.fundingSubmissionState === "provisional" &&
        saved.externalFundingExposedAt === invoice.exposedAt &&
        Number.isSafeInteger(invoice.exposedAt) &&
        Number.isSafeInteger(invoice.expiresAt) &&
        Number.isSafeInteger(invoice.takeoverAt) &&
        invoice.takeoverAt > 0 &&
        invoice.exposedAt > 0 &&
        invoice.exposedAt <= now &&
        now < invoice.expiresAt
      )
    } catch {
      return false
    }
  }

  async function continueSettledRouterCheckout(
    confirmation: RouterConfirmation
  ): Promise<void> {
    if (routerActionInFlightRef.current) return
    routerActionInFlightRef.current = true
    setSettledRouterOutcome(null)
    setExternalFundingInvoice(null)
    setRouterPausing(false)
    const exposeExternalInvoice = confirmation.external
    const approvalGeneration = routerApprovalGenerationRef.current
    const approvedSessionIsCurrent = () =>
      approvalGeneration === routerApprovalGenerationRef.current &&
      canContinueRouterSession()
    try {
      if (!approvedSessionIsCurrent()) {
        throw new Error(
          "Keep this order open in the original buyer session to continue payment."
        )
      }
      const current = await readSettledRouterControl()
      if (
        !approvedSessionIsCurrent() ||
        current.status === "blocked" ||
        current.status === "complete" ||
        current.status === "retired" ||
        !matchesCheckoutSparkSettledOrderControl({
          displayed: confirmation.control,
          current,
          bindingPlanDigest: routerBinding?.planDigest,
        })
      ) {
        throw new Error(
          "Settled router state changed. Refresh this order before continuing."
        )
      }
      const paying = current.status === "pay_funding"
      if (exposeExternalInvoice && !current.externalFundingAvailable) {
        throw new Error(
          "This invoice cannot be opened for external payment. Check its saved funding status."
        )
      }
      const namedExternalChoice =
        confirmation.externalAction !== undefined &&
        exposeExternalInvoice &&
        confirmation.payerValue === "manual" &&
        routerPayerOptions.some((option) => option.target.type === "manual")
      const selectedChoice =
        routerSelectedOption &&
        routerTargetValue === confirmation.payerValue &&
        exposeExternalInvoice ===
          (routerSelectedOption.target.type === "manual")
      if (paying && !namedExternalChoice && !selectedChoice) {
        throw new Error("Choose how to pay before funding this order.")
      }
      const preparation = getCheckoutSparkSettledPreparation(current.checkoutId)
      const currentGuestIdentity = getCurrentRouterGuestIdentity()
      const signer = currentGuestIdentity?.signer ?? getAccountSigner()
      if (
        !preparation?.recoveryHandoffId ||
        !signer ||
        (guestIdentity && !currentGuestIdentity)
      ) {
        throw new Error("The signed recovery handoff is unavailable.")
      }
      const initialHandoffId = preparation.recoveryHandoffId
      const paymentTarget =
        paying && !exposeExternalInvoice
          ? routerSelectedOption!.target
          : ({ type: "manual" } as const)
      let externalActionHandled = false
      const result = await routerRunner.run({
        checkoutId: current.checkoutId,
        planDigest: current.planDigest,
        orderId: vm.orderId,
        merchantPubkey: row.merchantPubkey,
        network: current.network,
        buyerPubkey,
        guestIdentity: currentGuestIdentity,
        currentGuestIdentity: getCurrentRouterGuestIdentity,
        currentBuyerPubkey: () =>
          !guestIdentity && approvedSessionIsCurrent() ? buyerPubkey : null,
        shouldContinue: approvedSessionIsCurrent,
        authorization: {
          planDigest: confirmation.control.planDigest,
          walletId: confirmation.control.walletId,
          grossFundingSats: confirmation.control.grossFundingSats,
        },
        fundingMode: paying || exposeExternalInvoice ? "pay_once" : "inspect",
        onProgress: (progress) => {
          if (!approvedSessionIsCurrent()) return
          setRouterProgress(progress)
          void settledRouterQuery.refetch()
          void queryClient.invalidateQueries({
            queryKey: [BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY, buyerPubkey],
          })
        },
        onExternalInvoice: (invoice) => {
          if (
            !approvedSessionIsCurrent() ||
            !canUseRouterExternalInvoice(invoice)
          )
            return
          if (!confirmation.externalAction) {
            setExternalFundingInvoice({ ...invoice, authGeneration })
            return
          }
          // Observation polls may return the same reservation again. A named
          // browser handoff belongs to this explicit click exactly once.
          if (externalActionHandled) return
          externalActionHandled = true
          // Keep the already-reserved links available even if a clipboard
          // permission prompt stalls or an asynchronous wallet popup is blocked.
          setExternalFundingInvoice({ ...invoice, authGeneration })
          void performExternalInvoicePaymentAction({
            action: confirmation.externalAction,
            invoice: invoice.invoice,
            expectedAmountSats: invoice.amountSats,
            onBeforeInvoiceUse: () =>
              approvedSessionIsCurrent() &&
              canUseRouterExternalInvoice(invoice),
          }).then((actionResult) => {
            if (
              approvedSessionIsCurrent() &&
              canUseRouterExternalInvoice(invoice)
            ) {
              setExternalFundingInvoice({
                ...invoice,
                authGeneration,
                actionResult,
              })
            }
          })
        },
        fundingPayment: {
          buyerPubkey,
          shouldContinue: approvedSessionIsCurrent,
          inspectionOnly:
            current.status === "check_funding" && !exposeExternalInvoice,
          exposeExternalInvoice,
          paymentTarget,
          ...(paymentTarget.type === "wallet"
            ? { walletPaymentAttemptId: crypto.randomUUID() }
            : {}),
          ...(paymentTarget.type === "wallet" &&
          paymentTarget.providerId === "spark"
            ? { approveFee: sparkFeeApproval.requestApproval }
            : {}),
          beforeSend: async () => {
            if (!approvedSessionIsCurrent()) {
              throw new Error("Buyer session changed before funding was sent.")
            }
          },
          timeoutMs: 60_000,
          appId: "market",
        },
        acknowledgeRecoverySnapshot: async (state) => {
          if (!approvedSessionIsCurrent()) {
            throw new Error("Buyer session changed before recovery handoff.")
          }
          await acknowledgeOrRetryCheckoutSparkSettledSnapshot({
            initialHandoffId,
            state,
            identity: currentGuestIdentity ?? {
              kind: "signed_in",
              pubkey: buyerPubkey,
              signer,
            },
            transport: { shouldContinue: approvedSessionIsCurrent },
          })
          if (!approvedSessionIsCurrent()) {
            throw new Error("Buyer session changed during recovery handoff.")
          }
        },
      })
      if (
        viewMountedRef.current &&
        currentViewRef.current.orderId === vm.orderId &&
        authGenerationRef.current === authGeneration
      ) {
        setSettledRouterOutcome(getCheckoutSparkSettledOutcomeMessage(result))
      }
    } finally {
      routerActionInFlightRef.current = false
      setRouterProgress(null)
      setRouterPausing(false)
      await Promise.all([
        settledRouterQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: [BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY, buyerPubkey],
        }),
      ])
    }
  }

  function buildServiceCtx(): OrderPaymentContext | null {
    if (!actionsReady) return null
    if (zeroCostPickupOrder) return null
    const lc = row.lifecycle
    if (!lc) return null
    if (lc.checkoutSparkRouterBinding !== undefined) return null
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
    assertLegacyOrderPaymentAllowed(await getOrderLifecycle(vm.orderId))
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
    await assertCreatedEventMarketPickupTerms({
      id: row.orderId,
      buyerPubkey,
      merchantPubkey: row.merchantPubkey,
      items: (row.lifecycle?.items ?? vm.items).map((item) => ({
        productId: item.productId,
        familyProductId: item.familyProductId,
        selectedSpecifications: item.selectedSpecifications,
        format: item.format ?? "physical",
        quantity: item.quantity,
        priceAtPurchase: item.priceAtPurchase,
        currency: item.currency,
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? item.fulfillment
            : undefined,
        sourcePrice: item.sourcePrice,
        shippingCostSats: item.shippingCostSats,
        sourceShippingCost: item.sourceShippingCost,
      })),
      subtotal: row.lifecycle?.totalSats ?? vm.totalSats ?? 0,
      currency: row.lifecycle?.currency ?? vm.currency,
      shippingCostSats: row.lifecycle?.shippingCostSats ?? 0,
      createdAt: row.lifecycle?.createdAt ?? vm.createdAt,
    })
    await assertCartPickupHandlerReady(
      (row.lifecycle?.items ?? []).map((item) => ({
        fulfillment:
          item.fulfillment?.type === "event_market_pickup"
            ? item.fulfillment
            : undefined,
      })),
      undefined,
      {
        requestingAccountPubkey: authenticatedPubkey,
        authenticatedPubkey,
        shouldContinue: shouldContinueBuyerSession,
      }
    )
  }

  async function retryPayment(): Promise<void> {
    assertLegacyOrderPaymentAllowed(row.lifecycle)
    assertGeneralPaymentRetryEligible()
    await verifyRetryFreshness()
    assertGeneralPaymentRetryEligible()
    const ctx = await persistTargetAndBuildServiceCtx()
    const lifecycle = await getOrderLifecycle(vm.orderId)
    assertLegacyOrderPaymentAllowed(lifecycle)
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
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
    assertLegacyOrderPaymentAllowed(lifecycle)
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
    assertLegacyOrderPaymentAllowed(await getOrderLifecycle(vm.orderId))
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

  const finishAcceptedOrderRecoveryRef = useRef(finishAcceptedOrderRecovery)
  useLayoutEffect(() => {
    finishAcceptedOrderRecoveryRef.current = finishAcceptedOrderRecovery
  })

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

  useEffect(() => {
    if (
      !paymentFocused ||
      !actionsReady ||
      row.lifecycle?.orderDeliveryStatus !== "sent" ||
      row.lifecycle.checkoutSparkRouterBinding !== undefined ||
      row.lifecycle.paymentTarget?.type !== "wallet" ||
      row.lifecycle.paymentTarget.providerId !== "spark"
    ) {
      return
    }
    const handoff = takeSparkPaymentHandoff(vm.orderId, buyerPubkey)
    if (!handoff) return
    void withBusy(async () => {
      await runOrderPayment({
        ...handoff.context,
        approveFee: sparkFeeApproval.requestApproval,
      })
      await handoff.purchaseCleanup
      const current = await getOrderLifecycle(vm.orderId)
      if (!current || !hasCheckoutPaymentProgress(current)) {
        throw new Error(
          "Payment did not start. Continue this accepted order from here."
        )
      }
      await finishAcceptedOrderRecoveryRef.current(current)
    })
  }, [
    actionsReady,
    buyerPubkey,
    paymentFocused,
    row.lifecycle?.orderDeliveryStatus,
    row.lifecycle?.checkoutSparkRouterBinding,
    row.lifecycle?.paymentTarget,
    sparkFeeApproval.requestApproval,
    vm.orderId,
    withBusy,
  ])

  async function confirmPaymentAddressUpdate(): Promise<void> {
    assertLegacyOrderPaymentAllowed(row.lifecycle)
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
    if (routerBinding) {
      setRecoveryError(
        "This order uses Spark routing. Resume its exact saved checkout instead of paying the merchant directly."
      )
      return false
    }
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
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
        lifecycle.checkoutSparkRouterBinding === undefined &&
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
    assertLegacyOrderPaymentAllowed(row.lifecycle)
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
    !routerBinding &&
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
    !routerBinding &&
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
    !routerBinding &&
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
    !routerBinding &&
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
    !vm.checkoutSparkRouted &&
    !zeroCostPickupOrder &&
    vm.paymentStatus === "paid" &&
    (vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed")
  const showRetryOrderDelivery =
    row.lifecycle?.orderDeliveryStatus === "pending" &&
    !!row.lifecycle.orderRelayDelivery
  const showContinueAcceptedCheckout =
    !zeroCostPickupOrder &&
    !routerBinding &&
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
      if (!getAccountSigner()) throw new Error("Signer not connected")

      const rumor: PrivateMessageEvent = {
        id: "",
        pubkey: buyerPubkey,
        kind: 16,
        tags: [],
        content: "",
      }
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
      const delivery = await publishBuyerOrderMessage(
        rumor,
        row.merchantPubkey,
        buyerPubkey,
        {
          accountPubkey: authenticatedPubkey ?? null,
          authenticatedPubkey: authenticatedPubkey ?? null,
          shouldContinue: shouldContinueBuyerSession,
        }
      )
      return {
        delivery,
        buyerPubkey,
        merchantPubkey: row.merchantPubkey,
        orderId: vm.orderId,
        draft: replyText,
        isCurrent: shouldContinueBuyerSession,
      }
    },
    onSuccess: (sent) => {
      setReplyNotice({
        buyerPubkey: sent.buyerPubkey,
        merchantPubkey: sent.merchantPubkey,
        orderId: sent.orderId,
        text: getDeliveryNotice(sent.delivery, "Message"),
      })
      if (
        !sent.isCurrent() ||
        !viewMountedRef.current ||
        currentViewRef.current.orderId !== sent.orderId ||
        currentViewRef.current.merchantPubkey !== sent.merchantPubkey
      )
        return
      setReplyText((draft) => (draft === sent.draft ? "" : draft))
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages", buyerPubkey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages-live", buyerPubkey],
        }),
      ]).catch(() => console.warn("Could not refresh accepted order reply"))
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
                    to="/$identityRef"
                    params={{ identityRef: pubkeyToNpub(row.merchantPubkey) }}
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

      {!zeroCostPickupOrder && isBuyerOrderPaid(vm) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <p className="text-sm text-[var(--text-secondary)]">
            Had a good experience?
          </p>
          <MarketProjectTip className="min-h-11 text-primary-500" />
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

      {showFinishAcceptedOrderRecovery && !showExternalWallet && (
        <StatusNotice variant="info" title="Finish saving this order">
          <p className="text-pretty text-sm text-[var(--text-secondary)]">
            Finish saving this order before starting another checkout from the
            same cart.
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

      {routerBinding && !isQuantumRouterExecutionEnabled() && (
        <StatusNotice variant="warning" title="Payment processing paused">
          <p className="text-sm text-[var(--text-secondary)]">
            Saved payment status remains available. Processing is paused in this
            build; do not pay again or try a different rail.
          </p>
        </StatusNotice>
      )}

      {routerBinding && (
        <StatusNotice
          variant={
            settledRouterControl?.status === "complete" &&
            vm.checkoutSparkCommerceVerified === true
              ? "success"
              : settledRouterControl?.status === "blocked" ||
                  settledRouterQuery.isError
                ? "warning"
                : "info"
          }
          title={
            settledRouterControl?.status === "retired"
              ? "Payment complete"
              : "Order payment"
          }
          detail={
            settledRouterControl &&
            settledRouterControl.status !== "blocked" &&
            settledRouterControl.status !== "retired"
              ? settledRouterControl.status === "complete"
                ? "Payment recorded"
                : settledRouterControl.status === "pay_funding"
                  ? "Awaiting payment"
                  : "Completing payment"
              : undefined
          }
        >
          {settledRouterControl && "priceSummary" in settledRouterControl && (
            <div className="mb-4 max-w-lg">
              <CheckoutCoordinationSummary
                price={settledRouterControl.priceSummary}
                formatSats={formatSats}
              />
            </div>
          )}
          {settledRouterQuery.isPending ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Checking this order&apos;s saved payment state…
            </p>
          ) : settledRouterQuery.isError ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Saved payment status could not be read. Do not pay again until it
              is checked.
            </p>
          ) : settledRouterControl?.status === "blocked" ? (
            <p className="text-sm text-[var(--text-secondary)]">
              {settledRouterControl.reason}
            </p>
          ) : settledRouterControl?.status === "complete" ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--text-secondary)]">
                Your payment is recorded. Delivery confirmation is separate;
                check the order status for the latest confirmation.
              </p>
              <details className="text-xs leading-5 text-[var(--text-secondary)]">
                <summary className="cursor-pointer">
                  Checkout recovery details
                </summary>
                <p className="my-2">
                  Keep recovery details until the checkout wallet can be safely
                  retired.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 px-4 text-sm"
                  disabled={
                    busy ||
                    settledRouterQuery.isFetching ||
                    !settledRouterControl.retirement ||
                    !canContinueRouterCleanupSession()
                  }
                  onClick={() => void withBusy(checkSettledRouterCleanup)}
                >
                  Check wallet cleanup
                </Button>
                <p className="text-xs text-[var(--text-secondary)]">
                  Checks whether the checkout wallet is safe to retire. Sends no
                  funds.
                </p>
              </details>
            </div>
          ) : settledRouterControl?.status === "retired" ? (
            <p className="text-sm text-[var(--text-secondary)]">
              Payment processing is complete. Delivery confirmation is separate.
            </p>
          ) : settledRouterControl ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--text-secondary)]">
                {settledRouterControl.status === "pay_funding"
                  ? "Pay once for this order. After your payment is verified, we'll finish automatically."
                  : "Continue this order from its saved payment status. An uncertain payment is never sent again."}
              </p>
              <p className="text-xs leading-5 text-[var(--text-secondary)]">
                Keep this order visible while your payment finishes. You can
                pause processing; a submitted payment cannot be cancelled. Your
                wallet may charge a separate fee.
              </p>
              {(settledRouterControl.status === "pay_funding" ||
                settledRouterControl.status === "check_funding") && (
                <CheckoutSparkFundingExpiry
                  expiresAt={settledRouterControl.fundingExpiresAt}
                />
              )}
              {!row.receipt && (
                <details className="text-xs leading-5 text-[var(--text-secondary)]">
                  <summary className="cursor-pointer">Payment details</summary>
                  <p className="mt-2">
                    Gross funding:{" "}
                    {settledRouterControl.grossFundingSats.toLocaleString()}{" "}
                    sats
                    {settledRouterControl.creditedSats !== null
                      ? ` · exact credit: ${settledRouterControl.creditedSats.toLocaleString()} sats`
                      : " · exact credit pending"}
                    . Each recipient payment is verified before the next starts.
                  </p>
                </details>
              )}
              {routerProgress && routerProgress.phase !== "funding" && (
                <CheckoutPaymentProgress pausing={routerPausing} />
              )}
              {settledRouterControl.status === "pay_funding" &&
                routerFundingSelection.showSelector && (
                  <div className="grid max-w-sm gap-1.5">
                    <label
                      htmlFor={`settled-router-payer-${vm.orderId}`}
                      className="text-xs font-medium text-[var(--text-secondary)]"
                    >
                      Pay with
                    </label>
                    <Select
                      value={routerTargetValue}
                      onValueChange={(value) =>
                        setRouterTarget((selection) =>
                          applyCheckoutSparkFundingChoice({
                            selection,
                            value,
                            options: routerPayerOptions,
                          })
                        )
                      }
                      disabled={busy || wallets.loading}
                    >
                      <SelectTrigger
                        id={`settled-router-payer-${vm.orderId}`}
                        className={PAYMENT_TARGET_SELECT_TRIGGER_CLASS_NAME}
                      >
                        <PaymentTargetSelectValue
                          target={routerSelectedOption?.target ?? null}
                          eligibleWallets={routerPayerWallets}
                          walletDisplayLabels={getWalletDisplayLabels(
                            routerPayerWallets
                          )}
                          weblnAvailable={weblnAvailable}
                          placeholder="Choose a ready wallet"
                        />
                      </SelectTrigger>
                      <PaymentTargetSelectContent
                        options={routerPayerOptions}
                        eligibleWallets={routerPayerWallets}
                        walletDisplayLabels={getWalletDisplayLabels(
                          routerPayerWallets
                        )}
                        staleWalletValue={null}
                        weblnAvailable={weblnAvailable}
                      />
                    </Select>
                  </div>
                )}
              <Button
                type="button"
                className="h-11 px-4 text-sm"
                disabled={
                  busy ||
                  !actionsReady ||
                  !canContinueRouterSession() ||
                  settledRouterQuery.isFetching ||
                  (settledRouterControl.status === "route_payout" &&
                    !settledRouterControl.payoutReview &&
                    !settledRouterControl.nativeTreasury?.prepared) ||
                  (settledRouterControl.status === "pay_funding" &&
                    !routerSelectedOption)
                }
                onClick={() =>
                  void withBusy(() =>
                    continueSettledRouterCheckout({
                      control: settledRouterControl,
                      external:
                        settledRouterControl.status === "pay_funding" &&
                        routerSelectedOption?.target.type === "manual",
                      payerValue: routerTargetValue,
                    })
                  )
                }
              >
                {settledRouterControl.status === "pay_funding"
                  ? "Pay for order"
                  : "Resume payment"}
              </Button>
              {routerProgress && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={routerPausing}
                  onClick={() => {
                    setRouterPausing(true)
                    routerApprovalGenerationRef.current += 1
                    void routerRunner.pause()
                    sparkFeeApproval.decline()
                  }}
                >
                  Pause payment
                </Button>
              )}
              {settledRouterControl.status === "check_funding" &&
                !externalFundingInvoice &&
                settledRouterControl.externalFundingAvailable && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 px-4 text-sm"
                    disabled={
                      busy ||
                      !canContinueRouterSession() ||
                      settledRouterQuery.isFetching
                    }
                    onClick={() =>
                      void withBusy(() =>
                        continueSettledRouterCheckout({
                          control: settledRouterControl,
                          external: true,
                          payerValue: routerTargetValue,
                        })
                      )
                    }
                  >
                    Reopen external invoice
                  </Button>
                )}
              <CheckoutSparkExternalFunding
                externalInvoice={externalFundingInvoice}
                enabled={
                  settledRouterControl.externalFundingAvailable === true &&
                  canContinueRouterSession() &&
                  ((settledRouterControl.status === "pay_funding" &&
                    !externalFundingInvoice) ||
                    (settledRouterControl.status === "check_funding" &&
                      externalFundingInvoice?.authGeneration ===
                        authGeneration &&
                      canUseRouterExternalInvoice(externalFundingInvoice)))
                }
                preparation={
                  settledRouterControl.status === "pay_funding"
                    ? {
                        amountSats: settledRouterControl.grossFundingSats,
                        cashAppAvailable:
                          settledRouterControl.network === "mainnet",
                        disabled:
                          busy ||
                          !actionsReady ||
                          settledRouterQuery.isFetching,
                        onApprove: (externalAction) => {
                          void withBusy(() =>
                            continueSettledRouterCheckout({
                              control: settledRouterControl,
                              external: true,
                              payerValue: "manual",
                              externalAction,
                            })
                          )
                        },
                      }
                    : undefined
                }
                actionResult={externalFundingInvoice?.actionResult}
                onBeforeInvoiceUse={() =>
                  !!externalFundingInvoice &&
                  externalFundingInvoice.authGeneration === authGeneration &&
                  canUseRouterExternalInvoice(externalFundingInvoice)
                }
                preference={shopperPricing.preference}
                quote={shopperPricing.quote}
              />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-9 px-3 text-xs"
              disabled={busy || settledRouterQuery.isFetching}
              onClick={() => void settledRouterQuery.refetch()}
            >
              Refresh saved status
            </Button>
            {settledRouterOutcome && (
              <span className="text-xs text-[var(--text-secondary)]">
                {settledRouterOutcome}
              </span>
            )}
          </div>
        </StatusNotice>
      )}

      {routerBinding && row.receipt && (
        <CheckoutSparkPaymentReceipt receipt={row.receipt} />
      )}

      {routerBinding &&
        settledRouterControl?.status !== "retired" &&
        settledRouterControl?.status !== "complete" && (
          <p
            role="note"
            className="text-xs leading-5 text-[var(--text-secondary)]"
          >
            Keep this page open until payment processing finishes. If you leave,
            return to this order to check its saved status—do not pay again. If
            you cannot return, the merchant can help recover your checkout.
          </p>
        )}

      {!routerBinding &&
        (manualInvoiceAccess === "report_only" ||
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

      {showFinishAcceptedOrderRecovery && showExternalWallet && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <Button
            variant="outline"
            className="h-10 w-full px-4 text-sm"
            disabled={busy}
            onClick={() => void withBusy(finishAcceptedOrderRecovery)}
          >
            <Check className="h-4 w-4" />
            Finish saving this order
          </Button>
          {recoveryError && (
            <p
              role="alert"
              className="mt-2 text-pretty text-sm text-[var(--destructive)]"
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
          routerBinding && routerPayerWallet?.providerId === "spark"
            ? routerPayerWallet.label
            : paymentWallet?.providerId === "spark"
              ? (eligibleWalletDisplayLabels.get(paymentWallet.id) ??
                paymentWallet.label)
              : undefined
        }
      />

      {paymentFocused ? (
        <div className="space-y-4">
          {!showExternalWallet && (
            <OrderTimeline
              vm={vm}
              formatSats={formatSats}
              isRouterOrder={vm.checkoutSparkRouted === true}
            />
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
          <OrderTimeline
            vm={vm}
            formatSats={formatSats}
            isRouterOrder={vm.checkoutSparkRouted === true}
          />

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

            {vm.futureMarketFulfillments.map((pickup) => {
              const marketRef = encodeEventMarketNaddr(pickup.market.coordinate)
              const handlerPubkey =
                pickup.mode === "organizer_handoff"
                  ? pickup.organizerPubkey
                  : pickup.merchantPubkey
              const claimCode =
                pickup.mode === "organizer_handoff"
                  ? formatEventMarketPickupClaimCode(
                      getFutureMarketClaimRef({
                        orderId: vm.orderId,
                        merchantPubkey: vm.merchantPubkey,
                        organizerPubkey: pickup.organizerPubkey,
                        marketCoordinate: pickup.market.coordinate,
                      })
                    )
                  : null
              return (
                <section
                  key={pickup.market.coordinate}
                  className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"
                  data-testid="future-market-order-pickup"
                >
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Event pickup
                  </h3>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    {pickup.assignment}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    Selected date: {formatEventMarketPickupDate(pickup)}
                  </p>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    Handled by{" "}
                    <EventActorName
                      identity={eventActorIdentity(handlerPubkey)}
                    />
                  </p>
                  {claimCode && (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm">
                      <span className="text-[var(--text-secondary)]">
                        Pickup code
                      </span>
                      <span className="flex items-center gap-2 font-mono font-semibold tracking-wide text-[var(--text-primary)]">
                        {claimCode}
                        <CopyButton
                          value={claimCode}
                          npub={false}
                          label="Copy organizer pickup code"
                        />
                      </span>
                    </div>
                  )}
                  <Button asChild variant="outline" className="mt-4 h-9">
                    <Link
                      to="/events/$collectionRef"
                      params={{ collectionRef: marketRef }}
                    >
                      View event market
                    </Link>
                  </Button>
                </section>
              )
            })}

            {/* Shipping address */}
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
                  to="/$identityRef"
                  params={{ identityRef: pubkeyToNpub(row.merchantPubkey) }}
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
          historyIncomplete={historyIncomplete}
          notice={
            replyNotice?.buyerPubkey === buyerPubkey &&
            replyNotice.merchantPubkey === row.merchantPubkey &&
            replyNotice.orderId === vm.orderId &&
            replyNotice.text ? (
              <p role="status" className="text-sm text-warning">
                {replyNotice.text}
              </p>
            ) : null
          }
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
    isAuthGenerationCurrent,
    isGuestGenerationCurrent,
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
  const [lightningPlaying, setLightningPlaying] = useState(false)
  const priorSelectedPaymentRef = useRef<{
    orderId: string
    paymentStatus: string
  } | null>(null)
  const celebratedOrdersRef = useRef(new Set<string>())
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
      // Hide cached guest payment projections immediately, not after DB pruning.
      setGuestSessionEpoch((epoch) => epoch + 1)
      void pruneExpiredGuestOrderData().catch(() => {})
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
  const inbox = useCommerceInbox(activeBuyerPubkey, signerConnected)
  const messagesQuery = inbox.buyer

  const refetchAll = useCallback(async () => {
    const refreshes: Promise<unknown>[] = [
      lifecyclesQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: [
          BUYER_CHECKOUT_SPARK_SETTLEMENT_QUERY_KEY,
          activeBuyerPubkey ?? "none",
        ],
      }),
    ]
    if (signerConnected && activeBuyerPubkey) {
      clearProtectedReadAuthenticationSuppression(activeBuyerPubkey)
      refreshes.push(messagesQuery.refetch())
    }
    await Promise.all(refreshes)
  }, [
    activeBuyerPubkey,
    lifecyclesQuery,
    messagesQuery,
    queryClient,
    signerConnected,
  ])

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
    () => messagesQuery.data?.data ?? [],
    [messagesQuery.data]
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
  function getCurrentSettlementGuestIdentity(): GuestOrderSigningIdentity | null {
    const currentIdentity = guestIdentity
      ? getSessionGuestOrderSigningIdentity(guestIdentity.orderId)
      : null
    if (
      !guestIdentity ||
      !currentIdentity ||
      !isGuestGenerationCurrent(authGeneration) ||
      currentIdentity.pubkey !== guestIdentity.pubkey ||
      currentIdentity.createdAt !== guestIdentity.createdAt ||
      currentIdentity.expiresAt !== guestIdentity.expiresAt ||
      !isCurrentGuestOrderSigningIdentity(currentIdentity, {
        orderId: guestIdentity.orderId,
        merchantPubkey: guestIdentity.merchantPubkey,
        pubkey: guestIdentity.pubkey,
      })
    ) {
      return null
    }
    return currentIdentity
  }
  const canReadRouterSettlement = guestIdentity
    ? getCurrentSettlementGuestIdentity() !== null
    : signerConnected && isAuthGenerationCurrent(authGeneration)
  const buyerSettlementsQuery = useQuery(
    getCheckoutSparkBuyerSettlementQueryOptions({
      enabled: canReadRouterSettlement,
      lifecycles,
      buyerPubkey: activeBuyerPubkey,
      guestIdentity,
      currentGuestIdentity: getCurrentSettlementGuestIdentity,
      authGeneration,
      isAuthGenerationCurrent: guestIdentity
        ? isGuestGenerationCurrent
        : isAuthGenerationCurrent,
    })
  )
  const buyerSettlements = canReadRouterSettlement
    ? (buyerSettlementsQuery.data ?? NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS)
    : NO_BUYER_CHECKOUT_SPARK_SETTLEMENTS

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
        checkoutSparkSettlement: buyerSettlements.get(orderId),
      })
      rows.push({
        orderId,
        merchantPubkey,
        lifecycle: entry.lifecycle,
        conversation: entry.conversation,
        vm,
        receipt: buyerSettlements.get(orderId)?.receipt,
        headerStatus: presentSettledRouterHeaderStatus(
          deriveOrderHeaderStatus(vm),
          vm.checkoutSparkRouted === true
        ),
        updatedAt: vm.updatedAt,
      })
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [buyerSettlements, conversations, lifecycles])

  useEffect(() => {
    for (const row of orders) {
      const lifecycle = row.lifecycle
      if (!lifecycle || !isBuyerOrderPaid(row.vm)) continue
      if (
        row.vm.checkoutSparkRouted &&
        (!canReadRouterSettlement || !isAuthGenerationCurrent(authGeneration))
      )
        continue
      void reportCommerceGmvEstimate({
        orderId: lifecycle.orderId,
        orderCreatedAt: lifecycle.createdAt,
        invoicedAmountSats: lifecycle.totalSats,
      })
    }
  }, [
    authGeneration,
    canReadRouterSettlement,
    isAuthGenerationCurrent,
    lifecyclesQuery.dataUpdatedAt,
    messagesQuery.dataUpdatedAt,
    orders,
  ])

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
      checkoutSparkSettlement: buyerSettlements.get(selected.orderId),
    })
    return {
      ...selected,
      vm,
      headerStatus: presentSettledRouterHeaderStatus(
        deriveOrderHeaderStatus(vm),
        vm.checkoutSparkRouted === true
      ),
    }
  }, [buyerSettlements, paymentAttemptQuery.data, selected])

  useEffect(() => {
    const current = selectedRow?.lifecycle
    if (!current) return
    const previous = priorSelectedPaymentRef.current
    priorSelectedPaymentRef.current = {
      orderId: current.orderId,
      paymentStatus: current.paymentStatus,
    }
    if (
      current.paymentStatus !== "paid" ||
      getOrderPaymentState(current.orderId)?.lifecycle?.paymentStatus !==
        "paid" ||
      celebratedOrdersRef.current.has(current.orderId)
    ) {
      return
    }
    const observedTransition =
      previous?.orderId === current.orderId && previous.paymentStatus !== "paid"
    if (paymentFocused || observedTransition) {
      celebratedOrdersRef.current.add(current.orderId)
      setLightningPlaying(true)
    }
  }, [paymentFocused, selectedRow])

  useEffect(() => {
    if (
      !paymentFocused ||
      !selectedRow ||
      selectedRow.orderId !== selectedFromUrl ||
      selectedRow.lifecycle?.paymentStatus !== "paid"
    ) {
      return
    }
    void navigate({
      to: "/orders",
      search: { order: selectedRow.orderId },
      replace: true,
    })
  }, [navigate, paymentFocused, selectedFromUrl, selectedRow])

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
      <CommerceInboxRecovery {...inbox} />
      <LightningStrikeOverlay
        open={lightningPlaying}
        onComplete={() => setLightningPlaying(false)}
      />
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
                key={`${activeBuyerPubkey}:${selectedRow.merchantPubkey}:${selectedRow.orderId}`}
                row={selectedRow}
                buyerPubkey={activeBuyerPubkey}
                guestIdentity={guestIdentity}
                accountPubkey={hasAccount ? activeBuyerPubkey : null}
                authenticatedPubkey={signerConnected ? activeBuyerPubkey : null}
                paymentFocused={paymentFocused}
                signerReady={signerConnected}
                historyIncomplete={protectedOrdersReadState !== "complete"}
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
