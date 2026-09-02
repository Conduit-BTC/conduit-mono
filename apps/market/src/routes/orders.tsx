import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  getProductImageCandidates,
  getOrderPublicZapSigner,
  getWalletDisplayLabels,
  getWalletNetworkFromLightningConfig,
  hasWebLN,
  listOrderLifecycles,
  normalizeLightningInvoice,
  ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR,
  pruneExpiredGuestOrderData,
  prepareProtectedReadRefreshState,
  pubkeyToNpub,
  replaceOrderPaymentTarget,
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
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DecryptFailureNotice,
  LiveReadNotice,
  OrderMessagesWidget,
  SearchInput,
  RefreshChip,
  Select,
  SelectTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  StatusStepper,
} from "@conduit/ui"
import {
  ChevronRight,
  Copy,
  ExternalLink,
  LoaderCircle,
  MapPin,
  MessageCircle,
  ReceiptText,
  RotateCw,
  ShoppingBag,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { ConversationProfilePicture } from "../components/ConversationProfilePicture"
import { CopyButton } from "../components/CopyButton"
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
  deriveBoundMerchantInvoiceAccess,
  deriveOrderHeaderStatus,
  getOrderFilterPhase,
  getOrderPaymentMethodLabel,
  isZeroCostPickupOrder,
  type OrderHeaderStatus,
  type OrderViewModel,
} from "../lib/order-view"
import { verifyPickupCartFreshness } from "../lib/event-market-adapter"
import {
  assertCartPickupHandlerReady,
  getOrganizerPickupClaimCode,
  getPickupHandoffPrivacyCopy,
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
  isMerchantInvoicePaymentActionBound,
  observeOrderPublicZapReceipt,
  prepareMerchantInvoicePaymentAction,
  resendOrderProof,
  runOrderPrivateFallback,
  runOrderPayment,
  submitExternalPaymentProof,
  subscribeOrderPayment,
  validateMerchantInvoicePaymentAction,
  type OrderPaymentContext,
} from "../lib/order-payment-service"
import {
  getNextOrderPaymentLeaseExpiry,
  reconcileOrderPaymentForDisplay,
} from "../lib/order-payment-recovery"

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
  doesAuthorizedAnonZapPricingMatchOrder,
  type CheckoutZapMode,
} from "../lib/checkout-payment"
import { publishBuyerOrderMessage } from "../lib/order-publish"
import {
  getCheckoutPaymentTargetOptions,
  getCheckoutPaymentTargetValue,
} from "../lib/checkout-payment-target"

const ORDERS_SEARCH_DEFAULT: { order?: string } = {}

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
  validateSearch: (search: Record<string, unknown>): { order?: string } => {
    const order = search.order
    return typeof order === "string" && order.length > 0
      ? { order }
      : ORDERS_SEARCH_DEFAULT
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

/** External-wallet QR fallback (CND-120): shown when payment is manual_required. */
function ExternalWalletPanel({
  vm,
  onMarkPaid,
  onBeforeInvoiceUse,
  onPrepareMerchantInvoice,
  merchantInvoicePrepared,
  boundMerchantInvoiceExpiresAt,
  busy,
  guestSession,
  autoDetectReceipt,
}: {
  vm: OrderViewModel
  onMarkPaid: () => void
  onBeforeInvoiceUse: () => boolean
  onPrepareMerchantInvoice: () => void
  merchantInvoicePrepared: boolean
  boundMerchantInvoiceExpiresAt: number | null
  busy: boolean
  guestSession: boolean
  autoDetectReceipt: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1_000)
  )
  const invoice = vm.invoice
  const merchantInvoice = vm.merchantInvoiceAction
  const hasBoundMerchantInvoice =
    vm.checkoutMode === "pay_later" &&
    vm.paymentStatus === "manual_required" &&
    !!invoice &&
    boundMerchantInvoiceExpiresAt !== null
  const isMerchantInvoice = !!merchantInvoice || hasBoundMerchantInvoice
  const merchantInvoiceExpiry =
    merchantInvoice?.expiresAt ??
    (hasBoundMerchantInvoice ? boundMerchantInvoiceExpiresAt : null)
  useEffect(() => {
    if (merchantInvoiceExpiry === null) return
    const remainingMs = merchantInvoiceExpiry * 1_000 - Date.now()
    const timer = window.setTimeout(
      () => setNowSeconds(Math.floor(Date.now() / 1_000)),
      Math.max(0, Math.min(remainingMs, 2_147_483_647))
    )
    return () => window.clearTimeout(timer)
  }, [merchantInvoiceExpiry, nowSeconds])
  if (!invoice) return null
  if (merchantInvoice?.status === "payable" && !merchantInvoicePrepared) {
    return (
      <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          Merchant invoice ready
        </h2>
        <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
          Confirm this invoice before opening it. Orders will keep this exact
          invoice attached to the payment report.
        </p>
        <Button
          className="mt-4 h-10 px-4 text-sm"
          disabled={busy}
          onClick={onPrepareMerchantInvoice}
        >
          Use merchant invoice
        </Button>
      </section>
    )
  }
  const merchantInvoiceExpired =
    isMerchantInvoice &&
    merchantInvoiceExpiry !== null &&
    merchantInvoiceExpiry <= nowSeconds
  const merchantInvoiceBlocked =
    merchantInvoice?.status === "blocked" || merchantInvoiceExpired
  const merchantInvoiceCanReport =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.canReport
      : merchantInvoiceExpired
  const merchantInvoiceError =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.reason
      : merchantInvoiceExpired
        ? "The invoice returned by the merchant is already expired."
        : null
  if (merchantInvoiceBlocked) {
    return (
      <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          Invoice unavailable
        </h2>
        <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
          {merchantInvoiceError}
        </p>
        {merchantInvoiceCanReport && (
          <div className="mt-4 space-y-2">
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              disabled={busy}
              onClick={onMarkPaid}
            >
              Report a payment already made
            </Button>
            <p className="text-pretty text-xs text-[var(--text-secondary)]">
              Only report this if your wallet confirms it paid this exact
              invoice before expiry.
            </p>
          </div>
        )}
      </section>
    )
  }
  const bolt11 = normalizeLightningInvoice(invoice)
  const copy = async () => {
    if (!onBeforeInvoiceUse()) return
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
      <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
        {isMerchantInvoice
          ? "Pay merchant invoice"
          : "Pay with an external wallet"}
      </h2>
      <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
        {autoDetectReceipt
          ? "Check your wallet first if an automatic payment was already attempted. Otherwise scan or copy this invoice and pay it once. Conduit will match the public Lightning receipt and notify the merchant automatically."
          : isMerchantInvoice
            ? "Scan, copy, or open this merchant invoice. After your wallet confirms payment, report it to the merchant for verification."
            : "Automatic payment did not complete. Check your wallet first, then pay this same invoice once and report it to the merchant for verification. This invoice can only settle once, so paying it again is safe if nothing was sent."}
      </p>
      {guestSession && (
        <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
          {autoDetectReceipt
            ? "Return to this same tab after paying so Conduit can finish receipt detection. Closing it ends local access to this guest order."
            : "Keep this tab open until the payment is reported. Closing it ends local access to this guest order. The merchant can use the private recovery contact submitted at checkout."}
        </p>
      )}
      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={bolt11} size={156} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild className="h-10 px-4 text-sm">
              <a
                href={`lightning:${bolt11}`}
                onClick={(event) => {
                  if (!onBeforeInvoiceUse()) event.preventDefault()
                }}
              >
                <ExternalLink className="h-4 w-4" />
                Open in wallet
              </a>
            </Button>
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              onClick={copy}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy invoice"}
            </Button>
          </div>
          <div className="max-h-24 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-secondary)]">
            {invoice}
          </div>
          {autoDetectReceipt ? (
            <p className="text-xs leading-5 text-[var(--text-secondary)]">
              Waiting for the matching receipt. If your wallet confirms payment,
              do not pay this invoice again while detection completes.
            </p>
          ) : (
            <>
              <Button
                variant="primary"
                className="h-10 px-4 text-sm"
                disabled={busy}
                onClick={onMarkPaid}
              >
                Report payment to merchant
              </Button>
              <p className="text-xs text-[var(--text-secondary)]">
                Only report after your wallet confirms payment. This does not
                verify settlement; the merchant will confirm it.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function OrderDetail({
  row,
  buyerPubkey,
  guestIdentity,
}: {
  row: OrderRow
  buyerPubkey: string
  guestIdentity?: GuestOrderSigningIdentity | null
}) {
  const { vm, headerStatus } = row
  const zeroCostPickupOrder = isZeroCostPickupOrder(vm)
  const wallets = useWallets()
  const shopperPricing = useShopperPricing()
  const formatSats = (sats: number) =>
    shopperPricing.formatSatsAmount(sats).primary
  const { data: profile } = useProfile(row.merchantPubkey, {
    maxUnresolvedRefetches: 1,
  })
  const merchantName = getMerchantDisplayName(profile, row.merchantPubkey)
  const [busy, setBusy] = useState(false)
  const [privateFallbackOpen, setPrivateFallbackOpen] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
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
  const sparkFeeApproval = useSparkFeeApproval()
  const queryClient = useQueryClient()

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
    queryKey: ["selected-order-products", row.merchantPubkey],
    enabled: !!row.merchantPubkey,
    queryFn: () => fetchStoreProducts(row.merchantPubkey),
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
    const replacement = await replaceOrderPaymentTarget(
      vm.orderId,
      selectedStoredPaymentTarget
    )
    if (replacement.status !== "updated") {
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

  const withBusy = useCallback(async (fn: () => Promise<unknown>) => {
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
  }, [])

  async function retryPayment(): Promise<void> {
    const pickupFreshness = await verifyPickupCartFreshness(
      row.lifecycle?.items ?? [],
      row.lifecycle?.merchantPubkey ?? row.merchantPubkey
    )
    if (!pickupFreshness.fresh) throw new Error(pickupFreshness.reason)
    await assertCartPickupHandlerReady(row.lifecycle?.items ?? [])

    const ctx = await persistTargetAndBuildServiceCtx()
    if (ctx.zapMode !== "anonymous_public_zap") {
      await runOrderPayment(ctx)
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
    await runOrderPayment({
      ...ctx,
      zapContent: preparedAnonZap.rawEvent.content,
      preparedAnonZap,
    })
  }

  async function continuePrivateFallback(): Promise<void> {
    const pickupFreshness = await verifyPickupCartFreshness(
      row.lifecycle?.items ?? [],
      row.lifecycle?.merchantPubkey ?? row.merchantPubkey
    )
    if (!pickupFreshness.fresh) throw new Error(pickupFreshness.reason)
    await assertCartPickupHandlerReady(row.lifecycle?.items ?? [])
    const ctx = await persistTargetAndBuildServiceCtx()
    setPrivateFallbackOpen(false)
    await runOrderPrivateFallback(ctx)
  }

  const boundMerchantInvoiceAccess = deriveBoundMerchantInvoiceAccess(
    row.lifecycle,
    vm.merchantStatus,
    vm.phase
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
      boundMerchantInvoiceAccess === "report_only" ||
      boundMerchantInvoiceAccess === "closed"
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
    if (boundMerchantInvoiceAccess === "closed") {
      throw new Error("The merchant already confirmed this payment.")
    }
    const action = vm.merchantInvoiceAction
    const unboundPaidInvoice =
      action?.status === "blocked" && action.canReport ? action : undefined
    await submitExternalPaymentProof(
      vm.orderId,
      guestIdentity ?? undefined,
      unboundPaidInvoice,
      merchantInvoiceReopenEvidence
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

  const showRetryPayment = !zeroCostPickupOrder && vm.paymentStatus === "failed"
  const recoveredBeforeWallet =
    row.lifecycle?.lastError === ORDER_PAYMENT_INTERRUPTED_BEFORE_WALLET_ERROR
  const showAnonPaymentRecovery =
    showRetryPayment &&
    vm.publicZapSigner === "anon" &&
    row.lifecycle?.invoiceStatus === "failed"
  const showAmbiguousPayment =
    !zeroCostPickupOrder && vm.paymentStatus === "ambiguous"
  const showExternalWallet =
    !zeroCostPickupOrder &&
    boundMerchantInvoiceAccess !== "closed" &&
    boundMerchantInvoiceAccess !== "report_only" &&
    (vm.paymentStatus === "manual_required" || !!vm.merchantInvoiceAction)
  const autoDetectPublicReceipt =
    !zeroCostPickupOrder &&
    vm.publicZapSigner === "anon" &&
    vm.zapReceiptStatus === "waiting"
  const publicReceiptNotObserved =
    !zeroCostPickupOrder &&
    vm.publicZapSigner === "anon" &&
    vm.zapReceiptStatus === "receipt_not_observed"
  const showResendProof =
    !zeroCostPickupOrder &&
    vm.paymentStatus === "paid" &&
    (vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed")

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (guestIdentity) throw new Error("Guest orders cannot send messages")
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
        buyerPubkey
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

      {boundMerchantInvoiceAccess === "report_only" && (
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
            Do not pay this invoice. If your wallet already confirms a payment,
            report it so the merchant can verify what happened.
          </p>
          <Button
            variant="outline"
            className="mt-4 h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void withBusy(reportExternalPayment)}
          >
            Report a payment already made
          </Button>
        </StatusNotice>
      )}

      {showExternalWallet && (
        <div className="space-y-3">
          <StatusNotice
            variant="warning"
            title={
              autoDetectPublicReceipt
                ? "Pay with any Lightning wallet"
                : vm.merchantInvoiceAction?.status === "blocked"
                  ? "Invoice needs review"
                  : vm.merchantInvoiceAction
                    ? "Merchant invoice ready"
                    : vm.publicZapFallback
                      ? "Checkout continued privately"
                      : "Action needed"
            }
            detail={
              autoDetectPublicReceipt
                ? "Receipt detection is automatic"
                : vm.merchantInvoiceAction?.status === "blocked"
                  ? "Payment unavailable"
                  : vm.merchantInvoiceAction
                    ? "Pay from Orders"
                    : vm.publicZapFallback
                      ? "Optional public note unavailable"
                      : "Pay with an external wallet"
            }
          >
            <p className="text-pretty text-sm text-[var(--text-secondary)]">
              {autoDetectPublicReceipt
                ? "Pay the invoice below. Conduit is watching for the matching public receipt and will notify the merchant automatically."
                : vm.merchantInvoiceAction?.status === "blocked"
                  ? "Orders checked the latest merchant invoice but could not make it payable."
                  : vm.merchantInvoiceAction
                    ? "Orders checked the latest merchant invoice against this saved order. Confirm it once before payment controls appear."
                    : vm.publicZapFallback
                      ? "Your order is still ready. The optional public checkout note was unavailable, so this invoice is private. Pay it once, then report the payment so the merchant can verify it."
                      : "No automatic wallet was available. Pay the invoice below, then report the payment to the merchant for verification."}
            </p>
          </StatusNotice>
          <ExternalWalletPanel
            vm={vm}
            busy={busy}
            guestSession={!!guestIdentity}
            autoDetectReceipt={autoDetectPublicReceipt}
            onBeforeInvoiceUse={beginMerchantInvoicePayment}
            onPrepareMerchantInvoice={() =>
              void withBusy(prepareCurrentMerchantInvoice)
            }
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

      {(showRetryPayment || showAmbiguousPayment || showResendProof) && (
        <StatusNotice
          variant={TONE_VARIANT[headerStatus.tone]}
          title={headerStatus.primaryLabel}
          detail={headerStatus.detailLabel}
        >
          <div className="flex flex-wrap items-end gap-3">
            {showRetryPayment && (
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
            {showRetryPayment && (
              <Button
                className="h-11 px-4 text-sm"
                disabled={
                  busy ||
                  wallets.loading ||
                  !selectedStoredPaymentTarget ||
                  !buildServiceCtx()
                }
                onClick={() => void withBusy(retryPayment)}
              >
                <RotateCw className="h-4 w-4" />
                {recoveredBeforeWallet
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
                disabled={busy}
                onClick={() =>
                  void withBusy(() =>
                    resendOrderProof(vm.orderId, guestIdentity ?? undefined)
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
                  ? "Conduit did not observe the matching public receipt. If your wallet shows payment, do not pay again. The receipt can still reconcile if it reaches the configured relays during this guest session."
                  : showAmbiguousPayment
                    ? "Your wallet may have received the payment request, but Conduit couldn't confirm whether funds moved. Check your wallet and merchant messages before trying again."
                    : showRetryPayment && retryWalletTargetIsStale
                      ? "The previously selected saved wallet is unavailable. Explicitly choose another wallet, browser wallet, or manual payment."
                      : showRetryPayment && !selectedStoredPaymentTarget
                        ? "Choose the exact wallet or manual payment path for this retry."
                        : showRetryPayment && !buildServiceCtx()
                          ? "The saved payment target is unavailable. Unlock or reconnect it, or explicitly choose another option."
                          : showRetryPayment
                            ? recoveredBeforeWallet
                              ? "Conduit closed before the invoice reached a wallet. Continuing reuses this order; no funds moved."
                              : showAnonPaymentRecovery
                                ? "This older anonymous zap attempt failed before automatic fallback was available. No funds moved; retry it or continue with a private invoice."
                                : "No funds moved. You can retry payment for this order."
                            : "Payment went through; the receipt didn't reach the merchant."}
            </span>
            {recoveryError && (
              <p
                role="alert"
                className="w-full text-sm text-[var(--destructive)]"
              >
                {recoveryError}
              </p>
            )}
            {showRetryPayment && wallets.initializationError && (
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
                busy || !selectedStoredPaymentTarget || !buildServiceCtx()
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
            const pickupCost =
              typeof pickup.costSats === "number"
                ? formatSats(pickup.costSats)
                : pickup.sourceCost
                  ? `${pickup.sourceCost.amount.toLocaleString()} ${pickup.sourceCost.currency}`
                  : "Not available"
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
                    <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-[var(--border)] pt-4 text-xs sm:grid-cols-2 xl:grid-cols-1">
                      <div>
                        <dt className="text-[var(--text-muted)]">
                          Resolved pickup cost
                        </dt>
                        <dd className="mt-1 font-medium text-[var(--text-primary)]">
                          {pickupCost}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--text-muted)]">
                          Pickup handler
                        </dt>
                        <dd className="mt-1 flex items-center gap-2 font-mono text-[var(--text-secondary)]">
                          <span>{formatNpub(handoff.handlerPubkey, 8)}</span>
                          <CopyButton
                            value={handoff.handlerPubkey}
                            label="Copy pickup handler npub"
                          />
                        </dd>
                      </div>
                      {pickupClaimCode && (
                        <div>
                          <dt className="text-[var(--text-muted)]">
                            Pickup code
                          </dt>
                          <dd className="mt-1 flex items-center gap-2 font-mono font-semibold tracking-wide text-[var(--text-primary)]">
                            <span>{pickupClaimCode}</span>
                            <CopyButton
                              value={pickupClaimCode}
                              npub={false}
                              label="Copy organizer pickup code"
                            />
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-[var(--text-muted)]">
                          Event organizer
                        </dt>
                        <dd className="mt-1 flex items-center gap-2 font-mono text-[var(--text-secondary)]">
                          <span>{formatNpub(pickup.organizerPubkey, 8)}</span>
                          <CopyButton
                            value={pickup.organizerPubkey}
                            label="Copy event organizer npub"
                          />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--text-muted)]">
                          Calendar revision
                        </dt>
                        <dd className="mt-1 flex items-center gap-2 font-mono text-[var(--text-secondary)]">
                          <span>
                            {formatPubkey(pickup.calendar.eventId, 8)}
                          </span>
                          <CopyButton
                            value={pickup.calendar.eventId}
                            npub={false}
                            label="Copy calendar event id"
                          />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[var(--text-muted)]">
                          Pickup revision
                        </dt>
                        <dd className="mt-1 flex items-center gap-2 font-mono text-[var(--text-secondary)]">
                          <span>{formatPubkey(pickup.option.eventId, 8)}</span>
                          <CopyButton
                            value={pickup.option.eventId}
                            npub={false}
                            label="Copy pickup event id"
                          />
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-4 border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--text-secondary)]">
                      {getPickupHandoffPrivacyCopy(handoff)}
                    </p>
                    {pickupClaimCode && (
                      <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                        Show this code to the organizer only after the merchant
                        says your pickup is ready.
                      </p>
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
                <DetailRow label="Order npub">
                  <span className="font-mono text-xs">
                    {formatNpub(row.merchantPubkey, 8)}
                  </span>
                  <CopyButton value={row.merchantPubkey} label="Copy pubkey" />
                </DetailRow>
                {typeof vm.totalSats === "number" && (
                  <DetailRow label={zeroCostPickupOrder ? "Total" : "Payment"}>
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
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const shopperPricing = useShopperPricing()
  const formatSats = (sats: number) =>
    shopperPricing.formatSatsAmount(sats).primary
  const { order: selectedFromUrl } = Route.useSearch()
  const [searchValue, setSearchValue] = useState("")
  const [tab, setTab] = useState<PhaseTab>("all")
  const [changeOrderOpen, setChangeOrderOpen] = useState(false)
  const [, setGuestSessionEpoch] = useState(0)
  const guestIdentity =
    !signerConnected && selectedFromUrl
      ? getSessionGuestOrderSigningIdentity(selectedFromUrl)
      : null
  const activeBuyerPubkey = signerConnected
    ? pubkey
    : (guestIdentity?.pubkey ?? null)
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
      if (signerConnected) {
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
    enabled: signerConnected,
    queryFn: () => fetchCachedBuyerConversations(activeBuyerPubkey!),
    staleTime: 5_000,
  })

  const refetchAll = useCallback(() => {
    if (signerConnected && activeBuyerPubkey) {
      clearProtectedReadAuthenticationSuppression(activeBuyerPubkey)
      void messagesQuery.refetch()
    }
    void lifecyclesQuery.refetch()
  }, [activeBuyerPubkey, lifecyclesQuery, messagesQuery, signerConnected])

  useEffect(() => {
    const refetchAfterResume = () => {
      if (document.visibilityState === "hidden") return
      refetchAll()
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
        if (!canObserveOrderPublicZapReceipt(lifecycle)) continue
        const identity =
          guestIdentity?.orderId === lifecycle.orderId
            ? guestIdentity
            : undefined
        void observeOrderPublicZapReceipt(lifecycle.orderId, identity)
      }
    }

    resumeReceiptObservers()
    window.addEventListener("focus", resumeReceiptObservers)
    document.addEventListener("visibilitychange", resumeReceiptObservers)
    return () => {
      window.removeEventListener("focus", resumeReceiptObservers)
      document.removeEventListener("visibilitychange", resumeReceiptObservers)
    }
  }, [guestIdentity, lifecycles])

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

  const merchantPubkeys = useMemo(
    () =>
      Array.from(new Set(orders.map((o) => o.merchantPubkey).filter(Boolean))),
    [orders]
  )
  const merchantProfilesQuery = useProfiles(merchantPubkeys, {
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
    if (
      selectedFromUrl &&
      filteredOrders.some((o) => o.orderId === selectedFromUrl)
    ) {
      return selectedFromUrl
    }
    return filteredOrders[0]?.orderId ?? null
  }, [filteredOrders, selectedFromUrl])

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
    enabled: !!selected?.orderId,
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

  return (
    <div className="space-y-6">
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

      {signerConnected &&
        protectedOrdersReadState !== "complete" &&
        protectedOrdersReadState !== "pending" && (
          <LiveReadNotice
            state={protectedOrdersReadState}
            onRetry={refetchAll}
            retrying={messagesQuery.isRefetching}
          />
        )}

      {signerConnected && (
        <DecryptFailureNotice
          count={messagesMeta?.decryptFailures?.length ?? 0}
          onRetry={refetchAll}
          retrying={messagesQuery.isRefetching}
        />
      )}

      {activeBuyerPubkey &&
        !lifecyclesQuery.isPending &&
        !hasOrders &&
        protectedOrdersReadState === "complete" && (
          <EmptyState
            title={signerConnected ? "No orders yet" : "Guest order not found"}
            body={
              signerConnected
                ? "Place your first order and it will appear here with live status."
                : "This guest order is not available in local order history on this device."
            }
            action={
              signerConnected ? (
                <Button asChild className="h-11 px-4 text-sm">
                  <Link to="/products">Browse products</Link>
                </Button>
              ) : undefined
            }
          />
        )}

      {activeBuyerPubkey && hasOrders && (
        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          {/* Desktop left rail */}
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

          {/* Mobile: filter pills + browse sheet + horizontal orders */}
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

          {/* Detail */}
          <section className="min-w-0">
            {selectedRow ? (
              <OrderDetail
                key={selectedRow.orderId}
                row={selectedRow}
                buyerPubkey={activeBuyerPubkey}
                guestIdentity={guestIdentity}
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
