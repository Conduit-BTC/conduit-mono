import { config } from "../config"
import { configuredRelayTargets } from "./account-network-local-state"
import {
  mergeRelayTargets,
  relayTargetsFromUrls,
  type RelayTarget,
} from "./relay-authority"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "./network-preferences"
import type { OwnerRelayListEvidenceRepository } from "./owner-relay-list-evidence"
import type { ReadProtectedInboxOptions } from "./protected-inbox-read"
import {
  getCommerceReadRelayUrls,
  getGeneralReadRelayUrls,
  loadRelaySettingsPlanningSnapshot,
  normalizeOwnerSelectedRelayUrls,
  normalizePublicOrIsolatedE2eRelayHints,
  normalizePublicRelayHints,
  normalizeUntrustedRelayHintsForContext,
} from "./relay-settings"
import {
  getRelayLists,
  getRelayListsDetailed,
  type RelayList,
  type RelayListResolutionState,
} from "./relay-list"
import {
  DEFAULT_READ_FANOUT,
  planRelayReads,
  type RelayReadIntent,
} from "./relay-planner"

export const BROAD_AUTHOR_HINT_LIMIT = 16

interface CommerceRelayPlanningTestOverrides {
  getRelayLists?: typeof getRelayLists
  getRelayListsDetailed?: typeof getRelayListsDetailed
  ownerRelayListEvidenceRepository?: OwnerRelayListEvidenceRepository
  accountNetworkLocalStateRepository?: ReadProtectedInboxOptions["accountNetworkLocalStateRepository"]
  hasFetchOverride?: boolean
}

let testOverrides: CommerceRelayPlanningTestOverrides = {}

/** Replace with the facade's complete effective overrides after each merge. */
export function __setCommerceRelayPlanningTestOverrides(
  overrides: CommerceRelayPlanningTestOverrides
): void {
  testOverrides = { ...overrides }
}

export function __resetCommerceRelayPlanningTestOverrides(): void {
  testOverrides = {}
}

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

function publicReadRelayUrls(): string[] {
  return getGeneralReadRelayUrls({
    fallbackRelayUrls:
      config.corePublicFallbackRelayUrls.length > 0
        ? config.corePublicFallbackRelayUrls
        : undefined,
  })
}

function commerceFallbackRelayUrls(): string[] {
  return uniqueStrings([
    ...config.appBackplaneRelayUrls,
    ...config.commerceDiscoveryRelayUrls,
    ...config.corePublicFallbackRelayUrls,
  ])
}

function commerceReadRelayUrls(): string[] {
  return getCommerceReadRelayUrls({
    fallbackRelayUrls: commerceFallbackRelayUrls(),
  })
}

function hasCommerceFetchTestOverride(): boolean {
  return testOverrides.hasFetchOverride === true
}

/**
 * Resolve a planner-driven relay URL list for a commerce read intent.
 * Pulls cached NIP-65 relay lists for any author/recipient hints so
 * fanout includes the author's write/read relays alongside user settings.
 * Public commerce discovery keeps its bounded app fallback; authoritative
 * signed account state leaves generic reads empty when no relay is enabled.
 */
export type CommerceReadRelayPlan = {
  relayUrls: string[]
  relayTargets: RelayTarget[]
  /** Ordered candidates retained until the final live-policy admission gate. */
  candidateRelayUrls: string[]
  /** Maximum candidates that may reach relay I/O after policy filtering. */
  maxRelayAttempts?: number
  parkedRelayUrls: string[]
  /** Complete NIP-65 hint set before the executable fanout cap. */
  hintRelayUrls: string[]
  /** Exact planned subset backed by this authenticated owner's settings. */
  ownerSelectedRelayUrls: string[]
  /** Exact executable subset contributed by Conduit's app-owned layer. */
  appRelayUrls: string[]
  /** Exact executable subset contributed by the owner's NIP-65 layer. */
  personalRelayUrls: string[]
  /** Exact candidates with signed remote or retained source authority. */
  independentRelayUrls: string[]
  /** Resolved once so per-family plans do not repeat the NIP-65 lookup. */
  relayLists: ReadonlyMap<string, RelayList>
  /** Payment reads must distinguish a missing list from failed discovery. */
  relayListResolutionStates: ReadonlyMap<string, RelayListResolutionState>
  relayListLookupIncomplete: boolean
}

/** Existing bounded legacy-DM policy, independent of kind-10050 inbox declarations. */
export async function planLegacyDirectMessageRead(
  principalPubkey: string,
  shouldContinue: () => boolean
): Promise<CommerceReadRelayPlan> {
  return await planCommerceReadRelayPlan({
    intent: "legacy_dm",
    authors: [principalPubkey],
    recipients: [principalPubkey],
    authenticatedPubkey: principalPubkey,
    maxRelays: 24,
    shouldContinue,
  })
}

export async function planCommerceReadRelayPlan(input: {
  intent: RelayReadIntent
  authors?: readonly string[]
  recipients?: readonly string[]
  authenticatedPubkey?: string | null
  /** Account policy for final hint discovery without changing read authority. */
  accountPubkey?: string | null
  maxRelays?: number
  relayHintMode?: "auto" | "skip" | "force"
  /** Untrusted hints that must independently resolve to public WSS targets. */
  extraRelayUrls?: readonly string[]
  /** Hints belonging to the exact authenticated author. */
  authenticatedAuthorRelayUrls?: readonly string[]
  /** Batched NIP-65 result reused by narrower author plans. */
  relayLists?: ReadonlyMap<string, RelayList>
  paymentProfileEvidence?: boolean
  shouldContinue?: () => boolean
  signal?: AbortSignal
}): Promise<CommerceReadRelayPlan> {
  const accountPubkey = input.accountPubkey ?? input.authenticatedPubkey
  const settingsSnapshot = input.authenticatedPubkey
    ? await readDurableAccountRelaySettingsPlanningSnapshot(
        input.authenticatedPubkey,
        {
          evidenceRepository: testOverrides.ownerRelayListEvidenceRepository,
        }
      )
    : loadRelaySettingsPlanningSnapshot()
  const hintPubkeys = Array.from(
    new Set(
      [...(input.authors ?? []), ...(input.recipients ?? [])]
        .map((p) => p.trim())
        .filter(Boolean)
    )
  )

  const normalizedAuthenticatedPubkey = input.authenticatedPubkey
    ?.trim()
    .toLowerCase()
  const normalizedPolicyAccount = accountPubkey?.trim().toLowerCase()
  const configuredOwnerRelayListLookupUrls =
    normalizedAuthenticatedPubkey &&
    normalizedAuthenticatedPubkey === normalizedPolicyAccount
      ? normalizeOwnerSelectedRelayUrls(
          settingsSnapshot.settings.entries.flatMap((entry) =>
            entry.readEnabled ? [entry.url] : []
          )
        )
      : []
  const relayListLookupPlan = planRelayReads({
    intent: "relay_lists",
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: configuredOwnerRelayListLookupUrls,
    settings: settingsSnapshot.settings,
    signedRelayListAuthoritative: settingsSnapshot.signedRelayListAuthoritative,
  })
  // A durable signed-empty owner projection is already authoritative. Do not
  // activate ambient app discovery merely to refresh that owner's own NIP-65
  // hints before the account relay-settings scope is available. This boundary
  // is author-specific: unrelated authors still need bounded App discovery so
  // their advertised write relays can participate in the requested read.
  const suppressAmbientOwnerRelayListLookup =
    !!normalizedAuthenticatedPubkey &&
    normalizedAuthenticatedPubkey === normalizedPolicyAccount &&
    settingsSnapshot.signedRelayListAuthoritative &&
    configuredOwnerRelayListLookupUrls.length === 0
  const relayListLookupPubkeys = suppressAmbientOwnerRelayListLookup
    ? hintPubkeys.filter(
        (pubkey) =>
          pubkey.trim().toLowerCase() !== normalizedAuthenticatedPubkey
      )
    : hintPubkeys
  const shouldFetchRelayHints =
    relayListLookupPubkeys.length > 0 &&
    (input.relayHintMode === "force" ||
      (input.relayHintMode !== "skip" &&
        relayListLookupPubkeys.length <= BROAD_AUTHOR_HINT_LIMIT))
  const relayListLookupRelayUrls =
    relayListLookupPubkeys.length === 0
      ? []
      : relayListLookupPlan.candidateRelayUrls
  const relayListLookupRelayUrlSet = new Set(relayListLookupRelayUrls)
  const ownerSelectedRelayListLookupUrls = (
    relayListLookupPlan.ownerSelectedRelayUrls ?? []
  ).filter((relayUrl) => relayListLookupRelayUrlSet.has(relayUrl))
  const appRelayListLookupUrls = (
    relayListLookupPlan.appRelayUrls ?? []
  ).filter((relayUrl) => relayListLookupRelayUrlSet.has(relayUrl))
  const personalRelayListLookupUrls = (
    relayListLookupPlan.personalRelayUrls ?? []
  ).filter((relayUrl) => relayListLookupRelayUrlSet.has(relayUrl))
  const independentRelayListLookupUrls = (
    relayListLookupPlan.independentRelayUrls ?? []
  ).filter((relayUrl) => relayListLookupRelayUrlSet.has(relayUrl))
  const relayListLookupOptions = {
    ...(hasCommerceFetchTestOverride() && !input.paymentProfileEvidence
      ? { cacheOnly: true }
      : { relayUrls: relayListLookupRelayUrls }),
    ...(input.paymentProfileEvidence
      ? { skipCache: true, requireAllRequestedRelays: true }
      : {}),
    relayTargets: relayListLookupPlan.relayTargets,
    allowInsecureRelayUrlsForPubkey: input.authenticatedPubkey,
    accountPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: ownerSelectedRelayListLookupUrls,
    appRelayUrls: appRelayListLookupUrls,
    personalRelayUrls: personalRelayListLookupUrls,
    independentRelayUrls: independentRelayListLookupUrls,
    maxRelayAttempts: relayListLookupPlan.maxRelayAttempts,
    accountNetworkLocalStateRepository:
      testOverrides.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
    signal: input.signal,
  }
  const relayListResult = input.relayLists
    ? {
        relayLists: input.relayLists,
        resolutionStates: new Map<string, RelayListResolutionState>(),
      }
    : shouldFetchRelayHints
      ? input.paymentProfileEvidence
        ? await (testOverrides.getRelayListsDetailed ?? getRelayListsDetailed)(
            relayListLookupPubkeys,
            relayListLookupOptions
          )
        : {
            relayLists: await (testOverrides.getRelayLists ?? getRelayLists)(
              relayListLookupPubkeys,
              relayListLookupOptions
            ),
            resolutionStates: new Map<string, RelayListResolutionState>(),
          }
      : {
          relayLists: new Map<string, RelayList>(),
          resolutionStates: new Map<string, RelayListResolutionState>(),
        }
  const relayLists = relayListResult.relayLists
  const relayListLookupIncomplete =
    !!input.paymentProfileEvidence &&
    relayListLookupPlan.parkedRelayUrls.length > 0

  const plan = planRelayReads({
    intent: input.intent,
    authors: input.authors,
    recipients: input.recipients,
    relayLists,
    authenticatedPubkey: input.authenticatedPubkey,
    ownerSelectedRelayUrls: normalizeOwnerSelectedRelayUrls(
      settingsSnapshot.settings.entries.flatMap((entry) =>
        entry.readEnabled ||
        (hintPubkeys.some(
          (pubkey) =>
            pubkey.trim().toLowerCase() === normalizedAuthenticatedPubkey
        ) &&
          entry.writeEnabled)
          ? [entry.url]
          : []
      )
    ),
    maxRelays: input.maxRelays,
    settings: settingsSnapshot.settings,
    signedRelayListAuthoritative: settingsSnapshot.signedRelayListAuthoritative,
  })

  const preservesPublicCommerceDiscovery =
    input.intent === "commerce_products" || input.intent === "author_products"
  const protectedInboxIntent =
    input.intent === "legacy_dm" || input.intent === "dm_inbox"
  const fallbackRelayUrls = (() => {
    if (preservesPublicCommerceDiscovery) return commerceFallbackRelayUrls()
    // Protected inbox reads have their own bounded compatibility and signed
    // owner sources. Generic public fallback relays cannot authorize them.
    if (protectedInboxIntent) return []
    if (settingsSnapshot.signedRelayListAuthoritative) return []
    return config.corePublicFallbackRelayUrls.length > 0
      ? config.corePublicFallbackRelayUrls
      : config.defaultRelays
  })()
  const preferFallbackFirst =
    input.relayHintMode !== "force" &&
    (input.intent === "commerce_products" ||
      (input.intent === "author_products" && (input.authors?.length ?? 0) > 1))
  const publicExternalRelayHints = normalizePublicRelayHints(
    input.extraRelayUrls ?? []
  )
  const authenticatedAuthorRelayHints = normalizeUntrustedRelayHintsForContext({
    relayUrls: input.authenticatedAuthorRelayUrls ?? [],
    approvedRelayUrls: plan.candidateRelayUrls,
    allowApprovedPrivate: !!input.authenticatedPubkey,
  })
  const externalRelayHints = uniqueStrings([
    ...publicExternalRelayHints,
    ...authenticatedAuthorRelayHints,
  ])
  const plannedRelayUrls = preferFallbackFirst
    ? uniqueStrings([
        ...fallbackRelayUrls,
        ...externalRelayHints,
        ...plan.candidateRelayUrls,
      ])
    : uniqueStrings([
        ...externalRelayHints,
        ...plan.candidateRelayUrls,
        ...fallbackRelayUrls,
      ])
  const effectiveMaxRelays = input.maxRelays ?? DEFAULT_READ_FANOUT
  const candidateRelayUrls = config.e2eRelayIsolationEnabled
    ? normalizePublicOrIsolatedE2eRelayHints(plannedRelayUrls)
    : plannedRelayUrls
  const executableRelayUrls = candidateRelayUrls
  const candidateRelayUrlSet = new Set(candidateRelayUrls)
  const candidateRelayTargets = mergeRelayTargets(
    plan.relayTargets,
    configuredRelayTargets(
      {
        kind: "public_fallback",
        operation: "read",
        bucket: "commerce_discovery",
      },
      fallbackRelayUrls
    ),
    configuredRelayTargets(
      { kind: "public_fallback", operation: "read", bucket: "core_public" },
      fallbackRelayUrls
    ),
    configuredRelayTargets(
      { kind: "public_fallback", operation: "read", bucket: "default" },
      fallbackRelayUrls
    ),
    relayTargetsFromUrls(publicExternalRelayHints, {
      kind: "public_hint",
      operation: "read",
    })
  ).filter((target) => candidateRelayUrlSet.has(target.url))
  const authenticatedOwner = input.authenticatedPubkey?.trim().toLowerCase()
  const policyAccount = accountPubkey?.trim().toLowerCase()
  const includesAuthenticatedOwner = Boolean(
    authenticatedOwner &&
    [...(input.authors ?? []), ...(input.recipients ?? [])].some(
      (pubkey) => pubkey.trim().toLowerCase() === authenticatedOwner
    )
  )
  const ownerSelectedRelayUrls =
    authenticatedOwner && authenticatedOwner === policyAccount
      ? normalizeOwnerSelectedRelayUrls(
          settingsSnapshot.settings.entries.flatMap((entry) =>
            entry.readEnabled ||
            (includesAuthenticatedOwner && entry.writeEnabled)
              ? [entry.url]
              : []
          )
        ).filter((relayUrl) => candidateRelayUrlSet.has(relayUrl))
      : []
  const appRelayUrlSet = new Set([
    ...(plan.appRelayUrls ?? []),
    ...fallbackRelayUrls,
  ])
  const independentRelayUrlSet = new Set([
    ...(plan.independentRelayUrls ?? []),
    ...publicExternalRelayHints,
  ])

  if (
    config.e2eRelayIsolationEnabled ||
    protectedInboxIntent ||
    executableRelayUrls.length > 0 ||
    (settingsSnapshot.signedRelayListAuthoritative &&
      !preservesPublicCommerceDiscovery)
  ) {
    return {
      relayUrls: executableRelayUrls,
      relayTargets: candidateRelayTargets,
      candidateRelayUrls,
      ...(effectiveMaxRelays > 0
        ? { maxRelayAttempts: effectiveMaxRelays }
        : {}),
      parkedRelayUrls: plan.parkedRelayUrls.filter(
        (relayUrl) => !candidateRelayUrlSet.has(relayUrl)
      ),
      hintRelayUrls: plan.hintRelayUrls,
      ownerSelectedRelayUrls,
      appRelayUrls: candidateRelayUrls.filter((relayUrl) =>
        appRelayUrlSet.has(relayUrl)
      ),
      personalRelayUrls: ownerSelectedRelayUrls,
      independentRelayUrls: candidateRelayUrls.filter((relayUrl) =>
        independentRelayUrlSet.has(relayUrl)
      ),
      relayLists,
      relayListResolutionStates: relayListResult.resolutionStates,
      relayListLookupIncomplete,
    }
  }

  // Defensive fallback: legacy resolution paths.
  switch (input.intent) {
    case "commerce_products":
    case "author_products": {
      const relayUrls = commerceReadRelayUrls()
      const relayUrlSet = new Set(relayUrls)
      const candidateRelayUrls = commerceReadRelayUrls()
      return {
        relayUrls,
        relayTargets: configuredRelayTargets(
          {
            kind: "public_fallback",
            operation: "read",
            bucket: "commerce_discovery",
          },
          candidateRelayUrls
        ),
        candidateRelayUrls,
        ...(effectiveMaxRelays > 0
          ? { maxRelayAttempts: effectiveMaxRelays }
          : {}),
        parkedRelayUrls: plan.parkedRelayUrls.filter(
          (relayUrl) => !relayUrlSet.has(relayUrl)
        ),
        hintRelayUrls: plan.hintRelayUrls,
        ownerSelectedRelayUrls: [],
        appRelayUrls: candidateRelayUrls,
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayLists,
        relayListResolutionStates: relayListResult.resolutionStates,
        relayListLookupIncomplete,
      }
    }
    default: {
      const relayUrls = publicReadRelayUrls()
      const relayUrlSet = new Set(relayUrls)
      const candidateRelayUrls = publicReadRelayUrls()
      return {
        relayUrls,
        relayTargets: configuredRelayTargets(
          {
            kind: "public_fallback",
            operation: "read",
            bucket: "default",
          },
          candidateRelayUrls
        ),
        candidateRelayUrls,
        ...(effectiveMaxRelays > 0
          ? { maxRelayAttempts: effectiveMaxRelays }
          : {}),
        parkedRelayUrls: plan.parkedRelayUrls.filter(
          (relayUrl) => !relayUrlSet.has(relayUrl)
        ),
        hintRelayUrls: plan.hintRelayUrls,
        ownerSelectedRelayUrls: [],
        appRelayUrls: candidateRelayUrls,
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayLists,
        relayListResolutionStates: relayListResult.resolutionStates,
        relayListLookupIncomplete,
      }
    }
  }
}
