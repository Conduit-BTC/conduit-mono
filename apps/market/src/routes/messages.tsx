import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  ConversationMessageBubble,
  DecryptFailureNotice,
  LegacyDirectMessageNotice,
  LiveReadNotice,
  MessageComposer,
  OrderConversationMessage,
  formatProductReference,
  getConversationPreview,
  getConversationMessageDisplayContent,
} from "@conduit/ui"
import { MessageCircleMore, Search, Store } from "lucide-react"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  buildDirectMessageRumor,
  cacheParsedDirectMessage,
  cacheParsedOrderMessage,
  formatNpub,
  getCachedDirectMessageConversationList,
  getDirectMessageConversationList,
  getNdk,
  formatPubkey,
  markDirectMessageConversationRead,
  normalizePubkey,
  parseDirectMessageRumor,
  parseOrderMessageRumorEvent,
  publishPrivateMessage,
  pubkeyToNpub,
  useAuth,
  useProfile,
  useProfiles,
} from "@conduit/core"
import type { DirectConversationSummary } from "@conduit/core"
import { requireAuth } from "../lib/auth"
import { CopyButton } from "../components/CopyButton"
import {
  MerchantAvatarFallback,
  getMerchantDisplayName,
} from "../components/MerchantIdentity"
import {
  fetchCachedBuyerConversations,
  fetchBuyerConversations,
  type BuyerConversation,
} from "../lib/orderConversations"
import { NDKEvent } from "@nostr-dev-kit/ndk"

type MessagesSearch = {
  tab?: "dms" | "merchants"
  thread?: string
  merchant?: string
}

function prepareBuyerConversationRumor(
  rumor: NDKEvent,
  buyerPubkey: string
): void {
  rumor.pubkey = buyerPubkey
  if (rumor.id) return

  try {
    rumor.id = rumor.getEventHash()
  } catch (error) {
    console.warn("Failed to derive buyer message rumor id", error)
  }
}

async function cacheBuyerConversationRumor(rumor: NDKEvent): Promise<void> {
  try {
    if (!rumor.id) throw new Error("Missing buyer message rumor id")
    const parsed = parseOrderMessageRumorEvent(rumor)
    await cacheParsedOrderMessage(parsed)
  } catch (error) {
    console.warn("Failed to cache buyer message", error)
  }
}

export const Route = createFileRoute("/messages")({
  beforeLoad: () => {
    requireAuth()
  },
  validateSearch: (raw: Record<string, unknown>): MessagesSearch => ({
    tab: raw.tab === "dms" || raw.tab === "merchants" ? raw.tab : undefined,
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    merchant:
      typeof raw.merchant === "string"
        ? (normalizePubkey(raw.merchant) ?? raw.merchant)
        : undefined,
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
  const { data: profile } = useProfile(conversation.merchantPubkey, {
    maxUnresolvedRefetches: 1,
  })
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
        "w-full rounded-[1.05rem] border px-3 py-3 text-left transition-[border-color,background-color,box-shadow]",
        active
          ? "border-[var(--text-secondary)] bg-[var(--surface)]"
          : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-elevated)]",
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
              {new Date(conversation.latestAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
          </div>
          <div className="mt-1 truncate text-xs text-[var(--text-muted)]">
            {conversation.status ?? "pending"} /{" "}
            {formatPubkey(conversation.orderId, 6)}
          </div>
          <div className="mt-1.5 line-clamp-2 text-sm text-[var(--text-secondary)]">
            {latestMessage
              ? getConversationPreview(latestMessage)
              : "No messages yet"}
          </div>
        </div>
      </div>
    </button>
  )
}

function DmThreadRow({
  conversation,
  active,
  onClick,
}: {
  conversation: DirectConversationSummary
  active: boolean
  onClick: () => void
}) {
  const { data: profile } = useProfile(conversation.counterpartyPubkey, {
    maxUnresolvedRefetches: 1,
  })
  const name = getMerchantDisplayName(profile, conversation.counterpartyPubkey)

  return (
    <button
      type="button"
      onClick={onClick}
      data-dm-id={conversation.counterpartyPubkey}
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
            <img
              src={profile.picture}
              alt={name}
              className="h-full w-full object-cover"
            />
          ) : (
            <MerchantAvatarFallback />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm font-medium text-[var(--text-primary)]">
              {name}
            </div>
            <div className="flex items-center gap-2">
              {conversation.transport === "nip04" && (
                <Badge variant="secondary">Legacy</Badge>
              )}
              {conversation.unreadFromCounterparty > 0 && (
                <Badge className="bg-fuchsia-500 text-white">
                  {conversation.unreadFromCounterparty}
                </Badge>
              )}
              <div className="text-[11px] text-[var(--text-muted)]">
                {new Date(conversation.latestAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-[var(--text-muted)]">
            {formatNpub(conversation.counterpartyPubkey, 8)}
          </div>
          <div className="mt-1.5 line-clamp-2 text-sm text-[var(--text-secondary)]">
            {getConversationMessageDisplayContent(conversation.preview) ||
              "No messages yet"}
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
  const [dmText, setDmText] = useState("")
  const [selectedDmPubkey, setSelectedDmPubkey] = useState<string | null>(null)
  const [selectedDmTransport, setSelectedDmTransport] = useState<
    "nip17" | "nip04"
  >("nip17")

  const activeTab = search.tab ?? "merchants"

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
  const merchantProfilesQuery = useProfiles(merchantPubkeys, {
    enabled: signerConnected && merchantPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })

  const filteredConversations = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return conversations.filter((conversation) => {
      if (search.merchant && conversation.merchantPubkey !== search.merchant) {
        return false
      }

      if (!normalized) return true

      return (
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.displayName
          ?.toLowerCase()
          .includes(normalized) ??
          false) ||
        (merchantProfilesQuery.data?.[conversation.merchantPubkey]?.name
          ?.toLowerCase()
          .includes(normalized) ??
          false) ||
        conversation.orderId.toLowerCase().includes(normalized) ||
        conversation.merchantPubkey.toLowerCase().includes(normalized) ||
        (conversation.messages ?? []).some((message) =>
          getConversationPreview(message).toLowerCase().includes(normalized)
        ) ||
        (conversation.messages ?? [])
          .flatMap((message) =>
            message.type === "order" ? message.payload.items : []
          )
          .some(
            (item) =>
              item.productId.toLowerCase().includes(normalized) ||
              formatProductReference(item.productId)
                .title.toLowerCase()
                .includes(normalized)
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

    if (
      !search.thread ||
      !filteredConversations.some(
        (conversation) => conversation.id === search.thread
      )
    ) {
      navigate({
        search: (prev) => ({ ...prev, thread: filteredConversations[0]?.id }),
        replace: true,
      })
    }
  }, [activeTab, filteredConversations, navigate, search.thread])

  useEffect(() => {
    if (!search.thread) return
    const element = document.querySelector<HTMLElement>(
      `[data-thread-id="${search.thread}"]`
    )
    element?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [search.thread])

  const selectedConversation =
    filteredConversations.find(
      (conversation) => conversation.id === search.thread
    ) ?? null
  const selectedProfile = useProfile(selectedConversation?.merchantPubkey, {
    maxUnresolvedRefetches: 1,
  })
  const merchantName = selectedConversation
    ? getMerchantDisplayName(
        selectedProfile.data,
        selectedConversation.merchantPubkey
      )
    : null

  useEffect(() => {
    setReplyText("")
  }, [selectedConversation?.id])

  const replyMutation = useMutation({
    mutationFn: async () => {
      if (!pubkey || !selectedConversation)
        throw new Error("No merchant thread selected")
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
      rumor.tags = appendConduitClientTag(rumor.tags, "market")
      rumor.content = JSON.stringify({
        note: replyText.trim(),
        orderId: selectedConversation.orderId,
        merchantPubkey: selectedConversation.merchantPubkey,
        buyerPubkey: pubkey,
        createdAt: Date.now(),
      })
      prepareBuyerConversationRumor(rumor, pubkey)

      const { selfCopyError } = await publishPrivateMessage({
        rumor,
        senderPubkey: pubkey,
        recipientPubkey: selectedConversation.merchantPubkey,
        signer: ndk.signer,
        rumorKind: EVENT_KINDS.ORDER,
      })
      if (selfCopyError) {
        console.warn("Buyer message self-copy publish failed", selfCopyError)
      }

      await cacheBuyerConversationRumor(rumor)
    },
    onSuccess: async () => {
      setReplyText("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages", pubkey ?? "none"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["buyer-messages-live", pubkey ?? "none"],
        }),
      ])
    },
  })

  // General kind-14 DM inbox, cache-first, distinct from order threads.
  const dmsLiveQuery = useQuery({
    queryKey: ["buyer-dms-live", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () =>
      getDirectMessageConversationList({ principalPubkey: pubkey! }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const dmsCacheQuery = useQuery({
    queryKey: ["buyer-dms", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () =>
      getCachedDirectMessageConversationList({ principalPubkey: pubkey! }),
    staleTime: 5_000,
  })

  const dmConversations = useMemo(
    () => dmsLiveQuery.data?.data ?? dmsCacheQuery.data?.data ?? [],
    [dmsCacheQuery.data, dmsLiveQuery.data]
  )
  const dmLiveMeta = dmsLiveQuery.data?.meta
  const dmDecryptFailures = dmLiveMeta?.decryptFailures?.length ?? 0

  // Scaffold a compose view when arriving via ?merchant=<pubkey>.
  useEffect(() => {
    if (activeTab !== "dms") return
    if (!selectedDmPubkey && search.merchant) {
      setSelectedDmPubkey(search.merchant)
      setSelectedDmTransport("nip17")
    }
  }, [activeTab, search.merchant, selectedDmPubkey])

  useEffect(() => {
    setDmText("")
  }, [selectedDmPubkey])

  const selectedDm =
    dmConversations.find(
      (conversation) =>
        conversation.counterpartyPubkey === selectedDmPubkey &&
        conversation.transport === selectedDmTransport
    ) ?? null
  const selectedDmProfile = useProfile(selectedDmPubkey ?? undefined, {
    maxUnresolvedRefetches: 1,
  })
  const selectedDmName = selectedDmPubkey
    ? getMerchantDisplayName(selectedDmProfile.data, selectedDmPubkey)
    : null
  const selectedDmMessages = selectedDm?.messages ?? []

  useEffect(() => {
    if (
      activeTab !== "dms" ||
      !pubkey ||
      !selectedDmPubkey ||
      !selectedDm?.unreadFromCounterparty
    ) {
      return
    }

    let cancelled = false
    void markDirectMessageConversationRead({
      principalPubkey: pubkey,
      counterpartyPubkey: selectedDmPubkey,
      transport: selectedDmTransport,
    })
      .then(async (updated) => {
        if (cancelled || updated === 0) return
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["buyer-dms", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["buyer-dms-live", pubkey],
          }),
        ])
      })
      .catch(() => {
        console.warn("Failed to update direct-message read state")
      })

    return () => {
      cancelled = true
    }
  }, [
    activeTab,
    pubkey,
    queryClient,
    selectedDm?.unreadFromCounterparty,
    selectedDmPubkey,
    selectedDmTransport,
  ])

  const sendDmMutation = useMutation({
    mutationFn: async () => {
      const counterparty = selectedDmPubkey
      const text = dmText.trim()
      if (!counterparty) throw new Error("No conversation selected")
      if (!text) throw new Error("Message is required")

      const ndk = getNdk()
      if (!ndk.signer || !pubkey) throw new Error("Signer not connected")

      const rumor = buildDirectMessageRumor({
        senderPubkey: pubkey,
        recipientPubkey: counterparty,
        content: text,
        appId: "market",
      })
      const { selfCopyError } = await publishPrivateMessage({
        rumor,
        senderPubkey: pubkey,
        recipientPubkey: counterparty,
        signer: ndk.signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      })
      if (selfCopyError) {
        console.warn("DM self-copy publish failed", selfCopyError)
      }
      await cacheParsedDirectMessage(parseDirectMessageRumor(rumor))
    },
    onSuccess: async () => {
      setDmText("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["buyer-dms", pubkey ?? "none"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["buyer-dms-live", pubkey ?? "none"],
        }),
      ])
    },
  })

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
            Messages
          </h1>
          <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
            Your general Nostr inbox will live here. Merchant conversations are
            already available.
          </p>
        </div>
      </div>

      <div className="border-b border-[var(--border)] xl:shrink-0">
        <div className="flex flex-wrap items-center gap-6">
          {(
            [
              ["dms", "DMs"],
              ["merchants", "Merchants"],
            ] as const
          ).map(([tab, label]) => (
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
        !signerConnected ? (
          <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
              <MessageCircleMore className="h-7 w-7" />
            </div>
            <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
              Connect to view your inbox
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
              General direct messages are tied to your signer identity.
            </p>
          </section>
        ) : (
          <>
            {dmDecryptFailures > 0 && (
              <DecryptFailureNotice
                count={dmDecryptFailures}
                onRetry={() => dmsLiveQuery.refetch()}
                retrying={dmsLiveQuery.isRefetching}
              />
            )}
            {(dmsLiveQuery.error || dmLiveMeta?.degraded) && (
              <LiveReadNotice
                state={
                  dmsLiveQuery.error
                    ? dmConversations.length > 0
                      ? "cached"
                      : "unavailable"
                    : "partial"
                }
                onRetry={() => void dmsLiveQuery.refetch()}
                retrying={dmsLiveQuery.isRefetching}
              />
            )}
            <DecryptFailureNotice
              count={dmLiveMeta?.legacyDecryptFailures?.length ?? 0}
              label="Some legacy messages couldn't be decrypted."
              onRetry={() => void dmsLiveQuery.refetch()}
              retrying={dmsLiveQuery.isRefetching}
            />

            {dmsCacheQuery.isLoading &&
            dmsLiveQuery.isLoading &&
            dmConversations.length === 0 &&
            !selectedDmPubkey ? (
              <div className="text-sm text-[var(--text-secondary)]">
                Loading your inbox…
              </div>
            ) : dmConversations.length === 0 &&
              !selectedDmPubkey &&
              !dmsLiveQuery.error &&
              !dmLiveMeta?.degraded ? (
              <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
                  <MessageCircleMore className="h-7 w-7" />
                </div>
                <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
                  No messages yet
                </h2>
                <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
                  General Nostr conversations you start or receive will appear
                  here.
                </p>
              </section>
            ) : (
              <div className="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[340px_minmax(0,1fr)]">
                <aside className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] p-4 xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                  <div className="mt-1 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                    {dmConversations.length > 0 ? (
                      dmConversations.map((conversation) => (
                        <DmThreadRow
                          key={conversation.id}
                          conversation={conversation}
                          active={
                            conversation.counterpartyPubkey ===
                              selectedDmPubkey &&
                            conversation.transport === selectedDmTransport
                          }
                          onClick={() => {
                            setSelectedDmPubkey(conversation.counterpartyPubkey)
                            setSelectedDmTransport(conversation.transport)
                          }}
                        />
                      ))
                    ) : (
                      <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                        No conversations yet.
                      </div>
                    )}
                  </div>
                </aside>

                <section className="rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface)] xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                  {selectedDmPubkey ? (
                    <>
                      <div className="border-b border-[var(--border)] px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className="h-12 w-12 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
                            {selectedDmProfile.data?.picture ? (
                              <img
                                src={selectedDmProfile.data.picture}
                                alt={selectedDmName ?? "Contact"}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <MerchantAvatarFallback />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-lg font-semibold text-[var(--text-primary)]">
                              {selectedDmName}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                              <span className="inline-flex items-center gap-1">
                                <span className="font-mono">
                                  {formatNpub(selectedDmPubkey, 8)}
                                </span>
                                <CopyButton
                                  value={selectedDmPubkey}
                                  label="Copy pubkey"
                                />
                              </span>
                            </div>
                          </div>
                          <Link
                            to="/orders"
                            className="shrink-0 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-elevated)]"
                          >
                            View orders
                          </Link>
                        </div>
                      </div>

                      <div className="space-y-3 overflow-auto px-6 py-5 xl:min-h-0 xl:flex-1">
                        {selectedDmMessages.length > 0 ? (
                          selectedDmMessages.map((message) => (
                            <ConversationMessageBubble
                              key={message.id}
                              content={message.content}
                              mine={message.senderPubkey === pubkey}
                              timestampLabel={new Date(
                                message.createdAt
                              ).toLocaleString()}
                            />
                          ))
                        ) : (
                          <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--text-secondary)]">
                            No messages yet. Say hello.
                          </div>
                        )}
                      </div>

                      <div className="border-t border-[var(--border)] px-6 py-4">
                        {selectedDmTransport === "nip04" ? (
                          <div className="space-y-3">
                            <LegacyDirectMessageNotice />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedDmTransport("nip17")}
                            >
                              Start current conversation
                            </Button>
                          </div>
                        ) : (
                          <>
                            <MessageComposer
                              value={dmText}
                              onChange={setDmText}
                              onSend={() => sendDmMutation.mutate()}
                              sending={sendDmMutation.isPending}
                              placeholder="Send a direct message"
                            />
                            {sendDmMutation.error && (
                              <div className="mt-2 text-xs text-error">
                                {sendDmMutation.error instanceof Error
                                  ? sendDmMutation.error.message
                                  : "Failed to send message"}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-[var(--text-secondary)]">
                      Select a conversation to view messages.
                    </div>
                  )}
                </section>
              </div>
            )}
          </>
        )
      ) : (
        <>
          {!signerConnected && (
            <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
                <Store className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
                Connect to view merchant threads
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
                Order replies and payment updates are tied to your signer
                identity.
              </p>
            </section>
          )}

          {signerConnected && messagesQuery.isFetching && (
            <div className="text-sm text-[var(--text-secondary)]">
              Checking latest merchant conversations…
            </div>
          )}

          {signerConnected &&
            (messagesQuery.error || messagesQuery.data?.meta.degraded) && (
              <LiveReadNotice
                state={
                  messagesQuery.error
                    ? conversations.length > 0
                      ? "cached"
                      : "unavailable"
                    : "partial"
                }
                onRetry={() => void messagesQuery.refetch()}
                retrying={messagesQuery.isRefetching}
              />
            )}

          {signerConnected &&
            !cachedMessagesQuery.isLoading &&
            conversations.length === 0 &&
            !messagesQuery.error &&
            !messagesQuery.data?.meta.degraded && (
              <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
                  <Store className="h-7 w-7" />
                </div>
                <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
                  No merchant threads yet
                </h2>
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
                            search: (prev) => ({
                              ...prev,
                              thread: conversation.id,
                            }),
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
                            <img
                              src={selectedProfile.data.picture}
                              alt={merchantName ?? "Merchant"}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <MerchantAvatarFallback />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link
                            to="/store/$pubkey"
                            params={{
                              pubkey: pubkeyToNpub(
                                selectedConversation.merchantPubkey
                              ),
                            }}
                            className="truncate text-lg font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline"
                          >
                            {merchantName}
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                            <Badge
                              variant="outline"
                              className="border-[var(--border)] bg-[var(--surface)]"
                            >
                              {selectedConversation.status ?? "pending"}
                            </Badge>
                            <span className="inline-flex items-center gap-1">
                              <span className="font-mono">
                                {formatNpub(
                                  selectedConversation.merchantPubkey,
                                  8
                                )}
                              </span>
                              <CopyButton
                                value={selectedConversation.merchantPubkey}
                                label="Copy pubkey"
                              />
                            </span>
                          </div>
                        </div>
                        <Link
                          to="/orders"
                          search={{ order: selectedConversation.orderId }}
                          className="shrink-0 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-elevated)]"
                        >
                          View order
                        </Link>
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
                          disabled={
                            replyMutation.isPending || !replyText.trim()
                          }
                          onClick={() => replyMutation.mutate()}
                        >
                          {replyMutation.isPending
                            ? "Sending…"
                            : "Send message"}
                        </Button>
                      </div>
                      {replyMutation.error && (
                        <div className="mt-2 text-xs text-error">
                          {replyMutation.error instanceof Error
                            ? replyMutation.error.message
                            : "Failed to send message"}
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
