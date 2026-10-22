// Runner-authored phases only. Never derive these labels from browser or
// provider state, assertion messages, identifiers, or payment content.
const routerSmokePhases = [
  "event setup",
  "event occurrence assignment",
  "event occurrence date selection",
  "event occurrence product selection",
  "event occurrence allocation submission",
  "event organizer device selection",
  "event reserved stock grant",
  "event reserved stock Merchant page",
  "event reserved stock product selector",
  "event reserved stock product selection",
  "event reserved stock quantity entry",
  "event reserved stock pickup setup entry",
  "event reserved stock grant submission",
  "event reserved stock grant saved notice",
  "event reserved stock Organizer refresh",
  "event reserved stock Organizer acceptance",
  "event reserved stock ready notice",
  "event buyer checkout",
  "event buyer catalog admission",
  "event buyer cart checkout",
  "event buyer price presentation",
  "event guest contact-free fields",
  "event mobile checkout layout",
  "event organizer fee disclosure",
  "event buyer plan preparation",
  "event buyer funding authorization",
  "event buyer automatic payment routing",
  "event buyer payment completion visible",
  "event buyer exact Lightning payments verified",
  "event buyer exact native payment verified",
  "event buyer connected funding paid once",
  "event organizer observes the buyer cutoff",
  "event organizer automatic payment routing",
  "event organizer recovery page reopening",
  "event organizer saved orders refresh",
  "event organizer saved order selection",
  "event organizer restored continuation",
  "event organizer payment completion observation",
  "event organizer stock authority rejected",
  "event organizer recovery authority rejected",
  "event organizer destination rejected",
  "event organizer routing stopped before sends",
  "event organizer routing stopped during commerce",
  "event organizer native submission pending",
  "event organizer native verification pending",
  "event replacement device registration",
  "event source device handover",
  "event retired device cannot continue",
  "event replacement journal restoration",
  "event replacement transfer discovery",
  "event replacement transfer activation",
  "event replacement writer projection",
  "event exact pickup claim and handout",
  "event Merchant once-only stock reconciliation",
  "merchant product page",
  "opening product form",
  "product title and pricing fields",
  "product currency selection",
  "digital fulfillment selection",
  "product image URL",
  "public zap preference",
  "required product tags",
  "supplier allocation controls",
  "product publication submission",
  "product publication completion",
  "isolated setup",
  "Merchant setup checks a supported receiver before signing",
  "Merchant setup reads back its genuine signed receiving profile",
  "unsupported required recipient blocks before wallet funding or disclosure",
  "mounted supplier listing publication",
  "mounted buyer cart and private order",
  "buyer catalog product load",
  "browser SDK module preload without wallet initialization",
  "buyer catalog product visibility",
  "guest product detail navigation",
  "guest product detail cart admission",
  "guest product detail cart reset",
  "buyer add product to cart",
  "buyer continue to checkout",
  "buyer router prepare eligibility",
  "buyer router order submission",
  "buyer order preparation completion",
  "buyer order preparation rejected",
  "buyer prepared funding matches the frozen total",
  "inline price and authorization without a popup",
  "bound buyer continues while new router admission is disabled",
  "disabled execution preserves partial saved payment history",
  "partial execution stop requests buyer pause",
  "partial execution stop waits for buyer pause",
  "partial execution stop mounts disabled saved order",
  "partial execution stop refreshes saved status",
  "partial execution stop shows paused notice",
  "partial execution stop disables dispatch controls",
  "partial execution stop retains recorded receipt",
  "partial execution stop preserves verified commerce",
  "partial execution stop preserves provider and wallet counters",
  "partial execution stop restores bound continuation",
  "disabled execution preserves complete saved payment history",
  "order and account changes hide stale saved payment history",
  "single consent for external funding and automatic routing",
  "buyer completes commerce before disappearing",
  "buyer disappears after commerce and before the remaining payment",
  "buyer disappears before any payout preparation",
  "buyer freezes independent funding and handoff deadlines",
  "cold Merchant discovers the signed recovery",
  "Merchant order sorting keeps the selected payment target stable",
  "cold Merchant respects the frozen shopper handoff",
  "cold Merchant restores exact saved funding deadlines",
  "cold Merchant remains before the original shopper cutoff",
  "cold Merchant automatically continues after handoff without a prompt",
  "cold Merchant browser clock follows the isolated clock advance",
  "cold Merchant stays paused across the isolated clock advance",
  "cold Merchant has no sends before reopening",
  "cold Merchant reload navigation completes",
  "cold Merchant reload rejected a failed local request",
  "cold Merchant reload rejected pending local work",
  "cold Merchant reload rejected a disposed barrier",
  "cold Merchant reload navigation timed out",
  "cold Merchant enables automatic recovery on reopening",
  "cold Merchant foreground Date advances after reopening",
  "cold Merchant submits the final native treasury transfer",
  "cold Merchant requests query-only native authentication",
  "cold Merchant authenticates query-only native observations",
  "cold Merchant opens native recovery only after handoff",
  "cold Merchant reads exact completed funding from the provider",
  "cold Merchant retains the exact admitted recovery witness",
  "cold Merchant retains a separate provider settlement record",
  "cold Merchant retains independent provider funding credit",
  "cold Merchant independently verifies supported recipient invoices",
  "cold Merchant independently checks recipient verification requests",
  "cold Merchant preserves exact commerce payment counters",
  "cold Merchant resumes the next Lightning payout",
  "cold Merchant completes remaining Lightning payouts",
  "cold Merchant provider completed the second Lightning payout",
  "cold Merchant saved independently verified commerce payments",
  "cold Merchant next unpaid recipient is organizer",
  "cold Merchant prepared the remaining organizer payout",
  "cold Merchant staged exact current progress",
  "cold Merchant exact current progress has a self acknowledgement",
  "cold Merchant fresh discovery matches prepared progress",
  "cold Merchant fresh discovery can select the prepared payout",
  "cold Merchant continuation has original order authority",
  "cold Merchant continuation has available payment checks",
  "cold Merchant continuation has verified recipients",
  "cold Merchant continuation is not awaiting invoice renewal",
  "cold Merchant continuation needs no payment attention",
  "cold Merchant continuation is not paused",
  "cold Merchant remaining fees need no attention",
  "cold Merchant remaining fee processing is not paused",
  "cold Merchant observes the exact pending native treasury transfer",
  "cold Merchant records independently verified commerce and native receipt",
  "cold Merchant retains independently verified credit",
  "cold Merchant retains independently verified commerce",
  "cold Merchant retains independently verified native receipt",
  "cold Merchant records exact independently verified accounting",
  "cold Merchant persists terminal treasury reconciliation",
  "cold Merchant preserves recovery while residual funds remain",
  "cold Merchant reconciles the completed transfer without replay",
  "cold Merchant keeps automatic native reconciliation active after claim",
  "cold Merchant retains accurate recovery verification status",
  "cold Merchant payments match the frozen destinations and allocations",
  "Merchant sends only the verified supplier's private notification",
  "cold Merchant never replays prior payments or invents recipient proof",
  "recovery access check opens payment details",
  "recovery access check starts account verification",
  "recovery access check confirms account access",
  "recovery access check remains paused",
  "recovery access check preserves provider history",
  "recovery access check publishes no public payment event",
  "cold Merchant drains automatic recovery before retirement",
  "cold Merchant retires only after fresh terminal zero evidence",
  "cold Merchant reload automatically checks without replaying payouts",
  "cold Merchant retired recovery remains visible after reload",
  "cold Merchant retains retirement tombstone after reload",
  "cold Merchant retired reload does not replay payments",
  "external QR remains mounted during funding polls",
  "external QR records two bounded funding observations",
  "automatic commerce payouts and pending native treasury transfer",
  "native treasury transfer not submitted after commerce",
  "native treasury sender commits before receiver claim",
  "native treasury pre-commit provider transfer matches",
  "native treasury sender commitment applied",
  "sender-committed payment status visible",
  "sender-committed delivery separation visible",
  "sender commitment completes routing without native replay",
  "sender-committed exact provider transfer matches",
  "sender-committed persisted obligations match",
  "sender-committed payment receipt is fully verified",
  "unclaimed receiver keeps encrypted recovery active",
  "sender-committed refresh does not replay native payment",
  "pending native treasury buyer progress",
  "pending native treasury accounting",
  "partial payout receipt preserves pending native finalization",
  "automatically reconcile the completed native transfer",
  "terminal buyer reconciliation without replay",
  "actual payout receipt uses provider fees",
  "explicit buyer cleanup retains residual recovery",
  "recorded receipt remains historical with additional owned funds",
  "explicit buyer cleanup verifies terminal zero funds",
  "retired buyer order survives reload without replay",
  "retired payout receipt survives reload",
  "cold Merchant completes payment while retaining checkout recovery",
  "cold Merchant retains acknowledged encrypted recovery",
  "cold Merchant retains original encrypted recovery",
  "cold Merchant keeps the completed checkout wallet active",
  "cold Merchant retained recovery and paid state survive reload",
  "cold Merchant retained reload does not replay payments",
  "cold Merchant reload preserves recorded accounting",
  "cold Merchant reload preserves the native send count",
  "cold Merchant retains one supplier notification",
  "private router keeps public zap history empty",
  "unclaimed receiver keeps encrypted checkout recovery saved",
  "paid checkout retains wallet and encrypted recovery",
  "retained buyer order survives reload without replay",
] as const

export type RouterSmokePhase = (typeof routerSmokePhases)[number]
export type RouterSmokeDiagnostic = {
  phase: RouterSmokePhase
  lifecycle: "body" | "teardown" | "complete"
  body: "running" | "completed" | "failed"
  expected?: RouterSmokeExpectation
  category?: RouterSmokeCategory
}

const checkpointEvidence = {
  "cold Merchant resumes the next Lightning payout": {
    expected: "next-lightning-send",
    category: "provider-observation",
  },
  "cold Merchant completes remaining Lightning payouts": {
    expected: "three-lightning-sends",
    category: "provider-observation",
  },
  "cold Merchant provider completed the second Lightning payout": {
    expected: "second-lightning-completed",
    category: "provider-observation",
  },
  "cold Merchant saved independently verified commerce payments": {
    expected: "two-commerce-payments-verified",
    category: "app-readiness",
  },
  "cold Merchant next unpaid recipient is organizer": {
    expected: "next-unpaid-organizer",
    category: "app-readiness",
  },
  "cold Merchant prepared the remaining organizer payout": {
    expected: "remaining-organizer-intent-prepared",
    category: "app-readiness",
  },
  "cold Merchant staged exact current progress": {
    expected: "current-progress-staged",
    category: "app-readiness",
  },
  "cold Merchant exact current progress has a self acknowledgement": {
    expected: "current-progress-self-acknowledged",
    category: "app-readiness",
  },
  "cold Merchant fresh discovery matches prepared progress": {
    expected: "fresh-discovery-matches-prepared-progress",
    category: "app-readiness",
  },
  "cold Merchant fresh discovery can select the prepared payout": {
    expected: "fresh-discovery-selects-prepared-payout",
    category: "app-readiness",
  },
  "cold Merchant continuation has original order authority": {
    expected: "original-order-available",
    category: "app-readiness",
  },
  "cold Merchant continuation has available payment checks": {
    expected: "payment-check-available",
    category: "app-readiness",
  },
  "cold Merchant continuation has verified recipients": {
    expected: "payment-recipient-verified",
    category: "app-readiness",
  },
  "cold Merchant continuation is not awaiting invoice renewal": {
    expected: "payment-renewal-not-required",
    category: "app-readiness",
  },
  "cold Merchant continuation needs no payment attention": {
    expected: "payment-attention-not-required",
    category: "app-readiness",
  },
  "cold Merchant continuation is not paused": {
    expected: "automatic-payment-not-paused",
    category: "app-readiness",
  },
  "cold Merchant remaining fees need no attention": {
    expected: "remaining-fee-attention-not-required",
    category: "app-readiness",
  },
  "cold Merchant remaining fee processing is not paused": {
    expected: "remaining-fee-not-paused",
    category: "app-readiness",
  },
  "cold Merchant retains original encrypted recovery": {
    expected: "merchant-recovery-retained",
    category: "assertion",
  },
  "cold Merchant retains acknowledged encrypted recovery": {
    expected: "merchant-recovery-retained",
    category: "assertion",
  },
  "cold Merchant keeps the completed checkout wallet active": {
    expected: "checkout-wallet-retained",
    category: "assertion",
  },
  "guest product detail cart admission": {
    expected: "guest-cart-item-present",
    category: "app-readiness",
  },
  "native treasury pre-commit provider transfer matches": {
    expected: "pending-sender-transfer",
    category: "provider-observation",
  },
  "native treasury sender commitment applied": {
    expected: "sender-commitment-applied",
    category: "fixture-control",
  },
  "sender-committed payment status visible": {
    expected: "payment-recorded-visible",
    category: "app-readiness",
  },
  "sender-committed delivery separation visible": {
    expected: "delivery-separation-visible",
    category: "assertion",
  },
} as const

type RouterSmokeExpectation =
  (typeof checkpointEvidence)[keyof typeof checkpointEvidence]["expected"]
type RouterSmokeCategory =
  (typeof checkpointEvidence)[keyof typeof checkpointEvidence]["category"]

export const ROUTER_SMOKE_DIAGNOSTIC_ANNOTATION = "router-phase"
const approvedPhases = new Set<string>(routerSmokePhases)

export function parseRouterSmokeDiagnostic(
  value: unknown
): RouterSmokeDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  const fields = value as Record<string, unknown>
  if (
    ![3, 5].includes(Object.keys(fields).length) ||
    Object.keys(fields).some(
      (key) =>
        !["phase", "lifecycle", "body", "expected", "category"].includes(key)
    ) ||
    !["phase", "lifecycle", "body"].every((key) =>
      Object.hasOwn(fields, key)
    ) ||
    typeof fields.phase !== "string" ||
    !approvedPhases.has(fields.phase) ||
    typeof fields.lifecycle !== "string" ||
    !["body", "teardown", "complete"].includes(fields.lifecycle) ||
    typeof fields.body !== "string" ||
    !["running", "completed", "failed"].includes(fields.body) ||
    (fields.lifecycle === "body" && fields.body === "completed") ||
    (fields.lifecycle !== "body" && fields.body === "running")
  )
    return undefined
  const checkpoint =
    checkpointEvidence[fields.phase as keyof typeof checkpointEvidence]
  if (
    (checkpoint &&
      (fields.expected !== checkpoint.expected ||
        fields.category !== checkpoint.category)) ||
    (!checkpoint &&
      (Object.hasOwn(fields, "expected") || Object.hasOwn(fields, "category")))
  )
    return undefined
  return {
    phase: fields.phase as RouterSmokePhase,
    lifecycle: fields.lifecycle as RouterSmokeDiagnostic["lifecycle"],
    body: fields.body as RouterSmokeDiagnostic["body"],
    ...(checkpoint ? checkpoint : {}),
  }
}

export function routerSmokeDiagnosticFromAnnotations(
  annotations: readonly { type: string; description?: string }[] | undefined
): RouterSmokeDiagnostic | undefined {
  const matches = (annotations ?? []).filter(
    ({ type }) => type === ROUTER_SMOKE_DIAGNOSTIC_ANNOTATION
  )
  if (matches.length !== 1 || typeof matches[0]?.description !== "string")
    return undefined
  try {
    return parseRouterSmokeDiagnostic(JSON.parse(matches[0].description))
  } catch {
    return undefined
  }
}

export function formatRouterSmokeDiagnostic(
  value: RouterSmokeDiagnostic
): string {
  const safe = parseRouterSmokeDiagnostic(value)
  if (!safe) throw new Error("Invalid runner-authored router diagnostic.")
  return `router_phase=${JSON.stringify(safe.phase)} router_lifecycle=${safe.lifecycle} router_body=${safe.body}${safe.expected ? ` router_expected=${safe.expected} router_category=${safe.category}` : ""}`
}

export function createRouterSmokeRecorder(
  annotations: Array<{ type: string; description?: string }>
) {
  let current: RouterSmokeDiagnostic = {
    phase: "isolated setup",
    lifecycle: "body",
    body: "running",
  }
  // One owned slot contains the whole tuple; there are no independently
  // updated phase/lifecycle fields for a timeout to observe halfway through.
  const annotation = {
    type: ROUTER_SMOKE_DIAGNOSTIC_ANNOTATION,
    description: JSON.stringify(current),
  }
  annotations.push(annotation)
  const record = (next: RouterSmokeDiagnostic) => {
    const safe = parseRouterSmokeDiagnostic(next)
    if (!safe) throw new Error("Invalid runner-authored router diagnostic.")
    current = safe
    annotation.description = JSON.stringify(safe)
  }
  return {
    phase(phase: RouterSmokePhase) {
      const checkpoint =
        checkpointEvidence[phase as keyof typeof checkpointEvidence]
      record({
        phase,
        lifecycle: current.lifecycle,
        body: current.body,
        ...(checkpoint ? checkpoint : {}),
      })
    },
    failed() {
      record({ ...current, body: "failed" })
    },
    teardown(bodyCompleted: boolean) {
      record({
        ...current,
        lifecycle: "teardown",
        body:
          bodyCompleted && current.body !== "failed" ? "completed" : "failed",
      })
    },
    complete() {
      record({ ...current, lifecycle: "complete" })
    },
  }
}
