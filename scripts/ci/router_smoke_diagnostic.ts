// Runner-authored phases only. Never derive these labels from browser or
// provider state, assertion messages, identifiers, or payment content.
const routerSmokePhases = [
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
  "mounted supplier listing publication",
  "mounted buyer cart and private order",
  "buyer catalog product load",
  "browser SDK module preload without wallet initialization",
  "buyer catalog product visibility",
  "buyer add product to cart",
  "buyer continue to checkout",
  "buyer router prepare eligibility",
  "buyer router order submission",
  "buyer order preparation completion",
  "inline price and authorization without a popup",
  "single consent for external funding and automatic routing",
  "buyer completes commerce before disappearing",
  "buyer disappears after commerce and before the remaining payment",
  "buyer disappears before any payout preparation",
  "cold Merchant discovers the signed recovery",
  "Merchant order sorting keeps the selected payment target stable",
  "cold Merchant respects the frozen shopper handoff",
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
  "cold Merchant submits the final native treasury transfer",
  "cold Merchant preserves recovery while residual funds remain",
  "cold Merchant reconciles the completed transfer without replay",
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
] as const

export type RouterSmokePhase = (typeof routerSmokePhases)[number]
export type RouterSmokeDiagnostic = {
  phase: RouterSmokePhase
  lifecycle: "body" | "teardown" | "complete"
  body: "running" | "completed" | "failed"
}

export const ROUTER_SMOKE_DIAGNOSTIC_ANNOTATION = "router-phase"
const approvedPhases = new Set<string>(routerSmokePhases)

export function parseRouterSmokeDiagnostic(
  value: unknown
): RouterSmokeDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  const fields = value as Record<string, unknown>
  if (
    Object.keys(fields).length !== 3 ||
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
  return {
    phase: fields.phase as RouterSmokePhase,
    lifecycle: fields.lifecycle as RouterSmokeDiagnostic["lifecycle"],
    body: fields.body as RouterSmokeDiagnostic["body"],
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
  return `router_phase=${JSON.stringify(value.phase)} router_lifecycle=${value.lifecycle} router_body=${value.body}`
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
      record({ ...current, phase })
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
