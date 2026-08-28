import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  clearProtectedReadAuthenticationSuppression,
  getAuthoritativeProfileLud16,
  getMerchantConversationList,
  nwcGetInfo,
  nwcLookupInvoice,
  publishMerchantOrderMessage,
  useAuth,
  type NwcConnection,
  type NwcGetInfoResult,
} from "@conduit/core"
import {
  advanceMerchantPaymentVerificationIdentity,
  assertMerchantPaymentAuthoritySnapshotCurrent,
  assertMerchantPaymentConversationSnapshotCurrent,
  assertMerchantPaymentVerificationReadsIdle,
  getMerchantPaymentConversationSnapshotIdentity,
  getMerchantPaymentVerificationFailureRunState,
  getMerchantNwcAddressStatus,
  getMerchantPaymentVerificationCandidatesForRead,
  isMerchantPaymentConversationReadComplete,
  reconcileMerchantPaymentConversationReadRunState,
  reconcileMerchantPaymentStableSnapshot,
  selectAuthoritativeMerchantProfileLud16,
  verifyMerchantPaymentCandidates,
  MerchantPaymentAuthoritySnapshotChangedError,
  type MerchantPaymentVerificationIdentity,
  type MerchantPaymentVerificationRunState,
  type MerchantNwcAddressStatus,
} from "../lib/merchant-payment-verification"
import { getNwcConnectionCacheKey } from "../lib/readiness"
import { useNwcConnection } from "./useNwcConnection"

const PAYMENT_VERIFICATION_CONVERSATION_LIMIT = 400

interface MerchantPaymentAutomationState {
  connection: ReturnType<typeof useNwcConnection>["connection"]
  connectionError: string | null
  setUri: (uri: string) => void
  disconnect: () => void
  info: NwcGetInfoResult | null
  infoPending: boolean
  infoError: string | null
  profileLud16: string | null
  profileDestinationPending: boolean
  profileDestinationUnavailable: boolean
  addressStatus: MerchantNwcAddressStatus
  canLookupInvoices: boolean
  canCreateInvoices: boolean
  canVerifyPayments: boolean
  resolveInvoiceConnection: () => NwcConnection
  run: MerchantPaymentVerificationRunState
  retry: () => void
}

const MerchantPaymentAutomationContext =
  createContext<MerchantPaymentAutomationState | null>(null)

export function MerchantPaymentAutomationProvider({
  children,
}: {
  children: ReactNode
}) {
  const { pubkey, status } = useAuth()
  const queryClient = useQueryClient()
  const nwc = useNwcConnection()
  const invoiceConnectionRef = useRef(nwc.connection)
  invoiceConnectionRef.current = nwc.connection
  const invoiceConnectionReaderRef = useRef(nwc.readCurrentConnection)
  invoiceConnectionReaderRef.current = nwc.readCurrentConnection
  const confirmedEvidenceRef = useRef(new Set<string>())
  const verificationIdentityRef =
    useRef<MerchantPaymentVerificationIdentity | null>(null)
  const runningRef = useRef(false)
  const [run, setRun] = useState<MerchantPaymentVerificationRunState>({
    status: "idle",
    checked: 0,
    verified: 0,
  })
  const signerConnected = status === "connected" && !!pubkey
  const profileAuthorityQuery = useQuery({
    queryKey: ["merchant-payment-profile-authority", pubkey ?? "none"],
    enabled: signerConnected,
    queryFn: () => getAuthoritativeProfileLud16(pubkey!),
    staleTime: 30_000,
    refetchInterval: run.status === "checking" ? false : 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const profileAuthority = profileAuthorityQuery.data?.authority
  const profileLud16 = selectAuthoritativeMerchantProfileLud16({
    lud16: profileAuthorityQuery.data?.data,
    frontierConfirmed: profileAuthority?.frontierConfirmed ?? false,
    degraded: profileAuthority?.degraded ?? true,
    capped: profileAuthority?.capped ?? false,
    isFetching: profileAuthorityQuery.isFetching,
    hasError: !!profileAuthorityQuery.error,
  })
  const profileDestinationPending =
    signerConnected &&
    (profileAuthorityQuery.isPending || profileAuthorityQuery.isFetching)
  const profileDestinationUnavailable =
    signerConnected &&
    !profileDestinationPending &&
    (!!profileAuthorityQuery.error ||
      (!!profileAuthority &&
        (!profileAuthority.frontierConfirmed ||
          profileAuthority.degraded ||
          profileAuthority.capped)))
  const profileDestinationConfirmed =
    signerConnected &&
    !profileAuthorityQuery.isFetching &&
    !profileAuthorityQuery.error &&
    !!profileAuthority &&
    profileAuthority.frontierConfirmed &&
    !profileAuthority.degraded &&
    !profileAuthority.capped
  const connectionKey = nwc.connection
    ? getNwcConnectionCacheKey(nwc.rawUri)
    : "none"

  const infoQuery = useQuery({
    queryKey: ["merchant-nwc-info", pubkey ?? "none", connectionKey],
    enabled: !!pubkey && !!nwc.connection,
    queryFn: () => nwcGetInfo(nwc.connection!, 10_000, "merchant"),
    staleTime: 60_000,
    refetchInterval: run.status === "checking" ? false : 60_000,
    retry: false,
  })
  const info = infoQuery.data ?? null
  const addressStatus = getMerchantNwcAddressStatus({
    profileLud16,
    connectionLud16: nwc.connection?.lud16,
    walletLud16: info?.lud16,
  })
  const canCreateInvoices = info?.methods.includes("make_invoice") ?? false
  const canLookupInvoices = info?.methods.includes("lookup_invoice") ?? false
  const canVerifyPayments =
    canLookupInvoices &&
    addressStatus !== "mismatch" &&
    addressStatus !== "missing_profile"
  const verificationAuthoritySnapshotCandidate = useMemo(
    () =>
      signerConnected &&
      pubkey &&
      canVerifyPayments &&
      profileDestinationConfirmed &&
      profileLud16
        ? { principalPubkey: pubkey, connectionKey, profileLud16 }
        : null,
    [
      canVerifyPayments,
      connectionKey,
      profileDestinationConfirmed,
      profileLud16,
      pubkey,
      signerConnected,
    ]
  )
  const verificationAuthorityStableSnapshotRef = useRef<{
    boundary: string
    identity: string
    value: NonNullable<typeof verificationAuthoritySnapshotCandidate>
  } | null>(null)
  verificationAuthorityStableSnapshotRef.current =
    reconcileMerchantPaymentStableSnapshot({
      current: verificationAuthorityStableSnapshotRef.current,
      boundary:
        signerConnected && pubkey
          ? JSON.stringify([pubkey, connectionKey])
          : null,
      identity: verificationAuthoritySnapshotCandidate
        ? JSON.stringify([
            verificationAuthoritySnapshotCandidate.principalPubkey,
            verificationAuthoritySnapshotCandidate.connectionKey,
            verificationAuthoritySnapshotCandidate.profileLud16,
          ])
        : null,
      value: verificationAuthoritySnapshotCandidate,
      fetching: profileAuthorityQuery.isFetching || infoQuery.isFetching,
    })
  const verificationAuthoritySnapshot =
    verificationAuthorityStableSnapshotRef.current?.value ?? null
  const currentVerificationAuthoritySnapshotRef = useRef(
    verificationAuthoritySnapshot
  )
  currentVerificationAuthoritySnapshotRef.current =
    verificationAuthoritySnapshot
  const resolveInvoiceConnection = useCallback((): NwcConnection => {
    const connection = invoiceConnectionRef.current
    const persisted = invoiceConnectionReaderRef.current()
    if (!connection || !persisted || persisted.uri !== connection.uri) {
      throw new Error("A connected NWC wallet is required.")
    }
    return connection
  }, [])

  const conversationsQuery = useQuery({
    queryKey: ["merchant-payment-verification", pubkey ?? "none"],
    enabled: signerConnected && canVerifyPayments,
    queryFn: () =>
      getMerchantConversationList({
        principalPubkey: pubkey!,
        limit: PAYMENT_VERIFICATION_CONVERSATION_LIMIT,
      }),
    refetchInterval: run.status === "checking" ? false : 30_000,
  })
  const conversationReadComplete = isMerchantPaymentConversationReadComplete({
    error: conversationsQuery.error,
    meta: conversationsQuery.data?.meta,
  })
  const completeConversationSnapshotCandidate = conversationReadComplete
    ? (conversationsQuery.data ?? null)
    : null
  const completeConversationStableSnapshotRef = useRef<{
    boundary: string
    identity: string
    value: NonNullable<typeof completeConversationSnapshotCandidate>
  } | null>(null)
  completeConversationStableSnapshotRef.current =
    reconcileMerchantPaymentStableSnapshot({
      current: completeConversationStableSnapshotRef.current,
      boundary: signerConnected && pubkey ? pubkey : null,
      identity: completeConversationSnapshotCandidate
        ? getMerchantPaymentConversationSnapshotIdentity(
            completeConversationSnapshotCandidate.data
          )
        : null,
      value: completeConversationSnapshotCandidate,
      fetching: conversationsQuery.isFetching,
    })
  const completeConversationSnapshot =
    completeConversationStableSnapshotRef.current?.value ?? null
  const currentConversationSnapshotRef = useRef(completeConversationSnapshot)
  currentConversationSnapshotRef.current = completeConversationSnapshot
  const candidates = useMemo(
    () =>
      completeConversationSnapshot
        ? getMerchantPaymentVerificationCandidatesForRead({
            conversations: completeConversationSnapshot.data,
            meta: completeConversationSnapshot.meta,
          })
        : [],
    [completeConversationSnapshot]
  )
  const conversationReadUnavailable = !conversationReadComplete
  const conversationReadCapped =
    conversationsQuery.data?.meta.inbox?.declaredWritePlan.capped === true

  useEffect(() => {
    const transition = advanceMerchantPaymentVerificationIdentity(
      verificationIdentityRef.current,
      {
        principalPubkey: signerConnected ? pubkey : null,
        connectionKey,
        confirmedDestination: profileDestinationConfirmed
          ? profileLud16
          : undefined,
      }
    )
    verificationIdentityRef.current = transition.identity
    if (!transition.resetEvidence) return

    confirmedEvidenceRef.current.clear()
    setRun({ status: "idle", checked: 0, verified: 0 })
  }, [
    connectionKey,
    profileDestinationConfirmed,
    profileLud16,
    pubkey,
    signerConnected,
  ])

  useEffect(() => {
    setRun((current) =>
      reconcileMerchantPaymentConversationReadRunState({
        current,
        eligible: signerConnected && canVerifyPayments,
        fetching: conversationsQuery.isFetching,
        unavailable: conversationReadUnavailable,
        capped: conversationReadCapped,
      })
    )
  }, [
    canVerifyPayments,
    conversationReadCapped,
    conversationReadUnavailable,
    conversationsQuery.isFetching,
    signerConnected,
  ])

  const verifyCandidates = useCallback(async () => {
    const connection = nwc.connection
    const verificationSnapshot = completeConversationSnapshot
    const authoritySnapshot = verificationAuthoritySnapshot
    if (
      !pubkey ||
      !signerConnected ||
      !connection ||
      !canVerifyPayments ||
      conversationsQuery.isFetching ||
      infoQuery.isFetching ||
      profileAuthorityQuery.isFetching ||
      conversationReadUnavailable ||
      !verificationSnapshot ||
      !authoritySnapshot ||
      runningRef.current
    ) {
      return
    }
    runningRef.current = true
    setRun({ status: "checking", checked: 0, verified: 0 })
    let checked = 0
    let verified = 0

    const assertPaymentAuthorityCurrent = () => {
      assertMerchantPaymentVerificationReadsIdle({
        conversation: queryClient.getQueryState([
          "merchant-payment-verification",
          pubkey,
        ])?.fetchStatus,
        profile: queryClient.getQueryState([
          "merchant-payment-profile-authority",
          pubkey,
        ])?.fetchStatus,
        info: queryClient.getQueryState([
          "merchant-nwc-info",
          pubkey,
          connectionKey,
        ])?.fetchStatus,
      })
      assertMerchantPaymentConversationSnapshotCurrent(
        verificationSnapshot,
        currentConversationSnapshotRef.current
      )
      assertMerchantPaymentAuthoritySnapshotCurrent(
        authoritySnapshot,
        currentVerificationAuthoritySnapshotRef.current
      )
      let currentConnection: NwcConnection
      try {
        currentConnection = resolveInvoiceConnection()
      } catch {
        throw new MerchantPaymentAuthoritySnapshotChangedError()
      }
      if (currentConnection.uri !== connection.uri) {
        throw new MerchantPaymentAuthoritySnapshotChangedError()
      }
    }

    try {
      const result = await verifyMerchantPaymentCandidates({
        candidates,
        confirmedEvidence: confirmedEvidenceRef.current,
        assertAuthorityCurrent: assertPaymentAuthorityCurrent,
        lookupInvoice: (candidate) =>
          nwcLookupInvoice(
            connection,
            { invoice: candidate.invoice },
            10_000,
            "merchant"
          ),
        publishConfirmation: async (candidate) => {
          await publishMerchantOrderMessage({
            merchantPubkey: pubkey,
            buyerPubkey: candidate.buyerPubkey,
            orderId: candidate.orderId,
            type: "status_update",
            tags: [["status", "paid"]],
            payload: { status: "paid" },
            delivery: candidate.delivery,
            revalidateBeforeDelivery: () => assertPaymentAuthorityCurrent(),
          })
        },
        onConfirmed: () => {
          verified += 1
        },
      })
      // Pending/failed lookups do not call publishConfirmation, so re-check
      // both authorities before this older run may update visible lifecycle
      // state. A newer protected read or wallet/profile identity owns it now.
      checked = result.checked
      verified = result.verified
      assertMerchantPaymentConversationSnapshotCurrent(
        verificationSnapshot,
        currentConversationSnapshotRef.current
      )
      assertMerchantPaymentAuthoritySnapshotCurrent(
        authoritySnapshot,
        currentVerificationAuthoritySnapshotRef.current
      )
      const allLookupsFailed = result.lookupFailures > 0 && result.checked === 0
      setRun({
        status: allLookupsFailed ? "error" : "complete",
        checked,
        verified,
        ...(allLookupsFailed
          ? { message: "The wallet could not check pending invoices." }
          : {}),
      })
    } catch (error) {
      const failure = getMerchantPaymentVerificationFailureRunState({
        error,
        checked,
        verified,
      })
      setRun(failure)
      if (failure.blocker === "conversation_read") {
        void queryClient.invalidateQueries({
          queryKey: ["merchant-payment-verification", pubkey],
        })
      }
    } finally {
      runningRef.current = false
      if (verified > 0) {
        await Promise.allSettled([
          queryClient.invalidateQueries({
            queryKey: ["merchant-order-messages", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-order-messages-live", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-conversations-live", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-dashboard-live", pubkey],
          }),
          queryClient.invalidateQueries({
            queryKey: ["merchant-payment-verification", pubkey],
          }),
        ])
      }
    }
  }, [
    canVerifyPayments,
    candidates,
    completeConversationSnapshot,
    conversationReadUnavailable,
    conversationsQuery.isFetching,
    connectionKey,
    infoQuery.isFetching,
    nwc.connection,
    profileAuthorityQuery.isFetching,
    pubkey,
    queryClient,
    resolveInvoiceConnection,
    signerConnected,
    verificationAuthoritySnapshot,
  ])

  useEffect(() => {
    if (
      candidates.length === 0 ||
      conversationReadUnavailable ||
      !signerConnected ||
      !canVerifyPayments ||
      conversationsQuery.isFetching ||
      infoQuery.isFetching ||
      profileAuthorityQuery.isFetching
    ) {
      return
    }
    void verifyCandidates()
  }, [
    canVerifyPayments,
    candidates,
    conversationReadUnavailable,
    connectionKey,
    conversationsQuery.isFetching,
    infoQuery.isFetching,
    profileAuthorityQuery.isFetching,
    signerConnected,
    verifyCandidates,
  ])

  const retry = useCallback(() => {
    setRun({ status: "idle", checked: 0, verified: 0 })
    if (pubkey) clearProtectedReadAuthenticationSuppression(pubkey)
    void infoQuery.refetch()
    void profileAuthorityQuery.refetch()
    void conversationsQuery.refetch()
  }, [conversationsQuery, infoQuery, profileAuthorityQuery, pubkey])

  const value = useMemo<MerchantPaymentAutomationState>(
    () => ({
      connection: nwc.connection,
      connectionError: nwc.error,
      setUri: nwc.setUri,
      disconnect: nwc.disconnect,
      info,
      infoPending: infoQuery.isFetching,
      infoError:
        infoQuery.error instanceof Error ? infoQuery.error.message : null,
      profileLud16,
      profileDestinationPending,
      profileDestinationUnavailable,
      addressStatus,
      canLookupInvoices,
      canCreateInvoices,
      canVerifyPayments,
      resolveInvoiceConnection,
      run,
      retry,
    }),
    [
      addressStatus,
      canLookupInvoices,
      canCreateInvoices,
      canVerifyPayments,
      info,
      infoQuery.error,
      infoQuery.isFetching,
      nwc.connection,
      nwc.disconnect,
      nwc.error,
      nwc.setUri,
      profileDestinationPending,
      profileDestinationUnavailable,
      profileLud16,
      resolveInvoiceConnection,
      retry,
      run,
    ]
  )

  return (
    <MerchantPaymentAutomationContext.Provider value={value}>
      {children}
    </MerchantPaymentAutomationContext.Provider>
  )
}

export function useMerchantPaymentAutomation(): MerchantPaymentAutomationState {
  const value = useContext(MerchantPaymentAutomationContext)
  if (!value) {
    throw new Error(
      "useMerchantPaymentAutomation must be used inside MerchantPaymentAutomationProvider"
    )
  }
  return value
}
