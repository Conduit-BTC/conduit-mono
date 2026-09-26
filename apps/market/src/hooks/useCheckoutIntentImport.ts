import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useNavigate } from "@tanstack/react-router"
import { pubkeyToNpub, useAuth, useConduitSession } from "@conduit/core"
import { useCart } from "./useCart"
import {
  prepareCheckoutIntent,
  type CheckoutImportError,
  type CheckoutImportPreparation,
} from "../lib/checkout-intent-import"
import {
  clearStagedCheckoutIntent,
  getStagedCheckoutIntent,
  recordCheckoutHandoffStage,
} from "../lib/checkout-intent-stage"
import { getCartRepositorySnapshot } from "../lib/cart-repository"
import {
  bindCheckoutReferral,
  clearCheckoutReferral,
} from "../lib/checkout-referral"

export type CheckoutIntentGateState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "error"
      error:
        | CheckoutImportError
        | "invalid_intent"
        | "unsupported_version"
        | "cart_changed"
        | "navigation_failed"
        | "session_changed"
        | "storage_unavailable"
    }
  | {
      status: "conflict"
      prepared: Extract<CheckoutImportPreparation, { status: "ready" }>
    }

export function useCheckoutIntentImport() {
  const [stage, setStage] = useState(getStagedCheckoutIntent)
  const [state, setState] = useState<CheckoutIntentGateState>(
    stage ? { status: "loading" } : { status: "idle" }
  )
  const started = useRef<string | null>(null)
  const { hydrated, installCheckoutIntentPurchase } = useCart()
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const navigate = useNavigate()

  const finish = useCallback(
    async (merchantPubkey: string, purchaseId: string) => {
      if (stage?.result.status === "valid")
        bindCheckoutReferral(stage.result.intent, merchantPubkey, purchaseId)
      try {
        await navigate({
          to: "/checkout",
          search: {
            merchant: pubkeyToNpub(merchantPubkey),
            purchase: purchaseId,
          },
          replace: true,
        })
        if (stage) recordCheckoutHandoffStage(stage, "checkout_ready")
        clearStagedCheckoutIntent()
        setStage(null)
        setState({ status: "idle" })
      } catch {
        clearCheckoutReferral()
        setState({ status: "error", error: "navigation_failed" })
      }
    },
    [navigate, stage]
  )

  const attempt = useCallback(async () => {
    if (!stage || !hydrated) return
    if (stage.result.status === "invalid") {
      setState({ status: "error", error: stage.result.error })
      return
    }
    setState({ status: "loading" })
    const expectedRevision = getCartRepositorySnapshot().revision
    const startedAuthGeneration = authGenerationRef.current
    const shouldContinue = () =>
      authGenerationRef.current === startedAuthGeneration &&
      getStagedCheckoutIntent()?.id === stage.id
    const prepared = await prepareCheckoutIntent(stage.result.intent, {
      authenticatedPubkey: session.mode === "signed_in" ? session.pubkey : null,
      shouldContinue,
    })
    if (!shouldContinue()) {
      if (getStagedCheckoutIntent()?.id === stage.id)
        setState({ status: "error", error: "session_changed" })
      return
    }
    if (prepared.status === "error") {
      recordCheckoutHandoffStage(
        stage,
        prepared.error === "relay_unavailable" ||
          prepared.error === "product_unresolved"
          ? "retryable_lookup_failure"
          : "rejected_link"
      )
      setState({ status: "error", error: prepared.error })
      return
    }
    recordCheckoutHandoffStage(stage, "products_resolved")
    const result = await installCheckoutIntentPurchase(
      prepared.items,
      expectedRevision,
      false
    )
    if (result.status === "cart_conflict") {
      recordCheckoutHandoffStage(stage, "cart_conflict")
      setState({ status: "conflict", prepared })
    } else if (result.status === "revision_conflict")
      setState({ status: "error", error: "cart_changed" })
    else if (result.status === "storage_unavailable")
      setState({ status: "error", error: "storage_unavailable" })
    else if (result.status === "invalid_purchase")
      setState({ status: "error", error: "incompatible_checkout" })
    else if ("purchaseId" in result)
      await finish(prepared.merchantPubkey, result.purchaseId)
  }, [
    stage,
    hydrated,
    installCheckoutIntentPurchase,
    session.mode,
    session.pubkey,
    finish,
  ])

  useEffect(() => {
    if (!stage || !hydrated || started.current === stage.id) return
    started.current = stage.id
    void attempt()
  }, [stage, hydrated, attempt])

  const retry = useCallback(() => {
    void attempt()
  }, [attempt])
  const keepCart = useCallback(() => {
    clearStagedCheckoutIntent()
    clearCheckoutReferral()
    setStage(null)
    setState({ status: "idle" })
  }, [])
  const useLinkedItems = useCallback(async () => {
    if (state.status !== "conflict") return
    setState({ status: "loading" })
    const result = await installCheckoutIntentPurchase(
      state.prepared.items,
      getCartRepositorySnapshot().revision,
      true
    )
    if (result.status === "revision_conflict")
      setState({ status: "error", error: "cart_changed" })
    else if (result.status === "storage_unavailable")
      setState({ status: "error", error: "storage_unavailable" })
    else if (result.status === "invalid_purchase")
      setState({ status: "error", error: "incompatible_checkout" })
    else if (result.status === "cart_conflict")
      setState({ status: "error", error: "cart_changed" })
    else if ("purchaseId" in result)
      await finish(state.prepared.merchantPubkey, result.purchaseId)
  }, [state, installCheckoutIntentPurchase, finish])

  return { state, retry, keepCart, useLinkedItems }
}
