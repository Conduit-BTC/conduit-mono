import type { OwnerRelayListResolution } from "./owner-relay-list-evidence"

export const ACCOUNT_NETWORK_ROUTING_POLICY_VERSION = 1

export type AccountNetworkRoutingSource = "app" | "personal"

export type AccountNetworkSetupPromptState = "untouched" | "dismissed" | "acted"

/**
 * Account-scoped, device-local routing policy.
 *
 * This policy controls only Conduit's app-owned relay layer and the owner's
 * public NIP-65 layer. A recipient's signed kind-10050 inbox declaration is
 * separate protocol authority and must never be gated by these switches.
 */
export interface AccountNetworkRoutingPolicy {
  policyVersion: typeof ACCOUNT_NETWORK_ROUTING_POLICY_VERSION
  appRelaysEnabled: boolean
  personalRelaysEnabled: boolean
  appRelaysTouched: boolean
  personalRelaysTouched: boolean
  setupPromptState: AccountNetworkSetupPromptState
  setupPromptUpdatedAt?: number
}

export type AccountNetworkPersonalRelayEvidence =
  | {
      state: "positive"
      source: "published" | "pending" | "retained"
      observedAt: number
    }
  | { state: "absent_within_scope"; observedAt: number }
  | {
      state: "unknown"
      reason: "partial" | "unavailable" | "signed_empty" | "malformed"
    }

export type AccountNetworkOwnerRelayListPolicyEvidence = Pick<
  OwnerRelayListResolution,
  | "state"
  | "stale"
  | "current"
  | "lastUsable"
  | "pendingDistribution"
  | "lookup"
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`)
  }
  return value as number
}

/** Safe defaults while the account's NIP-65 evidence is still unknown. */
export function createDefaultAccountNetworkRoutingPolicy(): AccountNetworkRoutingPolicy {
  return {
    policyVersion: ACCOUNT_NETWORK_ROUTING_POLICY_VERSION,
    appRelaysEnabled: true,
    personalRelaysEnabled: true,
    appRelaysTouched: false,
    personalRelaysTouched: false,
    setupPromptState: "untouched",
  }
}

/**
 * Conservative v1 migration. The old runtime always admitted the signed
 * personal layer, so an existing local record keeps it enabled until the
 * owner explicitly changes the new switch.
 */
export function migrateLegacyAccountNetworkRoutingPolicy(): AccountNetworkRoutingPolicy {
  return {
    ...createDefaultAccountNetworkRoutingPolicy(),
    personalRelaysEnabled: true,
  }
}

export function normalizeAccountNetworkRoutingPolicy(
  value: unknown
): AccountNetworkRoutingPolicy {
  if (!isRecord(value)) {
    throw new Error("Account network routing policy must be an object")
  }
  if (value.policyVersion !== ACCOUNT_NETWORK_ROUTING_POLICY_VERSION) {
    throw new Error(
      `Unsupported account network routing policy version: ${String(value.policyVersion)}`
    )
  }
  const setupPromptState = value.setupPromptState
  if (
    setupPromptState !== "untouched" &&
    setupPromptState !== "dismissed" &&
    setupPromptState !== "acted"
  ) {
    throw new Error("Account network setup prompt state is invalid")
  }

  if (
    setupPromptState === "untouched" &&
    value.setupPromptUpdatedAt !== undefined
  ) {
    throw new Error(
      "Untouched account network setup prompt cannot have an update timestamp"
    )
  }
  if (
    setupPromptState !== "untouched" &&
    value.setupPromptUpdatedAt === undefined
  ) {
    throw new Error(
      "Changed account network setup prompt requires an update timestamp"
    )
  }

  return {
    policyVersion: ACCOUNT_NETWORK_ROUTING_POLICY_VERSION,
    appRelaysEnabled: requireBoolean(
      value.appRelaysEnabled,
      "Account network app relay setting"
    ),
    personalRelaysEnabled: requireBoolean(
      value.personalRelaysEnabled,
      "Account network personal relay setting"
    ),
    appRelaysTouched: requireBoolean(
      value.appRelaysTouched,
      "Account network app relay touched state"
    ),
    personalRelaysTouched: requireBoolean(
      value.personalRelaysTouched,
      "Account network personal relay touched state"
    ),
    setupPromptState,
    ...(value.setupPromptUpdatedAt === undefined
      ? {}
      : {
          setupPromptUpdatedAt: requireTimestamp(
            value.setupPromptUpdatedAt,
            "Account network setup prompt updatedAt"
          ),
        }),
  }
}

export function isAccountNetworkRoutingSourceEnabled(
  policy: AccountNetworkRoutingPolicy,
  source: AccountNetworkRoutingSource
): boolean {
  const normalized = normalizeAccountNetworkRoutingPolicy(policy)
  return source === "app"
    ? normalized.appRelaysEnabled
    : normalized.personalRelaysEnabled
}

export function setAccountNetworkRoutingSourceEnabled(
  policy: AccountNetworkRoutingPolicy,
  source: AccountNetworkRoutingSource,
  enabled: boolean
): AccountNetworkRoutingPolicy {
  const normalized = normalizeAccountNetworkRoutingPolicy(policy)
  if (source === "app") {
    return {
      ...normalized,
      appRelaysEnabled: enabled,
      appRelaysTouched: true,
    }
  }
  return {
    ...normalized,
    personalRelaysEnabled: enabled,
    personalRelaysTouched: true,
  }
}

export function markAccountNetworkSetupPrompt(
  policy: AccountNetworkRoutingPolicy,
  state: Exclude<AccountNetworkSetupPromptState, "untouched">,
  updatedAt: number
): AccountNetworkRoutingPolicy {
  const normalized = normalizeAccountNetworkRoutingPolicy(policy)
  return normalizeAccountNetworkRoutingPolicy({
    ...normalized,
    setupPromptState: state,
    setupPromptUpdatedAt: requireTimestamp(
      updatedAt,
      "Account network setup prompt updatedAt"
    ),
  })
}

/**
 * Apply NIP-65 evidence without overriding an explicit personal-layer choice.
 * Unknown or incomplete evidence preserves the policy byte-for-byte.
 */
export function reconcileAccountNetworkRoutingPolicy(
  policy: AccountNetworkRoutingPolicy,
  evidence: AccountNetworkPersonalRelayEvidence
): AccountNetworkRoutingPolicy {
  const normalized = normalizeAccountNetworkRoutingPolicy(policy)
  if (evidence.state === "unknown") return normalized

  if (evidence.state === "positive") {
    const observedAt = requireTimestamp(
      evidence.observedAt,
      "Account network personal relay evidence observedAt"
    )
    return {
      ...normalized,
      personalRelaysEnabled: normalized.personalRelaysTouched
        ? normalized.personalRelaysEnabled
        : true,
      setupPromptState: "acted",
      setupPromptUpdatedAt:
        normalized.setupPromptState === "acted"
          ? (normalized.setupPromptUpdatedAt ?? observedAt)
          : observedAt,
    }
  }

  if (normalized.personalRelaysTouched) return normalized
  return {
    ...normalized,
    personalRelaysEnabled: false,
  }
}

/** Classify the retained/fresh owner resolution without considering inboxes. */
export function classifyAccountNetworkPersonalRelayEvidence(
  resolution: AccountNetworkOwnerRelayListPolicyEvidence
): AccountNetworkPersonalRelayEvidence {
  const currentHasUsablePreferences =
    (resolution.current?.preferences?.length ?? 0) > 0
  const retainedHasUsablePreferences =
    (resolution.lastUsable?.preferences?.length ?? 0) > 0
  if (resolution.pendingDistribution && currentHasUsablePreferences) {
    return {
      state: "positive",
      source: "pending",
      observedAt: resolution.pendingDistribution.stagedAt,
    }
  }
  if (resolution.current?.state === "signed_empty") {
    return { state: "unknown", reason: "signed_empty" }
  }
  if (resolution.current?.state === "declared" && currentHasUsablePreferences) {
    return {
      state: "positive",
      source: resolution.stale ? "retained" : "published",
      observedAt: resolution.current.observedAt,
    }
  }
  if (
    resolution.current?.state === "malformed" &&
    resolution.lastUsable &&
    retainedHasUsablePreferences
  ) {
    return {
      state: "positive",
      source: "retained",
      observedAt: resolution.current.observedAt,
    }
  }
  if (resolution.current?.state === "malformed") {
    return { state: "unknown", reason: "malformed" }
  }
  if (resolution.lastUsable && retainedHasUsablePreferences) {
    return {
      state: "positive",
      source: "retained",
      observedAt: resolution.lastUsable.observedAt,
    }
  }
  if (
    resolution.state === "not_observed" &&
    resolution.lookup.coverage === "complete" &&
    !resolution.current &&
    !resolution.lastUsable &&
    !resolution.pendingDistribution
  ) {
    return {
      state: "absent_within_scope",
      observedAt: resolution.lookup.observedAt,
    }
  }
  return {
    state: "unknown",
    reason:
      resolution.lookup.coverage === "partial" ? "partial" : "unavailable",
  }
}
