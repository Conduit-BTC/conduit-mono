import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  createMerchantCheckoutSparkRecoveryDiscovery,
  DexieCheckoutSparkSettledRepository,
  hasCheckoutSparkProviderSendWindow,
  startMerchantCheckoutSparkReconciliation,
  type CheckoutSparkMerchantSettlementProjection,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryDiscoveryResult,
  type MerchantCheckoutSparkReconciliationSummary,
  type MerchantCheckoutSparkReconciliationStatus,
} from "@conduit/core"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@conduit/ui"
import { CheckoutSparkMerchantPayoutReview } from "./CheckoutSparkMerchantPayoutReview"
import { CheckoutSparkMerchantPaymentCard } from "./CheckoutSparkMerchantPaymentCard"
import { readMerchantCheckoutSparkVerification } from "../lib/checkout-spark-merchant-verification"
import {
  advanceMerchantCheckoutSparkOrder,
  reconcileMerchantCheckoutSparkOrder,
} from "../lib/checkout-spark-order-reconciliation"
import {
  startMerchantCheckoutSparkDiscovery,
  type MerchantCheckoutDiscoveryStatus,
} from "../lib/checkout-spark-discovery-controller"
import {
  captureMerchantCheckoutSparkRecoveryAction,
  createMerchantCheckoutSparkAutomaticSession,
} from "../lib/checkout-spark-automatic-session"
import { createMerchantCheckoutSparkPayoutReviewSelection } from "../lib/checkout-spark-payout-review-selection"
import {
  continueMerchantCheckoutSparkNativeTreasury,
  continueMerchantCheckoutSparkSettledPayout,
  reviewMerchantCheckoutSparkSettledPayout,
  type MerchantCheckoutSparkPayoutReview,
} from "../lib/checkout-spark-settled-continuation"
import {
  prepareNextMerchantCheckoutSparkSettledPayout,
  type MerchantCheckoutSparkPreparationResult,
} from "../lib/checkout-spark-settled-leg-preparation"

import {
  importMerchantCheckoutSparkSettledRecovery,
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  merchantCheckoutRecoveryPrincipalKey,
  reconcileMerchantCheckoutSparkSettledCredit,
  verifyMerchantCheckoutSparkSettledRecoveryKey,
} from "../lib/checkout-spark-settled-recovery"

interface CheckoutSparkRecoveryPanelProps {
  principalPubkey: string
  selectedOrderId?: string | null
  /** Independently order-bound durable facts; discovery is not payment truth. */
  selectedOrderSettlement?: {
    orderId: string
    projection: CheckoutSparkMerchantSettlementProjection
  } | null
  /** Local display reads only; these flags grant no recovery authority. */
  settlementRefreshing?: boolean
  settlementReadUnavailable?: boolean
  /** Keep workers mounted while the selected order card changes. */
  container?: HTMLElement | null
  onSettlementChange?: () => void
  /** Availability only; default activation remains a separate route policy. */
  allowAutomaticPayouts?: boolean
  startAutomatically?: boolean
  isSessionCurrent: () => boolean
}

const PREPARATION_NOTICES: Record<
  NonNullable<MerchantCheckoutSparkPreparationResult["preparation"]>["status"],
  string
> = {
  prepared:
    "Payout invoice prepared and its recovery message accepted by your inbox relay. No payout was sent. Refreshing signed recovery data; review the payout separately when it appears.",
  existing_intent:
    "The existing payout invoice was kept unchanged and its recovery message accepted by your inbox relay. No new invoice or payout was created. Refreshing signed recovery data before a separate review.",
  recovery_pending:
    "Recovery-message delivery is incomplete. No payout was sent. Retry preparation to retain the same saved intent; do not assume a recovery copy reached your inbox yet.",
  funding_wait:
    "Exact funding credit is not confirmed yet. No payout invoice was prepared or sent.",
  history_wait:
    "Exact payout history is unresolved. No new invoice or payout was created; inspect history before trying again.",
  allocation_unavailable:
    "This allocation cannot currently support a payout invoice and its fees. No payout was sent.",
  prerequisite_unpaid:
    "An earlier payout still needs attention. No later payout was prepared or sent.",
}

/** Keep private rows inside an account-keyed instance, even if callers reuse it. */
export function CheckoutSparkRecoveryPanel({
  principalPubkey,
  selectedOrderId,
  selectedOrderSettlement,
  settlementRefreshing = false,
  settlementReadUnavailable = false,
  container,
  onSettlementChange,
  allowAutomaticPayouts = false,
  startAutomatically = false,
  isSessionCurrent,
}: CheckoutSparkRecoveryPanelProps) {
  return (
    <CheckoutSparkRecoveryPanelForPrincipal
      key={merchantCheckoutRecoveryPrincipalKey(principalPubkey)}
      principalPubkey={principalPubkey}
      selectedOrderId={selectedOrderId}
      selectedOrderSettlement={selectedOrderSettlement}
      settlementRefreshing={settlementRefreshing}
      settlementReadUnavailable={settlementReadUnavailable}
      container={container}
      onSettlementChange={onSettlementChange}
      allowAutomaticPayouts={allowAutomaticPayouts}
      startAutomatically={startAutomatically}
      isSessionCurrent={isSessionCurrent}
    />
  )
}

/** Account-scoped recovery; automatic dispatch still requires the frozen plan authority. */
function CheckoutSparkRecoveryPanelForPrincipal({
  principalPubkey,
  selectedOrderId,
  selectedOrderSettlement,
  settlementRefreshing = false,
  settlementReadUnavailable = false,
  container,
  onSettlementChange,
  allowAutomaticPayouts = false,
  startAutomatically = false,
  isSessionCurrent,
}: CheckoutSparkRecoveryPanelProps) {
  const sessionCurrent = useRef(isSessionCurrent)
  sessionCurrent.current = isSessionCurrent
  const automaticAllowed = useRef(allowAutomaticPayouts)
  automaticAllowed.current = allowAutomaticPayouts
  const hasCurrentSession = useCallback(() => {
    try {
      return sessionCurrent.current()
    } catch {
      return false
    }
  }, [])
  const settlementChanged = useRef(onSettlementChange)
  settlementChanged.current = onSettlementChange
  const generation = useRef(0)
  const discoveryGeneration = useRef(0)
  const discoveryController = useRef<ReturnType<
    typeof startMerchantCheckoutSparkDiscovery
  > | null>(null)
  const reconciliationController = useRef<ReturnType<
    typeof startMerchantCheckoutSparkReconciliation
  > | null>(null)
  const discoveryDrain = useRef<Promise<void>>(Promise.resolve())
  const stopDiscovery = useCallback(() => {
    discoveryGeneration.current += 1
    const current = discoveryController.current
    discoveryController.current = null
    const provider = reconciliationController.current
    reconciliationController.current = null
    discoveryDrain.current = Promise.all([
      discoveryDrain.current,
      current?.stopAndDrain(),
      provider?.stopAndDrain(),
    ]).then(() => undefined)
    return discoveryDrain.current
  }, [])
  const [automaticSession] = useState(() =>
    createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => automaticAllowed.current && hasCurrentSession(),
      stopAndDrain: stopDiscovery,
    })
  )
  const [automaticPayouts, setAutomaticPayouts] = useState(false)
  const [automaticTransition, setAutomaticTransition] = useState<
    "starting" | "pausing" | null
  >(null)
  const automaticTransitionRef = useRef<typeof automaticTransition>(null)
  const [result, setResult] =
    useState<MerchantCheckoutSparkRecoveryDiscoveryResult | null>(null)
  const [busy, setBusyState] = useState(false)
  const busyRef = useRef(false)
  const setBusy = (next: boolean) => {
    busyRef.current = next
    setBusyState(next)
  }
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeOrderId, setNoticeOrderId] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<
    Record<string, MerchantCheckoutSparkReconciliationStatus>
  >({})
  const [checkingDigest, setCheckingDigest] = useState<string | null>(null)
  const [displayNowMs, setDisplayNowMs] = useState(Date.now)
  const [discoveryStatus, setDiscoveryStatus] =
    useState<MerchantCheckoutDiscoveryStatus>("checking")
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0)
  const [reconciliation, setReconciliation] =
    useState<MerchantCheckoutSparkReconciliationSummary | null>(null)
  const [verified, setVerified] = useState<
    Record<string, CheckoutSparkMerchantSettlementProjection>
  >({})
  const [verificationReadUnavailable, setVerificationReadUnavailable] =
    useState(false)
  const [confirmation, setConfirmation] = useState<{
    candidate: MerchantCheckoutSparkRecoveryCandidate
    review: MerchantCheckoutSparkPayoutReview
    isSelectionCurrent: () => boolean
  } | null>(null)
  const [reviewSelection] = useState(
    createMerchantCheckoutSparkPayoutReviewSelection
  )
  const reviewSelectionRevision = reviewSelection.select(
    selectedOrderId ?? null
  )
  const confirmationSelectionCurrent =
    confirmation?.isSelectionCurrent() === true
  const [confirmationNowMs, setConfirmationNowMs] = useState(Date.now)
  const confirmationHasTime =
    confirmation !== null &&
    hasCheckoutSparkProviderSendWindow({
      paymentRequest: confirmation.review.intent.paymentRequest,
      nowMs: confirmationNowMs,
    })
  const settledCandidates =
    result?.candidates.filter((candidate) => candidate.schemaVersion !== 1) ??
    []
  const orderCandidates = settledCandidates.filter(
    (candidate) => candidate.orderId === selectedOrderId
  )
  // Never choose one conflicting recovery plan arbitrarily for an order.
  const candidate = orderCandidates.length === 1 ? orderCandidates[0] : null
  const manualControlsDisabled =
    busy || automaticTransition !== null || !hasCurrentSession()

  useEffect(
    () => () => {
      generation.current += 1
      automaticTransitionRef.current = null
      automaticSession.revoke()
    },
    [automaticSession]
  )

  useEffect(() => {
    const timer = window.setInterval(() => setDisplayNowMs(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (confirmation && !confirmation.isSelectionCurrent()) {
      setConfirmation(null)
    }
  }, [confirmation, reviewSelectionRevision])

  useEffect(() => {
    if (!confirmation) return
    const timer = window.setInterval(
      () => setConfirmationNowMs(Date.now()),
      1_000
    )
    return () => window.clearInterval(timer)
  }, [confirmation])

  useEffect(() => {
    // Stop both workers before an explicit recovery action or payout review.
    // In-flight SDK calls can claim inbound funds and must drain through cleanup.
    if (busy || confirmation || automaticTransition) return
    const current = ++discoveryGeneration.current
    const actionGeneration = generation.current
    let verificationRead = 0
    let controller: ReturnType<
      typeof startMerchantCheckoutSparkDiscovery
    > | null = null
    let provider: ReturnType<
      typeof startMerchantCheckoutSparkReconciliation
    > | null = null
    let closed = false
    const isCurrent = () =>
      !closed &&
      hasCurrentSession() &&
      discoveryGeneration.current === current &&
      generation.current === actionGeneration
    const assertAutomaticCurrent = automaticSession.capture()
    const refreshSaved = async (
      candidates: readonly MerchantCheckoutSparkRecoveryCandidate[]
    ) => {
      const read = ++verificationRead
      try {
        const saved = await readMerchantCheckoutSparkVerification(
          principalPubkey,
          candidates
        )
        if (!isCurrent() || verificationRead !== read) return
        setVerified((previous) => ({ ...previous, ...saved.verified }))
        setVerificationReadUnavailable(saved.unavailable)
      } catch {
        if (isCurrent() && verificationRead === read) {
          setVerificationReadUnavailable(true)
        }
      }
    }
    void discoveryDrain.current
      .then(() => {
        if (!isCurrent()) return
        const repository = new DexieCheckoutSparkSettledRepository()
        provider = startMerchantCheckoutSparkReconciliation({
          active: document.visibilityState !== "hidden",
          async reconcile(candidate, assertWorkerCurrent) {
            const assertActive = () => {
              assertWorkerCurrent()
              if (automaticPayouts) assertAutomaticCurrent()
              if (!isCurrent() || document.visibilityState === "hidden") {
                throw new Error("Merchant reconciliation session changed.")
              }
            }
            const assertNotificationActive = () => {
              if (!isCurrent() || document.visibilityState === "hidden") {
                throw new Error("Merchant notification session changed.")
              }
            }
            if (isCurrent()) setCheckingDigest(candidate.planDigest)
            try {
              let outcome: MerchantCheckoutSparkReconciliationStatus
              if (automaticPayouts) {
                outcome = await advanceMerchantCheckoutSparkOrder(
                  principalPubkey,
                  candidate,
                  assertActive,
                  {
                    repository,
                    assertNotificationActive,
                    requestRescan: () => {
                      assertActive()
                      controller?.requestRescan()
                    },
                  }
                )
              } else {
                outcome = await reconcileMerchantCheckoutSparkOrder(
                  principalPubkey,
                  candidate,
                  assertActive,
                  { repository, assertNotificationActive }
                )
              }
              if (isCurrent()) {
                setOutcomes((previous) => ({
                  ...previous,
                  [candidate.planDigest]: outcome,
                }))
              }
              return outcome
            } catch (error) {
              if (isCurrent()) {
                setOutcomes((previous) => ({
                  ...previous,
                  [candidate.planDigest]: "unavailable",
                }))
              }
              throw error
            } finally {
              // A later read may fail after a positive provider fact was saved.
              // Refresh that fact, without changing the outcome into unpaid.
              if (isCurrent() && document.visibilityState !== "hidden") {
                setCheckingDigest(null)
                settlementChanged.current?.()
                await refreshSaved([candidate])
              }
            }
          },
          onUpdate(summary) {
            if (isCurrent()) setReconciliation(summary)
          },
        })
        reconciliationController.current = provider
        controller = startMerchantCheckoutSparkDiscovery({
          principalPubkey,
          createSession: (principal, options) =>
            createMerchantCheckoutSparkRecoveryDiscovery(principal, {
              ...options,
              async onOrderRecovery({
                state,
                witness,
                sourceEvents,
                assertCurrent,
              }) {
                const assertSaveCurrent = () => {
                  assertCurrent()
                  if (!isCurrent()) {
                    throw new Error("Recovery discovery session changed.")
                  }
                }
                assertSaveCurrent()
                // Import only signed state and a minimal authenticated order
                // witness. This does not initialize a wallet or prove payment.
                const imported = await repository.importMerchantOrderRecovery(
                  state,
                  witness,
                  assertSaveCurrent
                )
                assertSaveCurrent()
                if (imported.status === "active") {
                  await repository.recordMerchantPlanSources(
                    state.plan,
                    sourceEvents,
                    assertSaveCurrent
                  )
                  assertSaveCurrent()
                }
                settlementChanged.current?.()
              },
            }),
          active: document.visibilityState !== "hidden",
          onStatus: (status) => {
            if (isCurrent()) setDiscoveryStatus(status)
          },
          onPage(page) {
            if (!isCurrent()) return
            setResult(page)
            // A late discovery page may finish while hidden. The separate worker
            // rechecks visibility at dispatch and every provider boundary.
            provider?.replaceCandidates(page.candidates)
            void refreshSaved(page.candidates)
          },
        })
        discoveryController.current = controller
      })
      .catch(() => {
        if (isCurrent()) setDiscoveryStatus("unavailable")
      })
    const visibilityChanged = () => {
      const active = document.visibilityState !== "hidden"
      provider?.setActive(active)
      controller?.setActive(active)
    }
    document.addEventListener("visibilitychange", visibilityChanged)
    return () => {
      closed = true
      void stopDiscovery().catch(() => undefined)
      document.removeEventListener("visibilitychange", visibilityChanged)
    }
  }, [
    principalPubkey,
    automaticPayouts,
    automaticTransition,
    automaticSession,
    hasCurrentSession,
    busy,
    confirmation,
    discoveryRefresh,
    stopDiscovery,
  ])

  async function changeAutomaticPayouts(next: boolean): Promise<void> {
    if (busyRef.current || confirmation) return
    if (
      next &&
      (!allowAutomaticPayouts ||
        !hasCurrentSession() ||
        document.visibilityState === "hidden" ||
        automaticTransitionRef.current !== null)
    )
      return
    const current = ++generation.current
    automaticTransitionRef.current = next ? "starting" : "pausing"
    setAutomaticTransition(automaticTransitionRef.current)
    setAutomaticPayouts(false)
    setNotice(null)
    setNoticeOrderId(selectedOrderId ?? null)
    try {
      // change() revokes synchronously and drains before granting the new mode.
      const enabled = await automaticSession.change(next)
      if (generation.current !== current || !hasCurrentSession()) return
      setAutomaticPayouts(enabled)
      setNotice(
        enabled
          ? "Payment processing has resumed. Keep Orders open; unresolved payouts remain held until verified."
          : "Payment processing is paused. A payment already sent may still finish."
      )
    } catch {
      if (generation.current !== current || !hasCurrentSession()) return
      setNotice(
        "Automatic recovery could not finish draining. No new automatic payout is authorized; leave this page and inspect exact history before trying again."
      )
    } finally {
      if (generation.current === current && hasCurrentSession()) {
        automaticTransitionRef.current = null
        setAutomaticTransition(null)
      }
    }
  }

  const changeAutomaticMode = useRef(changeAutomaticPayouts)
  changeAutomaticMode.current = changeAutomaticPayouts
  useEffect(() => {
    if (!startAutomatically || !allowAutomaticPayouts) return
    let requested = false
    const startWhenVisible = () => {
      if (
        requested ||
        document.visibilityState === "hidden" ||
        !hasCurrentSession()
      )
        return
      requested = true
      // Use the same revoke/drain boundary as an explicit Start. A manual
      // action or Pause does not retrigger this mount-scoped activation.
      void changeAutomaticMode.current(true)
    }
    startWhenVisible()
    document.addEventListener("visibilitychange", startWhenVisible)
    return () =>
      document.removeEventListener("visibilitychange", startWhenVisible)
  }, [startAutomatically, allowAutomaticPayouts, hasCurrentSession])

  function beginManualAction(orderId: string) {
    if (
      busyRef.current ||
      automaticTransitionRef.current !== null ||
      !hasCurrentSession()
    )
      return null
    generation.current += 1
    setNoticeOrderId(orderId)
    automaticSession.revoke()
    setAutomaticPayouts(false)
    setBusy(true)
    // Revoke before React renders; each action also awaits this same drain.
    void stopDiscovery().catch(() => undefined)
    return captureMerchantCheckoutSparkRecoveryAction({
      generation: () => generation.current,
      isCurrent: hasCurrentSession,
    })
  }

  async function refreshVerifiedStatus(
    candidates: readonly MerchantCheckoutSparkRecoveryCandidate[],
    current: ReturnType<typeof captureMerchantCheckoutSparkRecoveryAction>
  ) {
    if (!current.isCurrent()) return
    settlementChanged.current?.()
    try {
      const saved = await readMerchantCheckoutSparkVerification(
        principalPubkey,
        candidates
      )
      if (!current.isCurrent()) return
      setVerified((previous) => ({ ...previous, ...saved.verified }))
      setVerificationReadUnavailable(saved.unavailable)
    } catch {
      // A local read failure must neither erase verified payment evidence nor
      // turn a successfully completed provider action into a retry prompt.
      if (current.isCurrent()) setVerificationReadUnavailable(true)
    }
  }

  function inspect(): void {
    if (
      busyRef.current ||
      automaticTransitionRef.current !== null ||
      !hasCurrentSession()
    )
      return
    void stopDiscovery().catch(() => undefined)
    setNotice(null)
    setConfirmation(null)
    setDiscoveryRefresh((previous) => previous + 1)
  }

  async function importCandidate(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy) return
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const imported = await importMerchantCheckoutSparkSettledRecovery(
        principalPubkey,
        candidate
      )
      if (!current.isCurrent()) return
      if (imported.status === "consumed") {
        setNotice(
          "Recovery state saved on this device. This import did not move funds."
        )
      } else {
        setResult(null)
        setNotice(
          imported.status === "incomplete"
            ? "Inbox evidence changed or became incomplete. Retry inspection."
            : "That recovery was not found on a fresh read. Retry inspection."
        )
      }
    } catch {
      if (!current.isCurrent()) return
      setResult(null)
      setNotice("Recovery import could not finish. No payout was attempted.")
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function verifyCandidate(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy) return
    if (Date.now() < candidate.takeoverAt) {
      setNoticeOrderId(candidate.orderId)
      setNotice(
        "Recovery access can be checked after the shopper handoff time."
      )
      return
    }
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const verified = await verifyMerchantCheckoutSparkSettledRecoveryKey(
        principalPubkey,
        candidate
      )
      if (!current.isCurrent()) return
      if (verified.status === "consumed") {
        setNotice(
          "Recovery access confirmed for this order. Automatic payments are paused. This check did not inspect funds or recipient payments, reveal the recovery phrase, or move money."
        )
      } else {
        setResult(null)
        setNotice(
          verified.status === "incomplete"
            ? "Inbox evidence changed or became incomplete. Retry inspection."
            : "That recovery was not found on a fresh read. Retry inspection."
        )
      }
    } catch {
      if (!current.isCurrent()) return
      setResult(null)
      setNotice(
        "Recovery access could not be confirmed. No payout was attempted."
      )
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function checkCredit(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy) return
    if (Date.now() < candidate.takeoverAt) {
      setNoticeOrderId(candidate.orderId)
      setNotice("Credit recovery is available after the shopper handoff time.")
      return
    }
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const recovered = await reconcileMerchantCheckoutSparkSettledCredit(
        principalPubkey,
        candidate,
        { assertActive: current.assertCurrent }
      )
      if (!current.isCurrent()) return
      if (recovered.status !== "consumed") {
        setResult(null)
        setNotice(
          recovered.status === "incomplete"
            ? "Inbox evidence changed or became incomplete. Retry inspection."
            : "That recovery was not found on a fresh read. Retry inspection."
        )
      } else if (recovered.creditStatus === "recorded") {
        await refreshVerifiedStatus([candidate], current)
        if (!current.isCurrent()) return
        setNotice(
          "Exact Spark funding credit is recorded locally. No payout was sent."
        )
      } else {
        setNotice(
          "Exact Spark funding credit is not confirmed yet. No payout was sent."
        )
      }
    } catch {
      if (!current.isCurrent()) return
      setResult(null)
      setNotice(
        "Credit check could not finish. Opening Spark may have claimed inbound funds; no payout was attempted."
      )
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function inspectPayoutHistory(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy) return
    if (Date.now() < candidate.takeoverAt) {
      setNoticeOrderId(candidate.orderId)
      setNotice("Payout history is available after the shopper handoff time.")
      return
    }
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const inspected = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        principalPubkey,
        candidate,
        { assertActive: current.assertCurrent }
      )
      if (!current.isCurrent()) return
      await refreshVerifiedStatus([candidate], current)
      if (!current.isCurrent()) return
      if (inspected.status !== "consumed") {
        setResult(null)
        setNotice(
          inspected.status === "incomplete"
            ? "Inbox evidence changed or became incomplete. Retry inspection."
            : "That recovery was not found on a fresh read. Retry inspection."
        )
      } else if (inspected.payoutHistory?.status === "credit_needed") {
        setNotice(
          "Exact funding credit is not saved yet. Check credit first; no payout was sent."
        )
      } else if (inspected.payoutHistory?.status === "no_intents") {
        setNotice(
          "No unpaid frozen payout invoice is saved for this order. No payout was sent."
        )
      } else if (inspected.payoutHistory?.status === "inspected") {
        const history = inspected.payoutHistory
        setNotice(
          `Checked ${history.checkedLegs} exact payout transfer${history.checkedLegs === 1 ? "" : "s"}: ${history.newlyConfirmedLegs} newly confirmed, ${history.unresolvedLegs} unresolved. ${history.withoutIntentLegs} leg${history.withoutIntentLegs === 1 ? "" : "s"} still lack a frozen invoice. No payout was sent by this check.`
        )
      }
    } catch {
      if (!current.isCurrent()) return
      setResult(null)
      setNotice(
        "Payout history check could not finish. Opening Spark may have claimed inbound funds; no payout was attempted."
      )
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function preparePayout(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy || confirmation) return
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      const prepared = await prepareNextMerchantCheckoutSparkSettledPayout(
        principalPubkey,
        candidate,
        {
          stopAndDrain: stopDiscovery,
          shouldContinue: current.isCurrent,
        }
      )
      if (!current.isCurrent()) return
      if (prepared.status === "save_required") {
        setNotice(
          "Save this recovery state on this device first. No payout invoice was created."
        )
      } else if (prepared.status === "retired") {
        setNotice("This checkout wallet is retired. No payout was prepared.")
      } else if (prepared.status === "handoff_wait") {
        setNotice(
          "Payout preparation is available after the shopper handoff time."
        )
      } else if (prepared.status === "no_unpaid_leg") {
        setNotice(
          "Every payout has saved paid progress. Inspect exact payout history to verify it; no new payout was prepared."
        )
      } else if (prepared.status === "attempted") {
        const recovered = prepared.recovery
        if (recovered.status !== "consumed" || !recovered.preparation) {
          setResult(null)
          setNotice(
            "Fresh recovery evidence is missing, incomplete, or changed. Check recoveries again; no payout was sent."
          )
        } else {
          const status = recovered.preparation.status
          setNotice(PREPARATION_NOTICES[status])
          if (status === "prepared" || status === "existing_intent") {
            // The old candidate may point only to the buyer snapshot. Require
            // normal fresh discovery to select the new Merchant self-wrap;
            // never manufacture a pointer or auto-confirm a local-only intent.
            setResult(null)
            setDiscoveryRefresh((previous) => previous + 1)
          }
        }
      }
    } catch {
      if (!current.isCurrent()) return
      setNotice(
        "Preparation could not finish. Spark may have claimed incoming funds, and an invoice may already be saved. No payout was sent; check recovery and exact history before retrying."
      )
    } finally {
      if (current.isCurrent()) {
        // Preparation may have saved positive provider facts before a later
        // delivery failure. Keep them visible without manufacturing success.
        await refreshVerifiedStatus([candidate], current)
        if (current.isCurrent()) setBusy(false)
      }
    }
  }

  async function finalizeNativeTreasury(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<void> {
    if (busy || confirmation) return
    if (Date.now() < candidate.takeoverAt) {
      setNoticeOrderId(candidate.orderId)
      setNotice(
        "Conduit payment finalization is available after the shopper handoff time."
      )
      return
    }
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const continued = await continueMerchantCheckoutSparkNativeTreasury(
        principalPubkey,
        candidate,
        { shouldContinue: current.isCurrent }
      )
      if (!current.isCurrent()) return
      await refreshVerifiedStatus([candidate], current)
      if (!current.isCurrent()) return
      if (continued.status !== "consumed") {
        setNotice(
          "Fresh recovery evidence is incomplete or changed. Check recoveries again; no Conduit payment was attempted."
        )
      } else if (
        continued.payout?.outcome === "paid" ||
        continued.payout?.outcome === "already_paid"
      ) {
        setNotice(
          "Spark confirms the exact native Conduit payment. Recipient payments and delivery confirmation remain separate."
        )
      } else if (continued.payout?.reason === "zero_remainder") {
        setNotice(
          "No approved checkout credit remains for the final Conduit payment. No payment was sent; this checkout needs manual attention."
        )
      } else if (continued.payout?.reason === "prerequisite_unpaid") {
        setNotice(
          "Recipient payments must be verified first. No Conduit payment was sent."
        )
      } else {
        setNotice(
          "The native Conduit payment is still unresolved. Inspect exact payout history before another attempt."
        )
      }
      setDiscoveryRefresh((previous) => previous + 1)
    } catch {
      if (!current.isCurrent()) return
      setNotice(
        "Native Conduit finalization could not finish. Funds may have moved; inspect exact payout history before trying again."
      )
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function reviewPayout(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ) {
    if (busy) return
    const isSelectionCurrent = reviewSelection.capture(candidate.orderId)
    if (!isSelectionCurrent()) return
    if (Date.now() < candidate.takeoverAt) {
      setNoticeOrderId(candidate.orderId)
      setNotice(
        "Payout continuation is available after the shopper handoff time."
      )
      return
    }
    const current = beginManualAction(candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        principalPubkey,
        candidate
      )
      if (!current.isCurrent() || !isSelectionCurrent()) return
      if (!review) {
        setNotice(
          "No saved unpaid payout invoice is available. Inspect exact history, then prepare the next payout if needed. No payout was sent."
        )
      } else {
        setConfirmationNowMs(Date.now())
        setConfirmation({ candidate, review, isSelectionCurrent })
      }
    } catch {
      if (!current.isCurrent()) return
      setNotice(
        "Save this recovery state first, then review its saved payout. No payout was sent."
      )
    } finally {
      if (current.isCurrent()) setBusy(false)
    }
  }

  async function confirmPayout() {
    if (!confirmation || busy) return
    if (!confirmation.isSelectionCurrent()) {
      setConfirmation(null)
      return
    }
    const reviewed = confirmation
    // A suspended tab can show a stale countdown. Recheck before any async work.
    const clickedAt = Date.now()
    setConfirmationNowMs(clickedAt)
    if (
      !hasCheckoutSparkProviderSendWindow({
        paymentRequest: reviewed.review.intent.paymentRequest,
        nowMs: clickedAt,
      })
    ) {
      setNotice(
        "The saved payout invoice has too little time remaining. Recovery is still saved; inspect exact payout history separately."
      )
      return
    }
    const current = beginManualAction(reviewed.candidate.orderId)
    if (current === null) return
    setNotice(null)
    try {
      await stopDiscovery()
      if (!current.isCurrent()) return
      const continued = await continueMerchantCheckoutSparkSettledPayout(
        principalPubkey,
        reviewed.candidate,
        reviewed.review,
        {
          shouldContinue: current.isCurrent,
        }
      )
      if (!current.isCurrent()) return
      await refreshVerifiedStatus([reviewed.candidate], current)
      if (!current.isCurrent()) return
      if (continued.status !== "consumed") {
        setNotice(
          "Fresh recovery evidence is incomplete or changed. Check recoveries again; no payout was attempted."
        )
      } else if (
        continued.payout?.outcome === "paid" ||
        continued.payout?.outcome === "already_paid"
      ) {
        setNotice(
          "Spark confirms payment of this exact invoice. Recipient verification is shown separately. Review the next saved payout separately."
        )
      } else if (continued.payout?.reason === "invoice_window_insufficient") {
        setNotice(
          "The saved payout invoice has too little time remaining. It was not replaced or sent; recovery remains saved."
        )
      } else if (continued.payout?.reason === "recipient_unverified") {
        setNotice(
          "The recipient for this saved payment could not be verified. No new payment was sent and its invoice was not replaced. Check the saved payment details before continuing."
        )
      } else {
        setNotice(
          "This payout is still unresolved. Check exact payout history before another attempt; the saved payment ID has not changed."
        )
      }
    } catch {
      if (!current.isCurrent()) return
      setNotice(
        "Continuation could not finish. Funds may have moved; inspect exact payout history before trying again."
      )
    } finally {
      if (current.isCurrent()) {
        setBusy(false)
        setConfirmation(null)
      }
    }
  }

  if (!selectedOrderId || container === null) return null

  const candidateProjection = candidate
    ? (verified[candidate.planDigest] ?? null)
    : null
  const orderProjection =
    selectedOrderSettlement?.orderId === selectedOrderId
      ? selectedOrderSettlement.projection
      : null
  // Both inputs are provider-attested projections. A temporary discovery gap or
  // slower route refresh must not erase an already verified order payment.
  const projection = candidateProjection?.commerceVerified
    ? candidateProjection
    : (orderProjection ?? candidateProjection)
  const recoveryLookupIncomplete =
    !candidate &&
    orderCandidates.length === 0 &&
    (discoveryStatus === "finished" ||
      discoveryStatus === "unavailable" ||
      discoveryStatus === "paused")
  const outcome =
    orderCandidates.length > 1
      ? "needs_attention"
      : candidate
        ? outcomes[candidate.planDigest]
        : discoveryStatus === "unavailable"
          ? "unavailable"
          : undefined
  const card = (
    <>
      <CheckoutSparkMerchantPaymentCard
        projection={projection}
        outcome={outcome}
        recoveryLookupIncomplete={recoveryLookupIncomplete}
        settlementRefreshing={settlementRefreshing}
        settlementReadUnavailable={settlementReadUnavailable}
        checking={
          candidate
            ? checkingDigest === candidate.planDigest
            : discoveryStatus === "checking"
        }
        paused={!automaticPayouts && automaticTransition !== "starting"}
        canContinue={allowAutomaticPayouts}
        transitioning={busy || automaticTransition !== null}
        handoffAt={candidate?.takeoverAt ?? 0}
        nowMs={displayNowMs}
        notice={noticeOrderId === selectedOrderId ? notice : null}
        onRetry={inspect}
        onPause={() => void changeAutomaticPayouts(false)}
        onContinue={() => void changeAutomaticPayouts(true)}
      >
        {candidate && (
          <>
            <p>
              Saved recovery stays attached to this order. Check the original
              payment before continuing. Manual actions pause automatic
              payments. Opening the wallet may claim pending inbound funds.
              Balance and history checks do not create invoices or send payouts.
            </p>
            {verificationReadUnavailable && (
              <p>
                Saved verification could not be refreshed. Previous verified
                results remain saved.
              </p>
            )}
            {(result?.orderBindingFailureCount ?? 0) > 0 && (
              <p>
                Some order history could not be saved. Check again when your
                inbox is available.
              </p>
            )}
            {reconciliation?.capacityReached && (
              <p>Some older orders are still waiting to be checked.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled}
                onClick={() => void importCandidate(candidate)}
              >
                Save recovery state
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled}
                onClick={() => void verifyCandidate(candidate)}
              >
                Check recovery access
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled}
                onClick={() => void checkCredit(candidate)}
              >
                Check received payment
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled}
                onClick={() => void inspectPayoutHistory(candidate)}
              >
                Inspect exact payout history
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled || confirmation !== null}
                onClick={() => void finalizeNativeTreasury(candidate)}
              >
                Finalize Conduit payment
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled || confirmation !== null}
                onClick={() => void preparePayout(candidate)}
              >
                Prepare next payout
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={manualControlsDisabled}
                onClick={() => void reviewPayout(candidate)}
              >
                Review saved payout
              </Button>
            </div>
          </>
        )}
      </CheckoutSparkMerchantPaymentCard>
      <Dialog
        open={confirmationSelectionCurrent}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Continue saved checkout payout?</DialogTitle>
          </DialogHeader>
          {confirmation && (
            <CheckoutSparkMerchantPayoutReview
              review={confirmation.review}
              nowMs={confirmationNowMs}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                busy || !confirmationHasTime || !confirmationSelectionCurrent
              }
              onClick={() => void confirmPayout()}
            >
              {busy ? "Checking and continuing…" : "Confirm payout"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
  return container ? createPortal(card, container) : card
}
