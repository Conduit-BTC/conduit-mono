import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
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
  markDirectMessageConversationRead,
  parseDirectMessageRumor,
  publishPrivateMessage,
  useAuth,
  useProfiles,
  type Profile,
} from "@conduit/core"
import {
  Badge,
  ConversationMessageBubble,
  DecryptFailureNotice,
  getConversationMessageDisplayContent,
  LegacyDirectMessageNotice,
  LiveReadNotice,
  MessageComposer,
} from "@conduit/ui"
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

function MessagesPage() {
  const { pubkey, status } = useAuth()
  const queryClient = useQueryClient()
  const signerConnected = status === "connected" && !!pubkey
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composerText, setComposerText] = useState("")

  const liveQuery = useQuery({
    queryKey: ["merchant-dms-live", pubkey ?? "none"],
    enabled: signerConnected,
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
  const relatedOrdersLiveQuery = useQuery({
    queryKey: [
      "merchant-message-orders-live",
      pubkey ?? "none",
      selected?.counterpartyPubkey ?? "none",
    ],
    enabled: signerConnected && !!selected,
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
    mutationFn: async () => {
      const text = composerText.trim()
      const counterparty = selected?.counterpartyPubkey
      const ndk = getNdk()
      if (!ndk.signer || !pubkey || !counterparty) {
        throw new Error("Connect your signer to reply.")
      }
      if (!text) throw new Error("Message is required")
      const rumor = buildDirectMessageRumor({
        senderPubkey: pubkey,
        recipientPubkey: counterparty,
        content: text,
        appId: "merchant",
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
      setComposerText("")
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms", pubkey ?? "none"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["merchant-dms-live", pubkey ?? "none"],
        }),
      ])
    },
  })

  const showEmpty =
    signerConnected &&
    !cachedQuery.isLoading &&
    !liveQuery.isLoading &&
    conversations.length === 0

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
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

      {signerConnected && (liveQuery.error || liveMeta?.degraded) && (
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

      <DecryptFailureNotice
        count={liveMeta?.legacyDecryptFailures?.length ?? 0}
        label="Some legacy messages couldn't be decrypted."
        onRetry={() => void liveQuery.refetch()}
        retrying={liveQuery.isRefetching}
        className="xl:shrink-0"
      />

      {signerConnected &&
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
        <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-2 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden">
            <div className="mb-2 px-2 text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
              Conversations
            </div>
            <div className="space-y-1 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedId
                const name = getDisplayName(
                  profilesQuery.data?.[conversation.counterpartyPubkey],
                  conversation.counterpartyPubkey
                )
                return (
                  <button
                    key={conversation.id}
                    className={`w-full rounded-md border px-3 py-2 text-left transition ${
                      active
                        ? "border-[var(--text-secondary)] bg-[var(--surface)]"
                        : "border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-elevated)]"
                    }`}
                    onClick={() => setSelectedId(conversation.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-[var(--text-primary)]">
                        {name}
                      </span>
                      {conversation.unreadFromCounterparty > 0 && (
                        <Badge
                          variant="secondary"
                          className="border-[var(--border)]"
                        >
                          {conversation.unreadFromCounterparty}
                        </Badge>
                      )}
                      {conversation.transport === "nip04" && (
                        <Badge variant="secondary">Legacy</Badge>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                      {formatNpub(conversation.counterpartyPubkey, 8)}
                    </div>
                    {conversation.preview && (
                      <div className="mt-1 truncate text-xs text-[var(--text-secondary)]">
                        {getConversationMessageDisplayContent(
                          conversation.preview
                        )}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </aside>

          <section className="rounded-[1.4rem] border border-[var(--border)] bg-[var(--surface-elevated)] p-4 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden">
            {selected ? (
              <div className="xl:flex xl:h-full xl:min-h-0 xl:flex-col">
                <div className="mb-3 flex items-start justify-between gap-2 xl:shrink-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                      {selectedName}
                    </div>
                    <div className="font-mono text-[11px] text-[var(--text-muted)]">
                      {formatNpub(selected.counterpartyPubkey, 12)}
                    </div>
                  </div>
                </div>

                <div className="mb-3 border-y border-[var(--border)] py-3 xl:shrink-0">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    Related orders
                  </div>
                  {relatedOrdersLiveQuery.isLoading &&
                  relatedOrdersCacheQuery.isLoading ? (
                    <div className="text-xs text-[var(--text-secondary)]">
                      Loading related orders...
                    </div>
                  ) : relatedOrders.length > 0 ? (
                    <div className="space-y-1">
                      {relatedOrders.map((order) => (
                        <Link
                          key={order.id}
                          to="/orders"
                          search={{ order: order.orderId }}
                          className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-xs transition-colors hover:bg-[var(--surface)]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[var(--text-primary)]">
                              {order.status ?? order.preview}
                            </span>
                            <span className="block truncate text-[var(--text-muted)]">
                              {order.totalSummary ?? "Total unavailable"} .{" "}
                              {new Date(order.latestAt).toLocaleDateString()}
                            </span>
                          </span>
                          <span className="shrink-0 text-[var(--text-secondary)]">
                            {order.context === "missing_order"
                              ? "Missing order context"
                              : "Open"}
                          </span>
                        </Link>
                      ))}
                    </div>
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

                <div className="max-h-[52vh] space-y-2 overflow-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
                  {threadMessages.length === 0 ? (
                    <div className="text-sm text-[var(--text-secondary)]">
                      No messages in this conversation yet.
                    </div>
                  ) : (
                    threadMessages.map((message) => (
                      <ConversationMessageBubble
                        key={message.id}
                        content={message.content}
                        mine={message.senderPubkey === pubkey}
                        timestampLabel={new Date(
                          message.createdAt
                        ).toLocaleString()}
                      />
                    ))
                  )}
                </div>

                <div className="mt-4 space-y-2 xl:shrink-0">
                  {selected.transport === "nip04" ? (
                    <LegacyDirectMessageNotice />
                  ) : (
                    <>
                      <MessageComposer
                        value={composerText}
                        onChange={setComposerText}
                        onSend={() => sendMutation.mutate()}
                        sending={sendMutation.isPending}
                        placeholder="Reply to buyer"
                      />
                      {sendMutation.error && (
                        <div className="text-xs text-error">
                          {sendMutation.error instanceof Error
                            ? sendMutation.error.message
                            : "Failed to send message"}
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
