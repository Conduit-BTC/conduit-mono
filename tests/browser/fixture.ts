import {
  assertCheckoutSparkOutgoingPreProviderRetry,
  runCheckoutSparkSettledOutgoingStep,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingProvider,
  type CheckoutSparkSettledOutgoingStateStore,
  type CheckoutSparkSettledOutgoingTarget,
} from "../../packages/core/src/protocol/checkout-spark-settled-outgoing"
import initialState from "./fixture-state.json"
import {
  type CheckoutSparkSettledReconciliation,
  restoreCheckoutSparkSettledReconciliation,
} from "../../packages/core/src/protocol/checkout-spark-settled-router"

const CREATED_AT = 1_800_000_000_000

function observation(
  target: CheckoutSparkSettledOutgoingTarget,
  status: CheckoutSparkSettledOutgoingObservation["status"],
  finalFeeSats = 4
): CheckoutSparkSettledOutgoingObservation {
  const identity = {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
  }
  return status === "paid"
    ? {
        ...identity,
        status,
        finalFeeSats,
        finalDebitSats: target.intent.invoiceAmountSats + finalFeeSats,
      }
    : { ...identity, status }
}

export function harness(
  initial = restoreCheckoutSparkSettledReconciliation(
    initialState as unknown as CheckoutSparkSettledReconciliation
  ),
  hooks: {
    afterPreflight?: () => Promise<void>
    afterSave?: () => Promise<void>
    afterAcknowledgement?: (status: string) => Promise<void>
  } = {}
) {
  let state = structuredClone(initial)
  let revision = 1
  let failNextSave = false
  let lookup: CheckoutSparkSettledOutgoingObservation["status"] = "not_found"
  let send: CheckoutSparkSettledOutgoingObservation["status"] | "not_sent" =
    "paid"
  let preflight:
    "ready" | "fee_over_cap" | "insufficient_funds" | "unavailable" = "ready"
  let throwOnSend = false
  let failHandoffAt: number | null = null
  const handoffs: string[] = []
  const lookups: CheckoutSparkSettledOutgoingTarget[] = []
  const preflights: CheckoutSparkSettledOutgoingTarget[] = []
  const sends: CheckoutSparkSettledOutgoingTarget[] = []
  const statusAtSend: string[] = []
  const store: CheckoutSparkSettledOutgoingStateStore = {
    outgoingAdmissionScope: Object.freeze({}),
    async saveOutgoingPreProviderRetry(next, expectedRevision, cancellation) {
      assertCheckoutSparkOutgoingPreProviderRetry(
        this.outgoingAdmissionScope!,
        state,
        next,
        expectedRevision,
        cancellation
      )
      return this.save(next, expectedRevision)
    },
    async load() {
      return { status: "active", revision, state: structuredClone(state) }
    },
    async save(next, expectedRevision) {
      if (failNextSave) throw new Error("durable save failed")
      if (expectedRevision !== revision) throw new Error("CAS conflict")
      state = structuredClone(next)
      revision += 1
      await hooks.afterSave?.()
      return { status: "active", revision, state: structuredClone(state) }
    },
  }
  const provider: CheckoutSparkSettledOutgoingProvider = {
    async reconcile(target) {
      lookups.push(target)
      return observation(target, lookup, Math.min(4, target.intent.maxFeeSats))
    },
    async preflight(target) {
      preflights.push(target)
      await hooks.afterPreflight?.()
      return preflight
    },
    async send(target) {
      sends.push(target)
      statusAtSend.push(state.legs[0]!.status)
      if (throwOnSend) throw new Error("provider response lost")
      return send === "not_sent"
        ? { status: "not_sent" }
        : observation(target, send)
    },
  }
  const step = (
    actor: "shopper" | "merchant" = "shopper",
    now: number | (() => number) = CREATED_AT + 3,
    legId = initial.plan.recipients[0]!.legId,
    inspectionOnly = false
  ) =>
    runCheckoutSparkSettledOutgoingStep({
      checkoutId: initial.plan.checkoutId,
      planDigest: initial.plan.planDigest,
      legId,
      actor,
      ...(inspectionOnly ? { inspectionOnly: true } : {}),
      now: typeof now === "function" ? now : () => now,
      store,
      provider,
      acknowledgeRecoverySnapshot: async (snapshot) => {
        handoffs.push(snapshot.legs[0]!.status)
        if (handoffs.length === failHandoffAt) {
          throw new Error("recovery relay unavailable")
        }
        await hooks.afterAcknowledgement?.(snapshot.legs[0]!.status)
      },
    })
  return {
    step,
    store,
    provider,
    sends,
    lookups,
    preflights,
    statusAtSend,
    handoffs,
    get state() {
      return state
    },
    set lookup(value: typeof lookup) {
      lookup = value
    },
    set send(value: typeof send) {
      send = value
    },
    set preflight(value: typeof preflight) {
      preflight = value
    },
    set failNextSave(value: boolean) {
      failNextSave = value
    },
    set throwOnSend(value: boolean) {
      throwOnSend = value
    },
    set failHandoffAt(value: number | null) {
      failHandoffAt = value
    },
  }
}
