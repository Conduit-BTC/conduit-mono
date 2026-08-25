import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  clearProtectedReadAuthenticationSuppression,
  getMerchantConversationList,
  nwcGetInfo,
  nwcLookupInvoice,
  publishMerchantOrderMessage,
  useAuth,
  useProfile,
  type NwcGetInfoResult,
} from "@conduit/core"
import {
  getMerchantNwcAddressStatus,
  getMerchantPaymentVerificationCandidates,
  MerchantPaymentVerificationAuthority,
  verifyMerchantPaymentCandidates,
  type MerchantNwcAddressStatus,
} from "../lib/merchant-payment-verification"
import { getNwcConnectionCacheKey } from "../lib/readiness"
import { useNwcConnection } from "./useNwcConnection"

type VerificationRunState = {
  status: "idle" | "checking" | "complete" | "error"
  checked: number
  verified: number
  message?: string
}

interface MerchantPaymentAutomationState {
  connection: ReturnType<typeof useNwcConnection>["connection"]
  connectionError: string | null
  setUri: (uri: string) => void
  disconnect: () => void
  info: NwcGetInfoResult | null
  infoPending: boolean
  infoError: string | null
  addressStatus: MerchantNwcAddressStatus
  canLookupInvoices: boolean
  canCreateInvoices: boolean
  canVerifyPayments: boolean
  run: VerificationRunState
  retry: () => void
}

const MerchantPaymentAutomationContext =
  createContext<MerchantPaymentAutomationState | null>(null)

export function MerchantPaymentAutomationProvider({
  children,
}: {
  children: ReactNode
}) {
  const { pubkey, status, authGeneration } = useAuth()
  const queryClient = useQueryClient()
  const profileQuery = useProfile(pubkey, { authenticatedPubkey: pubkey })
  const nwc = useNwcConnection()
  const setNwcUri = nwc.setUri
  const disconnectNwc = nwc.disconnect
  const attemptedOrConfirmedEvidenceRef = useRef(new Set<string>())
  const verificationAuthorityRef = useRef(
    new MerchantPaymentVerificationAuthority()
  )
  const [run, setRun] = useState<VerificationRunState>({
    status: "idle",
    checked: 0,
    verified: 0,
  })
  const signerConnected = status === "connected" && !!pubkey
  const connectionKey = nwc.connection
    ? getNwcConnectionCacheKey(nwc.rawUri)
    : "none"

  const infoQuery = useQuery({
    queryKey: ["merchant-nwc-info", pubkey ?? "none", connectionKey],
    enabled: !!pubkey && !!nwc.connection,
    queryFn: () => nwcGetInfo(nwc.connection!, 10_000, "merchant"),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  })
  const info = infoQuery.data ?? null
  const addressStatus = getMerchantNwcAddressStatus({
    profileLud16: profileQuery.data?.lud16,
    connectionLud16: nwc.connection?.lud16,
    walletLud16: info?.lud16,
  })
  const canCreateInvoices = info?.methods.includes("make_invoice") ?? false
  const canLookupInvoices = info?.methods.includes("lookup_invoice") ?? false
  const canVerifyPayments =
    canLookupInvoices &&
    addressStatus !== "mismatch" &&
    addressStatus !== "missing_profile"

  const conversationsQuery = useQuery({
    queryKey: [
      "merchant-payment-verification",
      pubkey ?? "none",
      authGeneration,
    ],
    enabled: signerConnected && canVerifyPayments,
    queryFn: () => getMerchantConversationList({ principalPubkey: pubkey! }),
    refetchInterval: 30_000,
  })
  const candidates = useMemo(
    () =>
      getMerchantPaymentVerificationCandidates(
        conversationsQuery.data?.data ?? []
      ),
    [conversationsQuery.data]
  )
  const conversationReadUnavailable =
    !!conversationsQuery.error ||
    (conversationsQuery.data?.meta.degraded === true &&
      conversationsQuery.data.data.length === 0)

  useLayoutEffect(() => {
    const verificationAuthority = verificationAuthorityRef.current
    verificationAuthority.revoke()
    setRun({ status: "idle", checked: 0, verified: 0 })

    return () => {
      verificationAuthority.revoke()
    }
  }, [
    addressStatus,
    authGeneration,
    canVerifyPayments,
    connectionKey,
    pubkey,
    signerConnected,
  ])

  useEffect(() => {
    if (!conversationReadUnavailable || conversationsQuery.isFetching) return
    setRun({
      status: "error",
      checked: 0,
      verified: 0,
      message:
        "Protected order updates are unavailable. Retry before checking pending invoices.",
    })
  }, [conversationReadUnavailable, conversationsQuery.isFetching])

  const verifyCandidates = useCallback(async () => {
    const connection = nwc.connection
    if (
      !pubkey ||
      !signerConnected ||
      !connection ||
      !canVerifyPayments ||
      conversationReadUnavailable
    ) {
      return
    }
    const authorityRun = verificationAuthorityRef.current.begin({
      authGeneration,
      connectionKey,
    })
    if (!authorityRun) return
    const { isCurrent } = authorityRun
    setRun({ status: "checking", checked: 0, verified: 0 })
    let checked = 0
    let verified = 0

    try {
      const result = await verifyMerchantPaymentCandidates({
        candidates,
        confirmedEvidence: attemptedOrConfirmedEvidenceRef.current,
        isCurrent,
        lookupInvoice: async (candidate) => {
          if (!isCurrent()) {
            throw new Error("Payment verification authority was revoked")
          }
          const settlement = await nwcLookupInvoice(
            connection,
            { invoice: candidate.invoice },
            10_000,
            "merchant"
          )
          if (!isCurrent()) {
            throw new Error("Payment verification authority was revoked")
          }
          return settlement
        },
        publishConfirmation: async (candidate, controls) => {
          if (!isCurrent()) {
            throw new Error("Payment verification authority was revoked")
          }
          await publishMerchantOrderMessage({
            merchantPubkey: pubkey,
            buyerPubkey: candidate.buyerPubkey,
            orderId: candidate.orderId,
            type: "status_update",
            tags: [["status", "paid"]],
            payload: { status: "paid" },
            inboundOrder: candidate.inboundOrder,
            delivery: candidate.delivery,
            publishAuthority: {
              isCurrent,
              onRecipientPublishStarted: controls.markPublishStarted,
            },
          })
          if (!isCurrent()) {
            throw new Error("Payment verification authority was revoked")
          }
        },
      })
      if (!isCurrent()) return
      checked = result.checked
      verified = result.verified

      const allLookupsFailed = result.lookupFailures > 0 && result.checked === 0
      setRun({
        status: allLookupsFailed ? "error" : "complete",
        checked,
        verified,
        ...(allLookupsFailed
          ? { message: "The wallet could not check pending invoices." }
          : {}),
      })
      if (verified > 0) {
        const queryKeys = [
          ["merchant-order-messages", pubkey],
          ["merchant-order-messages-live", pubkey],
          ["merchant-conversations-live", pubkey],
          ["merchant-dashboard-live", pubkey],
          ["merchant-payment-verification", pubkey],
        ]
        for (const queryKey of queryKeys) {
          if (!isCurrent()) return
          await queryClient.invalidateQueries({ queryKey })
        }
      }
    } catch (error) {
      if (!isCurrent()) return
      setRun({
        status: "error",
        checked,
        verified,
        message:
          error instanceof Error
            ? error.message
            : "Automatic payment verification stopped.",
      })
    } finally {
      authorityRun.finish()
    }
  }, [
    authGeneration,
    canVerifyPayments,
    candidates,
    connectionKey,
    conversationReadUnavailable,
    nwc.connection,
    pubkey,
    queryClient,
    signerConnected,
  ])

  useEffect(() => {
    if (
      candidates.length === 0 ||
      conversationReadUnavailable ||
      !signerConnected ||
      !canVerifyPayments ||
      conversationsQuery.isFetching
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
    signerConnected,
    verifyCandidates,
  ])

  const retry = useCallback(() => {
    setRun({ status: "idle", checked: 0, verified: 0 })
    if (pubkey) clearProtectedReadAuthenticationSuppression(pubkey)
    void infoQuery.refetch()
    void conversationsQuery.refetch()
  }, [conversationsQuery, infoQuery, pubkey])

  const setUri = useCallback(
    (uri: string) => {
      verificationAuthorityRef.current.revoke()
      setNwcUri(uri)
    },
    [setNwcUri]
  )
  const disconnect = useCallback(() => {
    verificationAuthorityRef.current.revoke()
    disconnectNwc()
  }, [disconnectNwc])

  const value = useMemo<MerchantPaymentAutomationState>(
    () => ({
      connection: nwc.connection,
      connectionError: nwc.error,
      setUri,
      disconnect,
      info,
      infoPending: infoQuery.isFetching,
      infoError:
        infoQuery.error instanceof Error ? infoQuery.error.message : null,
      addressStatus,
      canLookupInvoices,
      canCreateInvoices,
      canVerifyPayments,
      run,
      retry,
    }),
    [
      addressStatus,
      canLookupInvoices,
      canCreateInvoices,
      canVerifyPayments,
      disconnect,
      info,
      infoQuery.error,
      infoQuery.isFetching,
      nwc.connection,
      nwc.error,
      retry,
      run,
      setUri,
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
