import { useWallets } from "@conduit/core/hooks/useWallets"
import { getSparkWalletManager } from "@conduit/core/wallets/spark-sdk"
import { lookupAccountReceivingInvoice } from "@conduit/core/wallets/wallet-receiving"
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
  getProfilePaymentAddress,
  getAccountSigner,
  clearProtectedReadAuthenticationSuppression,
  getMerchantConversationList,
  nwcGetInfo,
  publishMerchantOrderMessage,
  useAuth,
  useProfile,
  type NwcGetInfoResult,
} from "@conduit/core"
import { reportCommerceGmvEstimate } from "@conduit/core/commerce-gmv"
import {
  getMerchantNwcAddressStatus,
  getMerchantPaymentVerificationCandidates,
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
  wallets: ReturnType<typeof useWallets>
  receivingWalletId: string | null
  run: VerificationRunState
  retry: () => void
}

function merchantConnectionKey(nwc: ReturnType<typeof useNwcConnection>) {
  return nwc.connection ? getNwcConnectionCacheKey(nwc.rawUri) : "none"
}

const MerchantPaymentAutomationContext =
  createContext<MerchantPaymentAutomationState | null>(null)

export function MerchantPaymentAutomationProvider({
  children,
}: {
  children: ReactNode
}) {
  const value = useMerchantPaymentAutomationState()
  return (
    <MerchantPaymentAutomationContext.Provider value={value}>
      {children}
    </MerchantPaymentAutomationContext.Provider>
  )
}

function useMerchantPaymentAutomationState(): MerchantPaymentAutomationState {
  const { pubkey, status, authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const queryClient = useQueryClient()
  const authenticatedPubkey = status === "connected" ? pubkey : null
  const profileQuery = useProfile(pubkey, {
    accountPubkey: authenticatedPubkey,
    authenticatedPubkey,
    shouldContinue: () => authGenerationRef.current === authGeneration,
  })
  const nwc = useNwcConnection()
  const wallets = useWallets({ enabled: status === "connected" })
  const receivingWallet =
    wallets.wallets.find((wallet) =>
      wallet.defaultIntents.includes("receive")
    ) ?? null
  const availableSparkWallets = wallets.portableWallets.filter((wallet) =>
    getSparkWalletManager()?.canVerifyReceiving(wallet.id)
  )

  const confirmedEvidenceRef = useRef(new Set<string>())
  const runningRef = useRef(false)
  const [run, setRun] = useState<VerificationRunState>({
    status: "idle",
    checked: 0,
    verified: 0,
  })
  const signerConnected = status === "connected" && !!pubkey
  const connectionKey = merchantConnectionKey(nwc)

  const migratedConnection = useRef<string | null>(null)
  useEffect(() => {
    if (
      !pubkey ||
      !nwc.rawUri ||
      wallets.loading ||
      migratedConnection.current === `${pubkey}:${connectionKey}`
    )
      return
    migratedConnection.current = `${pubkey}:${connectionKey}`
    void wallets.connectNwc(nwc.rawUri).catch(() => {
      /* Leave the existing connection usable; retry through Wallets. */
    })
  }, [pubkey, nwc.rawUri, wallets, connectionKey])

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
    profileLud16: getProfilePaymentAddress(profileQuery.profileContext),
    connectionLud16: nwc.connection?.lud16,
    walletLud16: info?.lud16,
  })
  const canCreateInvoices = info?.methods.includes("make_invoice") ?? false
  const canLookupInvoices = info?.methods.includes("lookup_invoice") ?? false
  const canVerifyPayments =
    canLookupInvoices ||
    availableSparkWallets.length > 0 ||
    Object.values(wallets.nwcSnapshots).some((snapshot) =>
      snapshot.info?.methods.includes("lookup_invoice")
    )

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
  const conversationReadUnavailable =
    !!conversationsQuery.error ||
    (conversationsQuery.data?.meta.degraded === true &&
      conversationsQuery.data.data.length === 0)

  useEffect(() => {
    confirmedEvidenceRef.current = new Set<string>()
    setRun({ status: "idle", checked: 0, verified: 0 })
  }, [pubkey, authGeneration])

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
    const initiatingSigner = getAccountSigner()
    if (
      !initiatingSigner ||
      initiatingSigner.pubkey !== pubkey ||
      !pubkey ||
      !signerConnected ||
      !canVerifyPayments ||
      conversationReadUnavailable ||
      runningRef.current
    ) {
      return
    }
    runningRef.current = true
    setRun({ status: "checking", checked: 0, verified: 0 })
    let checked = 0
    let verified = 0
    let localHistoryUnavailable = 0
    const confirmedEvidence = confirmedEvidenceRef.current

    const assertCurrentAuthority = () => {
      if (
        authGenerationRef.current !== authGeneration ||
        getAccountSigner() !== initiatingSigner
      )
        throw new Error("The connected account changed. Check payments again.")
    }

    try {
      const result = await verifyMerchantPaymentCandidates({
        candidates,
        confirmedEvidence,
        lookupInvoice: async (candidate) => {
          assertCurrentAuthority()
          const result = await lookupAccountReceivingInvoice({
            owner: pubkey,
            invoice: candidate.invoice,
            receivingWallet: candidate.receivingWallet,
            wallets: wallets.wallets,
            legacyConnection: connection,
          })
          assertCurrentAuthority()
          return result
        },
        publishConfirmation: async (candidate) => {
          assertCurrentAuthority()
          const delivery = await publishMerchantOrderMessage({
            merchantPubkey: pubkey,
            buyerPubkey: candidate.buyerPubkey,
            orderId: candidate.orderId,
            type: "status_update",
            tags: [["status", "paid"]],
            payload: { status: "paid" },
            delivery: candidate.delivery,
            signerInteraction: "background_external",
            authenticatedPubkey: signerConnected ? pubkey : null,
            shouldContinue: () =>
              authGenerationRef.current === authGeneration &&
              getAccountSigner() === initiatingSigner,
          })
          if (delivery.localHistory === "unavailable")
            localHistoryUnavailable += 1
          void reportCommerceGmvEstimate({
            orderId: candidate.orderId,
            orderCreatedAt: candidate.orderCreatedAt,
            invoicedAmountSats: candidate.expectedAmountMsats / 1_000,
          })
        },
      })
      checked = result.checked
      verified = result.verified
      if (authGenerationRef.current !== authGeneration) return

      const allLookupsFailed = result.lookupFailures > 0 && result.checked === 0
      setRun({
        status: allLookupsFailed ? "error" : "complete",
        checked,
        verified,
        ...(allLookupsFailed
          ? { message: "The wallet could not check pending invoices." }
          : localHistoryUnavailable > 0
            ? {
                message:
                  "Paid updates were sent, but some could not be saved on this device. Do not send them again.",
              }
            : {}),
      })
      if (verified > 0) {
        try {
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
        } catch {
          console.warn("Could not refresh accepted payment verification")
        }
      }
    } catch (error) {
      if (authGenerationRef.current !== authGeneration) return
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
    authGeneration,
    canVerifyPayments,
    candidates,
    conversationReadUnavailable,
    nwc.connection,
    wallets.wallets,
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
      wallets,
      receivingWalletId: receivingWallet?.id ?? null,
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
      receivingWallet?.id,
      wallets,
    ]
  )

  return value
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
