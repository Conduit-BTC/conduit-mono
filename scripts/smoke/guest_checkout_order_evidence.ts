export type GuestCheckoutOrderSmokeStatus = "passed" | "failed" | "inconclusive"

export type GuestCheckoutOrderSmokeStage =
  | "configuration"
  | "merchant_signer"
  | "product_read"
  | "order_build"
  | "order_publish"
  | "merchant_recovery"

export type GuestCheckoutOrderSmokeArtifactStage =
  GuestCheckoutOrderSmokeStage | "cleanup"

export type GuestCheckoutOrderSmokeFailureCode =
  | `failed_${GuestCheckoutOrderSmokeArtifactStage}`
  | `inconclusive_${GuestCheckoutOrderSmokeStage}`

export type GuestCheckoutOrderSmokeRelayEvidence = {
  relayAttemptCount: number | null
  relayAcknowledgementCount: number | null
  relayObservation: "available" | "unavailable"
}

export const NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT = {
  relayAttemptCount: 0,
  relayAcknowledgementCount: 0,
  relayObservation: "available",
} as const satisfies GuestCheckoutOrderSmokeRelayEvidence

export const UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE = {
  relayAttemptCount: null,
  relayAcknowledgementCount: null,
  relayObservation: "unavailable",
} as const satisfies GuestCheckoutOrderSmokeRelayEvidence

const DURATION_BUCKETS = [
  "under_30_seconds",
  "30_to_59_seconds",
  "60_to_119_seconds",
  "120_to_239_seconds",
  "240_seconds_or_more",
] as const

type GuestCheckoutOrderSmokeDurationBucket = (typeof DURATION_BUCKETS)[number]

export type GuestCheckoutOrderSmokeArtifact = {
  schemaVersion: 1
  candidateCommitSha: string
  check: "guest-checkout-order"
  apps: ["market", "merchant"]
  tags: ["protected-live-canary"]
  stableTestNames: ["merchant-recovers-encrypted-guest-order"]
  selectedTestCount: 1
  environment: "protected-live-canary"
  signerFidelity: {
    buyer: "production_order_scoped_guest_key"
    merchant: "external_nip46_remote_signer"
  }
  status: GuestCheckoutOrderSmokeStatus
  stage: GuestCheckoutOrderSmokeArtifactStage | "complete"
  failureCode: GuestCheckoutOrderSmokeFailureCode | null
  relayAttemptCount: number | null
  relayAcknowledgementCount: number | null
  relayObservation: "available" | "unavailable"
  durationBucket: GuestCheckoutOrderSmokeDurationBucket
  workflowName: "Guest Checkout Order Smoke"
  workflowRunId: string
  workflowRunAttempt: string
  artifactName: "guest-checkout-order-evidence"
}

type GuestCheckoutOrderSmokeOutcome =
  | { status: "passed"; stage: "complete" }
  | {
      status: "failed"
      stage: GuestCheckoutOrderSmokeArtifactStage
    }
  | {
      status: "inconclusive"
      stage: GuestCheckoutOrderSmokeStage
    }

const EXPECTED_KEYS = [
  "apps",
  "artifactName",
  "candidateCommitSha",
  "check",
  "durationBucket",
  "environment",
  "failureCode",
  "relayAcknowledgementCount",
  "relayAttemptCount",
  "relayObservation",
  "schemaVersion",
  "selectedTestCount",
  "signerFidelity",
  "stableTestNames",
  "stage",
  "status",
  "tags",
  "workflowName",
  "workflowRunAttempt",
  "workflowRunId",
] as const

const PROHIBITED_PATTERNS = [
  /\b[0-9a-f]{64}\b/i,
  /\b(?:nsec|npub|nprofile|nevent|naddr|note)1[0-9a-z]{8,}\b/i,
  /\b(?:nostr\+walletconnect|nwc):/i,
  /\b(?:lnbc|lntb|lnbcrt)[0-9a-z]{8,}\b/i,
  /(?:https?|wss?):\/\//i,
  /(?:bunker|nostrconnect):\/\//i,
  /@/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}\b/i,
] as const

export const GUEST_CHECKOUT_ORDER_SMOKE_PROHIBITED_PATTERN_SIGNATURES =
  Object.freeze(
    PROHIBITED_PATTERNS.map(({ source, flags }) =>
      Object.freeze({ source, flags })
    )
  )

export function containsProhibitedGuestCheckoutOrderSmokeEvidence(
  serialized: string,
  patterns: readonly RegExp[] = PROHIBITED_PATTERNS
): boolean {
  return patterns.some((pattern) =>
    new RegExp(pattern.source, pattern.flags).test(serialized)
  )
}

function serializeCanonicalGuestCheckoutOrderSmokeArtifact(
  artifact: GuestCheckoutOrderSmokeArtifact
): string {
  const canonical: GuestCheckoutOrderSmokeArtifact = {
    schemaVersion: artifact.schemaVersion,
    candidateCommitSha: artifact.candidateCommitSha,
    check: artifact.check,
    apps: artifact.apps,
    tags: artifact.tags,
    stableTestNames: artifact.stableTestNames,
    selectedTestCount: artifact.selectedTestCount,
    environment: artifact.environment,
    signerFidelity: {
      buyer: artifact.signerFidelity.buyer,
      merchant: artifact.signerFidelity.merchant,
    },
    status: artifact.status,
    stage: artifact.stage,
    failureCode: artifact.failureCode,
    relayAttemptCount: artifact.relayAttemptCount,
    relayAcknowledgementCount: artifact.relayAcknowledgementCount,
    relayObservation: artifact.relayObservation,
    durationBucket: artifact.durationBucket,
    workflowName: artifact.workflowName,
    workflowRunId: artifact.workflowRunId,
    workflowRunAttempt: artifact.workflowRunAttempt,
    artifactName: artifact.artifactName,
  }
  return `${JSON.stringify(canonical, null, 2)}\n`
}

function invalidEvidence(): never {
  throw new Error("Guest checkout order smoke evidence is invalid.")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function getDurationBucket(
  durationMs: number
): GuestCheckoutOrderSmokeDurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 0) invalidEvidence()
  if (durationMs < 30_000) return "under_30_seconds"
  if (durationMs < 60_000) return "30_to_59_seconds"
  if (durationMs < 120_000) return "60_to_119_seconds"
  if (durationMs < 240_000) return "120_to_239_seconds"
  return "240_seconds_or_more"
}

function getFailureCode(
  outcome: GuestCheckoutOrderSmokeOutcome
): GuestCheckoutOrderSmokeFailureCode | null {
  return outcome.status === "passed"
    ? null
    : (`${outcome.status}_${outcome.stage}` as GuestCheckoutOrderSmokeFailureCode)
}

export function buildGuestCheckoutOrderSmokeArtifact(input: {
  candidateCommitSha: string
  workflowRunId: string
  workflowRunAttempt: string
  outcome: GuestCheckoutOrderSmokeOutcome
  relayEvidence: GuestCheckoutOrderSmokeRelayEvidence
  durationMs: number
}): GuestCheckoutOrderSmokeArtifact {
  const artifact: GuestCheckoutOrderSmokeArtifact = {
    schemaVersion: 1,
    candidateCommitSha: input.candidateCommitSha.trim(),
    check: "guest-checkout-order",
    apps: ["market", "merchant"],
    tags: ["protected-live-canary"],
    stableTestNames: ["merchant-recovers-encrypted-guest-order"],
    selectedTestCount: 1,
    environment: "protected-live-canary",
    signerFidelity: {
      buyer: "production_order_scoped_guest_key",
      merchant: "external_nip46_remote_signer",
    },
    status: input.outcome.status,
    stage: input.outcome.stage,
    failureCode: getFailureCode(input.outcome),
    ...input.relayEvidence,
    durationBucket: getDurationBucket(input.durationMs),
    workflowName: "Guest Checkout Order Smoke",
    workflowRunId: input.workflowRunId.trim(),
    workflowRunAttempt: input.workflowRunAttempt.trim(),
    artifactName: "guest-checkout-order-evidence",
  }
  validateGuestCheckoutOrderSmokeArtifact(artifact)
  return artifact
}

export function validateGuestCheckoutOrderSmokeArtifact(
  value: unknown
): asserts value is GuestCheckoutOrderSmokeArtifact {
  if (!isRecord(value)) invalidEvidence()
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...EXPECTED_KEYS].sort())
  ) {
    invalidEvidence()
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.candidateCommitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.candidateCommitSha) ||
    value.check !== "guest-checkout-order" ||
    JSON.stringify(value.apps) !== JSON.stringify(["market", "merchant"]) ||
    JSON.stringify(value.tags) !== JSON.stringify(["protected-live-canary"]) ||
    JSON.stringify(value.stableTestNames) !==
      JSON.stringify(["merchant-recovers-encrypted-guest-order"]) ||
    value.selectedTestCount !== 1 ||
    value.environment !== "protected-live-canary" ||
    value.workflowName !== "Guest Checkout Order Smoke" ||
    value.artifactName !== "guest-checkout-order-evidence" ||
    typeof value.workflowRunId !== "string" ||
    !/^[1-9]\d*$/.test(value.workflowRunId) ||
    typeof value.workflowRunAttempt !== "string" ||
    !/^[1-9]\d*$/.test(value.workflowRunAttempt) ||
    typeof value.durationBucket !== "string" ||
    !DURATION_BUCKETS.includes(
      value.durationBucket as GuestCheckoutOrderSmokeDurationBucket
    )
  ) {
    invalidEvidence()
  }

  if (
    !isRecord(value.signerFidelity) ||
    JSON.stringify(Object.keys(value.signerFidelity).sort()) !==
      JSON.stringify(["buyer", "merchant"]) ||
    value.signerFidelity.buyer !== "production_order_scoped_guest_key" ||
    value.signerFidelity.merchant !== "external_nip46_remote_signer"
  ) {
    invalidEvidence()
  }

  const status = value.status
  const stage = value.stage
  if (
    typeof status !== "string" ||
    !["passed", "failed", "inconclusive"].includes(status) ||
    typeof stage !== "string" ||
    ![
      "configuration",
      "merchant_signer",
      "product_read",
      "order_build",
      "order_publish",
      "merchant_recovery",
      "cleanup",
      "complete",
    ].includes(stage)
  ) {
    invalidEvidence()
  }
  if (
    (status === "passed" &&
      (stage !== "complete" || value.failureCode !== null)) ||
    (status !== "passed" &&
      (stage === "complete" ||
        (status === "inconclusive" && stage === "cleanup") ||
        value.failureCode !== `${status}_${stage}`))
  ) {
    invalidEvidence()
  }

  if (value.relayObservation === "available") {
    if (
      !isNonNegativeInteger(value.relayAttemptCount) ||
      !isNonNegativeInteger(value.relayAcknowledgementCount) ||
      value.relayAcknowledgementCount > value.relayAttemptCount
    ) {
      invalidEvidence()
    }
  } else if (
    value.relayObservation !== "unavailable" ||
    value.relayAttemptCount !== null ||
    value.relayAcknowledgementCount !== null
  ) {
    invalidEvidence()
  }
}

export function serializeGuestCheckoutOrderSmokeArtifact(
  artifact: GuestCheckoutOrderSmokeArtifact
): string {
  validateGuestCheckoutOrderSmokeArtifact(artifact)
  const serialized = serializeCanonicalGuestCheckoutOrderSmokeArtifact(artifact)
  if (new TextEncoder().encode(serialized).byteLength > 4_096) {
    invalidEvidence()
  }
  if (containsProhibitedGuestCheckoutOrderSmokeEvidence(serialized)) {
    invalidEvidence()
  }
  return serialized
}

export function parseGuestCheckoutOrderSmokeArtifact(
  serialized: string
): GuestCheckoutOrderSmokeArtifact {
  if (new TextEncoder().encode(serialized).byteLength > 4_096) {
    invalidEvidence()
  }
  if (containsProhibitedGuestCheckoutOrderSmokeEvidence(serialized)) {
    invalidEvidence()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    invalidEvidence()
  }
  validateGuestCheckoutOrderSmokeArtifact(parsed)
  if (
    serialized !== serializeCanonicalGuestCheckoutOrderSmokeArtifact(parsed)
  ) {
    invalidEvidence()
  }
  return parsed
}
