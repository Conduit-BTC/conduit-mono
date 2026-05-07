import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  extractOrderSummary,
  formatNpub,
  getProfiles,
  formatPubkey,
  useAuth,
  useProfile,
} from "@conduit/core"
import { Badge, Button } from "@conduit/ui"
import {
  CheckCircle2,
  ChevronDown,
  ReceiptText,
  RotateCw,
  Search,
} from "lucide-react"
import { requireAuth } from "../lib/auth"
import { CopyButton } from "../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../components/MerchantIdentity"
import {
  OrderConversationMessage,
  formatProductReference,
  getConversationPreview,
} from "../components/OrderConversationMessage"
import {
  fetchBuyerConversations,
  fetchCachedBuyerConversations,
  type BuyerConversation,
} from "../lib/orderConversations"
import { fetchStoreProducts } from "../lib/storeProducts"

export const Route = createFileRoute("/orders")({
  beforeLoad: () => {
    requireAuth()
  },
  component: OrdersPage,
})

function OrderListItem({
  conversation,
  active,
  onClick,
}: {
  conversation: BuyerConversation
  active: boolean
  onClick: () => void
}) {
  const { data: profile } = useProfile(conversation.merchantPubkey)
  const merchantName = getMerchantDisplayName(
    profile,
    conversation.merchantPubkey
  )
  const messages = conversation.messages ?? []
  const latestMessage = messages[messages.length - 1]

  return (
    <button
      type="button"
      onClick={onClick}
      data-thread-id={conversation.id}
      className={[
        "w-full rounded-[1.1rem] border p-3 text-left transition-[border-color,background-color,box-shadow]",
        active
          ? "border-[var(--text-secondary)] bg-[var(--surface)]"
          : "border-[var(--border)] bg-[var(--surface-elevated)] hover:border-[var(--text-secondary)] hover:bg-[var(--surface)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
          {profile?.picture ? (
            <img
              src={profile.picture}
              alt={merchantName}
              className="h-full w-full object-cover"
            />
          ) : (
            <MerchantAvatarFallback />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {merchantName}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {new Date(conversation.latestAt).toLocaleDateString()}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-[var(--border)] bg-[var(--surface)]"
            >
              {conversation.status ?? "pending"}
            </Badge>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              {formatPubkey(conversation.orderId, 6)}
            </span>
          </div>
          <div className="mt-2 line-clamp-2 text-sm text-[var(--text-secondary)]">
            {latestMessage
              ? getConversationPreview(latestMessage)
              : "No messages yet"}
          </div>
          {conversation.totalSummary && (
            <div className="mt-2 text-xs font-medium text-secondary-300">
              {conversation.totalSummary}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}

function OrderHero({ conversation }: { conversation: BuyerConversation }) {
  const { data: profile } = useProfile(conversation.merchantPubkey)
  const merchantName = getMerchantDisplayName(
    profile,
    conversation.merchantPubkey
  )
  const summary = extractOrderSummary(conversation.messages ?? [])

  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
            {profile?.picture ? (
              <img
                src={profile.picture}
                alt={merchantName}
                className="h-full w-full object-cover"
              />
            ) : (
              <MerchantAvatarFallback />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/store/$pubkey"
                params={{ pubkey: conversation.merchantPubkey }}
                className="truncate text-lg font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
              >
                {merchantName}
              </Link>
              <Badge
                variant="outline"
                className="border-[var(--border)] bg-[var(--surface)] capitalize"
              >
                {conversation.status ?? "pending"}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">
                  {formatNpub(conversation.merchantPubkey, 8)}
                </span>
                <CopyButton
                  value={conversation.merchantPubkey}
                  label="Copy pubkey"
                />
              </span>
              <span className="text-[var(--text-muted)]">/</span>
              <span className="font-mono">{conversation.orderId}</span>
              <span className="text-[var(--text-muted)]">/</span>
              <span>{new Date(conversation.latestAt).toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm">
            <span className="text-[var(--text-secondary)]">Subtotal</span>
            <span className="ml-2 font-semibold text-secondary-300">
              {summary.subtotal} {summary.currency}
            </span>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm">
            <span className="text-[var(--text-secondary)]">Messages</span>
            <span className="ml-2 font-semibold text-[var(--text-primary)]">
              {conversation.messages?.length ?? 0}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <Button asChild variant="outline" className="h-11 px-4 text-sm">
          <Link
            to="/store/$pubkey"
            params={{ pubkey: conversation.merchantPubkey }}
          >
            Visit store
          </Link>
        </Button>
        <Button asChild variant="outline" className="h-11 px-4 text-sm">
          <Link
            to="/messages"
            search={{ tab: "merchants", thread: conversation.id }}
          >
            Open in messages
          </Link>
        </Button>
        <Button asChild className="h-11 px-4 text-sm">
          <Link to="/products">Keep shopping</Link>
        </Button>
      </div>
    </section>
  )
}

function CollapsibleInfo({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string
  summary: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <details
      className="group rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)]"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {title}
          </div>
          <div className="mt-1 truncate text-sm text-[var(--text-secondary)]">
            {summary}
          </div>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[var(--border)] px-4 py-4">
        {children}
      </div>
    </details>
  )
}

function OrdersPage() {
  const { pubkey, status } = useAuth()
  const signerConnected = status === "connected" && !!pubkey
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [searchValue, setSearchValue] = useState("")
  const [refreshButtonState, setRefreshButtonState] = useState<
    "idle" | "refreshing" | "done"
  >("idle")
  const refreshResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const messagesQuery = useQuery({
    queryKey: ["buyer-messages-live", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchBuyerConversations(pubkey!),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedMessagesQuery = useQuery({
    queryKey: ["buyer-messages", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchCachedBuyerConversations(pubkey!),
    staleTime: 5_000,
  })

  const isMessagesFetching = messagesQuery.isFetching
  const refetchMessages = messagesQuery.refetch

  useEffect(() => {
    if (isMessagesFetching) {
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
  }, [isMessagesFetching, refreshButtonState])

  useEffect(() => {
    return () => {
      if (refreshResetTimerRef.current)
        clearTimeout(refreshResetTimerRef.current)
    }
  }, [])

  const handleRefresh = useCallback(() => {
    if (!signerConnected) return
    if (refreshResetTimerRef.current) {
      clearTimeout(refreshResetTimerRef.current)
      refreshResetTimerRef.current = null
    }
    setRefreshButtonState("refreshing")
    void refetchMessages()
  }, [refetchMessages, signerConnected])

  const conversations = useMemo(
    () => messagesQuery.data?.data ?? cachedMessagesQuery.data?.data ?? [],
    [cachedMessagesQuery.data, messagesQuery.data]
  )
  const merchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          conversations
            .map((conversation) => conversation.merchantPubkey)
            .filter(Boolean)
        )
      ),
    [conversations]
  )
  const merchantProfilesQuery = useQuery({
    queryKey: ["buyer-order-profiles", merchantPubkeys],
    enabled: signerConnected && merchantPubkeys.length > 0,
    queryFn: async () => {
      const result = await getProfiles({ pubkeys: merchantPubkeys })
      return result.data
    },
  })

  const filteredConversations = useMemo(() => {
    const query = searchValue.trim().toLowerCase()
    if (!query) return conversations
    return conversations.filter(
      (conversation) =>
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.displayName
          ?.toLowerCase()
          .includes(query) ??
          false) ||
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.name
          ?.toLowerCase()
          .includes(query) ??
          false) ||
        conversation.orderId.toLowerCase().includes(query) ||
        conversation.merchantPubkey.toLowerCase().includes(query) ||
        conversation.status?.toLowerCase().includes(query) ||
        (conversation.messages ?? [])
          .flatMap((message) =>
            message.type === "order" ? message.payload.items : []
          )
          .some(
            (item) =>
              item.productId.toLowerCase().includes(query) ||
              formatProductReference(item.productId)
                .title.toLowerCase()
                .includes(query)
          ) ||
        (conversation.messages ?? []).some((message) =>
          getConversationPreview(message).toLowerCase().includes(query)
        )
    )
  }, [conversations, merchantProfilesQuery.data, searchValue])

  useEffect(() => {
    if (filteredConversations.length === 0) {
      setSelectedConversationId(null)
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
  }, [filteredConversations, selectedConversationId])

  useEffect(() => {
    if (!selectedConversationId) return
    const element = document.querySelector<HTMLElement>(
      `[data-thread-id="${selectedConversationId}"]`
    )
    element?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [selectedConversationId])

  const selected =
    filteredConversations.find(
      (conversation) => conversation.id === selectedConversationId
    ) ?? null
  const orderSummary = useMemo(
    () => (selected ? extractOrderSummary(selected.messages ?? []) : null),
    [selected]
  )
  const selectedProductsQuery = useQuery({
    queryKey: ["selected-order-products", selected?.merchantPubkey ?? "none"],
    enabled: !!selected?.merchantPubkey,
    queryFn: () => fetchStoreProducts(selected!.merchantPubkey),
  })
  const selectedProductsById = useMemo(() => {
    const map = new Map<
      string,
      Awaited<ReturnType<typeof fetchStoreProducts>>["data"][number]
    >()
    for (const product of selectedProductsQuery.data?.data ?? []) {
      map.set(product.id, product)
    }
    return map
  }, [selectedProductsQuery.data])

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Orders
          </h1>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
            Track merchant updates, invoices, and shipping progress across your
            recent checkouts.
          </p>
        </div>
        <Button
          variant="outline"
          className="h-11 px-4 text-sm"
          disabled={!signerConnected || isMessagesFetching}
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

      {!signerConnected && (
        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
            <ReceiptText className="h-7 w-7" />
          </div>
          <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
            Connect to view your orders
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            Order updates, invoices, and merchant replies are tied to your
            signer identity.
          </p>
        </section>
      )}

      {signerConnected && isMessagesFetching && (
        <div className="text-sm text-[var(--text-secondary)]">
          Checking latest order conversations…
        </div>
      )}

      {signerConnected && messagesQuery.error && (
        <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          Failed to load orders:{" "}
          {messagesQuery.error instanceof Error
            ? messagesQuery.error.message
            : "Unknown error"}
        </div>
      )}

      {signerConnected &&
        !cachedMessagesQuery.isLoading &&
        conversations.length === 0 && (
          <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
              <ReceiptText className="h-7 w-7" />
            </div>
            <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
              No order conversations yet
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
              Place your first order and merchant updates will start appearing
              here.
            </p>
            <div className="mt-6">
              <Button asChild className="h-11 px-4 text-sm">
                <Link to="/products">Browse products</Link>
              </Button>
            </div>
          </section>
        )}

      {signerConnected && conversations.length > 0 && (
        <div className="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="xl:sticky xl:top-24 xl:self-start">
            <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 xl:max-h-[calc(100vh-8rem)] xl:overflow-hidden">
              <div className="text-sm font-medium text-[var(--text-primary)]">
                Order threads
              </div>
              <div className="relative mt-3">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={searchValue}
                  onChange={(event) => setSearchValue(event.target.value)}
                  placeholder="Search orders"
                  className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
                />
              </div>
              <div className="mt-4 space-y-2 xl:max-h-[calc(100vh-14rem)] xl:overflow-y-auto xl:pr-1">
                {filteredConversations.length > 0 ? (
                  filteredConversations.map((conversation) => (
                    <OrderListItem
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === selectedConversationId}
                      onClick={() => setSelectedConversationId(conversation.id)}
                    />
                  ))
                ) : (
                  <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                    No orders match this search.
                  </div>
                )}
              </div>
            </section>
          </aside>

          <section className="space-y-4 xl:min-h-0 xl:overflow-hidden">
            <div className="space-y-4 xl:flex xl:h-full xl:min-h-0 xl:flex-col">
              {selected && orderSummary ? (
                <>
                  <OrderHero conversation={selected} />

                  <section className="space-y-3 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4">
                    <CollapsibleInfo
                      title="Items"
                      summary={`${orderSummary.items.length} item${orderSummary.items.length === 1 ? "" : "s"} in this order`}
                      defaultOpen={false}
                    >
                      <div className="space-y-3">
                        {orderSummary.items.map((item, index) => {
                          const resolvedProduct = selectedProductsById.get(
                            item.productId
                          )
                          const product = formatProductReference(item.productId)
                          const image = resolvedProduct?.images[0]
                          return (
                            <div
                              key={`${item.productId}-${index}`}
                              className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-sm"
                            >
                              <div className="flex min-w-0 flex-1 items-start gap-3">
                                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                                  {image ? (
                                    <img
                                      src={image.url}
                                      alt={
                                        image.alt ??
                                        resolvedProduct?.title ??
                                        product.title
                                      }
                                      loading="lazy"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : null}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-[var(--text-primary)]">
                                    {resolvedProduct?.title ?? product.title}
                                  </div>
                                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                                    Qty {item.quantity}
                                  </div>
                                  <div className="mt-1 break-all font-mono text-[11px] leading-5 text-[var(--text-muted)]">
                                    {product.detail}
                                  </div>
                                </div>
                              </div>
                              <div className="shrink-0 text-right text-[var(--text-secondary)]">
                                {item.priceAtPurchase} {item.currency}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </CollapsibleInfo>

                    <CollapsibleInfo
                      title="Order details"
                      summary={`${orderSummary.invoiceSent ? "Invoice sent" : "Awaiting merchant"}${orderSummary.trackingNumber ? ` · Tracking ${orderSummary.trackingNumber}` : ""}`}
                      defaultOpen={false}
                    >
                      <div className="space-y-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[var(--text-secondary)]">
                            Subtotal
                          </span>
                          <span className="font-medium text-secondary-300">
                            {orderSummary.subtotal} {orderSummary.currency}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[var(--text-secondary)]">
                            Invoice
                          </span>
                          <span className="text-[var(--text-primary)]">
                            {orderSummary.invoiceSent
                              ? "Sent"
                              : "Awaiting merchant"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[var(--text-secondary)]">
                            Tracking
                          </span>
                          <span className="text-[var(--text-primary)]">
                            {orderSummary.trackingNumber ?? "Not shared yet"}
                          </span>
                        </div>
                        {orderSummary.shippingAddress && (
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-[var(--text-secondary)]">
                            <div className="font-medium text-[var(--text-primary)]">
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
                        )}
                        {orderSummary.orderNote && (
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-[var(--text-secondary)]">
                            {orderSummary.orderNote}
                          </div>
                        )}
                      </div>
                    </CollapsibleInfo>
                  </section>

                  <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-2xl font-semibold text-[var(--text-primary)]">
                          Conversation
                        </h2>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          Merchant replies, invoices, and shipping changes
                          appear in sequence here.
                        </p>
                      </div>
                    </div>
                    <div className="mt-5 space-y-3 overflow-auto pr-1 xl:min-h-0 xl:flex-1">
                      {(selected.messages ?? []).map((message) => (
                        <OrderConversationMessage
                          key={message.id}
                          message={message}
                          mine={message.senderPubkey === pubkey}
                        />
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-6 xl:flex xl:min-h-0 xl:flex-1 xl:items-center xl:justify-center">
                  <div className="text-center text-sm text-[var(--text-secondary)]">
                    Adjust your search to reopen an order thread.
                  </div>
                </section>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
