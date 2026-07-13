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
  isNwcSettlementMatch,
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
  const { pubkey, status } = useAuth()
  const queryClient = useQueryClient()
  const profileQuery = useProfile(pubkey)
  const nwc = useNwcConnection()
  const attemptedRunsRef = useRef(new Set<string>())
  const runningRef = useRef(false)
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
    queryKey: ["merchant-payment-verification", pubkey ?? "none"],
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
  const runKey = candidates
    .map((candidate) => `${candidate.orderId}:${candidate.evidenceMessageId}`)
    .sort()
    .join("|")

  useEffect(() => {
    attemptedRunsRef.current.clear()
    setRun({ status: "idle", checked: 0, verified: 0 })
  }, [addressStatus, nwc.connection])

  const verifyCandidates = useCallback(async () => {
    if (
      !pubkey ||
      !signerConnected ||
      !nwc.connection ||
      !canVerifyPayments ||
      runningRef.current
    ) {
      return
    }
    if (candidates.length === 0) {
      setRun({ status: "complete", checked: 0, verified: 0 })
      return
    }

    runningRef.current = true
    setRun({ status: "checking", checked: 0, verified: 0 })
    let checked = 0
    let verified = 0
    let lookupFailures = 0
    const matches: Array<{
      candidate: (typeof candidates)[number]
      paymentHash: string
    }> = []

    try {
      for (const candidate of candidates) {
        try {
          const settlement = await nwcLookupInvoice(
            nwc.connection,
            { invoice: candidate.invoice },
            10_000,
            "merchant"
          )
          checked += 1
          if (isNwcSettlementMatch(candidate, settlement)) {
            matches.push({
              candidate,
              paymentHash: settlement.paymentHash.toLowerCase(),
            })
          }
        } catch {
          lookupFailures += 1
        }
      }

      const paymentHashCounts = new Map<string, number>()
      for (const match of matches) {
        paymentHashCounts.set(
          match.paymentHash,
          (paymentHashCounts.get(match.paymentHash) ?? 0) + 1
        )
      }

      for (const match of matches) {
        if (paymentHashCounts.get(match.paymentHash) !== 1) continue
        await publishMerchantOrderMessage({
          merchantPubkey: pubkey,
          buyerPubkey: match.candidate.buyerPubkey,
          orderId: match.candidate.orderId,
          type: "status_update",
          tags: [["status", "paid"]],
          payload: { status: "paid" },
          delivery: match.candidate.delivery,
        })
        verified += 1
      }

      setRun({
        status: lookupFailures === candidates.length ? "error" : "complete",
        checked,
        verified,
        ...(lookupFailures === candidates.length
          ? { message: "The wallet could not check pending invoices." }
          : {}),
      })
      if (verified > 0) {
        await Promise.all([
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
    } catch (error) {
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
      runningRef.current = false
    }
  }, [
    canVerifyPayments,
    candidates,
    nwc.connection,
    pubkey,
    queryClient,
    signerConnected,
  ])

  useEffect(() => {
    if (
      !runKey ||
      !signerConnected ||
      !canVerifyPayments ||
      conversationsQuery.isFetching
    ) {
      return
    }
    const scopedRunKey = `${connectionKey}:${runKey}`
    if (attemptedRunsRef.current.has(scopedRunKey)) return
    attemptedRunsRef.current.add(scopedRunKey)
    void verifyCandidates()
  }, [
    canVerifyPayments,
    connectionKey,
    conversationsQuery.isFetching,
    runKey,
    signerConnected,
    verifyCandidates,
  ])

  const retry = useCallback(() => {
    attemptedRunsRef.current.clear()
    setRun({ status: "idle", checked: 0, verified: 0 })
    void infoQuery.refetch()
    void conversationsQuery.refetch()
  }, [conversationsQuery, infoQuery])

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
      info,
      infoQuery.error,
      infoQuery.isFetching,
      nwc.connection,
      nwc.disconnect,
      nwc.error,
      nwc.setUri,
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
