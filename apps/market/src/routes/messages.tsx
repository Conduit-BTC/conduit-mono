import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Badge, Button } from "@conduit/ui"
import { MessageCircleMore, Search, Store } from "lucide-react"
import { EVENT_KINDS, formatNpub, getNdk, getProfiles, formatPubkey, useAuth, useProfile } from "@conduit/core"
import { requireAuth } from "../lib/auth"
import { CopyButton } from "../components/CopyButton"
import { MerchantAvatarFallback, getMerchantDisplayName } from "../components/MerchantIdentity"
import {
  OrderConversationMessage,
  formatProductReference,
  getConversationPreview,
} from "../components/OrderConversationMessage"
import { fetchBuyerConversations, type BuyerConversation } from "../lib/orderConversations"
import { giftWrap, NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"

type MessagesSearch = {
  tab?: "dms" | "merchants"
  thread?: string
  merchant?: string
}

export const Route = createFileRoute("/messages")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (raw: Record<string, unknown>): MessagesSearch => ({
    tab: raw.tab === "dms" || raw.tab === "merchants" ? raw.tab : undefined,
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    merchant: typeof raw.merchant === "string" ? raw.merchant : undefined,
  }),
  component: MessagesPage,
})

function MerchantThreadRow({
  conversation,
  active,
  onClick,
}: {
  conversation: BuyerConversation
  active: boolean
  onClick: () => void
}) {
  const { data: profile } = useProfile(conversation.merchantPubkey)
  const merchantName = getMerchantDisplayName(profile, conversation.merchantPubkey)
  const messages = conversation.messages ?? []
  const latestMessage = messages[messages.length - 1]

  return (
    <button
      type="button"
      onClick={onClick}
      data-thread-id={conversation.id}
      className={[
        "w-full rounded-[1.05rem] border px-3 py-3 text-left transition-[border-color,background-color,box-shadow]",
        active
          ? "border-[var(--text-secondary)] bg-[var(--surface)]"
          : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-elevated)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
          {profile?.picture ? (
            <img src={profile.picture} alt={merchantName} className="h-full w-full object-cover" />
          ) : (
            <MerchantAvatarFallback />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">{merchantName}</div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {new Date(conversation.latestAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
          <div className="mt-1 truncate text-xs text-[var(--text-muted)]">
            {conversation.status ?? "pending"} / {formatPubkey(conversation.orderId, 6)}
          </div>
          <div className="mt-1.5 line-clamp-2 text-sm text-[var(--text-secondary)]">
            {latestMessage ? getConversationPreview(latestMessage) : "No messages yet"}
          </div>
        </div>
      </div>
    </button>
  )
}

function MessagesPage() {
  const { pubkey, status } = useAuth()
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const signerConnected = status === "connected" && !!pubkey
  const [query, setQuery] = useState("")
  const [replyText, setReplyText] = useState("")

  const activeTab = search.tab ?? "merchants"

  const messagesQuery = useQuery({
    queryKey: ["buyer-messages", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => fetchBuyerConversations(pubkey!),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })

  const conversations = useMemo(() => messagesQuery.data?.data ?? [], [messagesQuery.data])
  const merchantPubkeys = useMemo(
    () => Array.from(new Set(conversations.map((conversation) => conversation.merchantPubkey).filter(Boolean))),
    [conversations],
  )
  const merchantProfilesQuery = useQuery({
    queryKey: ["buyer-message-profiles", merchantPubkeys],
    enabled: signerConnected && merchantPubkeys.length > 0,
    queryFn: async () => {
      const result = await getProfiles({ pubkeys: merchantPubkeys })
      return result.data
    },
  })

  const filteredConversations = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return conversations.filter((conversation) => {
      if (search.merchant && conversation.merchantPubkey !== search.merchant) {
        return false
      }

      if (!normalized) return true

      return (
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.displayName?.toLowerCase().includes(normalized) ?? false) ||
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.name?.toLowerCase().includes(normalized) ?? false) ||
        conversation.orderId.toLowerCase().includes(normalized) ||
        conversation.merchantPubkey.toLowerCase().includes(normalized) ||
        (conversation.messages ?? []).some((message) => getConversationPreview(message).toLowerCase().includes(normalized)) ||
        (conversation.messages ?? []).flatMap((message) => message.type === "order" ? message.payload.items : []).some((item) =>
          item.productId.toLowerCase().includes(normalized) ||
          formatProductReference(item.productId).title.toLowerCase().includes(normalized)
        )
      )
    })
  }, [conversations, merchantProfilesQuery.data, query, search.merchant])

  useEffect(() => {
    if (activeTab !== "merchants") return
    if (filteredConversations.length === 0) {
      if (search.thread) {
        navigate({
          search: (prev) => ({ ...prev, thread: undefined }),
          replace: true,
        })
      }
      return
    }

    if (!search.thread || !filteredConversations.some((conversation) => conversation.id === search.thread)) {
      navigate({
        search: (prev) => ({ ...prev, thread: filteredConversations[0]?.id }),
        replace: true,
      })
    }
  }, [activeTab, filteredConversations, navigate, search.thread])

  useEffect(() => {
    if (!search.thread) return
    const element = document.querySelector<HTMLElement>(`[data-thread-id="${search.thread}"]`)
    element?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [search.thread])

  const selectedConversation = filteredConversations.find((conversation) => conversation.id === search.thread) ?? null
  const selectedProfile = useProfile(selectedConversation?.merchantPubkey)
  const merchantName = selectedConversation
    ? getMerchantDisplayName(selectedProfile.data, selectedConversation.merchantPubkey)
    : null

  useEffect(() => {
    setReplyText("")
  }, [selectedConversation?.id])

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selectedConversation) throw new Error("No merchant thread selected")
      if (!replyText.trim()) throw new Error("Message is required")

      const ndk = getNdk()
      if (!ndk.signer) throw new Error("Signer not connected")

      const rumor = new NDKEvent(ndk)
      rumor.kind = EVENT_KINDS.ORDER
      rumor.created_at = Math.floor(Date.now() / 1000)
      rumor.tags = [
        ["p", selectedConversation.merchantPubkey],
        ["type", "message"],
        ["order", selectedConversation.orderId],
      ]
      rumor.content = JSON.stringify({
        note: replyText.trim(),
        orderId: selectedConversation.orderId,
        merchantPubkey: selectedConversation.merchantPubkey,
        buyerPubkey: pubkey,
        createdAt: Date.now(),
      })

      const merchantUser = new NDKUser({ pubkey: selectedConversation.merchantPubkey })
      const buyerUser = new NDKUser({ pubkey })
      const wrappedToMerchant = await giftWrap(rumor, merchantUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      })
      const wrappedToBuyer = await giftWrap(rumor, buyerUser, ndk.signer, {
        rumorKind: EVENT_KINDS.ORDER,
      })

      await Promise.all([wrappedToMerchant.publish(), wrappedToBuyer.publish()])
    },
    onSuccess: async () => {
      setReplyText("")
      await queryClient.invalidateQueries({ queryKey: ["buyer-messages", pubkey ?? "none"] })
    },
  })

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">Messages</h1>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
            Your general Nostr inbox will live here. Merchant conversations are already available.
          </p>
        </div>
      </div>

      <div className="border-b border-[var(--border)] xl:shrink-0">
        <div className="flex flex-wrap items-center gap-6">
          {([
            ["dms", "DMs"],
            ["merchants", "Merchants"],
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev) => ({
                    ...prev,
                    tab: tab === "merchants" ? undefined : tab,
                    thread: tab === "merchants" ? prev.thread : undefined,
                  }),
                  replace: true,
                })
              }
              className={[
                "relative -mb-px inline-flex h-11 items-center border-b-2 text-sm font-medium transition-colors after:absolute after:-bottom-px after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-fuchsia-500 after:transition-opacity",
                activeTab === tab
                  ? "border-fuchsia-500 text-[var(--text-primary)] after:opacity-100"
                  : "border-transparent text-[var(--text-secondary)] after:opacity-0 hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "dms" ? (
        <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
            <MessageCircleMore className="h-7 w-7" />
          </div>
          <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">General DMs are not wired yet</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
            This inbox is reserved for broader Nostr conversations. For now, merchant threads live under the Merchants tab.
          </p>
          <div className="mt-6">
            <Button
              variant="outline"
              className="h-11 px-4 text-sm"
              onClick={() =>
                navigate({
                  search: (prev) => ({ ...prev, tab: undefined }),
                  replace: true,
                })
              }
            >
              View merchant threads
            </Button>
          </div>
        </section>
      ) : (
        <>
          {!signerConnected && (
            <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
                <Store className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">Connect to view merchant threads</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
                Checkout replies and payment updates are tied to your signer identity.
              </p>
            </section>
          )}

          {signerConnected && messagesQuery.isLoading && (
            <div className="text-sm text-[var(--text-secondary)]">Loading merchant conversations…</div>
          )}

          {signerConnected && messagesQuery.error && (
            <div className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
              Failed to load messages: {messagesQuery.error instanceof Error ? messagesQuery.error.message : "Unknown error"}
            </div>
          )}

          {signerConnected && !messagesQuery.isLoading && conversations.length === 0 && (
            <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
                <Store className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">No merchant threads yet</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
                Place an order and merchant replies will appear here.
              </p>
            </section>
          )}

          {signerConnected && conversations.length > 0 && (
            <div className="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                <div className="relative xl:shrink-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search"
                    className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30"
                  />
                </div>
                <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                  {filteredConversations.length > 0 ? (
                    filteredConversations.map((conversation) => (
                      <MerchantThreadRow
                        key={conversation.id}
                        conversation={conversation}
                        active={conversation.id === selectedConversation?.id}
                        onClick={() =>
                          navigate({
                            search: (prev) => ({ ...prev, thread: conversation.id }),
                            replace: true,
                          })
                        }
                      />
                    ))
                  ) : (
                    <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      {search.merchant
                        ? "No conversation with this merchant yet."
                        : "No merchant threads match this search."}
                    </div>
                  )}
                </div>
              </aside>

              <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                {selectedConversation ? (
                  <>
                    <div className="border-b border-[var(--border)] px-6 py-5">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
                          {selectedProfile.data?.picture ? (
                            <img src={selectedProfile.data.picture} alt={merchantName ?? "Merchant"} className="h-full w-full object-cover" />
                          ) : (
                            <MerchantAvatarFallback />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link
                            to="/store/$pubkey"
                            params={{ pubkey: selectedConversation.merchantPubkey }}
                            className="truncate text-lg font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                          >
                            {merchantName}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                            <Badge variant="outline" className="border-[var(--border)] bg-[var(--surface)]">
                              {selectedConversation.status ?? "pending"}
                            </Badge>
                            <span className="inline-flex items-center gap-1">
                              <span className="font-mono">{formatNpub(selectedConversation.merchantPubkey, 8)}</span>
                              <CopyButton value={selectedConversation.merchantPubkey} label="Copy pubkey" />
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 overflow-auto px-6 py-5 xl:min-h-0 xl:flex-1">
                      {(selectedConversation.messages ?? []).map((message) => (
                        <OrderConversationMessage
                          key={message.id}
                          message={message}
                          mine={message.senderPubkey === pubkey}
                        />
                      ))}
                    </div>

                    <div className="border-t border-[var(--border)] px-6 py-4">
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <input
                          value={replyText}
                          onChange={(event) => setReplyText(event.target.value)}
                          placeholder="Send a message to the merchant"
                          className="h-11 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                          aria-label="Reply to merchant"
                        />
                        <Button
                          className="h-11 px-5 text-sm"
                          disabled={replyMutation.isPending || !replyText.trim()}
                          onClick={() => replyMutation.mutate()}
                        >
                          {replyMutation.isPending ? "Sending…" : "Send message"}
                        </Button>
                      </div>
                      {replyMutation.error && (
                        <div className="mt-2 text-xs text-error">
                          {replyMutation.error instanceof Error ? replyMutation.error.message : "Failed to send message"}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-[var(--text-secondary)]">
                    {search.merchant
                      ? "Place an order with this merchant to start a conversation here."
                      : "Adjust your search to reopen a merchant thread."}
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  )
}
