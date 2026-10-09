import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  CommerceInboxRecovery,
  Badge,
  Button,
  ConversationCardScroller,
  ConversationMessageBubble,
  LegacyDirectMessageNotice,
  MessagingReadinessNotice,
  toMessagingReadinessNoticeState,
  MessageComposer,
  PrivateSendNotice,
  matchesConversationSearch,
  SearchInput,
  SignerRecoveryNotice,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  OrderConversationMessage,
  ProtectedInboxNotice,
  formatProductReference,
  getConversationPreview,
  getConversationMessageDisplayContent,
  useOptimisticConversationMessages,
  type OrderAmountFormatter,
  type OptimisticConversationMessage,
  type OptimisticConversationScope,
} from "@conduit/ui"
import { MessageCircleMore, Search, Store } from "lucide-react"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  createParticipantMessageRumor,
  sendAccountInboxRumor,
  createAcceptedInboxSendCheckpoint,
  cacheOrderMessageRumor,
  clearProtectedReadAuthenticationSuppression,
  createValidatedOrderRouteScope,
  deriveProtectedReadPresentationState,
  formatNpub,
  getAccountSigner,
  formatPubkey,
  getCommerceInbox,
  markDirectMessageConversationRead,
  normalizePubkey,
  PrivateMessageRelayReadinessError,
  publishPrivateMessage,
  pubkeyToNpub,
  useAuth,
  useCommerceInbox,
  type PrivateMessageEvent,
  type AccountInboxSendResult,
  type ParsedDirectMessage,
  createPrivateMessageRumor,
  useConduitSession,
  useInboxDeclaration,
  useProfile,
  useProfiles,
} from "@conduit/core"
import type { DirectConversationSummary } from "@conduit/core"
import { requireAuth } from "../lib/auth"
import { CopyButton } from "../components/CopyButton"
import { ConversationProfilePicture } from "../components/ConversationProfilePicture"
import { getMerchantDisplayName } from "../components/MerchantIdentity"
import { type BuyerConversation } from "../lib/orderConversations"
import { getAutomaticMerchantThreadId } from "../lib/message-route-state"
import { getDirectMessageSearchEmptyCopy } from "../lib/protected-read-copy"
import { useShopperPricing } from "../hooks/useShopperPricing"

type MessagesSearch = {
  tab?: "dms" | "merchants"
  thread?: string
  merchant?: string
}

type OptimisticDirectMessageSend = {
  accountPubkey: string
  authGeneration: number
  messageScope: OptimisticConversationScope
  message: OptimisticConversationMessage
  counterpartyPubkey: string
  rumor: PrivateMessageEvent
}

type BuyerOrderReplySend = {
  accountPubkey: string
  authGeneration: number
  content: string
  merchantPubkey: string
  orderId: string
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
  formatAmount,
  accountPubkey,
  authenticatedPubkey,
  shouldContinue,
}: {
  conversation: BuyerConversation
  active: boolean
  onClick: () => void
  formatAmount: OrderAmountFormatter
  accountPubkey: string | null
  authenticatedPubkey: string | null
  shouldContinue?: () => boolean
}) {
  const { data: profile } = useProfile(conversation.merchantPubkey, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue,
    maxUnresolvedRefetches: 1,
  })
  const merchantName = getMerchantDisplayName(
    profile,
    conversation.merchantPubkey
  )
  const messages = conversation.messages ?? []
  const latestMessage = messages[messages.length - 1]

  return (
    // eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes.
    <button
      type="button"
      onClick={onClick}
      data-thread-id={conversation.id}
      className={[
        "w-full rounded-[var(--radius-md)] border px-3 py-3 text-left transition-[border-color,background-color]",
        active
          ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
          <ConversationProfilePicture
            src={profile?.picture}
            alt={merchantName}
          />
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
              ? getConversationPreview(latestMessage, formatAmount)
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
  accountPubkey,
  authenticatedPubkey,
  shouldContinue,
}: {
  conversation: DirectConversationSummary
  active: boolean
  onClick: () => void
  accountPubkey: string | null
  authenticatedPubkey: string | null
  shouldContinue?: () => boolean
}) {
  const { data: profile } = useProfile(conversation.counterpartyPubkey, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue,
    maxUnresolvedRefetches: 1,
  })
  const name = getMerchantDisplayName(profile, conversation.counterpartyPubkey)

  return (
    // eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes.
    <button
      type="button"
      onClick={onClick}
      data-dm-id={conversation.counterpartyPubkey}
      className={[
        "w-full rounded-[var(--radius-md)] border px-3 py-3 text-left transition-[border-color,background-color]",
        active
          ? "border-[color-mix(in_srgb,var(--primary-500)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary-500)_2%,transparent)]"
          : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-secondary)]",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
          <ConversationProfilePicture src={profile?.picture} alt={name} />
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
                <Badge className="bg-primary-500 text-white">
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
  const { accountPubkey } = useAuth()
  return <MessagesWorkspace key={accountPubkey ?? "no-account"} />
}

function MessagesWorkspace() {
  const shopperPricing = useShopperPricing()
  const formatOrderAmount: OrderAmountFormatter = (
    amount,
    currency,
    sourcePrice
  ) =>
    shopperPricing.formatPrice(
      {
        price: amount,
        currency,
        priceSats: currency === "SATS" ? amount : undefined,
        sourcePrice,
      },
      { settledSatsAreAuthoritative: true }
    )
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
  const shouldContinueAccountRead = () =>
    messagingAuthorityRef.current.accountPubkey === accountPubkey &&
    messagingAuthorityRef.current.authGeneration === authGeneration
  const session = useConduitSession()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const hasAccount = !!accountPubkey
  const signerConnected =
    signerReadiness === "ready" && !!accountPubkey && pubkey === accountPubkey
  const authenticatedPubkey = signerConnected ? pubkey : null
  const inbox = useCommerceInbox(accountPubkey, signerConnected)
  const [query, setQuery] = useState("")
  const [merchantSearchSheetOpen, setMerchantSearchSheetOpen] = useState(false)
  const [replyText, setReplyText] = useState("")
  const [dmText, setDmText] = useState("")
  const [directSendOutcome, setDirectSendOutcome] = useState<{
    accountPubkey: string
    counterpartyPubkey: string
    result: AccountInboxSendResult
  } | null>(null)
  const [dmSearch, setDmSearch] = useState("")
  const [dmSearchSheetOpen, setDmSearchSheetOpen] = useState(false)
  const [selectedDmId, setSelectedDmId] = useState<string | null>(null)
  const [selectedDmPubkey, setSelectedDmPubkey] = useState<string | null>(null)
  const [selectedDmTransport, setSelectedDmTransport] = useState<
    "nip17" | "nip04"
  >("nip17")
  const optimisticDmQueue = useOptimisticConversationMessages({
    ownerKey: accountPubkey,
    authorityKey: `${authGeneration}:${signerReadiness}`,
  })
  const preparedDmRumors = useRef(new Map<string, PrivateMessageEvent>())
  const optimisticDmScope = optimisticDmQueue.scope
  const optimisticDmMessages = optimisticDmQueue.messages
  const removeOptimisticDmMessage = optimisticDmQueue.remove

  const activeTab = search.tab ?? "merchants"

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

  // Order conversations read permissively (declared inbox + local IN +
  // compatibility relays), so merchant order replies stay reachable even
  // before the buyer publishes a kind-10050 declaration (CND-208).
  const messagesQuery = inbox.buyer
  const retryMerchantThreadsRead = () => {
    if (!accountPubkey || !signerConnected) return
    clearProtectedReadAuthenticationSuppression(accountPubkey)
    void messagesQuery.refetch()
  }

  const conversations = useMemo(
    () => messagesQuery.data?.data ?? [],
    [messagesQuery.data]
  )
  const merchantThreadsReadState = deriveProtectedReadPresentationState({
    visibleCount: conversations.length,
    pending: messagesQuery.isLoading,
    error: messagesQuery.error,
    meta: messagesQuery.data?.meta,
  })
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
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    enabled: hasAccount && merchantPubkeys.length > 0,
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
    const automaticThreadId = getAutomaticMerchantThreadId(
      search.thread,
      filteredConversations.map((conversation) => conversation.id)
    )
    if (automaticThreadId) {
      navigate({
        search: (prev) => ({ ...prev, thread: automaticThreadId }),
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
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
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
  }, [accountPubkey, selectedConversation?.id])

  const orderReplyContextRef = useRef({
    accountPubkey,
    conversationId: selectedConversation?.id,
    merchantPubkey: selectedConversation?.merchantPubkey,
  })
  useLayoutEffect(() => {
    orderReplyContextRef.current = {
      accountPubkey,
      conversationId: selectedConversation?.id,
      merchantPubkey: selectedConversation?.merchantPubkey,
    }
  }, [
    accountPubkey,
    selectedConversation?.id,
    selectedConversation?.merchantPubkey,
  ])

  const replyMutation = useMutation({
    mutationFn: async (input: BuyerOrderReplySend) => {
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        throw new Error("Reconnect your signer, then send this message again.")
      }

      const signer = getAccountSigner()
      if (!signer) throw new Error("Signer not connected")
      let accountOwner: ReturnType<typeof getCommerceInbox> | null = null
      try {
        accountOwner = getCommerceInbox(input.accountPubkey)
      } catch {
        // The recipient send can proceed; report missing local history after ACK.
      }

      const rumor = createPrivateMessageRumor({
        pubkey: input.accountPubkey,
        kind: EVENT_KINDS.ORDER,
        created_at: Math.floor(Date.now() / 1000),
        tags: appendConduitClientTag(
          [
            ["p", input.merchantPubkey],
            ["type", "message"],
            ["order", input.orderId],
          ],
          "market"
        ),
        content: JSON.stringify({
          note: input.content,
          orderId: input.orderId,
          merchantPubkey: input.merchantPubkey,
          buyerPubkey: input.accountPubkey,
          createdAt: Date.now(),
        }),
      })

      // Reply inside an existing validated order thread: order identity and
      // counterparty match the parsed conversation, so the compatibility lane
      // may carry it when the merchant has no usable declaration.
      const checkpoint = createAcceptedInboxSendCheckpoint(async () => {
        if (!accountOwner) throw new Error("Local order history unavailable")
        await cacheOrderMessageRumor(rumor, accountOwner)
      })
      const sent = await publishPrivateMessage({
        rumor,
        senderPubkey: input.accountPubkey,
        accountPubkey: input.accountPubkey,
        authenticatedPubkey: input.accountPubkey,
        recipientPubkey: input.merchantPubkey,
        signer,
        rumorKind: EVENT_KINDS.ORDER,
        signerInteraction: "external",
        shouldContinue: () =>
          isCurrentMessagingAuthority(
            input.accountPubkey,
            input.authGeneration
          ),
        validatedOrderScope: createValidatedOrderRouteScope({
          rumor,
          orderId: input.orderId,
          senderPubkey: input.accountPubkey,
          recipientPubkey: input.merchantPubkey,
        }),
        telemetryApp: "market",
        onRecipientAccepted: checkpoint.onRecipientAccepted,
      })
      if (sent.selfCopyError) {
        console.warn("Buyer message self-copy publish failed")
      }

      return await checkpoint.complete(sent)
    },
    onSuccess: async (_, input) => {
      const current = orderReplyContextRef.current
      if (
        current.accountPubkey !== input.accountPubkey ||
        current.conversationId !== input.orderId ||
        current.merchantPubkey !== input.merchantPubkey
      )
        return
      setReplyText((current) =>
        current.trim() === input.content ? "" : current
      )
    },
  })

  // General kind-14 DM inbox, cache-first, distinct from order threads.
  // Own-inbox reads are permissive (CND-208); only sends require readiness.
  const dmsLiveQuery = inbox.direct
  const retryDirectMessagesRead = () => {
    if (!accountPubkey || !signerConnected) return
    clearProtectedReadAuthenticationSuppression(accountPubkey)
    void dmsLiveQuery.refetch()
  }

  const dmConversations = useMemo(
    () => dmsLiveQuery.data?.data ?? [],
    [dmsLiveQuery.data]
  )
  const dmCounterpartyPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          dmConversations
            .map((conversation) => conversation.counterpartyPubkey)
            .filter(Boolean)
        )
      ),
    [dmConversations]
  )
  const dmProfilesQuery = useProfiles(dmCounterpartyPubkeys, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    enabled: hasAccount && dmCounterpartyPubkeys.length > 0,
    priority: "background",
    refetchUnresolvedMs: 12_000,
    maxUnresolvedRefetches: 1,
  })
  const filteredDmConversations = useMemo(() => {
    return dmConversations.filter((conversation) => {
      const profile = dmProfilesQuery.data?.[conversation.counterpartyPubkey]
      const name = getMerchantDisplayName(
        profile,
        conversation.counterpartyPubkey
      )
      return matchesConversationSearch(dmSearch, [
        name,
        conversation.counterpartyPubkey,
        pubkeyToNpub(conversation.counterpartyPubkey),
        getConversationMessageDisplayContent(conversation.preview),
        ...(conversation.messages ?? []).map((message) => message.content),
      ])
    })
  }, [dmConversations, dmProfilesQuery.data, dmSearch])
  const dmLiveMeta = dmsLiveQuery.data?.meta
  const directMessagesReadState = deriveProtectedReadPresentationState({
    visibleCount: dmConversations.length,
    pending: dmsLiveQuery.isLoading,
    error: dmsLiveQuery.error,
    meta: dmLiveMeta,
  })
  const directMessageListPending =
    directMessagesReadState === "pending" && dmConversations.length === 0
  const directMessageSearchEmptyCopy = getDirectMessageSearchEmptyCopy(
    directMessagesReadState
  )
  const dmDecryptFailures = dmLiveMeta?.decryptFailures?.length ?? 0
  const directMessagesRetryUseful =
    directMessagesReadState !== "complete" ||
    dmDecryptFailures > 0 ||
    (dmLiveMeta?.legacyDecryptFailures?.some((failure) => failure.retryable) ??
      false)

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
        (selectedDmId
          ? conversation.id === selectedDmId
          : conversation.counterpartyPubkey === selectedDmPubkey) &&
        conversation.transport === selectedDmTransport
    ) ?? null
  const selectedDmProfile = useProfile(selectedDmPubkey ?? undefined, {
    accountPubkey,
    authenticatedPubkey,
    shouldContinue: shouldContinueAccountRead,
    maxUnresolvedRefetches: 1,
  })
  const selectedDmName = selectedDmPubkey
    ? getMerchantDisplayName(selectedDmProfile.data, selectedDmPubkey)
    : null
  const selectedDmMessages = selectedDm?.messages ?? []
  const selectedOptimisticDmMessages = optimisticDmMessages.filter(
    (message) =>
      selectedDmTransport === "nip17" &&
      message.conversationId ===
        (selectedDm?.id ?? `nip17:${selectedDmPubkey}`) &&
      !selectedDmMessages.some(
        (publishedMessage) => publishedMessage.id === message.eventId
      )
  )

  useEffect(() => {
    const publishedEventIds = new Set(
      dmConversations.flatMap((conversation) =>
        (conversation.messages ?? []).map((message) => message.id)
      )
    )
    for (const message of optimisticDmMessages) {
      if (message.eventId && publishedEventIds.has(message.eventId)) {
        removeOptimisticDmMessage(optimisticDmScope, message.localId)
      }
    }
  }, [
    dmConversations,
    optimisticDmMessages,
    optimisticDmScope,
    removeOptimisticDmMessage,
  ])

  useEffect(() => {
    if (
      activeTab !== "dms" ||
      !accountPubkey ||
      !selectedDmPubkey ||
      !selectedDm?.unreadFromCounterparty
    ) {
      return
    }

    let cancelled = false
    void markDirectMessageConversationRead({
      principalPubkey: accountPubkey,
      counterpartyPubkey: selectedDmPubkey,
      transport: selectedDmTransport,
      conversationId:
        (selectedDm?.participants?.length ?? 0) > 2
          ? selectedDm?.id
          : undefined,
    })
      .then(async (updated) => {
        if (cancelled || updated === 0) return
      })
      .catch(() => {
        console.warn("Failed to update direct-message read state")
      })

    return () => {
      cancelled = true
    }
  }, [
    activeTab,
    accountPubkey,
    selectedDm?.id,
    selectedDm?.participants,
    selectedDm?.unreadFromCounterparty,
    selectedDmPubkey,
    selectedDmTransport,
  ])

  const sendDmMutation = useMutation({
    mutationFn: async (input: OptimisticDirectMessageSend) => {
      if (!messagingReady) throw new Error("Encrypted messaging is not enabled")
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        throw new Error("Reconnect your signer, then retry this message.")
      }

      const signer = getAccountSigner()
      if (!signer) throw new Error("Signer not connected")

      const recipients = input.rumor.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1]!)
      const markAccepted = () => {
        optimisticDmQueue.markPublished(
          input.messageScope,
          input.message.localId
        )
        const current = messagingAuthorityRef.current
        if (current.accountPubkey === input.accountPubkey) {
          const currentScope = {
            ownerKey: current.accountPubkey,
            authorityKey: `${current.authGeneration}:${current.signerReadiness}`,
          }
          if (currentScope.authorityKey !== input.messageScope.authorityKey)
            optimisticDmQueue.markPublished(currentScope, input.message.localId)
        }
      }
      const outcome = await sendAccountInboxRumor(
        {
          principal: input.accountPubkey,
          recipients,
          content: input.rumor.content,
          rumor: input.rumor,
        },
        {
          getSigner: () => signer,
          send: async (prepared) =>
            await publishPrivateMessage({
              ...prepared,
              signerInteraction: "external",
              relayAuthMethod: signer.authMethod,
              shouldContinue: () => {
                if (prepared.shouldContinue?.() === false) return false
                return isCurrentMessagingAuthority(
                  input.accountPubkey,
                  input.authGeneration
                )
              },
              onRecipientAccepted: async (delivery) => {
                markAccepted()
                await prepared.onRecipientAccepted?.(delivery)
              },
            }),
        }
      )
      markAccepted()
      setDirectSendOutcome({
        accountPubkey: input.accountPubkey,
        counterpartyPubkey: input.counterpartyPubkey,
        result: outcome,
      })
    },
    onSuccess: async (_, input) => {
      if (
        !isCurrentMessagingAuthority(input.accountPubkey, input.authGeneration)
      ) {
        return
      }
    },
    onError: (error, input) => {
      if (
        messagingAuthorityRef.current.accountPubkey !== input.accountPubkey ||
        messagingAuthorityRef.current.authGeneration !== input.authGeneration
      ) {
        return
      }
      const { message } = input
      optimisticDmQueue.markFailed(input.messageScope, message.localId)
      if (
        error instanceof PrivateMessageRelayReadinessError &&
        error.reason === "sender_not_ready"
      ) {
        dmReadiness.refetch()
      }
    },
  })

  const sendDirectMessage = () => {
    const content = dmText.trim()
    if (!accountPubkey || !selectedDmPubkey || !content || !messagingReady)
      return

    const createdAt = Date.now()
    setDirectSendOutcome(null)
    const rumor = createParticipantMessageRumor({
      senderPubkey: accountPubkey,
      recipientPubkeys: [selectedDmPubkey],
      content,
      appId: "market",
      createdAt: Math.floor(createdAt / 1000),
      replyTo: selectedDmMessages.at(-1)?.id,
    })
    preparedDmRumors.current.set(rumor.id, rumor)
    const messageScope = optimisticDmScope
    const message = optimisticDmQueue.enqueue(messageScope, {
      eventId: rumor.id,
      conversationId: selectedDm?.id ?? `nip17:${selectedDmPubkey}`,
      content,
      createdAt,
    })
    setDmText("")
    sendDmMutation.mutate({
      accountPubkey,
      authGeneration,
      messageScope,
      message,
      counterpartyPubkey: selectedDmPubkey,
      rumor,
    })
  }

  const retryDirectMessage = (message: OptimisticConversationMessage) => {
    if (!accountPubkey || !selectedDmPubkey || !messagingReady) return
    const rumor =
      preparedDmRumors.current.get(message.eventId ?? "") ??
      createParticipantMessageRumor({
        senderPubkey: accountPubkey,
        recipientPubkeys: [selectedDmPubkey],
        content: message.content,
        appId: "market",
        createdAt: Math.floor(message.createdAt / 1000),
      })
    const messageScope = optimisticDmScope
    setDirectSendOutcome(null)
    optimisticDmQueue.markPending(messageScope, message.localId)
    sendDmMutation.mutate({
      accountPubkey,
      authGeneration,
      messageScope,
      message,
      counterpartyPubkey: selectedDmPubkey,
      rumor,
    })
  }

  const previousMessageAuthorityRef = useRef({
    key: optimisticDmScope.authorityKey,
    accountPubkey,
  })
  useLayoutEffect(() => {
    const previous = previousMessageAuthorityRef.current
    previousMessageAuthorityRef.current = {
      key: optimisticDmScope.authorityKey,
      accountPubkey,
    }
    if (previous.key === optimisticDmScope.authorityKey) return
    preparedDmRumors.current.clear()
    if (previous.accountPubkey !== accountPubkey) replyMutation.reset()
    sendDmMutation.reset()
  }, [
    accountPubkey,
    optimisticDmScope.authorityKey,
    replyMutation,
    sendDmMutation,
  ])

  return (
    <div className="space-y-6 xl:flex xl:h-[calc(100vh-8.5rem)] xl:flex-col xl:overflow-hidden">
      <CommerceInboxRecovery {...inbox} />
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

      {remoteSignerRecovery ? (
        <SignerRecoveryNotice
          description="Your message drafts and failed-send review items are still here. Reconnect the same signer, review the conversation, then choose Send or Retry again."
          reconnecting={status === "restoring"}
          restoreFailed={!!remoteSignerRecovery.restoreError}
          restoreFailureDescription="That saved signer connection could not be restored. Conduit has not re-encrypted or resent any message."
          onReconnect={() => connect({ mode: "restore" })}
        />
      ) : null}

      <div className="border-b border-[var(--border)] xl:shrink-0">
        <div className="flex flex-wrap items-center gap-6">
          {(
            [
              ["dms", "DMs"],
              ["merchants", "Merchants"],
            ] as const
          ).map(([tab, label]) => (
            // eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes.
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
                "relative -mb-px inline-flex h-11 items-center border-b-2 text-sm font-medium transition-colors after:absolute after:-bottom-px after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-primary-500 after:transition-opacity",
                activeTab === tab
                  ? "border-primary-500 text-[var(--text-primary)] after:opacity-100"
                  : "border-transparent text-[var(--text-secondary)] after:opacity-0 hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "dms" ? (
        !hasAccount ? (
          <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
              <MessageCircleMore className="h-7 w-7" />
            </div>
            <h2 className="mt-5 text-2xl font-semibold text-[var(--text-primary)]">
              Connect to view your inbox
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-[var(--text-secondary)]">
              General direct messages are tied to your signer identity.
            </p>
          </section>
        ) : dmReadiness.isLoading &&
          dmConversations.length === 0 &&
          !selectedDmPubkey ? (
          <div className="text-sm text-[var(--text-secondary)]">
            Checking encrypted messaging setup...
          </div>
        ) : !messagingReady &&
          readinessNoticeState &&
          dmConversations.length === 0 &&
          !selectedDmPubkey ? (
          <MessagingReadinessNotice
            state={readinessNoticeState}
            onAction={onReadinessAction}
            pending={dmReadiness.isRefetching}
          />
        ) : (
          <>
            {directMessagesReadState !== "pending" ? (
              <ProtectedInboxNotice
                state={directMessagesReadState}
                decryptFailureCount={
                  dmDecryptFailures +
                  (dmLiveMeta?.legacyDecryptFailures?.length ?? 0)
                }
                onRetry={
                  signerConnected && directMessagesRetryUseful
                    ? retryDirectMessagesRead
                    : undefined
                }
                retrying={dmsLiveQuery.isRefetching}
              />
            ) : null}

            {directMessageListPending && !selectedDmPubkey ? (
              <div className="text-sm text-[var(--text-secondary)]">
                Loading your inbox…
              </div>
            ) : dmConversations.length === 0 &&
              !selectedDmPubkey &&
              messagingReady &&
              directMessagesReadState === "complete" ? (
              <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
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
              <div className="grid min-w-0 max-w-full gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[340px_minmax(0,1fr)]">
                <aside className="hidden min-w-0 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                  <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
                    Conversations
                  </div>
                  <SearchInput
                    aria-label="Search conversations"
                    placeholder="Search conversations"
                    value={dmSearch}
                    onChange={(event) => setDmSearch(event.target.value)}
                    containerClassName="mt-3 xl:shrink-0"
                  />
                  <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                    {filteredDmConversations.length > 0 ? (
                      filteredDmConversations.map((conversation) => (
                        <DmThreadRow
                          key={conversation.id}
                          conversation={conversation}
                          accountPubkey={accountPubkey}
                          authenticatedPubkey={authenticatedPubkey}
                          shouldContinue={shouldContinueAccountRead}
                          active={
                            conversation.counterpartyPubkey ===
                              selectedDmPubkey &&
                            conversation.transport === selectedDmTransport
                          }
                          onClick={() => {
                            setSelectedDmId(conversation.id)
                            setSelectedDmPubkey(conversation.counterpartyPubkey)
                            setSelectedDmTransport(conversation.transport)
                          }}
                        />
                      ))
                    ) : (
                      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                        {directMessageSearchEmptyCopy}
                      </div>
                    )}
                  </div>
                </aside>

                <div className="min-w-0 max-w-full space-y-4 xl:hidden">
                  <Sheet
                    open={dmSearchSheetOpen}
                    onOpenChange={setDmSearchSheetOpen}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                        Conversations
                      </div>
                      <SheetTrigger asChild>
                        {/* eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes. */}
                        <button
                          type="button"
                          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)]"
                        >
                          <Search className="h-4 w-4" />
                          Search
                        </button>
                      </SheetTrigger>
                    </div>
                    <section className="min-w-0 max-w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
                      {filteredDmConversations.length > 0 ? (
                        <ConversationCardScroller>
                          {filteredDmConversations.map((conversation) => (
                            <div
                              key={conversation.id}
                              className="w-[18rem] shrink-0 snap-start [&>button]:h-full"
                            >
                              <DmThreadRow
                                conversation={conversation}
                                accountPubkey={accountPubkey}
                                authenticatedPubkey={authenticatedPubkey}
                                shouldContinue={shouldContinueAccountRead}
                                active={
                                  conversation.counterpartyPubkey ===
                                    selectedDmPubkey &&
                                  conversation.transport === selectedDmTransport
                                }
                                onClick={() => {
                                  setSelectedDmId(conversation.id)
                                  setSelectedDmPubkey(
                                    conversation.counterpartyPubkey
                                  )
                                  setSelectedDmTransport(conversation.transport)
                                }}
                              />
                            </div>
                          ))}
                        </ConversationCardScroller>
                      ) : (
                        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                          {directMessageSearchEmptyCopy}
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
                        value={dmSearch}
                        onChange={(event) => setDmSearch(event.target.value)}
                      />
                      <div className="mt-4 space-y-2">
                        {filteredDmConversations.length === 0 && (
                          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                            {directMessageSearchEmptyCopy}
                          </div>
                        )}
                        {filteredDmConversations.map((conversation) => (
                          <DmThreadRow
                            key={conversation.id}
                            conversation={conversation}
                            accountPubkey={accountPubkey}
                            authenticatedPubkey={authenticatedPubkey}
                            shouldContinue={shouldContinueAccountRead}
                            active={
                              conversation.counterpartyPubkey ===
                                selectedDmPubkey &&
                              conversation.transport === selectedDmTransport
                            }
                            onClick={() => {
                              setSelectedDmId(conversation.id)
                              setSelectedDmPubkey(
                                conversation.counterpartyPubkey
                              )
                              setSelectedDmTransport(conversation.transport)
                              setDmSearchSheetOpen(false)
                            }}
                          />
                        ))}
                      </div>
                    </SheetContent>
                  </Sheet>
                </div>

                <section className="flex min-h-[36rem] min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] xl:h-full xl:min-h-0">
                  {selectedDmPubkey ? (
                    <>
                      <div className="border-b border-[var(--border)] px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className="h-12 w-12 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
                            <ConversationProfilePicture
                              src={selectedDmProfile.data?.picture}
                              alt={selectedDmName ?? "Contact"}
                            />
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

                      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-6 py-5">
                        {selectedDmMessages.length > 0 ||
                        selectedOptimisticDmMessages.length > 0 ? (
                          <>
                            {selectedDmMessages.map((message) => (
                              <ConversationMessageBubble
                                key={message.id}
                                content={message.content}
                                file={
                                  "file" in message
                                    ? (message as ParsedDirectMessage).file
                                    : undefined
                                }
                                mine={message.senderPubkey === accountPubkey}
                                timestampLabel={new Date(
                                  message.createdAt
                                ).toLocaleString()}
                              />
                            ))}
                            {selectedOptimisticDmMessages.map((message) => (
                              <ConversationMessageBubble
                                key={message.localId}
                                content={message.content}

                                mine
                                timestampLabel={new Date(
                                  message.createdAt
                                ).toLocaleString()}
                                deliveryState={message.deliveryState}
                                onRetry={
                                  message.deliveryState === "failed" &&
                                  messagingReady
                                    ? () => retryDirectMessage(message)
                                    : undefined
                                }
                              />
                            ))}
                          </>
                        ) : (
                          <div className="flex h-full min-h-[160px] items-center justify-center text-center text-sm text-[var(--text-secondary)]">
                            {directMessagesReadState === "pending"
                              ? "Loading message history…"
                              : directMessagesReadState === "complete"
                                ? "No messages yet. Say hello."
                                : "Message history is unavailable. Retry the protected read before relying on an empty thread."}
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
                        ) : dmReadiness.isLoading ? (
                          <div className="text-sm text-[var(--text-secondary)]">
                            Checking encrypted messaging setup...
                          </div>
                        ) : !messagingReady ? (
                          readinessNoticeState ? (
                            <MessagingReadinessNotice
                              state={readinessNoticeState}
                              onAction={onReadinessAction}
                              pending={dmReadiness.isRefetching}
                            />
                          ) : null
                        ) : (
                          <>
                            <MessageComposer
                              value={dmText}
                              onChange={setDmText}
                              onAttach={
                                accountPubkey &&
                                selectedDmPubkey &&
                                inbox.attach
                                  ? (file) =>
                                      inbox.attach!([selectedDmPubkey], file)
                                  : undefined
                              }
                              onSend={sendDirectMessage}
                              sending={sendDmMutation.isPending}
                              placeholder="Send a direct message"
                            />
                            <PrivateSendNotice
                              outcome={
                                directSendOutcome?.accountPubkey ===
                                  accountPubkey &&
                                directSendOutcome.counterpartyPubkey ===
                                  selectedDmPubkey
                                  ? directSendOutcome.result
                                  : null
                              }
                              label="Reply"
                            />
                            {sendDmMutation.error && (
                              <div
                                className="mt-2 text-xs text-[var(--error-text)]"
                                role="alert"
                              >
                                Message wasn't published. Retry from the message
                                bubble.
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
          {!hasAccount && (
            <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
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
              />
            )}

          {hasAccount && merchantThreadsReadState !== "pending" && (
            <ProtectedInboxNotice
              state={merchantThreadsReadState}
              decryptFailureCount={
                messagesQuery.data?.meta.decryptFailures?.length ?? 0
              }
              onRetry={signerConnected ? retryMerchantThreadsRead : undefined}
              retrying={messagesQuery.isRefetching}
            />
          )}

          {hasAccount &&
            !messagesQuery.isLoading &&
            conversations.length === 0 &&
            merchantThreadsReadState === "complete" && (
              <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] text-secondary-300">
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

          {hasAccount && conversations.length > 0 && (
            <div className="grid min-w-0 max-w-full gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="hidden min-w-0 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 xl:flex xl:min-h-0 xl:h-full xl:flex-col xl:overflow-hidden">
                <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)] xl:shrink-0">
                  Conversations
                </div>
                <SearchInput
                  aria-label="Search merchant conversations"
                  placeholder="Search conversations"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  containerClassName="mt-3 xl:shrink-0"
                />
                <div className="mt-4 space-y-2 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                  {filteredConversations.length > 0 ? (
                    filteredConversations.map((conversation) => (
                      <MerchantThreadRow
                        key={conversation.id}
                        conversation={conversation}
                        accountPubkey={accountPubkey}
                        authenticatedPubkey={authenticatedPubkey}
                        shouldContinue={shouldContinueAccountRead}
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
                        formatAmount={formatOrderAmount}
                      />
                    ))
                  ) : (
                    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                      {search.merchant
                        ? "No conversation with this merchant yet."
                        : "No merchant threads match this search."}
                    </div>
                  )}
                </div>
              </aside>

              <div className="min-w-0 max-w-full space-y-4 xl:hidden">
                <Sheet
                  open={merchantSearchSheetOpen}
                  onOpenChange={setMerchantSearchSheetOpen}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                      Conversations
                    </div>
                    <SheetTrigger asChild>
                      {/* eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes. */}
                      <button
                        type="button"
                        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text-primary)] transition-[border-color,background-color] hover:border-[var(--text-secondary)]"
                      >
                        <Search className="h-4 w-4" />
                        Search
                      </button>
                    </SheetTrigger>
                  </div>
                  <section className="min-w-0 max-w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
                    {filteredConversations.length > 0 ? (
                      <ConversationCardScroller>
                        {filteredConversations.map((conversation) => (
                          <div
                            key={conversation.id}
                            className="w-[18rem] shrink-0 snap-start [&>button]:h-full"
                          >
                            <MerchantThreadRow
                              conversation={conversation}
                              accountPubkey={accountPubkey}
                              authenticatedPubkey={authenticatedPubkey}
                              shouldContinue={shouldContinueAccountRead}
                              active={
                                conversation.id === selectedConversation?.id
                              }
                              onClick={() =>
                                navigate({
                                  search: (prev) => ({
                                    ...prev,
                                    thread: conversation.id,
                                  }),
                                  replace: true,
                                })
                              }
                              formatAmount={formatOrderAmount}
                            />
                          </div>
                        ))}
                      </ConversationCardScroller>
                    ) : (
                      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                        {search.merchant
                          ? "No conversation with this merchant yet."
                          : "No merchant threads match this search."}
                      </div>
                    )}
                  </section>
                  <SheetContent
                    side="bottom"
                    className="h-[100dvh] overflow-y-auto"
                  >
                    <SheetHeader>
                      <SheetTitle>Your merchant conversations</SheetTitle>
                    </SheetHeader>
                    <SearchInput
                      aria-label="Search merchant conversations"
                      placeholder="Search conversations"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <div className="mt-4 space-y-2">
                      {filteredConversations.length === 0 && (
                        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 py-5 text-sm text-[var(--text-secondary)]">
                          {search.merchant
                            ? "No conversation with this merchant yet."
                            : "No merchant threads match this search."}
                        </div>
                      )}
                      {filteredConversations.map((conversation) => (
                        <MerchantThreadRow
                          key={conversation.id}
                          conversation={conversation}
                          accountPubkey={accountPubkey}
                          authenticatedPubkey={authenticatedPubkey}
                          shouldContinue={shouldContinueAccountRead}
                          active={conversation.id === selectedConversation?.id}
                          onClick={() => {
                            void navigate({
                              search: (prev) => ({
                                ...prev,
                                thread: conversation.id,
                              }),
                              replace: true,
                            })
                            setMerchantSearchSheetOpen(false)
                          }}
                          formatAmount={formatOrderAmount}
                        />
                      ))}
                    </div>
                  </SheetContent>
                </Sheet>
              </div>

              <section className="flex min-h-[36rem] min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] xl:h-full xl:min-h-0">
                {selectedConversation ? (
                  <>
                    <div className="border-b border-[var(--border)] px-6 py-5">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface-elevated)]">
                          <ConversationProfilePicture
                            src={selectedProfile.data?.picture}
                            alt={merchantName ?? "Merchant"}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link
                            to="/$identityRef"
                            params={{
                              identityRef: pubkeyToNpub(
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

                    <div className="min-h-0 flex-1 space-y-3 overflow-auto px-6 py-5">
                      {(selectedConversation.messages ?? []).map((message) => (
                        <OrderConversationMessage
                          key={message.id}
                          message={message}
                          mine={message.senderPubkey === accountPubkey}
                          formatAmount={formatOrderAmount}
                        />
                      ))}
                    </div>

                    <div className="border-t border-[var(--border)] px-6 py-4">
                      <div className="flex flex-col gap-3 sm:flex-row">
                        {/* eslint-disable-next-line no-restricted-syntax -- Legacy control; adopt @conduit/ui when this surface changes. */}
                        <input
                          value={replyText}
                          onChange={(event) => setReplyText(event.target.value)}
                          placeholder="Send a message to the merchant"
                          className="h-11 flex-1 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] px-4 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                          aria-label="Reply to merchant"
                        />
                        <Button
                          className="h-11 px-5 text-sm"
                          disabled={
                            replyMutation.isPending ||
                            !replyText.trim() ||
                            !signerConnected
                          }
                          onClick={() => {
                            if (!accountPubkey || !selectedConversation) return
                            replyMutation.mutate({
                              accountPubkey,
                              authGeneration,
                              content: replyText.trim(),
                              merchantPubkey:
                                selectedConversation.merchantPubkey,
                              orderId: selectedConversation.orderId,
                            })
                          }}
                        >
                          {replyMutation.isPending
                            ? "Sending..."
                            : "Send message"}
                        </Button>
                      </div>
                      {replyMutation.error && (
                        <div className="mt-2 text-xs text-[var(--error-text)]">
                          {replyMutation.error instanceof Error
                            ? replyMutation.error.message
                            : "Failed to send message"}
                        </div>
                      )}
                      {replyMutation.data &&
                        replyMutation.variables?.accountPubkey ===
                          accountPubkey &&
                        replyMutation.variables.orderId ===
                          selectedConversation.orderId &&
                        replyMutation.variables.merchantPubkey ===
                          selectedConversation.merchantPubkey && (
                          <PrivateSendNotice
                            outcome={replyMutation.data}
                            label="Reply"
                          />
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
