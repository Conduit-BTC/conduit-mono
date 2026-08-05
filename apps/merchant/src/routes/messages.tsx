import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { Search } from "lucide-react"
import {
  buildDirectMessageRumor,
  cacheParsedDirectMessage,
  EVENT_KINDS,
  formatNpub,
  getCachedDirectMessageConversationList,
  getCachedMerchantConversationList,
  getDirectMessageConversationList,
  getMerchantConversationList,
  getNdk,
  getProfileName,
  inspectOwnPrivateMessageRelayReadiness,
  markDirectMessageConversationRead,
  parseDirectMessageRumor,
  publishPrivateMessage,
  publishPrivateMessageRelayDeclaration,
  pubkeyToNpub,
  useAuth,
  useProfiles,
  type Profile,
} from "@conduit/core"
import {
  ConversationCardScroller,
  ConversationMessageBubble,
  DecryptFailureNotice,
  getConversationMessageDisplayContent,
  LegacyDirectMessageNotice,
  LiveReadNotice,
  matchesConversationSearch,
  MessagingReadinessNotice,
  MessageComposer,
  SearchInput,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  useOptimisticConversationMessages,
  type OptimisticConversationMessage,
} from "@conduit/ui"
import { DirectConversationListItem } from "../components/DirectConversationListItem"
import { OrderCardScroller } from "../components/OrderCardScroller"
import { BuyerAvatar } from "../components/OrderListItem"
import { requireAuth } from "../lib/auth"

export const Route = createFileRoute("/messages")({
  beforeLoad: () => {
    requireAuth()
  },
  component: MessagesPage,
})

function getDisplayName(profile: Profile | undefined, pubkey: string): string {
  return getProfileName(profile) || formatNpub(pubkey, 8)
}

type OptimisticDirectMessageSend = {
  message: OptimisticConversationMessage
  counterpartyPubkey: string
  rumor: NDKEvent
}

function MessagesPage() {
  const { pubkey, status } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signerConnected = status === "connected" && !!pubkey
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composerText, setComposerText] = useState("")
  const [conversationSearch, setConversationSearch] = useState("")
  const [conversationSheetOpen, setConversationSheetOpen] = useState(false)
  const optimisticMessageQueue = useOptimisticConversationMessages()
  const optimisticMessages = optimisticMessageQueue.messages
  const clearOptimisticMessages = optimisticMessageQueue.clear
  const removeOptimisticMessage = optimisticMessageQueue.remove

  useEffect(() => {
    clearOptimisticMessages()
    setComposerText("")
    setSelectedId(null)
  }, [clearOptimisticMessages, pubkey])

  const readinessQuery = useQuery({
    queryKey: ["merchant-dm-readiness", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => inspectOwnPrivateMessageRelayReadiness(pubkey!),
    staleTime: 30_000,
  })
  const messagingReady = readinessQuery.data?.state === "ready"
  const enableMessagingMutation = useMutation({
    mutationFn: async () => {
      const ndk = getNdk()
      if (!ndk.signer || !pubkey) throw new Error("Signer not connected")
      await publishPrivateMessageRelayDeclaration({
        pubkey,
        signer: ndk.signer,
        ndk,
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["merchant-dm-readiness", pubkey ?? "none"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms-live", pubkey ?? "none"],
        }),
      ])
    },
  })

  const liveQuery = useQuery({
    queryKey: ["merchant-dms-live", pubkey ?? "none"],
    enabled: signerConnected && messagingReady,
    queryFn: () =>
      getDirectMessageConversationList({ principalPubkey: pubkey! }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedQuery = useQuery({
    queryKey: ["merchant-dms", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () =>
      getCachedDirectMessageConversationList({ principalPubkey: pubkey! }),
    staleTime: 5_000,
  })

  const conversations = useMemo(
    () => liveQuery.data?.data ?? cachedQuery.data?.data ?? [],
    [cachedQuery.data, liveQuery.data]
  )
  const liveMeta = liveQuery.data?.meta

  const counterpartyPubkeys = useMemo(
    () =>
      Array.from(
        new Set(conversations.map((c) => c.counterpartyPubkey).filter(Boolean))
      ),
    [conversations]
  )
  const profilesQuery = useProfiles(counterpartyPubkeys, {
    enabled: signerConnected && counterpartyPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })
  const filteredConversations = useMemo(() => {
    return conversations.filter((conversation) => {
      const displayName = getDisplayName(
        profilesQuery.data?.[conversation.counterpartyPubkey],
        conversation.counterpartyPubkey
      )
      return matchesConversationSearch(conversationSearch, [
        displayName,
        conversation.counterpartyPubkey,
        pubkeyToNpub(conversation.counterpartyPubkey),
        getConversationMessageDisplayContent(conversation.preview),
      ])
    })
  }, [conversationSearch, conversations, profilesQuery.data])

  useEffect(() => {
    if (conversations.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !conversations.some((c) => c.id === selectedId)) {
      setSelectedId(conversations[0]?.id ?? null)
    }
  }, [conversations, selectedId])

  const selected = conversations.find((c) => c.id === selectedId) ?? null
  const selectedName = selected
    ? getDisplayName(
        profilesQuery.data?.[selected.counterpartyPubkey],
        selected.counterpartyPubkey
      )
    : null
  const threadMessages = selected?.messages ?? []
  const optimisticThreadMessages = optimisticMessages.filter(
    (message) =>
      message.conversationId === selected?.id &&
      !threadMessages.some(
        (publishedMessage) => publishedMessage.id === message.eventId
      )
  )

  useEffect(() => {
    const publishedEventIds = new Set(
      conversations.flatMap((conversation) =>
        (conversation.messages ?? []).map((message) => message.id)
      )
    )
    for (const message of optimisticMessages) {
      if (
        message.deliveryState === "published" &&
        message.eventId &&
        publishedEventIds.has(message.eventId)
      ) {
        removeOptimisticMessage(message.localId)
      }
    }
  }, [conversations, optimisticMessages, removeOptimisticMessage])
  const relatedOrdersLiveQuery = useQuery({
    queryKey: [
      "merchant-message-orders-live",
      pubkey ?? "none",
      selected?.counterpartyPubkey ?? "none",
    ],
    enabled: signerConnected && messagingReady && !!selected,
    queryFn: () =>
      getMerchantConversationList({
        principalPubkey: pubkey!,
        counterpartyPubkey: selected!.counterpartyPubkey,
        limit: 3,
      }),
  })
  const relatedOrdersCacheQuery = useQuery({
    queryKey: [
      "merchant-message-orders",
      pubkey ?? "none",
      selected?.counterpartyPubkey ?? "none",
    ],
    enabled: signerConnected && !!selected,
    queryFn: () =>
      getCachedMerchantConversationList({
        principalPubkey: pubkey!,
        counterpartyPubkey: selected!.counterpartyPubkey,
        limit: 3,
      }),
  })
  const relatedOrders =
    relatedOrdersLiveQuery.data?.data ??
    relatedOrdersCacheQuery.data?.data ??
    []

  useEffect(() => {
    if (!pubkey || !selected?.unreadFromCounterparty) return

    let cancelled = false
    void markDirectMessageConversationRead({
      principalPubkey: pubkey,
      counterpartyPubkey: selected.counterpartyPubkey,
      transport: selected.transport,
    })
      .then(async (updated) => {
        if (cancelled || updated === 0) return
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["merchant-dms", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-dms-live", pubkey],
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
    pubkey,
    queryClient,
    selected?.counterpartyPubkey,
    selected?.transport,
    selected?.unreadFromCounterparty,
  ])

  const sendMutation = useMutation({
    mutationFn: async ({
      message,
      counterpartyPubkey,
      rumor,
    }: OptimisticDirectMessageSend) => {
      const ndk = getNdk()
      if (!ndk.signer || !pubkey) {
        throw new Error("Connect your signer to reply.")
      }
      const { selfCopyError } = await publishPrivateMessage({
        rumor,
        senderPubkey: pubkey,
        recipientPubkey: counterpartyPubkey,
        signer: ndk.signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      })
      optimisticMessageQueue.markPublished(message.localId)
      if (selfCopyError) {
        console.warn("DM self-copy publish failed", selfCopyError)
      }
      try {
        await cacheParsedDirectMessage(parseDirectMessageRumor(rumor))
      } catch {
        console.warn("Failed to cache published direct message")
      }
    },
    onSuccess: async () => {
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms", pubkey ?? "none"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms-live", pubkey ?? "none"],
        }),
      ])
    },
    onError: (_error, { message }) => {
      optimisticMessageQueue.markFailed(message.localId)
    },
  })

  const sendDirectMessage = () => {
    const content = composerText.trim()
    if (
      !pubkey ||
      !selected ||
      selected.transport !== "nip17" ||
      !messagingReady ||
      !content
    ) {
      return
    }

    const createdAt = Date.now()
    const rumor = buildDirectMessageRumor({
      senderPubkey: pubkey,
      recipientPubkey: selected.counterpartyPubkey,
      content,
      appId: "merchant",
      createdAt: Math.floor(createdAt / 1000),
    })
    const message = optimisticMessageQueue.enqueue({
      eventId: rumor.id,
      conversationId: selected.id,
      content,
      createdAt,
    })
    setComposerText("")
    sendMutation.mutate({
      message,
      counterpartyPubkey: selected.counterpartyPubkey,
      rumor,
    })
  }

  const retryDirectMessage = (message: OptimisticConversationMessage) => {
    if (
      !pubkey ||
      !selected ||
      selected.transport !== "nip17" ||
      !messagingReady
    ) {
      return
    }
    const rumor = buildDirectMessageRumor({
      senderPubkey: pubkey,
      recipientPubkey: selected.counterpartyPubkey,
      content: message.content,
      appId: "merchant",
      createdAt: Math.floor(message.createdAt / 1000),
    })
    optimisticMessageQueue.markPending(message.localId)
    sendMutation.mutate({
      message,
      counterpartyPubkey: selected.counterpartyPubkey,
      rumor,
    })
  }

  const showEmpty =
    signerConnected &&
    messagingReady &&
    !cachedQuery.isLoading &&
    !liveQuery.isLoading &&
    conversations.length === 0

  return (
    <div className="min-w-0 max-w-full space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <div className="xl:shrink-0">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Messages
        </div>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Buyer support inbox
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
          Answer general buyer questions in encrypted direct messages.
          Order-specific conversations stay on the Orders page.
        </p>
      </div>

      {!signerConnected && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view buyer messages.
        </div>
      )}

      {signerConnected && readinessQuery.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">
          Checking encrypted messaging setup...
        </div>
      )}

      {signerConnected && !readinessQuery.isLoading && !messagingReady && (
        <MessagingReadinessNotice
          state={readinessQuery.error ? "lookup_failed" : "not_declared"}
          onAction={() => {
            if (readinessQuery.error) {
              void readinessQuery.refetch()
            } else {
              enableMessagingMutation.mutate()
            }
          }}
          pending={
            readinessQuery.isRefetching || enableMessagingMutation.isPending
          }
          error={
            enableMessagingMutation.error
              ? "Could not enable messaging. Retry when your signer and relays are available."
              : null
          }
          className="xl:shrink-0"
        />
      )}

      {signerConnected &&
        messagingReady &&
        (liveQuery.error || liveMeta?.stale) && (
          <LiveReadNotice
            state={
              liveQuery.error
                ? conversations.length > 0
                  ? "cached"
                  : "unavailable"
                : "partial"
            }
            onRetry={() => void liveQuery.refetch()}
            retrying={liveQuery.isRefetching}
            className="xl:shrink-0"
          />
        )}

      {messagingReady && (
        <DecryptFailureNotice
          count={liveMeta?.legacyDecryptFailures?.length ?? 0}
          label="Some legacy messages couldn't be decrypted."
          onRetry={
            liveMeta?.legacyDecryptFailures?.some(
              (failure) => failure.retryable
            )
              ? () => void liveQuery.refetch()
              : undefined
          }
          retrying={liveQuery.isRefetching}
          className="xl:shrink-0"
        />
      )}

      {signerConnected &&
        messagingReady &&
        conversations.length === 0 &&
        (cachedQuery.isLoading || liveQuery.isLoading) && (
          <div className="text-sm text-[var(--text-secondary)]">
            Loading buyer messages…
          </div>
        )}

      {showEmpty && !liveQuery.error && !liveMeta?.degraded && (
        <>
          <DecryptFailureNotice
            count={liveMeta?.decryptFailures?.length ?? 0}
            onRetry={() => void liveQuery.refetch()}
            retrying={liveQuery.isRefetching}
            className="xl:shrink-0"
          />
          <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
            No buyer messages yet.
          </div>
        </>
      )}

      {signerConnected && conversations.length > 0 && (
        <div className="grid min-w-0 max-w-full gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="hidden min-w-0 rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden">
            <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
              Conversations
            </div>
            <SearchInput
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
              containerClassName="mt-3 xl:shrink-0"
            />
            <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
              {filteredConversations.length === 0 && (
                <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                  No conversations match your search.
                </div>
              )}
              {filteredConversations.map((conversation) => {
                const active = conversation.id === selectedId
                const name = getDisplayName(
                  profilesQuery.data?.[conversation.counterpartyPubkey],
                  conversation.counterpartyPubkey
                )
                return (
                  <DirectConversationListItem
                    key={conversation.id}
                    conversation={conversation}
                    buyerName={name}
                    buyerPicture={
                      profilesQuery.data?.[conversation.counterpartyPubkey]
                        ?.picture
                    }
                    active={active}
                    onClick={() => setSelectedId(conversation.id)}
                  />
                )
              })}
            </div>
          </aside>

          <div className="min-w-0 max-w-full space-y-4 xl:hidden">
            <Sheet
              open={conversationSheetOpen}
              onOpenChange={setConversationSheetOpen}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                  Conversations
                </div>
                <SheetTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)]"
                  >
                    <Search className="h-4 w-4" />
                    Search
                  </button>
                </SheetTrigger>
              </div>
              <section className="min-w-0 max-w-full rounded-[1.5rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
                {filteredConversations.length > 0 ? (
                  <ConversationCardScroller>
                    {filteredConversations.map((conversation) => {
                      const active = conversation.id === selectedId
                      const name = getDisplayName(
                        profilesQuery.data?.[conversation.counterpartyPubkey],
                        conversation.counterpartyPubkey
                      )
                      return (
                        <div
                          key={conversation.id}
                          className="w-[17rem] shrink-0 snap-start [&>button]:h-full"
                        >
                          <DirectConversationListItem
                            conversation={conversation}
                            buyerName={name}
                            buyerPicture={
                              profilesQuery.data?.[
                                conversation.counterpartyPubkey
                              ]?.picture
                            }
                            active={active}
                            onClick={() => setSelectedId(conversation.id)}
                          />
                        </div>
                      )
                    })}
                  </ConversationCardScroller>
                ) : (
                  <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                    No conversations match your search.
                  </div>
                )}
              </section>
              <SheetContent
                side="bottom"
                className="h-[100dvh] overflow-y-auto"
              >
                <SheetHeader>
                  <SheetTitle>Your conversations</SheetTitle>
                </SheetHeader>
                <SearchInput
                  aria-label="Search conversations"
                  placeholder="Search conversations"
                  value={conversationSearch}
                  onChange={(event) =>
                    setConversationSearch(event.target.value)
                  }
                />
                <div className="mt-4 space-y-2">
                  {filteredConversations.length === 0 && (
                    <div className="rounded-[1.1rem] border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      No conversations match your search.
                    </div>
                  )}
                  {filteredConversations.map((conversation) => {
                    const name = getDisplayName(
                      profilesQuery.data?.[conversation.counterpartyPubkey],
                      conversation.counterpartyPubkey
                    )
                    return (
                      <DirectConversationListItem
                        key={conversation.id}
                        conversation={conversation}
                        buyerName={name}
                        buyerPicture={
                          profilesQuery.data?.[conversation.counterpartyPubkey]
                            ?.picture
                        }
                        active={conversation.id === selectedId}
                        onClick={() => {
                          setSelectedId(conversation.id)
                          setConversationSheetOpen(false)
                        }}
                      />
                    )
                  })}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          <section className="flex min-h-[36rem] min-w-0 flex-col overflow-hidden rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 xl:h-full xl:min-h-0">
            {selected ? (
              <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
                <div className="mb-3 flex shrink-0 items-center gap-3 border-b border-[var(--border)] pb-4">
                  <BuyerAvatar
                    name={selectedName ?? "Buyer"}
                    picture={
                      profilesQuery.data?.[selected.counterpartyPubkey]?.picture
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-semibold text-[var(--text-primary)]">
                      {selectedName}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-[var(--text-secondary)]">
                      {formatNpub(selected.counterpartyPubkey, 12)}
                    </div>
                  </div>
                </div>

                <div className="mb-3 min-w-0 max-w-full shrink-0 border-b border-[var(--border)] pb-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    Related orders
                  </div>
                  {relatedOrdersLiveQuery.isLoading &&
                  relatedOrdersCacheQuery.isLoading ? (
                    <div className="text-xs text-[var(--text-secondary)]">
                      Loading related orders...
                    </div>
                  ) : relatedOrders.length > 0 ? (
                    <OrderCardScroller
                      conversations={relatedOrders}
                      buyerName={() => selectedName ?? "Buyer"}
                      buyerPicture={(buyerPubkey) =>
                        profilesQuery.data?.[buyerPubkey]?.picture
                      }
                      onSelect={(order) => {
                        void navigate({
                          to: "/orders",
                          search: { order: order.orderId },
                        })
                      }}
                    />
                  ) : relatedOrdersLiveQuery.error ? (
                    <div className="text-xs text-[var(--text-secondary)]">
                      Related order context is unavailable.
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--text-secondary)]">
                      No related orders found.
                    </div>
                  )}
                </div>

                <DecryptFailureNotice
                  count={liveMeta?.decryptFailures?.length ?? 0}
                  onRetry={() => void liveQuery.refetch()}
                  retrying={liveQuery.isRefetching}
                  className="mb-3 xl:shrink-0"
                />

                <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                  {threadMessages.length === 0 &&
                  optimisticThreadMessages.length === 0 ? (
                    <div className="text-sm text-[var(--text-secondary)]">
                      No messages in this conversation yet.
                    </div>
                  ) : (
                    <>
                      {threadMessages.map((message) => (
                        <ConversationMessageBubble
                          key={message.id}
                          content={message.content}
                          mine={message.senderPubkey === pubkey}
                          timestampLabel={new Date(
                            message.createdAt
                          ).toLocaleString()}
                        />
                      ))}
                      {optimisticThreadMessages.map((message) => (
                        <ConversationMessageBubble
                          key={message.localId}
                          content={message.content}
                          mine
                          timestampLabel={new Date(
                            message.createdAt
                          ).toLocaleString()}
                          deliveryState={message.deliveryState}
                          onRetry={
                            message.deliveryState === "failed"
                              ? () => retryDirectMessage(message)
                              : undefined
                          }
                        />
                      ))}
                    </>
                  )}
                </div>

                <div className="mt-4 shrink-0 space-y-2">
                  {selected.transport === "nip04" ? (
                    <LegacyDirectMessageNotice />
                  ) : !messagingReady ? (
                    <div className="text-sm text-[var(--text-secondary)]">
                      Enable encrypted messaging to reply in this current
                      conversation.
                    </div>
                  ) : (
                    <>
                      <MessageComposer
                        value={composerText}
                        onChange={setComposerText}
                        onSend={sendDirectMessage}
                        sending={sendMutation.isPending}
                        placeholder="Reply to buyer"
                      />
                      {sendMutation.error && (
                        <div className="text-xs text-error">
                          Message wasn't published. Retry from the message
                          bubble.
                        </div>
                      )}
                    </>
                  )}
                </div>
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
