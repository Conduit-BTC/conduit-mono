import { createFileRoute, useNavigate } from "@tanstack/react-router"
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
  getProfilePaymentAddress,
  buildOrderStatusTimeline,
  clearProtectedReadAuthenticationSuppression,
  convertCommerceAmountToSats,
  decodeLightningInvoiceAmount,
  deriveProtectedReadPresentationState,
  formatNpub,
  formatEventMarketPickupDate,
  getNdk,
  getCachedMerchantConversationList,
  getCachedMerchantStorefront,
  getCurrencyAmountStep,
  getEventMarketOrderCorrelationRef,
  getLightningNetworkMismatchMessage,
  getMerchantConversationList,
  getMerchantOrderActions,
  getMerchantOrderReopenTransition,
  getProductImageCandidates,
  getProductsByIds,
  hasWebLN,
  isInvoiceCompatibleWithCurrentNetwork,
  isValidLud16Address,
  isMerchantOrderPaid,
  normalizeCurrencyAmount,
  normalizeSafeHttpUrl,
  publishMerchantOrderMessage,
  pubkeyToNpub,
  prepareProtectedReadRefreshState,
  selectProtectedReadRows,
  type MerchantConversationSummary,
  type MerchantOrderDelivery,
  type MerchantOrderAction,
  type MerchantOrderReopenTransition,
  type MerchantOrderState,
  type KnownOrderStatus,
  type Profile,
  type OrderSummary,
  type SignedPublicNostrEvent,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
  useNip05Verification,
  useProfile,
  useProfiles,
  useShopperTrustEvidence,
} from "@conduit/core"
import {
  getCommerceGmvEstimateFromOrder,
  reportCommerceGmvEstimate,
} from "@conduit/core/commerce-gmv"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  Input,
  Label,
  MessagingReadinessNotice,
  toMessagingReadinessNoticeState,
  EventGuestReceiptVerifier,
  OrderMessagesWidget,
  ProtectedInboxNotice,
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
  SignerRecoveryNotice,
  StatusPill,
  StatusStepper,
  cn,
} from "@conduit/ui"
import { requireAuth } from "../lib/auth"
import { OrderCardScroller } from "../components/OrderCardScroller"
import { BuyerAvatar, OrderListItem } from "../components/OrderListItem"
import { OrderItemsCard } from "../components/OrderItemsCard"
import { MerchantProjectTip } from "../components/MerchantProjectTip"
import { ShopperTrustCard } from "../components/ShopperTrustCard"
import {
  getMerchantBuyerDisplayName,
  getMerchantConversationQueue,
  getMerchantConversationCommunication,
  getMerchantConversationState,
  getMerchantConversationStatusDisplay,
  getMerchantOrderFulfillment,
  getMerchantOrderSummary,
  isMerchantGuestOrder,
  isOrderQueueTab,
  isMerchantConversationActiveFulfillment,
  ORDER_PHASE_OPTIONS,
  ORDER_SORT_OPTIONS,
  sortMerchantConversations,
  type MerchantOrderCommunication,
  type MerchantOrderSort,
  type OrderQueueTab,
} from "../lib/order-phase"
import {
  getMerchantPickupAuthorizationMessage,
  verifyFutureEventMarketOrderAuthorization,
  readVerifiedFutureEventMarketOrderEvidence,
} from "../lib/order-pickup-authorization"
import {
  archiveFutureMarketPrivateDelivery,
  canCompleteFutureMarketHandoff,
  loadFutureMarketPrivateDeliveries,
  publishFutureMarketReadyReceipt,
  publishFutureMarketRevocation,
  readFutureMarketHandoffAcks,
  readFutureMarketMerchantClaim,
  recoverFutureMarketReadyReceipt,
  retryFutureMarketPrivateDelivery,
  saveFutureMarketPrivateDelivery,
} from "@conduit/core"
import {
  buildMerchantOrderActionView,
  captureMerchantPaymentConfirmationTarget,
  getMerchantOrderCancellationCopy,
  isAuthorizedZeroCostPickup,
  isMerchantOrderActionSurfacePending,
  resolveMerchantPaymentConfirmationSelection,
  runExclusiveOrderAction,
  type MerchantPaymentConfirmationTarget,
} from "../lib/order-action-view"
import { prepareShippingUpdate } from "../lib/shipping-update"
import { formatMerchantOrderAmount } from "../lib/order-summary-display"
import {
  createDefaultMerchantInvoiceModule,
  type MerchantInvoiceActionSource,
  type MerchantInvoiceSelection,
} from "../lib/merchant-invoice"
import {
  buildLocalProductDeliveryNotice,
  buildLocalProductRetryNotice,
  buildProductDeliveryNotice,
  type ProductDeliveryNotice,
} from "../lib/product-delivery"
import {
  deliverSignedProductEvent,
  getRelayPublishDiagnosticsError,
  signAndPublishProductListing,
  SignedProductDeliveryError,
} from "../lib/product-publishing"
import { prepareOrderStockUpdate } from "../lib/order-stock-fulfillment"
import {
  applyOrderStockTarget,
  buildOrderStockAdjustments,
  getOrderStockAdjustmentForDisplay,
  isOrderStockAdjustmentMutationDisabled,
  PendingProductStockDeliveryStore,
  ProductStockDecisionStore,
  shouldShowOrderStockAdjustment,
  type OrderStockAdjustment,
  type OrderStockTargetMode,
} from "../lib/productStock"
import {
  Check,
  ChevronRight,
  Copy,
  MessageCircle,
  RotateCw,
  Search,
} from "lucide-react"
import { useBtcUsdRate } from "../hooks/useBtcUsdRate"
import { useMerchantPaymentAutomation } from "../hooks/useMerchantPaymentAutomation"
import { OrderStockPanel } from "../components/OrderStockPanel"
import {
  confirmMerchantPayment,
  type MerchantPaymentConfirmationInput,
} from "../lib/order-payment-release"
type OrdersSearch = { order?: string; queue?: OrderQueueTab }

type ReopenOrderMutationInput = {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  delivery: MerchantOrderDelivery
  communication: MerchantOrderCommunication
  transition: MerchantOrderReopenTransition
}

type StockDeliveryState = {
  orderId: string
  adjustment: OrderStockAdjustment
  notice: ProductDeliveryNotice
  signedEvent: SignedPublicNostrEvent
}

type OrderActionAuthority = {
  accountPubkey: string
  authGeneration: number
}

type StockUpdateMutationPayload =
  | {
      action: "update"
      orderId: string
      adjustment: OrderStockAdjustment
      orderItems: OrderSummary["items"]
    }
  | {
      action: "retry"
      orderId: string
      adjustment: OrderStockAdjustment
      signedEvent: SignedPublicNostrEvent
      previousNotice: ProductDeliveryNotice
    }

const ORDERS_SEARCH_DEFAULT: OrdersSearch = {}

export const Route = createFileRoute("/orders")({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    const order = search.order
    const queue = search.queue
    return {
      ...(typeof order === "string" && order.length > 0 ? { order } : {}),
      ...(isOrderQueueTab(queue) && queue !== "all" ? { queue } : {}),
    }
  },
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

const INVOICE_CURRENCY_OPTIONS = ["USD", "SATS"] as const

function normalizeInvoiceCurrencyChoice(
  currency: string | undefined
): (typeof INVOICE_CURRENCY_OPTIONS)[number] | "" {
  const normalized = currency?.trim().toUpperCase()
  if (normalized === "SAT" || normalized === "SATS") return "SATS"
  if (normalized === "USD") return "USD"
  return ""
}

const INVOICE_ACTION_ERROR_MESSAGES: Record<
  MerchantInvoiceActionSource,
  string
> = {
  profile_lud16:
    "Could not create an invoice from the profile Lightning address. Try again or choose another source.",
  webln:
    "Could not create an invoice with the browser wallet. Try again or choose another source.",
  nwc: "Could not create an invoice with the connected wallet. Check the wallet connection or choose another source.",
  manual:
    "Could not validate and send the pasted invoice. Check it and try again.",
}

function safeInvoiceActionError(source: MerchantInvoiceActionSource): Error {
  return new Error(INVOICE_ACTION_ERROR_MESSAGES[source])
}

const pendingInvoiceQueryTokens = new WeakMap<
  MerchantConversationSummary,
  string
>()
let nextPendingInvoiceQueryToken = 0

function getPendingInvoiceQueryToken(
  conversation: MerchantConversationSummary | null
): string {
  if (!conversation) return "none"
  const existing = pendingInvoiceQueryTokens.get(conversation)
  if (existing) return existing
  nextPendingInvoiceQueryToken += 1
  const token = `selection-${nextPendingInvoiceQueryToken}`
  pendingInvoiceQueryTokens.set(conversation, token)
  return token
}

const panelCard =
  "rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-5"

function CopyInline({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      className="text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
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
        aria-label="Search orders"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search orders"
        className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
      />
    </div>
  )
}

// Cap how many recent orders' product listings we resolve for search, so the
// batched relay read stays bounded on large inboxes.
const ORDER_SEARCH_PRODUCT_CAP = 100

function emptyOrdersLabel(query: string, phase: OrderQueueTab): string {
  if (query) return `No orders match "${query}".`
  if (phase !== "all") {
    const label =
      ORDER_PHASE_OPTIONS.find((option) => option.value === phase)?.label ?? ""
    return `No ${label.toLowerCase()} orders.`
  }
  return "No orders yet."
}

function OrderListSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  describedBy,
}: {
  id: string
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  describedBy?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-[var(--text-secondary)]">
        {label}
      </Label>
      <Select
        value={value}
        onValueChange={(nextValue) => {
          const selected = options.find((option) => option.value === nextValue)
          if (selected) onChange(selected.value)
        }}
      >
        <SelectTrigger
          id={id}
          aria-label={`${label} orders`}
          aria-describedby={describedBy}
          className="h-11 rounded-xl bg-[var(--surface)] px-3 shadow-none"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function OrderListControls({
  idPrefix,
  phase,
  onPhaseChange,
  sort,
  onSortChange,
}: {
  idPrefix: string
  phase: OrderQueueTab
  onPhaseChange: (value: OrderQueueTab) => void
  sort: MerchantOrderSort
  onSortChange: (value: MerchantOrderSort) => void
}) {
  const filterId = `${idPrefix}-order-filter`
  const sortId = `${idPrefix}-order-sort`
  const sortDescriptionId = `${idPrefix}-order-sort-description`
  return (
    <div className="mt-3 space-y-2">
      <OrderListSelect
        id={filterId}
        label="Filter"
        value={phase}
        options={ORDER_PHASE_OPTIONS}
        onChange={onPhaseChange}
      />
      <OrderListSelect
        id={sortId}
        label="Sort"
        value={sort}
        options={ORDER_SORT_OPTIONS}
        onChange={onSortChange}
        describedBy={sortDescriptionId}
      />
      <p
        id={sortDescriptionId}
        className="text-pretty text-xs text-[var(--text-muted)]"
      >
        {sort === "priority"
          ? "Orders needing your attention appear first."
          : "Most recently active orders appear first."}
      </p>
    </div>
  )
}

function MobileOrdersScroller({
  conversations,
  selectedId,
  buyerProfiles,
  onSelect,
}: {
  conversations: MerchantConversationSummary[]
  selectedId: string | null
  buyerProfiles: Record<string, Profile | undefined>
  onSelect: (id: string) => void
}) {
  return (
    <section className="min-w-0 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      {conversations.length === 0 ? (
        <div className="rounded-[1.25rem] border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
          No orders match this filter.
        </div>
      ) : (
        <OrderCardScroller
          conversations={conversations}
          selectedId={selectedId}
          buyerName={(_, conversation) =>
            getMerchantBuyerDisplayName(
              conversation,
              buyerProfiles[conversation.buyerPubkey]
            )
          }
          buyerPicture={(pubkey, conversation) =>
            isMerchantGuestOrder(conversation)
              ? undefined
              : buyerProfiles[pubkey]?.picture
          }
          onSelect={(conversation) => onSelect(conversation.id)}
        />
      )}
    </section>
  )
}

function OrdersPage() {
  const { accountPubkey } = useAuth()
  return <OrdersWorkspace key={accountPubkey ?? "no-account"} />
}

function OrdersWorkspace() {
  const {
    accountPubkey,
    pubkey: signerPubkey,
    status,
    authGeneration,
    isAuthGenerationCurrent,
    remoteSignerRecovery,
    signerReadiness,
    connect,
  } = useAuth()
  const pubkey = accountPubkey
  const mountedRef = useRef(true)
  const orderAuthorityRef = useRef({
    accountPubkey,
    authGeneration,
    signerPubkey,
    signerReadiness,
  })
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useLayoutEffect(() => {
    orderAuthorityRef.current = {
      accountPubkey,
      authGeneration,
      signerPubkey,
      signerReadiness,
    }
  }, [accountPubkey, authGeneration, signerPubkey, signerReadiness])
  const isCurrentOrderAccount = (ownerPubkey: string) =>
    mountedRef.current &&
    orderAuthorityRef.current.accountPubkey === ownerPubkey
  const isCurrentOrderOwner = (ownerPubkey: string, generation: number) => {
    const current = orderAuthorityRef.current
    return (
      isCurrentOrderAccount(ownerPubkey) &&
      isAuthGenerationCurrent(generation) &&
      current.authGeneration === generation
    )
  }
  const isCurrentOrderSigner = (ownerPubkey: string, generation: number) => {
    const current = orderAuthorityRef.current
    return (
      isCurrentOrderOwner(ownerPubkey, generation) &&
      current.signerPubkey === ownerPubkey &&
      current.signerReadiness === "ready"
    )
  }
  const captureFreshOrderAuthority = (): OrderActionAuthority => {
    const current = orderAuthorityRef.current
    if (
      !current.accountPubkey ||
      current.signerPubkey !== current.accountPubkey ||
      current.signerReadiness !== "ready" ||
      !isAuthGenerationCurrent(current.authGeneration)
    ) {
      throw new Error("Merchant signer is not connected")
    }
    return {
      accountPubkey: current.accountPubkey,
      authGeneration: current.authGeneration,
    }
  }
  const isCurrentOrderAction = (authority: OrderActionAuthority) =>
    isCurrentOrderSigner(authority.accountPubkey, authority.authGeneration)
  const session = useConduitSession()
  const signerConnected =
    signerReadiness === "ready" &&
    !!accountPubkey &&
    signerPubkey === accountPubkey
  const hasAccount = !!accountPubkey
  const authenticatedPubkey = signerConnected ? signerPubkey : null
  const navigate = useNavigate()
  const { order: selectedFromUrl, queue: queueFromUrl } = Route.useSearch()
  const selectedQueueFromUrl = queueFromUrl ?? "all"
  const btcUsdRateQuery = useBtcUsdRate()
  const btcUsdRate = btcUsdRateQuery.data ?? null
  const queryClient = useQueryClient()
  const merchantProfileQuery = useProfile(pubkey, {
    accountPubkey: pubkey,
    authenticatedPubkey,
    shouldContinue: () =>
      !!pubkey && isCurrentOrderOwner(pubkey, authGeneration),
  })
  const merchantInvoiceModule = useMemo(
    () => createDefaultMerchantInvoiceModule(),
    []
  )
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [orderSearch, setOrderSearch] = useState("")
  const [phaseTab, setPhaseTab] = useState<OrderQueueTab>(selectedQueueFromUrl)
  const [orderSort, setOrderSort] = useState<MerchantOrderSort>("priority")
  const [ordersSheetOpen, setOrdersSheetOpen] = useState(false)
  const [orderDetailsOpen, setOrderDetailsOpen] = useState(false)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [invoice, setInvoice] = useState("")
  const [invoiceSource, setInvoiceSource] =
    useState<MerchantInvoiceActionSource>("profile_lud16")
  const [invoiceAmount, setInvoiceAmount] = useState("")
  const [invoiceCurrency, setInvoiceCurrency] = useState("USD")
  const [invoiceNote, setInvoiceNote] = useState("")
  const [carrier, setCarrier] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [trackingUrl, setTrackingUrl] = useState("")
  const [shippingNote, setShippingNote] = useState("")
  const [replyNote, setReplyNote] = useState("")
  const [successFlash, setSuccessFlash] = useState<string | null>(null)
  const [sessionStockDecisionKeys, setSessionStockDecisionKeys] = useState(
    () => new Set<string>()
  )
  const [
    stockDecisionHydratedSelectionId,
    setStockDecisionHydratedSelectionId,
  ] = useState<string | null>(null)
  const [stockDelivery, setStockDelivery] = useState<StockDeliveryState | null>(
    null
  )
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<MerchantOrderAction | null>(null)
  const [reopenConfirmation, setReopenConfirmation] =
    useState<ReopenOrderMutationInput | null>(null)
  const [reopenConfirmationError, setReopenConfirmationError] = useState<
    string | null
  >(null)
  const [paymentConfirmationTarget, setPaymentConfirmationTarget] =
    useState<MerchantPaymentConfirmationTarget | null>(null)
  const [confirmingOrganizerRelease, setConfirmingOrganizerRelease] =
    useState(false)
  const [organizerReleaseConfirmed, setOrganizerReleaseConfirmed] =
    useState(false)
  const orderActionLockRef = useRef(false)
  const stockDecisionStoreRef = useRef(new ProductStockDecisionStore())
  const pendingStockDeliveryStoreRef = useRef(
    new PendingProductStockDeliveryStore()
  )
  const [weblnAvailable, setWeblnAvailable] = useState(false)
  const [handoffDeliveryRevision, setHandoffDeliveryRevision] = useState(0)
  const selectedOrderResetRef = useRef<string | null>(null)
  const invoiceAmountNumber = useMemo(() => {
    const amount = Number(invoiceAmount)
    if (!Number.isFinite(amount) || amount < 0) return 0
    const normalized = normalizeCurrencyAmount(amount, invoiceCurrency)
    return normalized.status === "ok" ? normalized.amount : 0
  }, [invoiceAmount, invoiceCurrency])
  const invoiceAmountSats = useMemo(
    () =>
      invoiceCurrency
        ? convertCommerceAmountToSats(
            invoiceAmountNumber,
            invoiceCurrency,
            btcUsdRate
          )
        : null,
    [btcUsdRate, invoiceAmountNumber, invoiceCurrency]
  )
  const manualInvoiceDecoded = useMemo(
    () =>
      invoice.trim() ? decodeLightningInvoiceAmount(invoice.trim()) : null,
    [invoice]
  )

  useLayoutEffect(() => {
    orderActionLockRef.current = false
    setPendingDestructiveAction(null)
    setReopenConfirmation(null)
    setReopenConfirmationError(null)
    setPaymentConfirmationTarget(null)
    setConfirmingOrganizerRelease(false)
    setOrganizerReleaseConfirmed(false)
  }, [authGeneration, signerConnected])

  useEffect(() => {
    // Detect WebLN (Alby extension) — may load after page render
    const check = () => setWeblnAvailable(hasWebLN())
    check()
    const timer = setTimeout(check, 1000)
    return () => clearTimeout(timer)
  }, [])

  const flash = useCallback((message: string) => {
    setSuccessFlash(message)
  }, [])

  const nwc = useMerchantPaymentAutomation()
  const profileLud16 =
    getProfilePaymentAddress(merchantProfileQuery.profileContext) ?? ""
  const profileInvoiceAvailable = isValidLud16Address(profileLud16)
  const nwcInvoiceAvailable =
    !!nwc.connection && nwc.canCreateInvoices && nwc.addressStatus === "match"
  const selectedInvoiceSourceAvailable =
    invoiceSource === "profile_lud16"
      ? profileInvoiceAvailable
      : invoiceSource === "webln"
        ? weblnAvailable
        : invoiceSource === "nwc"
          ? nwcInvoiceAvailable
          : true

  // Orders reads stay permissive without a NIP-17 declaration (CND-208);
  // this banner only reports readiness and links to Network for repair.
  const inboxReadiness = useInboxDeclaration(pubkey, {
    enabled: signerConnected && session.relaySettingsReady,
    relayScope: session.relayScope,
  })
  const inboxReadinessNoticeState = toMessagingReadinessNoticeState(
    inboxReadiness.status
  )

  const ordersQuery = useQuery({
    queryKey: ["merchant-order-messages-live", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => getMerchantConversationList({ principalPubkey: pubkey! }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedOrdersQuery = useQuery({
    queryKey: ["merchant-order-messages", pubkey ?? "none"],
    enabled: hasAccount,
    queryFn: () =>
      getCachedMerchantConversationList({ principalPubkey: pubkey! }),
    staleTime: 5_000,
  })
  const isOrdersInitialHydration = signerConnected && ordersQuery.isPending
  const refetchOrders = ordersQuery.refetch

  const handleRefresh = useCallback(async () => {
    if (!signerConnected || !pubkey) return
    clearProtectedReadAuthenticationSuppression(pubkey)
    await refetchOrders()
  }, [pubkey, refetchOrders, signerConnected])

  const conversations = useMemo(
    () =>
      selectProtectedReadRows(
        ordersQuery.data?.data,
        cachedOrdersQuery.data?.data
      ),
    [cachedOrdersQuery.data, ordersQuery.data]
  )

  useEffect(() => {
    for (const conversation of conversations) {
      const state = getMerchantConversationState(conversation)
      if (!state.paymentObserved && !isMerchantOrderPaid(state)) continue
      const orderMessage = (conversation.messages ?? []).find(
        (message) =>
          message.type === "order" &&
          message.orderId === conversation.orderId &&
          message.senderPubkey === conversation.buyerPubkey &&
          message.recipientPubkey === conversation.merchantPubkey
      )
      if (orderMessage?.type !== "order") continue
      const estimate = getCommerceGmvEstimateFromOrder({
        orderId: conversation.orderId,
        buyerPubkey: conversation.buyerPubkey,
        merchantPubkey: conversation.merchantPubkey,
        order: orderMessage.payload,
      })
      if (estimate) void reportCommerceGmvEstimate(estimate)
    }
  }, [conversations])
  const ordersMeta = ordersQuery.data?.meta
  const protectedOrdersReadState = deriveProtectedReadPresentationState({
    visibleCount: conversations.length,
    pending: signerConnected && ordersQuery.isPending,
    error: ordersQuery.error,
    meta: ordersMeta,
  })
  const ordersRefreshState = prepareProtectedReadRefreshState({
    protectedReadState: protectedOrdersReadState,
    protectedReadRefreshing: ordersQuery.isFetching,
    protectedReadPaused: ordersQuery.isPaused,
  })
  const protectedOrderCountsUnavailable =
    conversations.length === 0 && protectedOrdersReadState !== "complete"
  const buyerPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          conversations
            .filter((conversation) => !isMerchantGuestOrder(conversation))
            .map((conversation) => conversation.buyerPubkey)
            .filter(Boolean)
        )
      ),
    [conversations]
  )
  const buyerProfilesQuery = useProfiles(buyerPubkeys, {
    accountPubkey: pubkey,
    authenticatedPubkey,
    shouldContinue: () =>
      !!pubkey && isCurrentOrderOwner(pubkey, authGeneration),
    enabled: hasAccount && !isOrdersInitialHydration && buyerPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })

  const buyerProfiles = buyerProfilesQuery.data

  // Order messages carry no image and no reliable title, so resolve each item
  // from its product listing (addressId). One batched relay read covers every
  // loaded order (bounded to the most recent), and feeds both the selected
  // order's name/image and item search (title, description, tags).
  const allOrderProductIds = useMemo(() => {
    const ids = new Set<string>()
    for (const conversation of conversations) {
      for (const message of conversation.messages ?? []) {
        if (message.type !== "order") continue
        for (const item of message.payload.items) {
          if (item.productId) ids.add(item.productId)
        }
      }
      if (ids.size >= ORDER_SEARCH_PRODUCT_CAP) break
    }
    return [...ids].sort().slice(0, ORDER_SEARCH_PRODUCT_CAP)
  }, [conversations])

  const orderProductsQuery = useQuery({
    queryKey: [
      "order-products",
      session.relayScope ?? "no-relay-scope",
      pubkey ?? "anonymous",
      allOrderProductIds,
    ],
    enabled: hasAccount && allOrderProductIds.length > 0,
    queryFn: ({ signal }) =>
      getProductsByIds(allOrderProductIds, {
        includeMarketHidden: true,
        accountPubkey: pubkey,
        authenticatedPubkey,
        shouldContinue: () =>
          !signal.aborted &&
          !!pubkey &&
          isCurrentOrderOwner(pubkey, authGeneration),
      }),
    staleTime: 5 * 60_000,
  })

  const productLookup = useMemo(() => {
    const map = new Map<
      string,
      {
        title: string
        imageUrl?: string
        format: "physical" | "digital"
      }
    >()
    for (const record of orderProductsQuery.data?.data ?? []) {
      if (record.product.pubkey !== pubkey) continue
      map.set(record.addressId, {
        title: record.product.title,
        imageUrl: getProductImageCandidates(record.product)[0]?.url,
        format: record.product.format,
      })
    }
    return map
  }, [orderProductsQuery.data, pubkey])

  // Searchable text (name + description + tags) per resolved product listing,
  // populated once the listings load; search falls back to order-message item
  // titles until then.
  const productSearchIndex = useMemo(() => {
    const map = new Map<string, string>()
    for (const record of orderProductsQuery.data?.data ?? []) {
      map.set(
        record.addressId,
        [
          record.product.title,
          record.product.summary ?? "",
          record.product.tags.join(" "),
          record.product.location ?? "",
        ]
          .join(" ")
          .toLowerCase()
      )
    }
    return map
  }, [orderProductsQuery.data])

  const filteredConversations = useMemo(() => {
    const query = orderSearch.trim().toLowerCase()
    const matchingConversations = conversations.filter((conversation) => {
      if (
        phaseTab !== "all" &&
        getMerchantConversationQueue(conversation) !== phaseTab
      ) {
        return false
      }
      if (!query) return true
      const buyerName = getMerchantBuyerDisplayName(
        conversation,
        buyerProfiles?.[conversation.buyerPubkey]
      )
      const orderMessage = (conversation.messages ?? []).find(
        (message) => message.type === "order"
      )
      const items =
        orderMessage?.type === "order" ? orderMessage.payload.items : []
      const itemText = items
        .map(
          (item) =>
            `${item.title ?? ""} ${productSearchIndex.get(item.productId) ?? ""}`
        )
        .join(" ")
      return [
        buyerName,
        pubkeyToNpub(conversation.buyerPubkey),
        conversation.orderId,
        conversation.buyerPubkey,
        conversation.preview,
        conversation.totalSummary ?? "",
        getMerchantConversationStatusDisplay(conversation).label,
        itemText,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    })
    return sortMerchantConversations(matchingConversations, orderSort)
  }, [
    conversations,
    orderSearch,
    orderSort,
    phaseTab,
    buyerProfiles,
    productSearchIndex,
  ])

  const selectConversation = useCallback(
    (conversationId: string) => {
      setSelectedConversationId(conversationId)
      const orderId = conversations.find(
        (conversation) => conversation.id === conversationId
      )?.orderId
      void navigate({
        to: "/orders",
        search: {
          ...(orderId ? { order: orderId } : {}),
          ...(phaseTab !== "all" ? { queue: phaseTab } : {}),
        },
        replace: true,
      })
    },
    [conversations, navigate, phaseTab]
  )

  const changePhaseTab = useCallback(
    (nextPhase: OrderQueueTab) => {
      setPhaseTab(nextPhase)
      void navigate({
        to: "/orders",
        search:
          nextPhase === "all" ? ORDERS_SEARCH_DEFAULT : { queue: nextPhase },
        replace: true,
      })
    },
    [navigate]
  )

  useEffect(() => {
    setPhaseTab(selectedQueueFromUrl)
  }, [selectedQueueFromUrl])

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null)
      return
    }
    const urlConversation = selectedFromUrl
      ? filteredConversations.find(
          (conversation) => conversation.orderId === selectedFromUrl
        )
      : null
    if (urlConversation) {
      setSelectedConversationId(urlConversation.id)
      return
    }
    if (
      !selectedConversationId ||
      !filteredConversations.some(
        (conversation) => conversation.id === selectedConversationId
      )
    ) {
      setSelectedConversationId(filteredConversations[0]?.id ?? null)
    }
  }, [filteredConversations, selectedConversationId, selectedFromUrl])

  const selected =
    filteredConversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? null
  const pendingInvoiceQueryToken = useMemo(
    () => getPendingInvoiceQueryToken(selected),
    [selected]
  )
  const selectedStockDecisionId = selected
    ? `${pubkey ?? "none"}:${selected.id}`
    : null
  const selectedOrderMessage = selected?.messages?.find(
    (message) => message.type === "order"
  )
  const selectedOrder =
    selectedOrderMessage?.type === "order" ? selectedOrderMessage.payload : null
  const selectedFuturePickup = selectedOrder?.items.find(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )?.fulfillment
  const selectedFutureOrganizerHandoff =
    selectedOrder?.items.some(
      (item) =>
        item.fulfillment?.type === "event_market_pickup" &&
        item.fulfillment.mode === "organizer_handoff"
    ) ?? false
  const selectedOrderCorrelationRef = selectedOrder
    ? getEventMarketOrderCorrelationRef(selectedOrder.id)
    : null
  const futureDeliveries = useMemo(() => {
    void handoffDeliveryRevision
    return pubkey ? loadFutureMarketPrivateDeliveries(pubkey) : []
  }, [handoffDeliveryRevision, pubkey])
  const futureReadyRecord = futureDeliveries.find(
    (record) =>
      record.type === "future_market_ready" &&
      record.orderCorrelationRef === selectedOrderCorrelationRef
  )
  const futureRecoveryQuery = useQuery({
    queryKey: [
      "future-market-merchant-release",
      pubkey,
      selectedOrder?.id,
      authGeneration,
    ],
    enabled:
      signerConnected &&
      !!pubkey &&
      !!selectedOrder &&
      selectedFutureOrganizerHandoff,
    queryFn: ({ signal }) =>
      readFutureMarketMerchantClaim({
        order: selectedOrder!,
        merchantPubkey: pubkey!,
        shouldContinue: () =>
          !signal.aborted &&
          !!pubkey &&
          isCurrentOrderOwner(pubkey, authGeneration),
      }),
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
  })
  const futureRecoveredClaim = futureRecoveryQuery.data?.claim
  const futureHasRelease = Boolean(futureReadyRecord || futureRecoveredClaim)
  const futureRevocationRecord = futureDeliveries.find(
    (record) =>
      record.type === "future_market_revoked" &&
      record.readyReceiptId ===
        (futureRecoveredClaim?.receipt.id ?? futureReadyRecord?.readyReceiptId)
  )
  const futureAckQuery = useQuery({
    queryKey: [
      "future-market-handoff-ack",
      pubkey,
      futureReadyRecord?.readyReceiptId,
      futureRecoveredClaim?.receipt.id,
      authGeneration,
    ],
    enabled:
      signerConnected &&
      !!pubkey &&
      futureHasRelease &&
      selectedFutureOrganizerHandoff,
    queryFn: async ({ signal }) => {
      const shouldContinue = () =>
        !signal.aborted &&
        !!pubkey &&
        isCurrentOrderOwner(pubkey, authGeneration)
      if (!shouldContinue())
        throw new DOMException("Order account changed.", "AbortError")
      const signer = getNdk().signer
      if (!signer || !pubkey || !futureHasRelease)
        throw new Error("Merchant recovery signer is unavailable.")
      const receipt =
        futureRecoveredClaim?.receipt.payload ??
        (await recoverFutureMarketReadyReceipt({
          record: futureReadyRecord!,
          signer,
        }))
      if (!shouldContinue())
        throw new DOMException("Order account changed.", "AbortError")
      return readFutureMarketHandoffAcks({
        merchantPubkey: pubkey,
        readyReceiptId:
          futureRecoveredClaim?.receipt.id ?? futureReadyRecord!.readyReceiptId,
        receipt,
        shouldContinue,
      })
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 30_000,
  })
  const organizerCompletionBlocked =
    selectedFutureOrganizerHandoff &&
    !canCompleteFutureMarketHandoff({
      read: futureAckQuery.data,
      hasLocalRevocation:
        !!futureRevocationRecord ||
        futureRecoveredClaim?.state === "revoked" ||
        futureRecoveredClaim?.state === "conflicting",
    })
  const selectedOrderIsZeroCost =
    !!selectedOrder &&
    selectedOrder.subtotal === 0 &&
    (selectedOrder.shippingCostSats ?? 0) === 0 &&
    selectedOrder.items.every(
      (item) => item.priceAtPurchase === 0 && (item.shippingCostSats ?? 0) === 0
    )
  const selectedOrderCurrency =
    selectedOrderMessage?.type === "order"
      ? selectedOrderMessage.payload.currency
      : null
  const invoiceCurrencyUnsupported =
    !!selectedOrderCurrency &&
    normalizeInvoiceCurrencyChoice(selectedOrderCurrency) === ""

  useEffect(() => {
    const selectedId = selectedStockDecisionId
    if (selectedOrderResetRef.current === selectedId) return
    selectedOrderResetRef.current = selectedId

    setSuccessFlash(null)
    setReopenConfirmation(null)
    setReopenConfirmationError(null)
    setPaymentConfirmationTarget(null)
    setConfirmingOrganizerRelease(false)
    setOrganizerReleaseConfirmed(false)
    const pendingStockDeliveries =
      pubkey && selected
        ? pendingStockDeliveryStoreRef.current.getForOrder(
            pubkey,
            selected.orderId
          )
        : []
    const pendingStockDelivery = pendingStockDeliveries[0]
    setStockDelivery(
      pendingStockDelivery
        ? {
            orderId: pendingStockDelivery.orderId,
            adjustment: pendingStockDelivery.adjustment,
            notice: buildLocalProductRetryNotice("publish"),
            signedEvent: pendingStockDelivery.signedEvent,
          }
        : null
    )
    if (pubkey && pendingStockDeliveries.length > 0) {
      setSessionStockDecisionKeys((current) => {
        const next = new Set(current)
        for (const delivery of pendingStockDeliveries) {
          next.add(`${pubkey}:${delivery.adjustment.key}`)
        }
        return next
      })
    }
    setStockDecisionHydratedSelectionId(selectedId)
    setOrderDetailsOpen(false)
    setMessagesOpen(false)
    setInvoice("")
    setInvoiceSource("profile_lud16")
    setInvoiceAmount("")
    setInvoiceCurrency("USD")
    setInvoiceNote("")
    setCarrier("")
    setTrackingNumber("")
    setTrackingUrl("")
    setShippingNote("")
    setReplyNote("")
    const firstOrder = selected?.messages?.find(
      (message) => message.type === "order"
    )
    if (firstOrder?.type !== "order") return
    setInvoiceAmount(String(firstOrder.payload.subtotal))
    setInvoiceCurrency(
      normalizeInvoiceCurrencyChoice(firstOrder.payload.currency)
    )
  }, [pubkey, selected, selectedStockDecisionId])

  const orderSummary = useMemo(
    () => (selected ? getMerchantOrderSummary(selected) : null),
    [selected]
  )
  const selectedStatusDisplay = useMemo(
    () =>
      selected ? getMerchantConversationStatusDisplay(selected) : undefined,
    [selected]
  )
  const isGuestOrder = selected ? isMerchantGuestOrder(selected) : false
  const communicationState = selected
    ? getMerchantConversationCommunication(selected)
    : "unknown"
  const buyerInboxKnown = communicationState === "nostr_replyable"
  const operationalDelivery: MerchantOrderDelivery = buyerInboxKnown
    ? "buyer_and_self"
    : "self_only"
  const assertBuyerHasNostrInbox = useCallback(() => {
    if (!buyerInboxKnown) {
      throw new Error(
        "This order has no confirmed Nostr reply inbox. Follow up using the contact details on the order."
      )
    }
  }, [buyerInboxKnown])

  // A buyer-authored pickup snapshot is only a claim until the current signed
  // organizer graph and merchant listing authorize the same semantic terms.
  const snapshottedOrderFulfillment = getMerchantOrderFulfillment(
    orderSummary?.items ?? []
  )
  const pickupAuthorizationQuery = useQuery({
    queryKey: [
      "merchant-order-pickup-authorization",
      selected?.id ?? "none",
      snapshottedOrderFulfillment.futureMarket?.market.eventId ?? "none",
      snapshottedOrderFulfillment.futureMarket?.grant.eventId ?? "none",
      (orderSummary?.items ?? [])
        .flatMap((item) =>
          item.fulfillment?.type === "event_market_pickup"
            ? [item.fulfillment.product.eventId]
            : []
        )
        .join(","),
    ],
    enabled:
      signerConnected &&
      !!pubkey &&
      !!orderSummary &&
      snapshottedOrderFulfillment.hasPickupClaim,
    queryFn: async ({ signal }) => {
      const shouldContinue = () =>
        !signal.aborted &&
        !!pubkey &&
        isCurrentOrderOwner(pubkey, authGeneration)
      return snapshottedOrderFulfillment.futureMarket && selectedOrder
        ? await verifyFutureEventMarketOrderAuthorization({
            order: selectedOrder,
            merchantPubkey: pubkey!,
            authenticatedPubkey,
            shouldContinue,
          })
        : ({ status: "invalid", reason: "order" } as const)
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    retry: false,
  })
  const pickupAuthorizationVerified =
    pickupAuthorizationQuery.data?.status === "verified"
  const pickupFulfillmentActionsAuthorized =
    !snapshottedOrderFulfillment.hasPickupClaim || pickupAuthorizationVerified
  // Preserve the buyer's acknowledged pickup lane for presentation while
  // treating its organizer/product authorization as a separate action gate.
  // An unverifiable pickup must never silently become a shipment.
  const orderFulfillment = snapshottedOrderFulfillment
  const merchantOrderState: MerchantOrderState = selected
    ? {
        ...getMerchantConversationState(selected),
        buyerReplyable:
          communicationState === "nostr_replyable"
            ? true
            : communicationState === "guest_out_of_band"
              ? false
              : "unknown",
        fulfillmentMode: orderFulfillment.mode,
        requiresShipping: orderFulfillment.requiresShipping,
        isZeroCostPickup: isAuthorizedZeroCostPickup({
          order: selectedOrder,
          fulfillmentMode: orderFulfillment.mode,
          requiresShipping: orderFulfillment.requiresShipping,
          pickupAuthorizationVerified,
        }),
      }
    : { status: null }
  const stockAdjustments =
    !selected ||
    !orderSummary ||
    !pubkey ||
    stockDecisionHydratedSelectionId !== selectedStockDecisionId
      ? []
      : buildOrderStockAdjustments({
          orderId: selected.orderId,
          merchantPubkey: pubkey,
          items: orderSummary.items,
          productRecords: orderProductsQuery.data?.data ?? [],
        }).flatMap((adjustment) => {
          const pendingAdjustment =
            stockDelivery?.notice.state !== "delivered" &&
            stockDelivery?.orderId === selected.orderId &&
            stockDelivery.adjustment.key === adjustment.key
              ? stockDelivery.adjustment
              : null
          const storedDecision = stockDecisionStoreRef.current.get(
            pubkey,
            selected.orderId,
            adjustment.addressId
          )
          const persistedDecision = pendingAdjustment
            ? {
                kind: "applied" as const,
                decidedAt: 0,
                adjustment: pendingAdjustment,
              }
            : storedDecision
          const adjustmentForDecision = pendingAdjustment ?? adjustment
          if (
            !shouldShowOrderStockAdjustment({
              adjustment: adjustmentForDecision,
              orderStatus: merchantOrderState.status,
              hasSessionDecision: sessionStockDecisionKeys.has(
                `${pubkey}:${adjustment.key}`
              ),
              persistedDecision,
            })
          ) {
            return []
          }
          return [
            getOrderStockAdjustmentForDisplay({
              adjustment: adjustmentForDecision,
              persistedDecision,
            }),
          ]
        })
  const stockMutationDisabledKeys = new Set<string>()
  for (const adjustment of stockAdjustments) {
    const hasPendingDelivery = Boolean(
      stockDelivery &&
      stockDelivery.notice.state !== "delivered" &&
      selected &&
      stockDelivery.orderId === selected.orderId &&
      stockDelivery.adjustment.key === adjustment.key
    )
    const persistedDecision =
      pubkey && selected
        ? stockDecisionStoreRef.current.get(
            pubkey,
            selected.orderId,
            adjustment.addressId
          )
        : null
    if (
      isOrderStockAdjustmentMutationDisabled({
        adjustment,
        persistedDecision,
        hasPendingDelivery,
        hasSessionDecision: sessionStockDecisionKeys.has(
          `${pubkey}:${adjustment.key}`
        ),
      })
    ) {
      stockMutationDisabledKeys.add(adjustment.key)
    }
  }
  const merchantPaid = isMerchantOrderPaid(merchantOrderState)
  const safeTrackingUrl = normalizeSafeHttpUrl(orderSummary?.trackingUrl)
  const assertPaidForFulfillment = useCallback(
    (allowZeroCostPickup = false) => {
      if (
        !merchantPaid &&
        !(allowZeroCostPickup && merchantOrderState.isZeroCostPickup)
      ) {
        throw new Error(
          "Confirm payment before sending shipping updates or fulfilling a nonzero order."
        )
      }
    },
    [merchantOrderState.isZeroCostPickup, merchantPaid]
  )
  async function assertCurrentPickupAuthorization(
    authority: OrderActionAuthority
  ) {
    if (!snapshottedOrderFulfillment.hasPickupClaim) return null
    if (
      !pubkey ||
      !orderSummary ||
      authority.accountPubkey !== pubkey ||
      !isCurrentOrderAction(authority)
    ) {
      throw new Error("Current signed pickup evidence is unavailable.")
    }
    const result =
      snapshottedOrderFulfillment.futureMarket && selectedOrder
        ? await verifyFutureEventMarketOrderAuthorization({
            order: selectedOrder,
            merchantPubkey: pubkey,
            authenticatedPubkey,
            shouldContinue: () => isCurrentOrderAction(authority),
          })
        : ({ status: "invalid", reason: "order" } as const)
    if (!isCurrentOrderAction(authority)) {
      throw new Error("Merchant signer session changed")
    }
    queryClient.setQueriesData(
      {
        queryKey: [
          "merchant-order-pickup-authorization",
          selected?.id ?? "none",
        ],
      },
      result
    )
    if (result.status !== "verified") {
      throw new Error(getMerchantPickupAuthorizationMessage(result))
    }
    return result
  }
  const orderActions = selected
    ? getMerchantOrderActions(merchantOrderState)
    : []
  const reopenTransition = getMerchantOrderReopenTransition(merchantOrderState)
  const currentReopenInput: ReopenOrderMutationInput | null =
    pubkey && selected && reopenTransition
      ? {
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
          delivery: operationalDelivery,
          communication: communicationState,
          transition: reopenTransition,
        }
      : null
  const selectedQueue = selected ? getMerchantConversationQueue(selected) : null
  const canSendInvoice =
    buyerInboxKnown &&
    selectedQueue === "unpaid_review" &&
    !merchantPaid &&
    !merchantOrderState.paymentObserved &&
    !!merchantOrderState.accepted
  const selectedInvoiceScope =
    pubkey && selected
      ? {
          merchantPubkey: pubkey,
          buyerPubkey: selected.buyerPubkey,
          orderId: selected.orderId,
        }
      : null
  const pendingInvoiceQuery = useQuery({
    queryKey: ["merchant-pending-invoice", pendingInvoiceQueryToken],
    enabled: canSendInvoice && !!selectedInvoiceScope,
    queryFn: async () => {
      try {
        return await merchantInvoiceModule.getStatus(selectedInvoiceScope!)
      } catch {
        throw new Error("Could not load the saved invoice status.")
      }
    },
  })
  const canRecordShipping =
    pickupFulfillmentActionsAuthorized &&
    selectedQueue === "paid_fulfill" &&
    merchantPaid &&
    orderFulfillment.requiresShipping &&
    !merchantOrderState.shippingUpdated
  const canRequestPaymentOutOfBand =
    communicationState === "guest_out_of_band" &&
    selectedQueue === "unpaid_review" &&
    !merchantPaid &&
    !merchantOrderState.paymentObserved &&
    !!merchantOrderState.accepted
  const actionView = buildMerchantOrderActionView({
    actions: orderActions,
    canSendInvoice,
    canRecordShipping,
    canRequestPaymentOutOfBand,
    fulfillmentActionsAuthorized:
      pickupFulfillmentActionsAuthorized && !organizerCompletionBlocked,
  })
  const { primaryButtonActions, destructiveActions, hasNextStep } = actionView
  const paymentConfirmationSelection =
    resolveMerchantPaymentConfirmationSelection({
      target: paymentConfirmationTarget,
      selected,
      actions: primaryButtonActions,
    })
  const destructiveCancellationCopy = destructiveActions[0]
    ? getMerchantOrderCancellationCopy({
        actionLabel: destructiveActions[0].label,
        buyerInboxKnown,
        merchantPaid,
        paymentObserved: !!merchantOrderState.paymentObserved,
      })
    : null
  const cancellationCopy = pendingDestructiveAction
    ? getMerchantOrderCancellationCopy({
        actionLabel: pendingDestructiveAction.label,
        buyerInboxKnown,
        merchantPaid,
        paymentObserved: !!merchantOrderState.paymentObserved,
      })
    : null
  const selectedStockDelivery =
    stockDelivery?.orderId === selected?.orderId ? stockDelivery : null
  const stockDeliveryCanRetry =
    selectedStockDelivery?.notice.state === "partial" ||
    selectedStockDelivery?.notice.state === "retry_needed"

  const selectedBuyerProfile =
    selected && !isGuestOrder
      ? buyerProfilesQuery.data?.[selected.buyerPubkey]
      : undefined
  const selectedShopperPubkey =
    selected && !isGuestOrder ? selected.buyerPubkey : null
  const shopperTrustQuery = useShopperTrustEvidence(
    pubkey && selectedShopperPubkey
      ? {
          merchantPubkey: pubkey,
          shopperPubkey: selectedShopperPubkey,
        }
      : null,
    {
      enabled:
        signerConnected &&
        session.relaySettingsReady &&
        !isOrdersInitialHydration,
      relayScope: session.relayScope,
      authenticatedPubkey,
      shouldContinue: () =>
        !!pubkey && isCurrentOrderOwner(pubkey, authGeneration),
    }
  )
  const selectedBuyerNip05 = selectedBuyerProfile?.nip05?.trim()
  const selectedBuyerNip05Verification = useNip05Verification(
    selectedShopperPubkey,
    selectedBuyerNip05,
    {
      enabled:
        signerConnected && !isOrdersInitialHydration && !!selectedBuyerNip05,
    }
  )
  const selectedBuyerProfileState = !selectedShopperPubkey
    ? "unavailable"
    : buyerProfilesQuery.hasProfile(selectedShopperPubkey)
      ? "loaded"
      : isOrdersInitialHydration || !buyerProfilesQuery.lookupSettled
        ? "loading"
        : "unavailable"
  const selectedBuyerName = selected
    ? getMerchantBuyerDisplayName(selected, selectedBuyerProfile)
    : null
  const awaitingInvoiceCount = useMemo(
    () =>
      conversations.filter((conversation) => {
        const summary = getMerchantOrderSummary(conversation)
        if (
          getMerchantConversationCommunication(conversation) !==
          "nostr_replyable"
        ) {
          return false
        }
        return (
          !summary.invoiceSent &&
          !summary.paymentProofReceived &&
          !summary.externalPaymentReportReceived &&
          !summary.paymentConfirmed
        )
      }).length,
    [conversations]
  )
  const activeFulfillmentCount = useMemo(
    () => conversations.filter(isMerchantConversationActiveFulfillment).length,
    [conversations]
  )

  const invalidateOrderQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["merchant-order-messages", pubkey ?? "none"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-order-messages-live", pubkey ?? "none"],
      }),
    ])
  }, [pubkey, queryClient])

  const invalidateProductQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["order-products"] }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-products", pubkey ?? "none"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["merchant-products-live", pubkey ?? "none"],
      }),
    ])
  }, [pubkey, queryClient])

  const stockUpdateMutation = useMutation({
    mutationFn: async (payload: StockUpdateMutationPayload) => {
      if (!pubkey) throw new Error("Merchant signer is not connected")

      if (payload.action === "retry") {
        if (
          payload.signedEvent.pubkey !== pubkey ||
          !isCurrentOrderAccount(pubkey)
        ) {
          throw new Error(
            "This signed stock update belongs to another account."
          )
        }
        pendingStockDeliveryStoreRef.current.set(pubkey, {
          orderId: payload.orderId,
          adjustment: payload.adjustment,
          signedEvent: payload.signedEvent,
        })
        const delivery = await deliverSignedProductEvent(
          payload.signedEvent,
          pubkey,
          {
            authenticatedPubkey,
            shouldContinue: () => isCurrentOrderAccount(pubkey),
          }
        )
        return {
          authority: null,
          retryOwner: pubkey,
          delivery,
          signedEvent: payload.signedEvent,
          adjustment: payload.adjustment,
        }
      }

      const authority = captureFreshOrderAuthority()

      const latestLocal = await getCachedMerchantStorefront({
        merchantPubkey: pubkey,
        includeMarketHidden: true,
      })
      const record = latestLocal.data.find(
        (candidate) => candidate.addressId === payload.adjustment.addressId
      )
      if (!record || record.product.pubkey !== pubkey || !record.dTag) {
        throw new Error(
          "The merchant listing is not available on this device. Refresh orders and try again."
        )
      }
      const persistedDecision = stockDecisionStoreRef.current.get(
        pubkey,
        payload.orderId,
        record.addressId
      )
      const { adjustment: effectiveAdjustment, fulfillmentIntent } =
        prepareOrderStockUpdate({
          merchantPubkey: pubkey,
          orderId: payload.orderId,
          items: payload.orderItems,
          adjustment: payload.adjustment,
          record,
          persistedDecision,
        })
      const hasPendingDelivery = pendingStockDeliveryStoreRef.current
        .getForOrder(pubkey, payload.orderId)
        .some((pending) => pending.adjustment.key === effectiveAdjustment.key)
      if (
        isOrderStockAdjustmentMutationDisabled({
          adjustment: effectiveAdjustment,
          persistedDecision,
          hasPendingDelivery,
          hasSessionDecision: sessionStockDecisionKeys.has(
            `${pubkey}:${effectiveAdjustment.key}`
          ),
        })
      ) {
        throw new Error(
          "This stock update is already applied or awaiting delivery."
        )
      }
      let signedEvent: SignedPublicNostrEvent | null = null
      const delivery = await signAndPublishProductListing({
        merchantPubkey: pubkey,
        authenticatedPubkey,
        shouldContinue: () => isCurrentOrderAction(authority),
        product: {
          ...record.product,
          stock: effectiveAdjustment.nextStock,
          updatedAt: Date.now(),
        },
        dTag: record.dTag,
        previousEventCreatedAt: record.eventCreatedAt,
        fulfillmentIntent,
        onSignedLocal: async (event) => {
          if (!isCurrentOrderAccount(pubkey)) {
            throw new Error("Signed stock update belongs to another account.")
          }
          const rawEvent = event.rawEvent() as SignedPublicNostrEvent
          signedEvent = rawEvent
          pendingStockDeliveryStoreRef.current.set(pubkey, {
            orderId: payload.orderId,
            adjustment: effectiveAdjustment,
            signedEvent: rawEvent,
          })
          setSessionStockDecisionKeys((current) => {
            const next = new Set(current)
            next.add(`${pubkey}:${effectiveAdjustment.key}`)
            return next
          })
          setStockDelivery({
            orderId: payload.orderId,
            adjustment: effectiveAdjustment,
            notice: buildLocalProductDeliveryNotice("publish"),
            signedEvent: rawEvent,
          })
        },
      })

      if (!signedEvent) {
        throw new Error("The signed stock update was not saved locally")
      }
      return {
        authority,
        retryOwner: null,
        delivery,
        signedEvent,
        adjustment: effectiveAdjustment,
      }
    },
    onMutate: (payload) => {
      if (payload.action === "update") setStockDelivery(null)
    },
    onSuccess: async (result, payload) => {
      const previousNotice =
        payload.action === "retry" ? payload.previousNotice : undefined
      const notice = buildProductDeliveryNotice(
        "publish",
        result.delivery,
        previousNotice
      )
      const merchantPubkey = result.signedEvent.pubkey
      if (
        !isCurrentOrderAccount(merchantPubkey) ||
        (result.authority && !isCurrentOrderAction(result.authority)) ||
        (result.retryOwner && !isCurrentOrderAccount(result.retryOwner))
      ) {
        return
      }
      setStockDelivery({
        orderId: payload.orderId,
        adjustment: result.adjustment,
        notice,
        signedEvent: result.signedEvent,
      })
      if (notice.state === "delivered") {
        const decisionPersisted = stockDecisionStoreRef.current.set(
          merchantPubkey,
          payload.orderId,
          result.adjustment.addressId,
          "applied",
          result.adjustment
        )
        pendingStockDeliveryStoreRef.current.delete(
          merchantPubkey,
          payload.orderId,
          result.adjustment.addressId
        )
        setSessionStockDecisionKeys((current) => {
          const next = new Set(current)
          next.delete(`${merchantPubkey}:${result.adjustment.key}`)
          return next
        })
        const nextPendingDelivery =
          pendingStockDeliveryStoreRef.current.getForOrder(
            merchantPubkey,
            payload.orderId
          )[0]
        if (nextPendingDelivery) {
          setStockDelivery({
            orderId: nextPendingDelivery.orderId,
            adjustment: nextPendingDelivery.adjustment,
            notice: buildLocalProductRetryNotice("publish"),
            signedEvent: nextPendingDelivery.signedEvent,
          })
        }
        flash(
          decisionPersisted
            ? `Stock updated for ${result.adjustment.title}`
            : `Stock updated for ${result.adjustment.title}, but this device could not remember the order decision after reload.`
        )
      } else {
        const retryPersisted = pendingStockDeliveryStoreRef.current.set(
          merchantPubkey,
          {
            orderId: payload.orderId,
            adjustment: result.adjustment,
            signedEvent: result.signedEvent,
          }
        )
        flash(
          retryPersisted
            ? `Stock update saved locally for ${result.adjustment.title}; relay delivery still needs attention.`
            : `Stock update saved locally for ${result.adjustment.title}, but this device could not remember the relay retry after reload.`
        )
      }
      await invalidateProductQueries()
    },
    onError: async (error, payload) => {
      if (!pubkey || !isCurrentOrderAccount(pubkey)) return
      setStockDelivery((current) => {
        if (
          !current ||
          current.orderId !== payload.orderId ||
          current.adjustment.key !== payload.adjustment.key
        ) {
          return current
        }

        const diagnosticsError = getRelayPublishDiagnosticsError(error)
        if (diagnosticsError) {
          return {
            ...current,
            notice: buildProductDeliveryNotice(
              "publish",
              diagnosticsError.diagnostics,
              payload.action === "retry"
                ? payload.previousNotice
                : current.notice
            ),
          }
        }
        if (error instanceof SignedProductDeliveryError) {
          return {
            ...current,
            notice:
              payload.action === "retry"
                ? payload.previousNotice
                : buildLocalProductRetryNotice("publish"),
          }
        }
        return current
      })
      await invalidateProductQueries()
    },
  })

  function resolveInvoiceSelection(
    source: MerchantInvoiceActionSource
  ): MerchantInvoiceSelection {
    switch (source) {
      case "profile_lud16":
        if (!profileInvoiceAvailable) {
          throw new Error("A valid profile Lightning address is required.")
        }
        return { type: source }
      case "webln":
        if (!weblnAvailable) {
          throw new Error("A browser wallet is not available.")
        }
        return { type: source }
      case "nwc":
        if (!nwc.connection || !nwcInvoiceAvailable) {
          throw new Error(
            "The connected wallet must match the profile Lightning address."
          )
        }
        return {
          type: source,
          connection: nwc.connection,
        }
      case "manual":
        if (!invoice.trim()) throw new Error("Invoice is required.")
        return { type: source, invoice: invoice.trim() }
    }
  }

  const createInvoiceMutation = useMutation({
    mutationFn: (source: MerchantInvoiceActionSource) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        try {
          const authority = captureFreshOrderAuthority()
          if (!selectedInvoiceScope) {
            throw new Error("No conversation selected")
          }
          assertBuyerHasNostrInbox()
          if (!canSendInvoice) {
            throw new Error("This order is not eligible for another invoice.")
          }
          const amountSats = invoiceAmountSats ?? 0
          if (amountSats <= 0) {
            throw new Error("Amount must be greater than 0")
          }
          await merchantInvoiceModule.createAndDeliver({
            ...selectedInvoiceScope,
            amountSats,
            note: invoiceNote.trim() || undefined,
            delivery: operationalDelivery,
            source: resolveInvoiceSelection(source),
            authenticatedPubkey,
            shouldContinue: () => isCurrentOrderAction(authority),
          })
          return authority
        } catch {
          // Provider errors can contain invoices, addresses, relay responses,
          // or wallet credentials. React Query retains errors, so only expose
          // an allowlisted content-free message at this boundary.
          throw safeInvoiceActionError(source)
        }
      }),
    onSuccess: async (authority) => {
      if (!isCurrentOrderAction(authority)) return
      setInvoice("")
      setInvoiceNote("")
      flash("Invoice generated and sent to the buyer's relay")
      await invalidateOrderQueries()
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["merchant-pending-invoice"],
      })
    },
  })

  const retryInvoiceMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        try {
          const authority = captureFreshOrderAuthority()
          if (!selectedInvoiceScope) {
            throw new Error("No conversation selected")
          }
          await merchantInvoiceModule.retryDelivery({
            ...selectedInvoiceScope,
            authenticatedPubkey,
            shouldContinue: () => isCurrentOrderAction(authority),
          })
          return authority
        } catch {
          throw new Error(
            "Could not redeliver the saved invoice. Refresh and try again."
          )
        }
      }),
    onSuccess: async (authority) => {
      if (!isCurrentOrderAction(authority)) return
      flash("Saved invoice sent to the buyer's relay")
      await invalidateOrderQueries()
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["merchant-pending-invoice"],
      })
    },
  })

  const futureReadyMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        if (
          !pubkey ||
          !selectedOrder ||
          !selectedFutureOrganizerHandoff ||
          futureHasRelease ||
          authority.accountPubkey !== pubkey
        )
          throw new Error(
            "A new organizer release is unavailable for this order."
          )
        assertPaidForFulfillment(true)
        const evidence = await readVerifiedFutureEventMarketOrderEvidence({
          order: selectedOrder,
          merchantPubkey: pubkey,
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        if (
          evidence.result.status !== "verified" ||
          !isCurrentOrderAction(authority)
        )
          throw new Error("Exact signed order terms could not be verified.")
        const signer = getNdk().signer
        if (!signer) throw new Error("Merchant signer is not connected.")
        const delivery = await publishFutureMarketReadyReceipt({
          order: selectedOrder,
          signedOrderEvidence: evidence.events,
          paymentAuthenticated: merchantPaid,
          releaseConfirmed: organizerReleaseConfirmed,
          signer,
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
          persistExactWraps: (record) =>
            saveFutureMarketPrivateDelivery(pubkey, record),
        })
        if (
          delivery.deliveryStatus === "full_success" &&
          !delivery.selfCopyError
        ) {
          const record = loadFutureMarketPrivateDeliveries(pubkey).find(
            (candidate) =>
              candidate.signedRecipientWrap.id ===
              delivery.wrappedToRecipient.id
          )
          if (record) archiveFutureMarketPrivateDelivery(pubkey, record.rumorId)
        }
        return { authority, delivery }
      }),
    onSuccess: ({ authority, delivery }) => {
      if (!isCurrentOrderAction(authority)) return
      setConfirmingOrganizerRelease(false)
      setOrganizerReleaseConfirmed(false)
      setHandoffDeliveryRevision((revision) => revision + 1)
      flash(
        delivery.deliveryStatus === "full_success" && !delivery.selfCopyError
          ? "Exact organizer pickup receipt delivered"
          : "Exact organizer pickup receipt saved; retry delivery below"
      )
    },
    onError: () => setHandoffDeliveryRevision((revision) => revision + 1),
  })

  const futureRetryMutation = useMutation({
    mutationFn: (record: NonNullable<typeof futureReadyRecord>) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        if (
          !pubkey ||
          record.senderPubkey !== pubkey ||
          authority.accountPubkey !== pubkey
        )
          throw new Error("Exact handoff delivery belongs to another account.")
        const delivery = await retryFutureMarketPrivateDelivery({
          record,
          authenticatedOwnerPubkey: pubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        if (delivery.recipientDelivered && delivery.selfCopyDelivered)
          archiveFutureMarketPrivateDelivery(pubkey, record.rumorId)
        return { authority, delivery }
      }),
    onSuccess: ({ authority, delivery }) => {
      if (isCurrentOrderAction(authority))
        flash(
          delivery.recipientDelivered && delivery.selfCopyDelivered
            ? "Exact signed handoff wraps delivered"
            : "Exact signed handoff wraps still need delivery attention"
        )
    },
  })

  const futureRevokeMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        if (
          !pubkey ||
          !futureHasRelease ||
          futureRevocationRecord ||
          authority.accountPubkey !== pubkey
        )
          throw new Error("Exact organizer release cannot be revoked here.")
        const current = await futureAckQuery.refetch()
        if (
          current.isError ||
          !current.data ||
          current.data.stale ||
          current.data.conflicting ||
          current.data.exactAck
        )
          throw new Error(
            "Organizer handoff evidence is unavailable or already handed out."
          )
        const signer = getNdk().signer
        if (!signer) throw new Error("Merchant signer is not connected.")
        const delivery = await publishFutureMarketRevocation({
          readyRecord: futureReadyRecord,
          recoveredClaim: futureRecoveredClaim ?? undefined,
          signer,
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
          persistExactWraps: (record) =>
            saveFutureMarketPrivateDelivery(pubkey, record),
        })
        if (
          delivery.deliveryStatus === "full_success" &&
          !delivery.selfCopyError
        ) {
          const record = loadFutureMarketPrivateDeliveries(pubkey).find(
            (candidate) =>
              candidate.signedRecipientWrap.id ===
              delivery.wrappedToRecipient.id
          )
          if (record) archiveFutureMarketPrivateDelivery(pubkey, record.rumorId)
        }
        return { authority, delivery }
      }),
    onSuccess: ({ authority, delivery }) => {
      if (!isCurrentOrderAction(authority)) return
      setHandoffDeliveryRevision((revision) => revision + 1)
      flash(
        delivery.deliveryStatus === "full_success" && !delivery.selfCopyError
          ? "Exact organizer release revocation delivered"
          : "Exact organizer release revocation saved; retry delivery below"
      )
    },
    onError: () => setHandoffDeliveryRevision((revision) => revision + 1),
  })

  const confirmPaymentMutation = useMutation({
    mutationFn: (input: MerchantPaymentConfirmationInput) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        if (authority.accountPubkey !== input.merchantPubkey) {
          throw new Error("Payment confirmation belongs to another account")
        }
        const result = await confirmMerchantPayment({
          ...input,
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        return { authority, result }
      }),
    onSuccess: async ({ authority }, input) => {
      if (!isCurrentOrderAction(authority)) return
      const estimate = input.order
        ? getCommerceGmvEstimateFromOrder({
            orderId: input.orderId,
            buyerPubkey: input.buyerPubkey,
            merchantPubkey: input.merchantPubkey,
            order: input.order,
          })
        : null
      if (estimate) void reportCommerceGmvEstimate(estimate)
      if (selected?.orderId === input.orderId) flash("Payment confirmed.")
      await invalidateOrderQueries()
    },
  })

  const advanceStatusMutation = useMutation({
    mutationFn: ({
      nextStatus,
      conversation,
    }: {
      nextStatus: KnownOrderStatus
      conversation?: MerchantConversationSummary
    }) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        const actionConversation = conversation ?? selected
        if (
          !pubkey ||
          !actionConversation ||
          authority.accountPubkey !== pubkey
        ) {
          throw new Error("No conversation selected")
        }
        const actionCorrelationRef = selectedOrderCorrelationRef
        if (nextStatus === "cancelled") {
          if (selectedFutureOrganizerHandoff && futureHasRelease) {
            const current = await futureAckQuery.refetch()
            if (
              !futureRevocationRecord ||
              current.isError ||
              !current.data ||
              current.data.stale ||
              current.data.conflicting ||
              current.data.exactAck ||
              !current.data.revoked
            )
              throw new Error(
                "Revoke the exact organizer release and verify its private receipt before cancelling."
              )
            const delivery = await retryFutureMarketPrivateDelivery({
              record: futureRevocationRecord,
              authenticatedOwnerPubkey: pubkey,
              shouldContinue: () => isCurrentOrderAction(authority),
            })
            if (!delivery.recipientDelivered)
              throw new Error(
                "The exact revocation has no organizer inbox acknowledgement; cancellation remains blocked."
              )
          }
          setHandoffDeliveryRevision((revision) => revision + 1)
        }
        if (nextStatus === "shipped" || nextStatus === "complete") {
          assertPaidForFulfillment(nextStatus === "complete")
        }
        if (
          nextStatus === "shipped" &&
          snapshottedOrderFulfillment.hasPickupClaim
        ) {
          throw new Error(
            "Pickup orders do not use carrier or tracking details."
          )
        }
        if (
          nextStatus === "complete" &&
          snapshottedOrderFulfillment.hasPickupClaim
        ) {
          await assertCurrentPickupAuthorization(authority)
          if (selectedFutureOrganizerHandoff) {
            const current = await futureAckQuery.refetch()
            if (
              !futureHasRelease ||
              !canCompleteFutureMarketHandoff({
                read: current.data,
                retained: futureAckQuery.data,
                hasLocalRevocation:
                  !!futureRevocationRecord ||
                  futureRecoveredClaim?.state === "revoked" ||
                  futureRecoveredClaim?.state === "conflicting",
              })
            )
              throw new Error(
                "A current exact organizer handed-out acknowledgement is required before completion."
              )
          }
        }
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: actionConversation.buyerPubkey,
          orderId: actionConversation.orderId,
          type: "status_update",
          tags: [["status", nextStatus]],
          payload: { status: nextStatus },
          delivery: operationalDelivery,
          signerInteraction: "external",
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        if (!isCurrentOrderAction(authority)) {
          throw new Error("Merchant signer session changed")
        }
        return { authority, actionCorrelationRef }
      }),
    onSuccess: async ({ authority }) => {
      if (!isCurrentOrderAction(authority)) return
      flash(buyerInboxKnown ? "Status update sent to buyer" : "Status recorded")
      await invalidateOrderQueries()
    },
  })

  const reopenOrderMutation = useMutation({
    mutationFn: (input: ReopenOrderMutationInput) =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        if (authority.accountPubkey !== input.merchantPubkey) {
          throw new Error("Merchant signer is not connected")
        }
        await publishMerchantOrderMessage({
          merchantPubkey: input.merchantPubkey,
          buyerPubkey: input.buyerPubkey,
          orderId: input.orderId,
          type: "status_update",
          tags: input.transition.tags,
          payload: input.transition.payload,
          delivery: input.delivery,
          signerInteraction: "external",
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        return authority
      }),
    onSuccess: async (authority, input) => {
      if (!isCurrentOrderAction(authority)) return
      setReopenConfirmation(null)
      setReopenConfirmationError(null)
      flash(
        input.delivery === "buyer_and_self"
          ? "Reopen update submitted for buyer delivery"
          : "Reopen update recorded in your encrypted order history"
      )
      await invalidateOrderQueries()
    },
  })

  const shippingMutation = useMutation({
    mutationFn: () =>
      runExclusiveOrderAction(orderActionLockRef, async () => {
        const authority = captureFreshOrderAuthority()
        const actionConversation = selected
        if (
          !pubkey ||
          !actionConversation ||
          authority.accountPubkey !== pubkey
        ) {
          throw new Error("No ready merchant signer for this order")
        }
        if (snapshottedOrderFulfillment.hasPickupClaim) {
          throw new Error(
            "Pickup orders do not use carrier or tracking details."
          )
        }
        assertPaidForFulfillment()
        const prepared = prepareShippingUpdate({
          trackingNumber,
          carrier,
          trackingUrl,
          note: shippingNote,
        })
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: actionConversation.buyerPubkey,
          orderId: actionConversation.orderId,
          type: "shipping_update",
          tags: [
            ["tracking", prepared.trackingNumber],
            ["carrier", prepared.carrier],
          ],
          payload: {
            carrier: prepared.carrier,
            trackingNumber: prepared.trackingNumber,
            trackingUrl: prepared.trackingUrl,
            note: prepared.note,
          },
          delivery: operationalDelivery,
          signerInteraction: "external",
          authenticatedPubkey,
          shouldContinue: () => isCurrentOrderAction(authority),
        })
        return {
          authority,
          buyerInboxKnown,
          draft: {
            trackingNumber,
            carrier,
            trackingUrl,
            shippingNote,
          },
        }
      }),
    onSuccess: async ({ authority, buyerInboxKnown, draft }) => {
      if (!isCurrentOrderAction(authority)) return
      setCarrier((current) => (current === draft.carrier ? "" : current))
      setTrackingNumber((current) =>
        current === draft.trackingNumber ? "" : current
      )
      setTrackingUrl((current) =>
        current === draft.trackingUrl ? "" : current
      )
      setShippingNote((current) =>
        current === draft.shippingNote ? "" : current
      )
      flash(
        buyerInboxKnown
          ? "Shipping update sent to buyer"
          : "Shipping update recorded"
      )
      await invalidateOrderQueries()
    },
  })

  const noteMutation = useMutation({
    mutationFn: async (content: string) => {
      const authority = captureFreshOrderAuthority()
      const actionConversation = selected
      if (
        !pubkey ||
        !actionConversation ||
        authority.accountPubkey !== pubkey
      ) {
        throw new Error("No ready merchant signer for this order")
      }
      assertBuyerHasNostrInbox()
      const preparedContent = content.trim()
      if (!preparedContent) throw new Error("Message is required")
      await publishMerchantOrderMessage({
        merchantPubkey: pubkey,
        buyerPubkey: actionConversation.buyerPubkey,
        orderId: actionConversation.orderId,
        type: "message",
        payload: {
          note: preparedContent,
        },
        delivery: operationalDelivery,
        signerInteraction: "external",
        authenticatedPubkey,
        shouldContinue: () => isCurrentOrderAction(authority),
      })
      return { authority, content }
    },
    onSuccess: async ({ authority, content }) => {
      if (!isCurrentOrderAction(authority)) return
      setReplyNote((current) => (current === content ? "" : current))
      flash("Message sent to buyer")
      await invalidateOrderQueries()
    },
  })

  const orderActionPending =
    !signerConnected ||
    stockUpdateMutation.isPending ||
    confirmPaymentMutation.isPending ||
    futureReadyMutation.isPending ||
    futureRevokeMutation.isPending ||
    futureRetryMutation.isPending ||
    reopenOrderMutation.isPending ||
    isMerchantOrderActionSurfacePending({
      generateInvoice: createInvoiceMutation.isPending,
      sendInvoice: retryInvoiceMutation.isPending,
      advanceStatus: advanceStatusMutation.isPending,
      recordShipping: shippingMutation.isPending,
    })

  const previousOrderAuthorityKeyRef = useRef(
    `${authGeneration}:${signerReadiness}`
  )
  useLayoutEffect(() => {
    const authorityKey = `${authGeneration}:${signerReadiness}`
    if (previousOrderAuthorityKeyRef.current === authorityKey) return
    previousOrderAuthorityKeyRef.current = authorityKey
    if (stockUpdateMutation.variables?.action === "update") {
      stockUpdateMutation.reset()
    }
    createInvoiceMutation.reset()
    retryInvoiceMutation.reset()
    futureReadyMutation.reset()
    futureRevokeMutation.reset()
    futureRetryMutation.reset()
    confirmPaymentMutation.reset()
    advanceStatusMutation.reset()
    reopenOrderMutation.reset()
    shippingMutation.reset()
    noteMutation.reset()
  }, [
    advanceStatusMutation,
    authGeneration,
    confirmPaymentMutation,
    createInvoiceMutation,
    noteMutation,
    futureReadyMutation,
    futureRevokeMutation,
    futureRetryMutation,
    reopenOrderMutation,
    retryInvoiceMutation,
    shippingMutation,
    signerReadiness,
    stockUpdateMutation,
  ])
  const stockUpdateErrorMessage =
    stockUpdateMutation.error &&
    !(stockUpdateMutation.error instanceof SignedProductDeliveryError)
      ? stockUpdateMutation.error instanceof Error
        ? stockUpdateMutation.error.message
        : "Failed to update listing stock"
      : null

  function updateStock(
    adjustment: OrderStockAdjustment,
    stock: number,
    targetMode: OrderStockTargetMode
  ): void {
    if (!selected || !orderSummary) return
    stockUpdateMutation.mutate({
      action: "update",
      orderId: selected.orderId,
      adjustment: applyOrderStockTarget(adjustment, stock, targetMode),
      orderItems: orderSummary.items,
    })
  }

  function retryStockDelivery(): void {
    if (!selectedStockDelivery) return
    stockUpdateMutation.mutate({
      action: "retry",
      orderId: selectedStockDelivery.orderId,
      adjustment: selectedStockDelivery.adjustment,
      signedEvent: selectedStockDelivery.signedEvent,
      previousNotice: selectedStockDelivery.notice,
    })
  }

  function dismissStockDelivery(): void {
    if (stockDeliveryCanRetry) {
      flash("Relay retry hidden for now. Reopen this order to resume delivery.")
    }
    setStockDelivery(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 xl:shrink-0">
        <div>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Orders
          </h1>
          <p className="mt-2 max-w-2xl text-pretty text-sm leading-7 text-[var(--text-secondary)]">
            Review incoming buyer orders, send invoices, update status, and
            share shipping details.
          </p>
          <div className="mt-3">
            <RefreshChip
              refreshing={ordersRefreshState.refreshing}
              stale={ordersRefreshState.stale}
              onRefresh={handleRefresh}
              disabled={!signerConnected}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4 xl:shrink-0">
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Open threads
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {protectedOrderCountsUnavailable ? "—" : conversations.length}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Awaiting invoice
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {protectedOrderCountsUnavailable ? "—" : awaitingInvoiceCount}
          </div>
        </div>
        <div className="rounded-[1.35rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-3 md:p-4">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)] md:text-xs md:tracking-[0.18em]">
            Active fulfillment
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)] md:mt-3 md:text-3xl">
            {protectedOrderCountsUnavailable ? "—" : activeFulfillmentCount}
          </div>
        </div>
      </div>

      {remoteSignerRecovery ? (
        <SignerRecoveryNotice
          description="Your order drafts and saved exact-delivery retries are still here. Reconnect the same signer, review the order, then choose the action again. Conduit will not sign or send it automatically."
          reconnecting={status === "restoring"}
          restoreFailed={!!remoteSignerRecovery.restoreError}
          restoreFailureDescription="That saved signer connection could not be restored. Your drafts remain for this account, and no order action was replayed."
          onReconnect={() => connect({ mode: "restore" })}
        />
      ) : null}

      {!hasAccount && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view incoming orders.
        </div>
      )}

      {signerConnected &&
        !inboxReadiness.isLoading &&
        inboxReadinessNoticeState && (
          <MessagingReadinessNotice
            state={inboxReadinessNoticeState}
            onAction={() => {
              if (
                inboxReadiness.status === "lookup_partial" ||
                inboxReadiness.status === "lookup_unavailable"
              ) {
                inboxReadiness.refetch()
              } else {
                void navigate({ to: "/network" })
              }
            }}
            pending={inboxReadiness.isRefetching}
          />
        )}

      {hasAccount && protectedOrdersReadState !== "pending" && (
        <ProtectedInboxNotice
          state={protectedOrdersReadState}
          subject="orders"
          decryptFailureCount={ordersMeta?.decryptFailures?.length ?? 0}
          onRetry={signerConnected ? handleRefresh : undefined}
          retrying={ordersQuery.isRefetching}
        />
      )}

      {hasAccount &&
        !cachedOrdersQuery.isLoading &&
        conversations.length === 0 &&
        protectedOrdersReadState === "complete" && (
          <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No orders yet. Place an order from the Market app targeting this
            merchant pubkey.
          </div>
        )}

      {hasAccount && conversations.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start">
          <aside className="hidden rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 xl:sticky xl:top-4 xl:flex xl:max-h-[calc(100vh-2rem)] xl:flex-col xl:overflow-hidden">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
              Orders
            </div>
            <div className="xl:shrink-0">
              <SearchBox value={orderSearch} onChange={setOrderSearch} />
              <OrderListControls
                idPrefix="desktop"
                phase={phaseTab}
                onPhaseChange={changePhaseTab}
                sort={orderSort}
                onSortChange={setOrderSort}
              />
            </div>
            <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
              {filteredConversations.length === 0 && (
                <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                  {emptyOrdersLabel(orderSearch.trim(), phaseTab)}
                </div>
              )}
              {filteredConversations.map((conversation) => (
                <OrderListItem
                  key={conversation.id}
                  conversation={conversation}
                  buyerProfile={buyerProfiles?.[conversation.buyerPubkey]}
                  active={conversation.id === selectedConversationId}
                  onClick={() => selectConversation(conversation.id)}
                />
              ))}
            </div>
          </aside>

          <div className="min-w-0 space-y-4 xl:hidden">
            <Sheet open={ordersSheetOpen} onOpenChange={setOrdersSheetOpen}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                  Orders
                </div>
                <SheetTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)]"
                  >
                    <Search className="size-4" aria-hidden="true" />
                    Filter &amp; sort
                  </button>
                </SheetTrigger>
              </div>
              <MobileOrdersScroller
                conversations={filteredConversations}
                selectedId={selectedConversationId}
                buyerProfiles={buyerProfiles}
                onSelect={selectConversation}
              />
              <SheetContent
                side="bottom"
                className="h-[100dvh] overflow-y-auto"
              >
                <SheetHeader>
                  <SheetTitle>Your orders</SheetTitle>
                </SheetHeader>
                <SearchBox value={orderSearch} onChange={setOrderSearch} />
                <OrderListControls
                  idPrefix="mobile"
                  phase={phaseTab}
                  onPhaseChange={changePhaseTab}
                  sort={orderSort}
                  onSortChange={setOrderSort}
                />
                <div className="mt-4 space-y-2">
                  {filteredConversations.length === 0 && (
                    <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      {emptyOrdersLabel(orderSearch.trim(), phaseTab)}
                    </div>
                  )}
                  {filteredConversations.map((conversation) => (
                    <OrderListItem
                      key={conversation.id}
                      conversation={conversation}
                      buyerProfile={buyerProfiles?.[conversation.buyerPubkey]}
                      active={conversation.id === selectedConversationId}
                      onClick={() => {
                        selectConversation(conversation.id)
                        setOrdersSheetOpen(false)
                      }}
                    />
                  ))}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          <section className="min-w-0">
            {selected && orderSummary ? (
              <div className="space-y-4">
                <div className="xl:hidden">
                  <OrderItemsCard
                    items={orderSummary.items}
                    productLookup={productLookup}
                    itemSubtotal={orderSummary.itemSubtotal}
                    shippingCostSats={orderSummary.shippingCostSats}
                    shippingCostStatus={orderSummary.shippingCostStatus}
                    total={orderSummary.subtotal}
                    currency={orderSummary.currency}
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="min-w-0 space-y-4">
                    {selectedFuturePickup?.type === "event_market_pickup" ? (
                      <section className={panelCard}>
                        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                          Event pickup date
                        </h2>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          {formatEventMarketPickupDate(selectedFuturePickup)} ·{" "}
                          {selectedFuturePickup.assignment}
                        </p>
                        <p className="mt-1 text-xs text-[var(--text-muted)]">
                          This order keeps the signed date accepted by the
                          buyer.
                        </p>
                      </section>
                    ) : null}
                    <section className={panelCard}>
                      <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        Order progress
                      </h2>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        Track this order through fulfillment.
                      </p>
                      <div className="mt-5">
                        <StatusStepper
                          rows={buildOrderStatusTimeline(merchantOrderState)}
                          ariaLabel="Order progress"
                        />
                      </div>
                    </section>

                    {merchantOrderState.status === "complete" && (
                      <section className={panelCard}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm text-[var(--text-secondary)]">
                            Glad you fulfilled this order? Support the project.
                          </p>
                          <MerchantProjectTip className="min-h-11 text-primary-500" />
                        </div>
                      </section>
                    )}

                    <section className={panelCard}>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                        {isGuestOrder ? "Guest order" : "Actions"}
                      </h3>
                      <>
                        {!buyerInboxKnown && (
                          <p className="mt-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-warning">
                            {isGuestOrder
                              ? orderSummary.guestContact
                                ? "This guest has no Nostr reply inbox. Contact them by phone or email; fulfillment actions below are recorded to your encrypted order history."
                                : "This guest has no Nostr reply inbox and the order is missing required contact details. Fulfillment actions below are recorded only to your encrypted order history."
                              : "This partial order history does not prove the buyer has a Nostr reply inbox. Actions are recorded to your encrypted order history until the order identity is recovered."}
                          </p>
                        )}
                        <div className="mt-4 space-y-5">
                          {successFlash && (
                            <div
                              role="status"
                              aria-live="polite"
                              className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400"
                            >
                              {successFlash}
                            </div>
                          )}

                          <OrderStockPanel
                            adjustments={stockAdjustments}
                            stockMutationDisabledKeys={
                              stockMutationDisabledKeys
                            }
                            delivery={selectedStockDelivery}
                            deliveryNeedsAttention={stockDeliveryCanRetry}
                            pending={orderActionPending}
                            retryPending={stockUpdateMutation.isPending}
                            updatePending={stockUpdateMutation.isPending}
                            errorMessage={stockUpdateErrorMessage}
                            canMessageBuyer={buyerInboxKnown}
                            onUpdate={updateStock}
                            onMessageBuyer={() => setMessagesOpen(true)}
                            onRetry={retryStockDelivery}
                            onDismissDelivery={dismissStockDelivery}
                          />

                          {hasNextStep && (
                            <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                              Next step
                            </h4>
                          )}

                          {confirmPaymentMutation.error &&
                            confirmPaymentMutation.variables?.orderId ===
                              selected?.orderId && (
                              <p role="alert" className="text-sm text-error">
                                Payment confirmation could not be recorded.
                                Review the order status before retrying. No new
                                organizer release was authorized by this
                                attempt.
                              </p>
                            )}

                          {canRequestPaymentOutOfBand && (
                            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm leading-6 text-warning">
                              <div className="font-semibold">
                                Request payment outside Nostr
                              </div>
                              <p className="mt-1">
                                {orderSummary.guestContact
                                  ? "Use the phone or email on this order to request payment. Confirm it below only after settlement."
                                  : "Recover a buyer contact method before requesting payment. Confirm it below only after settlement."}
                              </p>
                            </div>
                          )}

                          {primaryButtonActions.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex flex-wrap gap-2">
                                {primaryButtonActions.map((action) => (
                                  <Button
                                    key={action.action}
                                    size="sm"
                                    variant="primary"
                                    disabled={
                                      orderActionPending ||
                                      (action.action === "reopen" &&
                                        !currentReopenInput) ||
                                      (action.status === "complete" &&
                                        organizerCompletionBlocked)
                                    }
                                    onClick={() => {
                                      if (action.action === "confirm_payment") {
                                        if (!selected) return
                                        confirmPaymentMutation.reset()
                                        setPaymentConfirmationTarget(
                                          captureMerchantPaymentConfirmationTarget(
                                            selected
                                          )
                                        )
                                        return
                                      }
                                      if (action.action === "reopen") {
                                        reopenOrderMutation.reset()
                                        setReopenConfirmationError(null)
                                        setReopenConfirmation(
                                          currentReopenInput
                                        )
                                        return
                                      }
                                      if (action.status) {
                                        advanceStatusMutation.mutate({
                                          nextStatus: action.status,
                                        })
                                      }
                                    }}
                                  >
                                    {(advanceStatusMutation.isPending &&
                                      advanceStatusMutation.variables
                                        ?.nextStatus === action.status) ||
                                    (action.action === "reopen" &&
                                      reopenOrderMutation.isPending)
                                      ? buyerInboxKnown
                                        ? "Sending…"
                                        : "Recording…"
                                      : action.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )}

                          {(canSendInvoice ||
                            canRecordShipping ||
                            advanceStatusMutation.error ||
                            reopenOrderMutation.error ||
                            createInvoiceMutation.error ||
                            retryInvoiceMutation.error ||
                            shippingMutation.error ||
                            noteMutation.error) && (
                            <div className="space-y-3">
                              {canSendInvoice && (
                                <div className="space-y-2">
                                  {pendingInvoiceQuery.isPending && (
                                    <p className="text-xs text-[var(--text-secondary)]">
                                      Checking for a saved invoice…
                                    </p>
                                  )}

                                  {pendingInvoiceQuery.error && (
                                    <div className="space-y-2 rounded-md border border-error/30 bg-error/10 p-3 text-xs text-error">
                                      <p>
                                        Could not load the saved invoice status.
                                        Refresh before creating one.
                                      </p>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          void pendingInvoiceQuery.refetch()
                                        }
                                      >
                                        Retry status check
                                      </Button>
                                    </div>
                                  )}

                                  {pendingInvoiceQuery.data?.state ===
                                    "pending" && (
                                    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
                                      <p className="text-sm font-medium text-[var(--text-primary)]">
                                        A saved invoice still needs delivery.
                                      </p>
                                      <p className="text-xs text-[var(--text-secondary)]">
                                        Retry sends the exact same invoice; it
                                        does not create another one.
                                      </p>
                                      <Button
                                        type="button"
                                        size="sm"
                                        className="w-full"
                                        disabled={orderActionPending}
                                        onClick={() =>
                                          retryInvoiceMutation.mutate()
                                        }
                                      >
                                        {retryInvoiceMutation.isPending
                                          ? "Retrying…"
                                          : "Retry saved invoice"}
                                      </Button>
                                    </div>
                                  )}

                                  {pendingInvoiceQuery.data?.state ===
                                    "sent" && (
                                    <div className="space-y-2 rounded-md border border-success/30 bg-success/10 p-3 text-xs text-success">
                                      <p>
                                        Invoice sent to the buyer's relay.
                                        Waiting for payment.
                                      </p>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="w-full"
                                        disabled={orderActionPending}
                                        onClick={() =>
                                          retryInvoiceMutation.mutate()
                                        }
                                      >
                                        {retryInvoiceMutation.isPending
                                          ? "Resending…"
                                          : "Resend same invoice"}
                                      </Button>
                                    </div>
                                  )}

                                  {!pendingInvoiceQuery.isPending &&
                                    !pendingInvoiceQuery.error &&
                                    (!pendingInvoiceQuery.data ||
                                      pendingInvoiceQuery.data.state ===
                                        "none") && (
                                      <div className="space-y-2">
                                        <div className="grid gap-1">
                                          <Label htmlFor="invoice-source">
                                            Invoice source
                                          </Label>
                                          <Select
                                            value={invoiceSource}
                                            onValueChange={(value) =>
                                              setInvoiceSource(
                                                value as MerchantInvoiceActionSource
                                              )
                                            }
                                          >
                                            <SelectTrigger id="invoice-source">
                                              <SelectValue placeholder="Choose invoice source" />
                                            </SelectTrigger>
                                            <SelectContent>
                                              <SelectItem
                                                value="profile_lud16"
                                                disabled={
                                                  !profileInvoiceAvailable
                                                }
                                              >
                                                Profile Lightning address
                                              </SelectItem>
                                              <SelectItem
                                                value="webln"
                                                disabled={!weblnAvailable}
                                              >
                                                Browser wallet (WebLN)
                                              </SelectItem>
                                              <SelectItem
                                                value="nwc"
                                                disabled={!nwcInvoiceAvailable}
                                              >
                                                Connected wallet (NWC)
                                              </SelectItem>
                                              <SelectItem value="manual">
                                                Paste BOLT11 manually
                                              </SelectItem>
                                            </SelectContent>
                                          </Select>
                                        </div>

                                        {invoiceSource === "profile_lud16" && (
                                          <p className="text-xs text-[var(--text-secondary)]">
                                            {profileInvoiceAvailable
                                              ? "Uses the Lightning address in your signed merchant profile."
                                              : "Add a valid Lightning address to your merchant profile, or choose another source."}
                                          </p>
                                        )}
                                        {invoiceSource === "nwc" &&
                                          nwc.addressStatus === "mismatch" && (
                                            <p className="text-xs text-error">
                                              The connected wallet destination
                                              does not match your profile
                                              Lightning address.
                                            </p>
                                          )}

                                        <div className="grid grid-cols-2 gap-2">
                                          <div className="grid gap-1">
                                            <Label htmlFor="invoice-amount">
                                              Amount
                                            </Label>
                                            <Input
                                              id="invoice-amount"
                                              type="number"
                                              min="0"
                                              step={getCurrencyAmountStep(
                                                invoiceCurrency
                                              )}
                                              value={invoiceAmount}
                                              onChange={(event) =>
                                                setInvoiceAmount(
                                                  event.target.value
                                                )
                                              }
                                            />
                                          </div>
                                          <div className="grid gap-1">
                                            <Label htmlFor="invoice-currency">
                                              Currency
                                            </Label>
                                            <Select
                                              value={invoiceCurrency}
                                              onValueChange={(value) =>
                                                setInvoiceCurrency(value)
                                              }
                                            >
                                              <SelectTrigger id="invoice-currency">
                                                <SelectValue placeholder="Choose currency" />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {INVOICE_CURRENCY_OPTIONS.map(
                                                  (currency) => (
                                                    <SelectItem
                                                      key={currency}
                                                      value={currency}
                                                    >
                                                      {currency}
                                                    </SelectItem>
                                                  )
                                                )}
                                              </SelectContent>
                                            </Select>
                                          </div>
                                        </div>
                                        <Input
                                          aria-label="Invoice note"
                                          value={invoiceNote}
                                          onChange={(event) =>
                                            setInvoiceNote(event.target.value)
                                          }
                                          placeholder="Optional note"
                                        />

                                        {invoiceSource === "manual" && (
                                          <div className="grid gap-1">
                                            <Label htmlFor="invoice-bolt11">
                                              BOLT11 (paste manually)
                                            </Label>
                                            <Input
                                              id="invoice-bolt11"
                                              value={invoice}
                                              onChange={(event) =>
                                                setInvoice(event.target.value)
                                              }
                                              placeholder="lnbc..."
                                            />
                                            {invoice.trim() &&
                                              !isInvoiceCompatibleWithCurrentNetwork(
                                                invoice.trim()
                                              ) && (
                                                <div className="text-xs text-error">
                                                  {getLightningNetworkMismatchMessage(
                                                    invoice.trim()
                                                  )}
                                                </div>
                                              )}
                                            {invoice.trim() &&
                                              isInvoiceCompatibleWithCurrentNetwork(
                                                invoice.trim()
                                              ) &&
                                              manualInvoiceDecoded?.currency && (
                                                <div className="text-xs text-[var(--text-secondary)]">
                                                  Parsed invoice amount:{" "}
                                                  {manualInvoiceDecoded.sats ??
                                                    manualInvoiceDecoded.msats}{" "}
                                                  {
                                                    manualInvoiceDecoded.currency
                                                  }
                                                </div>
                                              )}
                                          </div>
                                        )}

                                        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                                          {invoiceCurrencyUnsupported ? (
                                            <>
                                              This order was placed in{" "}
                                              {selectedOrderCurrency}. Choose
                                              USD or SATS before creating an
                                              invoice.
                                            </>
                                          ) : invoiceAmountNumber > 0 ? (
                                            invoiceAmountSats ? (
                                              <>
                                                The invoice must be exactly{" "}
                                                {invoiceAmountSats.toLocaleString()}{" "}
                                                sats.
                                              </>
                                            ) : (
                                              <>
                                                BTC/USD conversion is
                                                unavailable right now.
                                              </>
                                            )
                                          ) : (
                                            <>
                                              Enter the order amount to create
                                              an invoice.
                                            </>
                                          )}
                                        </div>

                                        <Button
                                          type="button"
                                          size="sm"
                                          className="w-full"
                                          disabled={
                                            orderActionPending ||
                                            !selectedInvoiceSourceAvailable ||
                                            !(invoiceAmountNumber > 0) ||
                                            !invoiceAmountSats ||
                                            (invoiceSource === "manual" &&
                                              !invoice.trim())
                                          }
                                          onClick={() =>
                                            createInvoiceMutation.mutate(
                                              invoiceSource
                                            )
                                          }
                                        >
                                          {createInvoiceMutation.isPending
                                            ? "Creating…"
                                            : invoiceSource === "manual"
                                              ? "Validate & send invoice"
                                              : "Generate & send invoice"}
                                        </Button>
                                        <p className="text-xs text-[var(--text-secondary)]">
                                          This private order flow does not
                                          create a public zap request or
                                          receipt.
                                        </p>
                                      </div>
                                    )}
                                </div>
                              )}

                              {canRecordShipping && (
                                <form
                                  className="space-y-2"
                                  onSubmit={(event) => {
                                    event.preventDefault()
                                    shippingMutation.mutate()
                                  }}
                                >
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-tracking-code">
                                      Tracking code
                                    </Label>
                                    <Input
                                      id="shipping-tracking-code"
                                      required
                                      pattern=".*\S.*"
                                      title="Enter a tracking code."
                                      value={trackingNumber}
                                      onChange={(event) =>
                                        setTrackingNumber(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-carrier">
                                      Carrier
                                    </Label>
                                    <Input
                                      id="shipping-carrier"
                                      required
                                      pattern=".*\S.*"
                                      title="Enter a carrier."
                                      value={carrier}
                                      onChange={(event) =>
                                        setCarrier(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-tracking-url">
                                      Tracking URL (optional)
                                    </Label>
                                    <Input
                                      id="shipping-tracking-url"
                                      type="url"
                                      inputMode="url"
                                      value={trackingUrl}
                                      onChange={(event) =>
                                        setTrackingUrl(event.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="grid gap-1">
                                    <Label htmlFor="shipping-additional-notes">
                                      Additional notes (optional)
                                    </Label>
                                    <Input
                                      id="shipping-additional-notes"
                                      maxLength={2000}
                                      value={shippingNote}
                                      onChange={(event) =>
                                        setShippingNote(event.target.value)
                                      }
                                    />
                                  </div>
                                  <Button
                                    type="submit"
                                    size="sm"
                                    className="w-full"
                                    disabled={orderActionPending}
                                  >
                                    {shippingMutation.isPending
                                      ? "Sending…"
                                      : buyerInboxKnown
                                        ? "Send shipping update"
                                        : "Record shipping update"}
                                  </Button>
                                </form>
                              )}

                              {(advanceStatusMutation.error ||
                                reopenOrderMutation.error ||
                                createInvoiceMutation.error ||
                                retryInvoiceMutation.error ||
                                shippingMutation.error ||
                                noteMutation.error) && (
                                <div
                                  role="alert"
                                  className="rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error"
                                >
                                  {[
                                    advanceStatusMutation.error,
                                    reopenOrderMutation.error,
                                    createInvoiceMutation.error,
                                    retryInvoiceMutation.error,
                                    shippingMutation.error,
                                    noteMutation.error,
                                  ]
                                    .filter(Boolean)
                                    .map((error) =>
                                      error instanceof Error
                                        ? error.message
                                        : "Failed to send message"
                                    )
                                    .join(" • ")}
                                </div>
                              )}
                            </div>
                          )}

                          {destructiveActions.length > 0 && (
                            <div
                              className={cn(
                                "space-y-3",
                                hasNextStep &&
                                  "border-t border-[var(--border)] pt-4"
                              )}
                            >
                              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                                Other actions
                              </h4>
                              {destructiveCancellationCopy?.warning && (
                                <p className="text-pretty text-xs leading-5 text-[var(--text-secondary)]">
                                  {destructiveCancellationCopy.warning}
                                </p>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {destructiveActions.map((action) => (
                                  <Button
                                    key={action.action}
                                    size="sm"
                                    variant="destructive"
                                    disabled={orderActionPending}
                                    onClick={() => {
                                      if (action.status) {
                                        setPendingDestructiveAction(action)
                                      }
                                    }}
                                  >
                                    {action.label}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    </section>
                  </div>

                  <div className="space-y-4">
                    <div className="hidden xl:block">
                      <OrderItemsCard
                        items={orderSummary.items}
                        productLookup={productLookup}
                        itemSubtotal={orderSummary.itemSubtotal}
                        shippingCostSats={orderSummary.shippingCostSats}
                        shippingCostStatus={orderSummary.shippingCostStatus}
                        total={orderSummary.subtotal}
                        currency={orderSummary.currency}
                      />
                    </div>

                    {isGuestOrder ? (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Buyer
                        </h3>
                        <div className="mt-3 flex items-center gap-3">
                          <BuyerAvatar name={selectedBuyerName ?? ""} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold text-[var(--text-primary)]">
                              {selectedBuyerName}
                            </div>
                            <div className="truncate font-mono text-xs text-[var(--text-muted)]">
                              Guest checkout
                            </div>
                          </div>
                          <StatusPill
                            variant={selectedStatusDisplay?.tone ?? "neutral"}
                            className="shrink-0 capitalize"
                          >
                            {selectedStatusDisplay?.label ?? "Unknown"}
                          </StatusPill>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3 w-full"
                          onClick={() => setMessagesOpen(true)}
                        >
                          <MessageCircle
                            className="size-4"
                            aria-hidden="true"
                          />
                          Order history
                          {(selected.messages?.length ?? 0) > 0 && (
                            <span className="ml-1 rounded-full bg-[var(--surface)] px-1.5 text-xs text-[var(--text-secondary)]">
                              {selected.messages?.length}
                            </span>
                          )}
                        </Button>
                      </section>
                    ) : (
                      <ShopperTrustCard
                        shopperPubkey={selected.buyerPubkey}
                        profile={selectedBuyerProfile}
                        profileState={selectedBuyerProfileState}
                        evidence={shopperTrustQuery.evidence}
                        isHydrating={
                          shopperTrustQuery.isHydrating ||
                          isOrdersInitialHydration ||
                          !session.relaySettingsReady
                        }
                        nip05Status={
                          selectedBuyerNip05 && isOrdersInitialHydration
                            ? "checking"
                            : selectedBuyerNip05Verification.status
                        }
                        statusDisplay={{
                          label: selectedStatusDisplay?.label ?? "Unknown",
                          tone: selectedStatusDisplay?.tone ?? "neutral",
                        }}
                        messageCount={selected.messages?.length ?? 0}
                        messageLabel={
                          buyerInboxKnown ? "Message" : "Order history"
                        }
                        onRefresh={shopperTrustQuery.refetch}
                        onOpenMessages={() => setMessagesOpen(true)}
                      />
                    )}

                    {snapshottedOrderFulfillment.hasPickupClaim &&
                      !pickupAuthorizationVerified && (
                        <section
                          className={panelCard}
                          data-testid="merchant-order-pickup-unverified"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                                Verifying event pickup
                              </h3>
                              <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                                {getMerchantPickupAuthorizationMessage(
                                  pickupAuthorizationQuery.data
                                )}
                              </p>
                            </div>
                            <StatusPill
                              variant={
                                pickupAuthorizationQuery.isFetching
                                  ? "info"
                                  : "warning"
                              }
                              className="shrink-0"
                            >
                              {pickupAuthorizationQuery.isFetching
                                ? "Checking"
                                : "Unverified"}
                            </StatusPill>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            disabled={pickupAuthorizationQuery.isFetching}
                            onClick={() => {
                              void pickupAuthorizationQuery.refetch()
                            }}
                          >
                            <RotateCw
                              className={cn(
                                "size-4",
                                pickupAuthorizationQuery.isFetching &&
                                  "animate-spin"
                              )}
                              aria-hidden="true"
                            />
                            Retry verification
                          </Button>
                        </section>
                      )}

                    {selectedFutureOrganizerHandoff && selectedOrder && (
                      <section
                        className={panelCard}
                        data-testid="merchant-future-organizer-handoff"
                      >
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Organizer pickup release
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                          Share only this order’s signed product evidence and
                          quantity. Payment and buyer details remain with you.
                        </p>
                        <p className="mt-3 text-sm" role="status">
                          {futureAckQuery.data?.exactAck
                            ? "Organizer handed out"
                            : futureAckQuery.data?.conflicting
                              ? "Conflicting handoff evidence"
                              : futureRevocationRecord
                                ? "Release revoked"
                                : futureHasRelease
                                  ? "Release authorized"
                                  : "Not shared"}
                        </p>
                        {futureRecoveryQuery.isPending && !futureHasRelease && (
                          <p
                            className="mt-2 text-xs leading-5 text-[var(--text-secondary)]"
                            role="status"
                          >
                            Recovering signed organizer release history…
                          </p>
                        )}
                        {(futureAckQuery.data?.coverageDegraded ||
                          futureRecoveryQuery.data?.coverageDegraded) && (
                          <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                            Private inbox coverage is incomplete. Verified
                            handoff evidence is retained; other updates may
                            still arrive.
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!futureReadyRecord &&
                            futureRecoveredClaim?.state ===
                              "ready_for_pickup" &&
                            !futureRevocationRecord &&
                            !futureAckQuery.data?.exactAck && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={orderActionPending}
                                onClick={() => futureRevokeMutation.mutate()}
                              >
                                Revoke recovered release
                              </Button>
                            )}
                          {!futureHasRelease &&
                            (merchantPaid || selectedOrderIsZeroCost) && (
                              <Button
                                type="button"
                                size="sm"
                                disabled={
                                  orderActionPending ||
                                  !pickupAuthorizationVerified ||
                                  futureRecoveryQuery.isPending ||
                                  futureRecoveryQuery.isError ||
                                  futureRecoveryQuery.data?.stale ||
                                  futureRecoveryQuery.data?.coverageDegraded
                                }
                                onClick={() => {
                                  setOrganizerReleaseConfirmed(false)
                                  setConfirmingOrganizerRelease(true)
                                }}
                              >
                                Prepare organizer release
                              </Button>
                            )}
                          {futureReadyRecord &&
                            !futureRevocationRecord &&
                            !futureAckQuery.data?.exactAck && (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={orderActionPending}
                                  onClick={() =>
                                    futureRetryMutation.mutate(
                                      futureReadyRecord
                                    )
                                  }
                                >
                                  Retry exact receipt
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={orderActionPending}
                                  onClick={() => futureRevokeMutation.mutate()}
                                >
                                  Revoke release
                                </Button>
                              </>
                            )}
                          {futureRevocationRecord && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={orderActionPending}
                              onClick={() =>
                                futureRetryMutation.mutate(
                                  futureRevocationRecord
                                )
                              }
                            >
                              Retry exact revocation
                            </Button>
                          )}
                        </div>
                        {[
                          futureReadyMutation.error,
                          futureRevokeMutation.error,
                          futureRetryMutation.error,
                          futureAckQuery.error,
                          futureRecoveryQuery.error,
                        ]
                          .filter(Boolean)
                          .map((error, index) => (
                            <p
                              key={index}
                              role="alert"
                              className="mt-2 text-xs text-error"
                            >
                              {error instanceof Error
                                ? error.message
                                : "Private handoff needs attention."}
                            </p>
                          ))}
                      </section>
                    )}

                    {orderFulfillment.requiresShipping &&
                      orderSummary.shippingAddress && (
                        <section className={panelCard}>
                          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                            Shipping address
                          </h3>
                          <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                            <div className="text-[var(--text-primary)]">
                              {orderSummary.shippingAddress.name}
                            </div>
                            <div>{orderSummary.shippingAddress.street}</div>
                            <div>
                              {orderSummary.shippingAddress.city}
                              {orderSummary.shippingAddress.state
                                ? `, ${orderSummary.shippingAddress.state}`
                                : ""}{" "}
                              {orderSummary.shippingAddress.postalCode}
                            </div>
                            <div>{orderSummary.shippingAddress.country}</div>
                          </div>
                        </section>
                      )}

                    {orderSummary.guestContact &&
                      (orderSummary.guestContact.phone ||
                        orderSummary.guestContact.email) && (
                        <section className={panelCard}>
                          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                            Guest contact
                          </h3>
                          <div className="mt-3 space-y-1 text-sm text-[var(--text-secondary)]">
                            {orderSummary.guestContact.phone && (
                              <div>
                                Phone: {orderSummary.guestContact.phone}
                              </div>
                            )}
                            {orderSummary.guestContact.email && (
                              <div>
                                Email: {orderSummary.guestContact.email}
                              </div>
                            )}
                          </div>
                        </section>
                      )}

                    {selectedOrderMessage?.type === "order" && pubkey ? (
                      <EventGuestReceiptVerifier
                        key={selectedOrderMessage.payload.id}
                        order={selectedOrderMessage.payload}
                        merchantPubkey={pubkey}
                      />
                    ) : null}
                    {orderSummary.orderNote && (
                      <section className={panelCard}>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                          Order note
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                          {orderSummary.orderNote}
                        </p>
                      </section>
                    )}

                    {orderFulfillment.requiresShipping &&
                      (orderSummary.trackingCarrier ||
                        orderSummary.trackingNumber ||
                        orderSummary.trackingUrl) && (
                        <section className={panelCard}>
                          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                            Tracking
                          </h3>
                          <div className="mt-3 space-y-1 text-sm text-[var(--text-secondary)]">
                            {orderSummary.trackingCarrier && (
                              <div className="text-[var(--text-primary)]">
                                {orderSummary.trackingCarrier}
                              </div>
                            )}
                            {orderSummary.trackingNumber && (
                              <div className="font-mono text-xs">
                                {orderSummary.trackingNumber}
                              </div>
                            )}
                            {safeTrackingUrl && (
                              <a
                                href={safeTrackingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-[var(--accent)] underline-offset-2 hover:underline"
                              >
                                Open tracking link
                              </a>
                            )}
                          </div>
                        </section>
                      )}

                    <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)]">
                      <button
                        type="button"
                        onClick={() => setOrderDetailsOpen((open) => !open)}
                        aria-expanded={orderDetailsOpen}
                        aria-controls="merchant-order-details-panel"
                        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
                      >
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                          Order details
                        </span>
                        <ChevronRight
                          className={`h-4 w-4 text-[var(--text-muted)] transition-transform ${orderDetailsOpen ? "rotate-90" : ""}`}
                        />
                      </button>
                      {orderDetailsOpen && (
                        <div
                          id="merchant-order-details-panel"
                          className="space-y-2 border-t border-[var(--border)] px-5 py-4 text-sm"
                        >
                          <DetailRow label="Order ID">
                            <span
                              className="max-w-[9rem] truncate font-mono text-xs"
                              title={selected.orderId}
                            >
                              {selected.orderId}
                            </span>
                            <CopyInline
                              value={selected.orderId}
                              label="Copy order id"
                            />
                          </DetailRow>
                          <DetailRow label="Buyer">
                            <span className="font-mono text-xs">
                              {formatNpub(selected.buyerPubkey, 8)}
                            </span>
                            <CopyInline
                              value={selected.buyerPubkey}
                              label="Copy buyer pubkey"
                            />
                          </DetailRow>
                          <DetailRow label="Total">
                            <span>
                              {formatMerchantOrderAmount(
                                orderSummary.subtotal,
                                orderSummary.currency
                              )}
                            </span>
                          </DetailRow>
                          {selectedOrderMessage && (
                            <DetailRow label="Ordered">
                              <span>
                                {new Date(
                                  selectedOrderMessage.createdAt
                                ).toLocaleString()}
                              </span>
                            </DetailRow>
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                </div>

                <OrderMessagesWidget
                  open={messagesOpen}
                  onOpenChange={setMessagesOpen}
                  subtitle={
                    selectedBuyerName ?? formatNpub(selected.buyerPubkey, 8)
                  }
                  messages={selected.messages ?? []}
                  selfPubkey={pubkey}
                  replyValue={replyNote}
                  onReplyChange={setReplyNote}
                  onSend={() => noteMutation.mutate(replyNote)}
                  sending={noteMutation.isPending}
                  error={
                    noteMutation.error instanceof Error
                      ? noteMutation.error.message
                      : noteMutation.error
                        ? "Failed to send message"
                        : null
                  }
                  placeholder="Message the buyer, then press Enter"
                  readOnly={!buyerInboxKnown || !signerConnected}
                  resolveItem={(id) => productLookup.get(id)}
                />

                <AlertDialog
                  open={confirmingOrganizerRelease}
                  onOpenChange={(open) => {
                    if (futureReadyMutation.isPending) return
                    setConfirmingOrganizerRelease(open)
                    if (!open) setOrganizerReleaseConfirmed(false)
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Confirm organizer release
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-pretty">
                        This creates a signed authorization for the organizer to
                        release this product to the buyer. Confirm only after
                        checking payment and preparing the order.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-3">
                      <Checkbox
                        id="organizer-release-confirmation"
                        checked={organizerReleaseConfirmed}
                        onCheckedChange={(checked) =>
                          setOrganizerReleaseConfirmed(checked === true)
                        }
                      />
                      <Label
                        htmlFor="organizer-release-confirmation"
                        className="text-sm leading-6"
                      >
                        I confirm payment is settled or nothing is owed, the
                        order is ready, and the organizer may release it.
                      </Label>
                    </div>
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={futureReadyMutation.isPending}
                        onClick={() => setConfirmingOrganizerRelease(false)}
                      >
                        Go back
                      </Button>
                      <Button
                        type="button"
                        disabled={
                          orderActionPending || !organizerReleaseConfirmed
                        }
                        onClick={() => futureReadyMutation.mutate()}
                      >
                        {futureReadyMutation.isPending
                          ? "Sending authorization…"
                          : "Authorize organizer release"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog
                  open={!!pendingDestructiveAction}
                  onOpenChange={(open) => {
                    if (!open) setPendingDestructiveAction(null)
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {cancellationCopy?.title}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {cancellationCopy?.description}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setPendingDestructiveAction(null)}
                      >
                        Keep order
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={orderActionPending}
                        onClick={() => {
                          if (!pendingDestructiveAction?.status) return
                          advanceStatusMutation.mutate({
                            nextStatus: pendingDestructiveAction.status,
                          })
                          setPendingDestructiveAction(null)
                        }}
                      >
                        {advanceStatusMutation.isPending
                          ? buyerInboxKnown
                            ? "Sending…"
                            : "Recording…"
                          : cancellationCopy?.confirmLabel}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog
                  open={reopenConfirmation !== null}
                  onOpenChange={(open) => {
                    if (!open && !reopenOrderMutation.isPending) {
                      setReopenConfirmation(null)
                      setReopenConfirmationError(null)
                    }
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-balance">
                        Reopen this order?
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-pretty">
                        {reopenConfirmation?.communication === "nostr_replyable"
                          ? "This restores the order workflow and submits the correction through the buyer's Nostr inbox. Payment, refunds, stock, and shipping are unchanged. Review any refund or stock changes separately."
                          : reopenConfirmation?.communication ===
                              "guest_out_of_band"
                            ? "This restores the order in your encrypted order history. It does not notify the guest. Payment, refunds, stock, and shipping are unchanged; contact the guest separately."
                            : "This restores the order in your encrypted order history without claiming buyer notification. Payment, refunds, stock, and shipping are unchanged."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {(reopenConfirmationError || reopenOrderMutation.error) && (
                      <p
                        role="alert"
                        className="text-pretty text-sm leading-6 text-error"
                      >
                        {reopenConfirmationError ?? (
                          <>
                            Couldn&apos;t reopen the order. Check your signer
                            and network, then try again.
                          </>
                        )}
                      </p>
                    )}
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={reopenOrderMutation.isPending}
                        onClick={() => {
                          setReopenConfirmation(null)
                          setReopenConfirmationError(null)
                        }}
                      >
                        Keep cancelled
                      </Button>
                      <Button
                        type="button"
                        disabled={orderActionPending || !reopenConfirmation}
                        onClick={() => {
                          if (reopenConfirmation) {
                            const frozenCancellationId =
                              reopenConfirmation.transition.payload.reopens
                            const currentCancellationId =
                              currentReopenInput?.transition.payload.reopens ??
                              null
                            if (
                              frozenCancellationId !== currentCancellationId
                            ) {
                              setReopenConfirmationError(
                                "This order changed while the confirmation was open. Close this dialog and refresh Orders, then review the current cancellation before trying again."
                              )
                              return
                            }
                            setReopenConfirmationError(null)
                            reopenOrderMutation.mutate(reopenConfirmation)
                          }
                        }}
                      >
                        {reopenOrderMutation.isPending
                          ? reopenConfirmation?.delivery === "buyer_and_self"
                            ? "Sending…"
                            : "Recording…"
                          : "Reopen order"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog
                  open={paymentConfirmationSelection !== null}
                  onOpenChange={(open) => {
                    if (!open) {
                      setPaymentConfirmationTarget(null)
                    }
                  }}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Confirm payment received?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {buyerInboxKnown
                          ? "Continue only after checking your wallet and verifying this order's payment settled. This marks payment as confirmed, notifies the buyer, and unlocks fulfillment."
                          : "Continue only after independently verifying this order's payment settled. This records payment as confirmed in your encrypted order history and unlocks fulfillment."}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setPaymentConfirmationTarget(null)
                        }}
                      >
                        Keep unpaid
                      </Button>
                      <Button
                        type="button"
                        disabled={
                          orderActionPending || !paymentConfirmationSelection
                        }
                        onClick={() => {
                          if (!paymentConfirmationSelection || !pubkey) {
                            setPaymentConfirmationTarget(null)
                            return
                          }
                          confirmPaymentMutation.mutate({
                            merchantPubkey: pubkey,
                            buyerPubkey:
                              paymentConfirmationSelection.buyerPubkey,
                            orderId: paymentConfirmationSelection.orderId,
                            delivery: operationalDelivery,
                            order: selectedOrder,
                          })
                          setPaymentConfirmationTarget(null)
                        }}
                      >
                        {confirmPaymentMutation.isPending
                          ? buyerInboxKnown
                            ? "Sending…"
                            : "Recording…"
                          : buyerInboxKnown
                            ? "Confirm payment"
                            : "Record payment received"}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : (
              <div className="text-sm text-[var(--text-secondary)]">
                Select a conversation.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
