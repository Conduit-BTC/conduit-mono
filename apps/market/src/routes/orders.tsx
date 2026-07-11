import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  db,
  formatNpub,
  formatPubkey,
  getProductPriceDisplay,
  getOrderPublicZapSigner,
  listOrderLifecycles,
  normalizeLightningInvoice,
  pruneExpiredGuestOrderData,
  pubkeyToNpub,
  useAuth,
  useProfile,
  useProfiles,
  type OrderLifecycle,
} from "@conduit/core"
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  StatusPill,
  StatusStepper,
} from "@conduit/ui"
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  ReceiptText,
  RotateCw,
  Search,
  ShoppingBag,
} from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { CopyButton } from "../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../components/MerchantIdentity"
import {
  fetchBuyerConversations,
  fetchCachedBuyerConversations,
  type BuyerConversation,
} from "../lib/orderConversations"
import { fetchStoreProducts } from "../lib/storeProducts"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useWallet } from "../hooks/useWallet"
import {
  buildOrderTimeline,
  buildOrderViewModel,
  deriveOrderHeaderStatus,
  getOrderPaymentMethodLabel,
  type OrderHeaderStatus,
  type OrderViewModel,
} from "../lib/order-view"
import {
  resendOrderProof,
  runOrderPayment,
  submitExternalPaymentProof,
  subscribeOrderPayment,
  type OrderPaymentContext,
} from "../lib/order-payment-service"
import {
  clearSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "../lib/guest-order-identity"
import type { CheckoutZapMode } from "../lib/checkout-payment"

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
      {picture ? (
        <img
          src={picture}
          alt={name || formatNpub(pubkey, 8)}
          className="h-full w-full object-cover"
        />
      ) : (
        <MerchantAvatarFallback />
      )}
    </div>
  )
}

function OrderListCard({
  row,
  merchantName,
  merchantPicture,
  active,
  onClick,
}: {
  row: OrderRow
  merchantName: string
  merchantPicture?: string
  active: boolean
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
              {row.vm.totalSats.toLocaleString()} sats
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
  onSelect,
}: {
  rows: OrderRow[]
  selectedOrderId: string | null
  merchantName: (pk: string) => string
  onSelect: (orderId: string) => void
}) {
  const orderedRows = useMemo(() => {
    if (!selectedOrderId) return rows
    const selectedRow = rows.find((row) => row.orderId === selectedOrderId)
    if (!selectedRow) return rows
    return [
      selectedRow,
      ...rows.filter((row) => row.orderId !== selectedOrderId),
    ]
  }, [rows, selectedOrderId])

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
            {orderedRows.map((row) => {
              const active = row.orderId === selectedOrderId
              return (
                <button
                  key={row.orderId}
                  type="button"
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
                        {row.vm.totalSats.toLocaleString()} sats
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
  btcUsdRate,
}: {
  vm: OrderViewModel
  productsById: Map<
    string,
    Awaited<ReturnType<typeof fetchStoreProducts>>["data"][number]
  >
  btcUsdRate: ReturnType<typeof useBtcUsdRate>["data"] | null
}) {
  return (
    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
        <ShoppingBag className="h-4 w-4" /> Items
      </h3>
      <div className="mt-3 space-y-3">
        {vm.items.map((item, index) => {
          const product = productsById.get(item.productId)
          const image = product?.images[0]
          const price = getProductPriceDisplay(
            {
              price: item.priceAtPurchase,
              currency: item.currency,
              priceSats:
                item.currency === "SATS" ? item.priceAtPurchase : undefined,
            },
            btcUsdRate
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
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="text-[var(--text-primary)]">
                    {product?.title ?? item.displayTitle}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                    Qty {item.quantity}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right text-[var(--text-secondary)]">
                {price.primary}
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
            {vm.totalSats.toLocaleString()} sats
          </span>
        </div>
      ) : null}
    </section>
  )
}

function OrderTimeline({ vm }: { vm: OrderViewModel }) {
  const rows = useMemo(() => buildOrderTimeline(vm), [vm])
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
  busy,
  guestSession,
}: {
  vm: OrderViewModel
  onMarkPaid: () => void
  busy: boolean
  guestSession: boolean
}) {
  const [copied, setCopied] = useState(false)
  const invoice = vm.invoice
  if (!invoice) return null
  const bolt11 = normalizeLightningInvoice(invoice)
  const copy = async () => {
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
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
        Pay with an external wallet
      </h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        No automatic wallet was available. Scan or copy this invoice, pay it in
        your wallet, then send the receipt to the merchant.
      </p>
      {guestSession && (
        <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
          Keep this tab open until the receipt is sent. Closing it ends local
          access to this guest order. The merchant will follow up using the
          phone and email contact details submitted at checkout.
        </p>
      )}
      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={bolt11} size={156} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild className="h-10 px-4 text-sm">
              <a href={`lightning:${bolt11}`}>
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
          <Button
            variant="primary"
            className="h-10 px-4 text-sm"
            disabled={busy}
            onClick={onMarkPaid}
          >
            I've paid — send receipt
          </Button>
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
  const wallet = useWallet()
  const btcUsdRateQuery = useBtcUsdRate()
  const { data: profile } = useProfile(row.merchantPubkey, {
    maxUnresolvedRefetches: 1,
  })
  const merchantName = getMerchantDisplayName(profile, row.merchantPubkey)
  const [busy, setBusy] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

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

  const canTryNwc =
    !guestIdentity &&
    !!wallet.connection &&
    wallet.status !== "unsupported" &&
    wallet.status !== "error"

  function buildServiceCtx(): OrderPaymentContext | null {
    const lc = row.lifecycle
    if (!lc) return null
    if (!lc.merchantLightningAddress) return null
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
      walletConnection: wallet.connection,
      tryNwc: canTryNwc,
      tryWebln: !guestIdentity,
    }
  }

  const withBusy = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  const showRetryPayment = vm.paymentStatus === "failed"
  const showAmbiguousPayment = vm.paymentStatus === "ambiguous"
  const showExternalWallet = vm.paymentStatus === "manual_required"
  const showResendProof =
    vm.paymentStatus === "paid" &&
    (vm.proofDeliveryStatus === "retry_needed" ||
      vm.proofDeliveryStatus === "failed")

  const messageMerchant = guestIdentity ? null : (
    <Button asChild variant="outline" className="h-10 px-4 text-sm">
      <Link to="/messages" search={{ tab: "merchants", thread: vm.orderId }}>
        <MessageCircle className="h-4 w-4" />
        Message merchant
      </Link>
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
                    {vm.totalSats.toLocaleString()} sats
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
            btcUsdRate={btcUsdRateQuery.data ?? null}
          />
        </section>
      </>

      {showExternalWallet && (
        <div className="space-y-3">
          <StatusNotice
            variant="warning"
            title="Action needed"
            detail="Pay with an external wallet"
          >
            <p className="text-sm text-[var(--text-secondary)]">
              No automatic wallet was available. Pay the invoice below, then
              send the receipt to the merchant.
            </p>
          </StatusNotice>
          <ExternalWalletPanel
            vm={vm}
            busy={busy}
            guestSession={!!guestIdentity}
            onMarkPaid={() =>
              void withBusy(() =>
                submitExternalPaymentProof(
                  vm.orderId,
                  guestIdentity ?? undefined
                )
              )
            }
          />
        </div>
      )}

      {(showRetryPayment || showAmbiguousPayment || showResendProof) && (
        <StatusNotice
          variant={TONE_VARIANT[headerStatus.tone]}
          title={headerStatus.primaryLabel}
          detail={headerStatus.detailLabel}
        >
          <div className="flex flex-wrap items-center gap-3">
            {showRetryPayment && (
              <Button
                className="h-10 px-4 text-sm"
                disabled={busy || !buildServiceCtx()}
                onClick={() => {
                  const ctx = buildServiceCtx()
                  if (ctx) void withBusy(() => runOrderPayment(ctx))
                }}
              >
                <RotateCw className="h-4 w-4" />
                Try payment again
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
              {showAmbiguousPayment
                ? "Your wallet may have received the payment request, but Conduit couldn't confirm whether funds moved. Check your wallet and merchant messages before trying again."
                : showRetryPayment && !buildServiceCtx()
                  ? "This order did not keep a checkout-time Lightning target, so retry is unavailable from Orders. Message the merchant before attempting another payment path."
                  : showRetryPayment
                    ? "No funds moved. You can retry payment for this order."
                    : "Payment went through; the receipt didn't reach the merchant."}
            </span>
          </div>
        </StatusNotice>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <OrderTimeline vm={vm} />

        <div className="space-y-4">
          <div className="hidden xl:block">
            <OrderItemsSection
              vm={vm}
              productsById={productsById}
              btcUsdRate={btcUsdRateQuery.data ?? null}
            />
          </div>

          {/* Shipping address */}
          {vm.shippingAddress && (
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Shipping address
                </h3>
                {!guestIdentity && (
                  <Button asChild variant="ghost" className="h-8 px-3 text-xs">
                    <Link
                      to="/messages"
                      search={{ tab: "merchants", thread: vm.orderId }}
                    >
                      Edit
                    </Link>
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
              <div className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm">
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
                  <DetailRow label="Payment">
                    <span>{vm.totalSats.toLocaleString()} sats</span>
                  </DetailRow>
                )}
                <DetailRow label="Paid with">
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
                ? "The merchant will use the phone and email contact details submitted at checkout for questions and fulfillment updates."
                : "Message the merchant for any questions or issues."}
            </p>
            {messageMerchant && <div className="mt-3">{messageMerchant}</div>}
          </section>
        </div>
      </div>
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
  // The phase tabs only exist on the mobile layout. Track the desktop breakpoint
  // (xl = 1280px) so a tab chosen on a narrow viewport doesn't silently filter
  // the tab-less desktop rail after a resize.
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 1280px)").matches
  )
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1280px)")
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])
  const effectiveTab: PhaseTab = isDesktop ? "all" : tab
  const [refreshButtonState, setRefreshButtonState] = useState<
    "idle" | "refreshing" | "done"
  >("idle")
  const refreshResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const lifecyclesQuery = useQuery({
    queryKey: [
      "order-lifecycles",
      activeBuyerPubkey ?? "none",
      selectedFromUrl ?? "all",
    ],
    enabled: !!activeBuyerPubkey,
    queryFn: async () => {
      if (signerConnected) return listOrderLifecycles(activeBuyerPubkey!)
      if (!selectedFromUrl || !guestIdentity) return []
      const lifecycle = await db.orderLifecycles.get(selectedFromUrl)
      if (!lifecycle || lifecycle.buyerPubkey !== guestIdentity.pubkey)
        return []
      return [lifecycle]
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

  const isFetching = messagesQuery.isFetching || lifecyclesQuery.isFetching
  const refetchAll = useCallback(() => {
    if (signerConnected) void messagesQuery.refetch()
    void lifecyclesQuery.refetch()
  }, [lifecyclesQuery, messagesQuery, signerConnected])

  useEffect(() => {
    if (isFetching) {
      if (refreshResetTimerRef.current) {
        clearTimeout(refreshResetTimerRef.current)
        refreshResetTimerRef.current = null
      }
      setRefreshButtonState("refreshing")
      return
    }
    if (refreshButtonState === "refreshing") {
      setRefreshButtonState("done")
      refreshResetTimerRef.current = setTimeout(() => {
        setRefreshButtonState("idle")
        refreshResetTimerRef.current = null
      }, 900)
    }
  }, [isFetching, refreshButtonState])

  useEffect(
    () => () => {
      if (refreshResetTimerRef.current)
        clearTimeout(refreshResetTimerRef.current)
    },
    []
  )

  const handleRefresh = useCallback(() => {
    if (!activeBuyerPubkey) return
    setRefreshButtonState("refreshing")
    refetchAll()
  }, [activeBuyerPubkey, refetchAll])

  const conversations = useMemo(
    () => messagesQuery.data?.data ?? cachedMessagesQuery.data?.data ?? [],
    [cachedMessagesQuery.data, messagesQuery.data]
  )
  const lifecycles = useMemo(
    () => lifecyclesQuery.data ?? [],
    [lifecyclesQuery.data]
  )

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
      if (effectiveTab !== "all" && row.vm.phase !== effectiveTab) {
        // "in_progress" tab also surfaces failed/action-needed active orders.
        if (!(effectiveTab === "in_progress" && row.headerStatus.actionNeeded))
          return false
      }
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
  }, [effectiveTab, merchantName, orders, searchValue])

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
    const unsub = subscribeOrderPayment(selected.orderId, () => {
      void lifecyclesQuery.refetch()
      void queryClient.invalidateQueries({
        queryKey: ["buyer-payment-attempt", selected.orderId],
      })
    })
    return unsub
  }, [lifecyclesQuery, queryClient, selected?.orderId])

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
              : "Finish this guest payment and review locally saved checkout status. Merchant follow-up uses your submitted phone and email contact details."}
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 px-4 text-sm"
          disabled={!activeBuyerPubkey || isFetching}
          onClick={handleRefresh}
        >
          <span className="inline-flex items-center gap-2">
            {refreshButtonState === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <RotateCw
                className={`h-4 w-4 ${refreshButtonState === "refreshing" ? "animate-spin text-amber-300" : ""}`}
              />
            )}
            {refreshButtonState === "refreshing"
              ? "Refreshing…"
              : refreshButtonState === "done"
                ? "Updated"
                : "Refresh"}
          </span>
        </Button>
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
              ? "Guest checkout orders are tied to the browser session that created them. Return from checkout in the same tab before the session expires; merchant follow-up uses the phone and email contact details submitted at checkout."
              : "Order updates, invoices, and merchant replies are tied to your signer identity."
          }
        />
      )}

      {activeBuyerPubkey && !lifecyclesQuery.isLoading && !hasOrders && (
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
              <OrderList
                rows={filteredOrders}
                selectedOrderId={selectedOrderId}
                merchantName={merchantName}
                merchantPicture={(pk) =>
                  merchantProfilesQuery.data?.[pk]?.picture
                }
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
                <OrderList
                  rows={filteredOrders}
                  selectedOrderId={selectedOrderId}
                  merchantName={merchantName}
                  merchantPicture={(pk) =>
                    merchantProfilesQuery.data?.[pk]?.picture
                  }
                  onSelect={selectOrder}
                />
              </SheetContent>
            </Sheet>
          </div>

          {/* Detail */}
          <section className="min-w-0">
            {selectedRow ? (
              <OrderDetail
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
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search orders"
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
      />
    </div>
  )
}

function OrderList({
  rows,
  selectedOrderId,
  merchantName,
  merchantPicture,
  onSelect,
}: {
  rows: OrderRow[]
  selectedOrderId: string | null
  merchantName: (pk: string) => string
  merchantPicture: (pk: string) => string | undefined
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
