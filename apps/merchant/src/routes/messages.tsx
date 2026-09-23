import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import { Search } from "lucide-react"
import {
  buildDirectMessageRumor,
  cacheParsedDirectMessage,
  clearProtectedReadAuthenticationSuppression,
  deriveProtectedReadPresentationState,
  EVENT_KINDS,
  formatNpub,
  getCachedDirectMessageConversationList,
  getCachedMerchantConversationList,
  getDirectMessageConversationList,
  getMerchantConversationList,
  getNdk,
  getProfileName,
  markDirectMessageConversationRead,
  parseDirectMessageRumor,
  publishPrivateMessage,
  PrivateMessageRelayReadinessError,
  pubkeyToNpub,
  selectProtectedReadRows,
  useAuth,
  useConduitSession,
  useInboxDeclaration,
  useProfiles,
  type Profile,
} from "@conduit/core"
import {
  Button,
  ConversationCardScroller,
  ConversationMessageBubble,
  getConversationMessageDisplayContent,
  LegacyDirectMessageNotice,
  matchesConversationSearch,
  MessagingReadinessNotice,
  MessageComposer,
  ProtectedInboxNotice,
  SearchInput,
  SignerRecoveryNotice,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  toMessagingReadinessNoticeState,
  useOptimisticConversationMessages,
  type OptimisticConversationMessage,
  type OptimisticConversationScope,
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
  accountPubkey: string
  authGeneration: number
  messageScope: OptimisticConversationScope
  message: OptimisticConversationMessage
  counterpartyPubkey: string
  rumor: NDKEvent
}

function MessagesPage() {
  const { accountPubkey } = useAuth()
  return <MessagesWorkspace key={accountPubkey ?? "no-account"} />
}

function MessagesWorkspace() {
  const {
    accountPubkey,
    pubkey,
    status,
    authGeneration,
    isAuthGenerationCurrent,
    remoteSignerRecovery,
    signerReadiness,
    connect,
  } = useAuth()
  const messagingAuthorityRef = useRef({
    accountPubkey,
    authGeneration,
    pubkey,
    signerReadiness,
  })
  useLayoutEffect(() => {
    messagingAuthorityRef.current = {
      accountPubkey,
      authGeneration,
      pubkey,
      signerReadiness,
    }
  }, [accountPubkey, authGeneration, pubkey, signerReadiness])
  const isCurrentMessagingAuthority = (
    ownerPubkey: string,
    generation: number
  ) => {
    const current = messagingAuthorityRef.current
    return (
      isAuthGenerationCurrent(generation) &&
      current.accountPubkey === ownerPubkey &&
      current.pubkey === ownerPubkey &&
      current.authGeneration === generation &&
      current.signerReadiness === "ready"
    )
  }
  const session = useConduitSession()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const hasAccount = !!accountPubkey
  const signerConnected =
    signerReadiness === "ready" && !!accountPubkey && pubkey === accountPubkey
  const authenticatedPubkey = signerConnected ? pubkey : null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composerText, setComposerText] = useState("")
  const [conversationSearch, setConversationSearch] = useState("")
  const [conversationSheetOpen, setConversationSheetOpen] = useState(false)
  const optimisticMessageQueue = useOptimisticConversationMessages({
    ownerKey: accountPubkey,
    authorityKey: `${authGeneration}:${signerReadiness}`,
  })
  const optimisticMessageScope = optimisticMessageQueue.scope
  const optimisticMessages = optimisticMessageQueue.messages
  const removeOptimisticMessage = optimisticMessageQueue.remove

  // Network settings is the only surface that publishes or repairs the
  // NIP-17 inbox declaration; this route only reflects readiness (CND-208).
  const dmReadiness = useInboxDeclaration(accountPubkey, {
    enabled: signerConnected && session.relaySettingsReady,
    relayScope: session.relayScope,
  })
  const messagingReady = signerConnected && dmReadiness.status === "ready"
  const readinessNoticeState = toMessagingReadinessNoticeState(
    dmReadiness.status
  )
  const readinessLookupDegraded =
    readinessNoticeState === "lookup_partial" ||
    readinessNoticeState === "lookup_unavailable"
  const onReadinessAction = () => {
    if (readinessLookupDegraded) {
      dmReadiness.refetch()
    } else {
      void navigate({ to: "/network" })
    }
  }

  // Own-inbox reads are permissive (CND-208); only sends require readiness.
  const liveQuery = useQuery({
    queryKey: ["merchant-dms-live", accountPubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () =>
      getDirectMessageConversationList({ principalPubkey: accountPubkey! }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  })
  const cachedQuery = useQuery({
    queryKey: ["merchant-dms", accountPubkey ?? "none"],
    enabled: hasAccount,
    queryFn: () =>
      getCachedDirectMessageConversationList({
        principalPubkey: accountPubkey!,
      }),
    staleTime: 5_000,
  })
  const retryMessagesRead = () => {
    if (!accountPubkey || !signerConnected) return
    clearProtectedReadAuthenticationSuppression(accountPubkey)
    void liveQuery.refetch()
  }

  const conversations = useMemo(
    () => selectProtectedReadRows(liveQuery.data?.data, cachedQuery.data?.data),
    [cachedQuery.data, liveQuery.data]
  )
  const liveMeta = liveQuery.data?.meta
  const protectedMessagesReadState = deriveProtectedReadPresentationState({
    visibleCount: conversations.length,
    pending: liveQuery.isLoading,
    error: liveQuery.error,
    meta: liveMeta,
  })
  const messagesRetryUseful =
    protectedMessagesReadState !== "complete" ||
    (liveMeta?.decryptFailures?.length ?? 0) > 0 ||
    (liveMeta?.legacyDecryptFailures?.some((failure) => failure.retryable) ??
      false)

  const counterpartyPubkeys = useMemo(
    () =>
      Array.from(
        new Set(conversations.map((c) => c.counterpartyPubkey).filter(Boolean))
      ),
    [conversations]
  )
  const profilesQuery = useProfiles(counterpartyPubkeys, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: () =>
      messagingAuthorityRef.current.accountPubkey === accountPubkey &&
      messagingAuthorityRef.current.authGeneration === authGeneration,
    enabled: hasAccount && counterpartyPubkeys.length > 0,
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
      if (message.eventId && publishedEventIds.has(message.eventId)) {
        removeOptimisticMessage(optimisticMessageScope, message.localId)
      }
    }
  }, [
    conversations,
    optimisticMessageScope,
    optimisticMessages,
    removeOptimisticMessage,
  ])
  const relatedOrdersLiveQuery = useQuery({
    queryKey: [
      "merchant-message-orders-live",
      accountPubkey ?? "none",
      selected?.counterpartyPubkey ?? "none",
    ],
    enabled: signerConnected && !!selected,
    queryFn: () =>
      getMerchantConversationList({
        principalPubkey: accountPubkey!,
        counterpartyPubkey: selected!.counterpartyPubkey,
        limit: 3,
      }),
  })
  const relatedOrdersCacheQuery = useQuery({
    queryKey: [
      "merchant-message-orders",
      accountPubkey ?? "none",
      selected?.counterpartyPubkey ?? "none",
    ],
    enabled: hasAccount && !!selected,
    queryFn: () =>
      getCachedMerchantConversationList({
        principalPubkey: accountPubkey!,
        counterpartyPubkey: selected!.counterpartyPubkey,
        limit: 3,
      }),
  })
  const retryRelatedOrdersRead = () => {
    if (!accountPubkey || !signerConnected) return
    clearProtectedReadAuthenticationSuppression(accountPubkey)
    void relatedOrdersLiveQuery.refetch()
  }
  const relatedOrders = selectProtectedReadRows(
    relatedOrdersLiveQuery.data?.data,
    relatedOrdersCacheQuery.data?.data
  )
  const relatedOrdersReadState = deriveProtectedReadPresentationState({
    visibleCount: relatedOrders.length,
    pending: relatedOrdersLiveQuery.isLoading,
    error: relatedOrdersLiveQuery.error,
    meta: relatedOrdersLiveQuery.data?.meta,
  })

  useEffect(() => {
    if (!accountPubkey || !selected?.unreadFromCounterparty) return

    let cancelled = false
    void markDirectMessageConversationRead({
      principalPubkey: accountPubkey,
      counterpartyPubkey: selected.counterpartyPubkey,
      transport: selected.transport,
    })
      .then(async (updated) => {
        if (cancelled || updated === 0) return
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: ["merchant-dms", accountPubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-dms-live", accountPubkey],
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
    accountPubkey,
    queryClient,
    selected?.counterpartyPubkey,
    selected?.transport,
    selected?.unreadFromCounterparty,
  ])

  const sendMutation = useMutation({
    mutationFn: async (input: OptimisticDirectMessageSend) => {
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        throw new Error("Reconnect your signer, then retry this message.")
      }
      const ndk = getNdk()
      if (!ndk.signer) {
        throw new Error("Connect your signer to reply.")
      }
      const { selfCopyError } = await publishPrivateMessage({
        rumor: input.rumor,
        senderPubkey: input.accountPubkey,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.accountPubkey,
        recipientPubkey: input.counterpartyPubkey,
        signer: ndk.signer,
        rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
        signerInteraction: "external",
        shouldContinue: () =>
          isCurrentMessagingAuthority(
            input.accountPubkey,
            input.authGeneration
          ),
      })
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        return
      }
      optimisticMessageQueue.markPublished(
        input.messageScope,
        input.message.localId
      )
      if (selfCopyError) {
        console.warn("DM self-copy publish failed", selfCopyError)
      }
      try {
        await cacheParsedDirectMessage(parseDirectMessageRumor(input.rumor))
      } catch {
        console.warn("Failed to cache published direct message")
      }
    },
    onSuccess: async (_, input) => {
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        return
      }
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms", input.accountPubkey],
        }),
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms-live", input.accountPubkey],
        }),
      ])
    },
    onError: (error, input) => {
      if (
        messagingAuthorityRef.current.accountPubkey !== input.accountPubkey ||
        messagingAuthorityRef.current.authGeneration !== input.authGeneration
      ) {
        return
      }
      optimisticMessageQueue.markFailed(
        input.messageScope,
        input.message.localId
      )
      if (
        error instanceof PrivateMessageRelayReadinessError &&
        error.reason === "sender_not_ready"
      ) {
        dmReadiness.refetch()
      }
    },
  })

  const sendDirectMessage = () => {
    const content = composerText.trim()
    if (
      !accountPubkey ||
      !selected ||
      selected.transport !== "nip17" ||
      !messagingReady ||
      !content
    ) {
      return
    }

    const createdAt = Date.now()
    const rumor = buildDirectMessageRumor({
      senderPubkey: accountPubkey,
      recipientPubkey: selected.counterpartyPubkey,
      content,
      appId: "merchant",
      createdAt: Math.floor(createdAt / 1000),
    })
    const messageScope = optimisticMessageScope
    const message = optimisticMessageQueue.enqueue(messageScope, {
      eventId: rumor.id,
      conversationId: selected.id,
      content,
      createdAt,
    })
    setComposerText("")
    sendMutation.mutate({
      accountPubkey,
      authGeneration,
      messageScope,
      message,
      counterpartyPubkey: selected.counterpartyPubkey,
      rumor,
    })
  }

  const retryDirectMessage = (message: OptimisticConversationMessage) => {
    if (
      !accountPubkey ||
      !selected ||
      selected.transport !== "nip17" ||
      !messagingReady
    ) {
      return
    }
    const rumor = buildDirectMessageRumor({
      senderPubkey: accountPubkey,
      recipientPubkey: selected.counterpartyPubkey,
      content: message.content,
      appId: "merchant",
      createdAt: Math.floor(message.createdAt / 1000),
    })
    const messageScope = optimisticMessageScope
    optimisticMessageQueue.markPending(messageScope, message.localId)
    sendMutation.mutate({
      accountPubkey,
      authGeneration,
      messageScope,
      message,
      counterpartyPubkey: selected.counterpartyPubkey,
      rumor,
    })
  }

  const previousMessageAuthorityKeyRef = useRef(
    optimisticMessageScope.authorityKey
  )
  useLayoutEffect(() => {
    const previousAuthorityKey = previousMessageAuthorityKeyRef.current
    previousMessageAuthorityKeyRef.current = optimisticMessageScope.authorityKey
    if (previousAuthorityKey === optimisticMessageScope.authorityKey) return
    sendMutation.reset()
  }, [optimisticMessageScope.authorityKey, sendMutation])

  const showEmpty =
    signerConnected &&
    messagingReady &&
    !cachedQuery.isLoading &&
    !liveQuery.isLoading &&
    conversations.length === 0 &&
    protectedMessagesReadState === "complete"

  return (
    <div className="min-w-0 max-w-full space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <div className="xl:shrink-0">
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-[var(--text-primary)]">
          Buyer support inbox
        </h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-7 text-[var(--text-secondary)]">
          Answer general buyer questions in encrypted direct messages.
          Order-specific conversations stay on the Orders page.
        </p>
      </div>

      {remoteSignerRecovery ? (
        <SignerRecoveryNotice
          description="Your message draft and failed-send review items are still here. Reconnect the same signer, review the conversation, then choose Send or Retry again."
          reconnecting={status === "restoring"}
          restoreFailed={!!remoteSignerRecovery.restoreError}
          restoreFailureDescription="That saved signer connection could not be restored. Conduit has not re-encrypted or resent any message."
          onReconnect={() => connect({ mode: "restore" })}
        />
      ) : null}

      {!hasAccount && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          Connect your signer to view buyer messages.
        </div>
      )}

      {signerConnected && dmReadiness.isLoading && (
        <div className="text-sm text-[var(--text-secondary)]">
          Checking encrypted messaging setup...
        </div>
      )}

      {hasAccount &&
        !dmReadiness.isLoading &&
        !messagingReady &&
        readinessNoticeState && (
          <MessagingReadinessNotice
            state={readinessNoticeState}
            onAction={onReadinessAction}
            pending={dmReadiness.isRefetching}
            className="xl:shrink-0"
          />
        )}

      {hasAccount && protectedMessagesReadState !== "pending" && (
        <ProtectedInboxNotice
          state={protectedMessagesReadState}
          decryptFailureCount={
            (liveMeta?.decryptFailures?.length ?? 0) +
            (liveMeta?.legacyDecryptFailures?.length ?? 0)
          }
          onRetry={
            signerConnected && messagesRetryUseful
              ? retryMessagesRead
              : undefined
          }
          retrying={liveQuery.isRefetching}
          className="xl:shrink-0"
        />
      )}

      {hasAccount &&
        conversations.length === 0 &&
        (cachedQuery.isLoading || liveQuery.isLoading) && (
          <div className="text-sm text-[var(--text-secondary)]">
            Loading buyer messages…
          </div>
        )}

      {showEmpty && (
        <div className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 text-sm text-[var(--text-secondary)]">
          No buyer messages yet.
        </div>
      )}

      {hasAccount && conversations.length > 0 && (
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
                  {relatedOrders.length > 0 ? (
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
                  ) : relatedOrdersReadState === "pending" ? (
                    <div className="text-xs text-[var(--text-secondary)]">
                      Loading related orders...
                    </div>
                  ) : relatedOrdersReadState === "complete" ? (
                    <div className="text-xs text-[var(--text-secondary)]">
                      No related orders found.
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-secondary)]">
                      <span>
                        Related order context is {relatedOrdersReadState}. Retry
                        before relying on an empty result.
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={retryRelatedOrdersRead}
                        disabled={
                          relatedOrdersLiveQuery.isRefetching ||
                          !signerConnected
                        }
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                  {threadMessages.length === 0 &&
                  optimisticThreadMessages.length === 0 ? (
                    <div className="text-sm text-[var(--text-secondary)]">
                      {protectedMessagesReadState === "pending"
                        ? "Loading message history…"
                        : protectedMessagesReadState === "complete"
                          ? "No messages in this conversation yet."
                          : "Message history is unavailable. Retry before relying on an empty thread."}
                    </div>
                  ) : (
                    <>
                      {threadMessages.map((message) => (
                        <ConversationMessageBubble
                          key={message.id}
                          content={message.content}
                          mine={message.senderPubkey === accountPubkey}
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
                            message.deliveryState === "failed" && messagingReady
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
                  ) : dmReadiness.isLoading ? (
                    <div className="text-sm text-[var(--text-secondary)]">
                      Checking encrypted messaging setup...
                    </div>
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
                        <div role="alert" className="text-xs text-error">
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
