import type { PublicReadScope } from "./public-feed-read-scope"
import type { Filter } from "nostr-tools"
import type { CachedProfile } from "../db"
import type { Profile } from "../types"
import type {
  CommerceFreshnessMeta,
  CommerceQueryMeta,
  ProfileBatchQuery,
  ProfileBatchResult,
} from "./commerce"
import { loadCachedProducts } from "./commerce-product-cache"
import { EVENT_KINDS } from "./kinds"
import {
  projectProfileContent,
  areProfileProjectionsEqual,
  mergeRicherProfile,
  projectCachedProfile,
  reduceCachedProfileRows,
  createSelectedProfileContext,
  loadProfileCacheSnapshot,
  retainSelectedProfileRows as storeCachedProfiles,
  hasKnownProfileFrontier,
  hasValidProfileEventContent,
  projectProfilePaymentAuthority,
  retainedProfileFrontierState,
  type ProfileFrontierState,
  type SelectedProfileContext,
} from "./profile-cache"
import type { RelayTarget } from "./relay-authority"
import type { RelayListResolutionState } from "./relay-list"
import {
  fetchPublicEventsProgressive,
  getEventSourceRelayUrls,
  type PublicRelayReadOptions,
} from "./relay-reader"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import type { VerifiedNostrEvent } from "./verified-public-event"

type ContextualRelayHints = {
  publicRelayUrls: string[]
  authenticatedAuthorRelayUrls: string[]
}

/** Existing parser, relay admission and metadata remain composed by commerce.ts. */
export interface ProfileReadDependencies {
  readonly parseProfileEvent: (event: VerifiedNostrEvent) => Profile
  readonly planProfileReadRelays: (input: {
    readScope?: PublicReadScope
    intent: "profiles"
    authors: readonly string[]
    paymentProfileEvidence: boolean
    authenticatedPubkey?: string | null
    accountPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
    maxRelays: number
    extraRelayUrls: readonly string[]
    authenticatedAuthorRelayUrls: readonly string[]
  }) => Promise<{
    candidateRelayUrls: string[]
    relayTargets: RelayTarget[]
    maxRelayAttempts?: number
    hintRelayUrls: string[]
    relayListResolutionStates: ReadonlyMap<string, RelayListResolutionState>
    relayListLookupIncomplete: boolean
    parkedRelayUrls: string[]
  }>
  readonly fetchEvents: (
    filter: Filter,
    options?: PublicRelayReadOptions
  ) => Promise<VerifiedNostrEvent[]>
  readonly fetchEventsDetailed: (
    filter: Filter,
    options?: PublicRelayReadOptions
  ) => Promise<{
    events: VerifiedNostrEvent[]
    degraded: boolean
    capped: boolean
    completedRelayUrls: string[]
  }>
  readonly contextualRelayHints: (
    entries: readonly { pubkey: string; relayUrls: readonly string[] }[],
    authenticatedPubkey: string | null | undefined
  ) => ContextualRelayHints
  // Consult current overrides at their original await boundaries.
  readonly getAccountNetworkLocalStateRepository: () => PublicRelayReadOptions["accountNetworkLocalStateRepository"]
  readonly hasFetchPublicEventsOverride: () => boolean
  readonly createMeta: (
    source: "public" | "local_cache",
    options?: Partial<CommerceFreshnessMeta>
  ) => CommerceQueryMeta
  readonly now: () => number
}

const PROFILE_CACHE_TTL_MS = 5 * 60_000

function uniqueStrings(
  values: readonly (string | undefined | null)[]
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])
  )
}

function mergeContextualRelayHints(
  ...hints: readonly ContextualRelayHints[]
): ContextualRelayHints {
  return {
    publicRelayUrls: uniqueStrings(
      hints.flatMap((hint) => hint.publicRelayUrls)
    ),
    authenticatedAuthorRelayUrls: uniqueStrings(
      hints.flatMap((hint) => hint.authenticatedAuthorRelayUrls)
    ),
  }
}

async function loadProductSourceRelayHints(
  contextualRelayHints: ProfileReadDependencies["contextualRelayHints"],
  pubkeys: readonly string[],
  authenticatedPubkey?: string | null
): Promise<ContextualRelayHints> {
  const uniquePubkeys = uniqueStrings(pubkeys)
  if (uniquePubkeys.length === 0) {
    return { publicRelayUrls: [], authenticatedAuthorRelayUrls: [] }
  }

  const rowsByPubkey = await Promise.all(
    uniquePubkeys.map(async (pubkey) => ({
      pubkey,
      rows: await loadCachedProducts(pubkey),
    }))
  )

  return contextualRelayHints(
    rowsByPubkey.map(({ pubkey, rows }) => ({
      pubkey,
      relayUrls: rows.flatMap((row) => row.sourceRelayUrls ?? []),
    })),
    authenticatedPubkey
  )
}

function getProfileQueryRelayHints(
  contextualRelayHints: ProfileReadDependencies["contextualRelayHints"],
  query: ProfileBatchQuery
): ContextualRelayHints {
  return contextualRelayHints(
    query.pubkeys.map((pubkey) => ({
      pubkey,
      relayUrls: query.relayHintsByPubkey?.[pubkey] ?? [],
    })),
    query.authenticatedPubkey
  )
}

function hasProfileContent(
  profile: Pick<
    CachedProfile,
    | "name"
    | "displayName"
    | "about"
    | "picture"
    | "banner"
    | "nip05"
    | "lud16"
    | "website"
  >
): boolean {
  return [
    profile.name,
    profile.displayName,
    profile.about,
    profile.picture,
    profile.banner,
    profile.nip05,
    profile.lud16,
    profile.website,
  ].some((value) => typeof value === "string" && value.trim().length > 0)
}

function compareReplaceableProfileEvents(
  a: SignedPublicNostrEvent,
  b: SignedPublicNostrEvent
): number {
  const createdAt = (b.created_at ?? 0) - (a.created_at ?? 0)
  if (createdAt !== 0) return createdAt
  return (a.id || "\uffff").localeCompare(b.id || "\uffff")
}

function pickLatestProfileEvent(
  events: readonly VerifiedNostrEvent[],
  pubkey: string
): VerifiedNostrEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey)
    .sort(compareReplaceableProfileEvents)[0]
}

function pickLatestProfileEventWithContent(
  parseProfileEvent: ProfileReadDependencies["parseProfileEvent"],
  events: readonly VerifiedNostrEvent[],
  pubkey: string
): VerifiedNostrEvent | undefined {
  return events
    .filter((event) => event.pubkey === pubkey)
    .sort(compareReplaceableProfileEvents)
    .find((event) => hasProfileContent(parseProfileEvent(event)))
}

function mergeProfileEvents(
  dependencies: Pick<ProfileReadDependencies, "parseProfileEvent" | "now">,
  pubkeys: readonly string[],
  currentProfiles: Record<string, Profile>,
  events: readonly VerifiedNostrEvent[],
  currentRows: ReadonlyMap<string, CachedProfile> = new Map()
): {
  profiles: Record<string, Profile>
  rowsToCache: CachedProfile[]
  hasResolvedProfile: boolean
  hasInvalidLatestProfile: boolean
  profileFrontierStates: Record<string, ProfileFrontierState>
} {
  const { parseProfileEvent, now } = dependencies

  const profiles = { ...currentProfiles }
  const rowsToCache: CachedProfile[] = []
  const profileFrontierStates: Record<string, ProfileFrontierState> = {}
  let hasResolvedProfile = false
  let hasInvalidLatestProfile = false

  for (const pubkey of pubkeys) {
    const event = pickLatestProfileEventWithContent(
      parseProfileEvent,
      events,
      pubkey
    )
    const latestEvent = pickLatestProfileEvent(events, pubkey)
    const currentRow = currentRows.get(pubkey)
    const currentFrontier = currentRow?.eventCreatedAt ?? -1
    const latestEventCreatedAt = latestEvent?.created_at ?? -1
    const latestEventWins =
      !!latestEvent &&
      (latestEventCreatedAt > currentFrontier ||
        (latestEventCreatedAt === currentFrontier &&
          (latestEvent.id || "\uffff") < (currentRow?.eventId || "\uffff")))
    const frontier = latestEventWins ? latestEvent : undefined
    const exactCurrentFrontierObserved =
      !!latestEvent?.id &&
      latestEventCreatedAt === currentFrontier &&
      latestEvent.id === currentRow?.eventId
    const currentProjection = currentRow
      ? projectProfilePaymentAuthority(currentRow)
      : undefined
    const currentFrontierWins =
      currentRow?.eventCreatedAt !== undefined &&
      (!latestEvent ||
        latestEventCreatedAt < currentFrontier ||
        (latestEventCreatedAt === currentFrontier &&
          (currentRow.eventId || "\uffff") <= (latestEvent.id || "\uffff")))
    const effectiveFrontierContent =
      latestEventWins || exactCurrentFrontierObserved
        ? latestEvent?.content
        : currentFrontierWins
          ? currentRow?.rawContent
          : undefined
    if (
      effectiveFrontierContent !== undefined &&
      !hasValidProfileEventContent(effectiveFrontierContent)
    ) {
      hasInvalidLatestProfile = true
    }
    const richProfile = exactCurrentFrontierObserved
      ? mergeRicherProfile(
          undefined,
          event ? parseProfileEvent(event) : { pubkey }
        )
      : mergeRicherProfile(
          profiles[pubkey] ?? currentProjection,
          currentFrontierWins
            ? undefined
            : event
              ? parseProfileEvent(event)
              : { pubkey }
        )
    // Display identity may retain richer older fields, but a Lightning
    // destination is action authority and must reflect the exact effective
    // kind-0 frontier. A newer valid profile that removes lud16 must never
    // inherit the obsolete address from display/cache enrichment.
    const profile =
      effectiveFrontierContent !== undefined
        ? {
            ...(richProfile ?? { pubkey }),
            // An invalid exact frontier cannot authorize an older retained
            // payment destination. Keep richer identity fields for display,
            // but clear lud16 unless the current frontier parses safely.
            lud16: hasValidProfileEventContent(effectiveFrontierContent)
              ? projectProfileContent(pubkey, effectiveFrontierContent).lud16
              : undefined,
          }
        : richProfile
    const sourceRelayUrls = uniqueStrings([
      ...(currentRow?.sourceRelayUrls ?? []),
      ...(event ? getEventSourceRelayUrls(event) : []),
      ...(latestEvent ? getEventSourceRelayUrls(latestEvent) : []),
    ])
    profiles[pubkey] = profile ?? { pubkey }
    const observedFrontier =
      frontier ?? (exactCurrentFrontierObserved ? latestEvent : undefined)
    profileFrontierStates[pubkey] = !observedFrontier
      ? retainedProfileFrontierState(currentRow)
      : hasValidProfileEventContent(observedFrontier.content)
        ? "observed_valid"
        : "observed_malformed"
    if (
      observedFrontier ||
      hasKnownProfileFrontier(currentRow) ||
      (profile && hasProfileContent(profile))
    ) {
      if (event) hasResolvedProfile = true
      const cachedProfile = profile ?? { pubkey }
      rowsToCache.push({
        pubkey: cachedProfile.pubkey,
        name: cachedProfile.name,
        displayName: cachedProfile.displayName,
        about: cachedProfile.about,
        picture: cachedProfile.picture,
        banner: cachedProfile.banner,
        nip05: cachedProfile.nip05,
        lud16: cachedProfile.lud16,
        website: cachedProfile.website,
        rawContent: observedFrontier?.content ?? currentRow?.rawContent,
        eventId: observedFrontier?.id || currentRow?.eventId,
        eventCreatedAt:
          observedFrontier?.created_at ?? currentRow?.eventCreatedAt,
        sourceRelayUrls:
          sourceRelayUrls.length > 0 ? sourceRelayUrls : undefined,
        cachedAt: now(),
      })
    }
  }

  return {
    profiles,
    rowsToCache,
    hasResolvedProfile,
    hasInvalidLatestProfile,
    profileFrontierStates,
  }
}

export async function getProfiles(
  query: ProfileBatchQuery,
  dependencies: ProfileReadDependencies
): Promise<ProfileBatchResult> {
  if (
    query.readScope === "public_feed" &&
    (query.evidenceScope === "payment" ||
      query.evidenceScope === "profile_edit" ||
      query.authorRelayPaymentPolicy)
  ) {
    throw new TypeError(
      "Public feed profiles cannot supply payment or profile-edit authority."
    )
  }
  const {
    now,
    createMeta,
    planProfileReadRelays: planCommerceReadRelayPlan,
    fetchEvents: runFetchEventsFanout,
    fetchEventsDetailed: runFetchEventsFanoutDetailed,
  } = dependencies

  const pubkeys = Array.from(
    new Set(query.pubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  const result: Record<string, Profile> = {}
  const missing: string[] = []

  if (pubkeys.length === 0) {
    return {
      data: result,
      profileContexts: {},
      meta: createMeta("public"),
    }
  }

  // A forced refresh must bypass cached display data without forgetting the
  // durable replaceable-event frontier. Otherwise a narrower relay view can
  // regress raw kind-0 publish context and silently delete unchanged fields.
  const initialCacheSnapshot = await loadProfileCacheSnapshot(pubkeys)
  let profileStorageAvailable = initialCacheSnapshot.storageAvailable
  const retainedCachedRows = initialCacheSnapshot.rows
  const cachedRows = query.skipCache ? [] : retainedCachedRows
  const cachedRowsByPubkey = new Map(
    retainedCachedRows.flatMap((row) =>
      row ? ([[row.pubkey, row]] as const) : []
    )
  )
  const buildContexts = (
    selectedRows: ReadonlyMap<string, CachedProfile>,
    liveRows: ReadonlyMap<string, CachedProfile> = new Map(),
    readComplete = false,
    progressing = false
  ): Record<string, SelectedProfileContext> =>
    Object.fromEntries(
      pubkeys.map((pubkey) => {
        const row = selectedRows.get(pubkey)
        const live = liveRows.get(pubkey)
        const observed =
          !!row?.eventId &&
          row.eventId === live?.eventId &&
          row.eventCreatedAt === live.eventCreatedAt
        return [
          pubkey,
          createSelectedProfileContext({
            pubkey,
            row,
            profile: result[pubkey],
            observed: observed && query.readScope !== "public_feed",
            readComplete:
              readComplete && (row ? observed : profileStorageAvailable),
            storageAvailable: profileStorageAvailable,
            ...(progressing && observed
              ? { persistence: "unknown" as const }
              : {}),
          }),
        ]
      })
    )
  pubkeys.forEach((pubkey, index) => {
    const cached = cachedRows[index]
    const isAuthenticatedOwner =
      !!query.authenticatedPubkey &&
      pubkey.toLowerCase() === query.authenticatedPubkey.trim().toLowerCase()
    if (
      cached &&
      hasProfileContent(cached) &&
      !isAuthenticatedOwner &&
      !query.requireCompleteEvidence &&
      now() - cached.cachedAt < PROFILE_CACHE_TTL_MS
    ) {
      result[pubkey] = projectProfilePaymentAuthority(cached)
    } else {
      if (cached && hasProfileContent(cached)) {
        result[pubkey] = projectProfilePaymentAuthority(cached)
      }
      missing.push(pubkey)
    }
  })

  if (missing.length === 0) {
    return {
      data: result,
      profileContexts: buildContexts(cachedRowsByPubkey),
      meta: {
        ...createMeta("local_cache", {
          stale: false,
        }),
        profileFrontierStates: Object.fromEntries(
          pubkeys.map((pubkey) => [
            pubkey,
            retainedProfileFrontierState(cachedRowsByPubkey.get(pubkey)),
          ])
        ),
      },
    }
  }

  if (
    query.onProgress &&
    Object.values(result).some((profile) => hasProfileContent(profile))
  ) {
    query.onProgress({
      data: { ...result },
      profileContexts: buildContexts(cachedRowsByPubkey),
      meta: createMeta("local_cache", {
        stale: true,
      }),
    })
  }

  try {
    const visible = query.priority !== "background"
    const profileQueryRelayHints = getProfileQueryRelayHints(
      dependencies.contextualRelayHints,
      {
        ...query,
        pubkeys: missing,
      }
    )
    // Ordinary display reads use current caller hints, not the accumulated
    // delivery sources of unrelated cached products. Strict profile discovery
    // remains unchanged; product provenance never authorizes payment profiles.
    const ordinaryDisplayRead =
      !query.requireCompleteEvidence &&
      query.evidenceScope !== "payment" &&
      query.evidenceScope !== "profile_edit"
    const sourceRelayHints =
      query.evidenceScope === "payment" || ordinaryDisplayRead
        ? profileQueryRelayHints
        : mergeContextualRelayHints(
            profileQueryRelayHints,
            await loadProductSourceRelayHints(
              dependencies.contextualRelayHints,
              missing,
              query.authenticatedPubkey
            )
          )
    const authorCriticalPaymentRead =
      query.readScope !== "public_feed" &&
      query.authorRelayPaymentPolicy === true &&
      query.requireCompleteEvidence === true &&
      query.evidenceScope === "payment" &&
      missing.length === 1
    const relayPlan = await planCommerceReadRelayPlan({
      readScope: query.readScope,
      intent: "profiles",
      authors: missing,
      paymentProfileEvidence: authorCriticalPaymentRead,
      authenticatedPubkey: query.authenticatedPubkey,
      accountPubkey: query.accountPubkey,
      shouldContinue: query.shouldContinue,
      signal: query.signal,
      maxRelays: query.readPolicy?.maxRelays ?? (visible ? 8 : 4),
      extraRelayUrls: sourceRelayHints.publicRelayUrls,
      authenticatedAuthorRelayUrls:
        sourceRelayHints.authenticatedAuthorRelayUrls,
    })
    const profileFilter: Filter = {
      kinds: [EVENT_KINDS.PROFILE],
      authors: missing,
      limit: Math.max(10, missing.length * 3),
    }
    const knownAuthorRelayUrls = authorCriticalPaymentRead
      ? relayPlan.hintRelayUrls
      : []
    const authorRelayListState = authorCriticalPaymentRead
      ? relayPlan.relayListResolutionStates.get(missing[0]!)
      : undefined
    const authorRelayListReady = authorRelayListState === "network"
    const candidateRelayUrlSet = new Set(relayPlan.candidateRelayUrls)
    // A single merchant's signed payment profile is read from all known
    // NIP-65 author write relays first. Additive routes may discover a
    // newer signed frontier on viewer/app relays, but those opportunistic
    // relays do not define payment-read completion. No author write hints
    // means no payment authority in this branch-only rehearsal.
    const admittedAuthorRelayUrls = knownAuthorRelayUrls.filter((relayUrl) =>
      candidateRelayUrlSet.has(relayUrl)
    )
    const authorRelayUrlSet = new Set(knownAuthorRelayUrls)
    const optionalPaymentRelayUrls = relayPlan.candidateRelayUrls.filter(
      (relayUrl) => !authorRelayUrlSet.has(relayUrl)
    )
    const paymentReadRelayUrls =
      authorCriticalPaymentRead && knownAuthorRelayUrls.length > 0
        ? [...admittedAuthorRelayUrls, ...optionalPaymentRelayUrls]
        : relayPlan.candidateRelayUrls
    const paymentReadRelayUrlSet = new Set(paymentReadRelayUrls)
    const fanoutOptions = {
      requireAllRequestedRelays: query.readScope === "public_feed",
      relayUrls: paymentReadRelayUrls,
      relayTargets: relayPlan.relayTargets.filter((target) =>
        paymentReadRelayUrlSet.has(target.url)
      ),
      maxRelayAttempts: relayPlan.maxRelayAttempts,
      accountPubkey: query.accountPubkey ?? query.authenticatedPubkey,
      authenticatedPubkey: query.authenticatedPubkey,
      accountNetworkLocalStateRepository:
        dependencies.getAccountNetworkLocalStateRepository(),
      shouldContinue: query.shouldContinue,
      signal: query.signal,
      connectTimeoutMs:
        query.readPolicy?.connectTimeoutMs ?? (visible ? 1_500 : 3_000),
      fetchTimeoutMs:
        query.readPolicy?.fetchTimeoutMs ?? (visible ? 3_000 : 6_000),
      // The planner already applied relay health. Strict evidence reads must
      // execute that exact surviving set rather than silently filtering it a
      // second time at the transport boundary.
      skipHealthFilter: query.requireCompleteEvidence ? true : undefined,
    }
    const emitProgress = (events: readonly VerifiedNostrEvent[]) => {
      if (!query.onProgress) return

      const progress = mergeProfileEvents(
        dependencies,
        missing,
        result,
        events,
        cachedRowsByPubkey
      )
      if (!progress.hasResolvedProfile) return

      const retained = Object.values(progress.profileFrontierStates).some(
        (state) => state === "retained_valid" || state === "retained_malformed"
      )
      query.onProgress({
        data: progress.profiles,
        profileContexts: buildContexts(
          new Map([
            ...cachedRowsByPubkey,
            ...progress.rowsToCache.map((row) => [row.pubkey, row] as const),
          ]),
          new Map(
            mergeProfileEvents(
              dependencies,
              missing,
              {},
              events
            ).rowsToCache.map((row) => [row.pubkey, row])
          ),
          false,
          true
        ),
        meta: {
          ...createMeta(retained ? "local_cache" : "public", {
            stale: retained,
          }),
          profileFrontierStates: progress.profileFrontierStates,
        },
      })
    }
    let evidenceDegraded =
      query.requireCompleteEvidence &&
      (authorCriticalPaymentRead
        ? !authorRelayListReady ||
          relayPlan.relayListLookupIncomplete ||
          knownAuthorRelayUrls.length === 0 ||
          knownAuthorRelayUrls.some(
            (relayUrl) => !candidateRelayUrlSet.has(relayUrl)
          )
        : relayPlan.parkedRelayUrls.length > 0)
    // Concurrency does not truncate sources. Actual event saturation and
    // missing required completion below still prevent complete evidence.
    let evidenceCapped = false
    let events: VerifiedNostrEvent[]
    if (query.requireCompleteEvidence || query.readScope === "public_feed") {
      const evidence = await runFetchEventsFanoutDetailed(profileFilter, {
        ...fanoutOptions,
        ...(query.readScope === "public_feed" &&
        !query.requireCompleteEvidence &&
        query.onProgress &&
        !dependencies.hasFetchPublicEventsOverride()
          ? {
              onRelayProgress: ({ mergedEvents }) => emitProgress(mergedEvents),
            }
          : {}),
      })
      events = evidence.events
      evidenceDegraded =
        evidenceDegraded ||
        (authorCriticalPaymentRead && knownAuthorRelayUrls.length > 0
          ? knownAuthorRelayUrls.some(
              (relayUrl) => !evidence.completedRelayUrls.includes(relayUrl)
            )
          : evidence.degraded)
      evidenceCapped = evidenceCapped || evidence.capped
      emitProgress(events)
    } else {
      events =
        query.onProgress && !dependencies.hasFetchPublicEventsOverride()
          ? await fetchPublicEventsProgressive(
              profileFilter,
              fanoutOptions,
              ({ mergedEvents }) => emitProgress(mergedEvents)
            )
          : await runFetchEventsFanout(profileFilter, fanoutOptions)

      if (query.onProgress && dependencies.hasFetchPublicEventsOverride()) {
        emitProgress(events)
      }
    }

    const {
      profiles,
      rowsToCache,
      hasInvalidLatestProfile,
      profileFrontierStates,
    } = mergeProfileEvents(
      dependencies,
      missing,
      result,
      events,
      cachedRowsByPubkey
    )
    // A fully observed malformed kind-0 must stay unusable as payment or
    // display authority, but it cannot permanently lock its owner out of the
    // repair surface. Only an explicitly complete profile-edit read may
    // ignore that malformed frontier; partial reads remain degraded.
    const canRepairMalformedProfile =
      query.evidenceScope === "profile_edit" && query.requireCompleteEvidence
    if (!canRepairMalformedProfile) {
      evidenceDegraded = evidenceDegraded || hasInvalidLatestProfile
    }
    const liveRowsByPubkey = new Map(
      mergeProfileEvents(dependencies, missing, {}, events).rowsToCache.map(
        (row) => [row.pubkey, row]
      )
    )
    let cacheRetention:
      Awaited<ReturnType<typeof storeCachedProfiles>> | undefined

    if (rowsToCache.length > 0) {
      cacheRetention = await storeCachedProfiles(rowsToCache)
    }
    // Authors with no candidate did not enter the cache transaction. Another
    // reader may have retained their frontier while this network read was empty.
    const candidatePubkeys = new Set(rowsToCache.map((row) => row.pubkey))
    const withoutCandidates = missing.filter(
      (pubkey) => !candidatePubkeys.has(pubkey)
    )
    if (withoutCandidates.length > 0) {
      const concurrentSnapshot =
        await loadProfileCacheSnapshot(withoutCandidates)
      profileStorageAvailable =
        profileStorageAvailable && concurrentSnapshot.storageAvailable
      const concurrentRows = concurrentSnapshot.rows.filter(
        (row): row is CachedProfile => !!row
      )
      if (concurrentRows.length > 0) {
        cacheRetention = {
          ...cacheRetention,
          rows: [...(cacheRetention?.rows ?? []), ...concurrentRows],
          displacedPubkeys: cacheRetention?.displacedPubkeys ?? new Set(),
        }
      }
    }
    for (const row of cacheRetention?.rows ?? []) {
      profiles[row.pubkey] = projectProfilePaymentAuthority(row)
      const liveRow = liveRowsByPubkey.get(row.pubkey)
      if (
        !liveRow ||
        row.eventId !== liveRow.eventId ||
        row.eventCreatedAt !== liveRow.eventCreatedAt
      ) {
        profileFrontierStates[row.pubkey] = retainedProfileFrontierState(row)
      }
    }
    const networkReadComplete =
      query.readScope !== "public_feed" &&
      !!query.requireCompleteEvidence &&
      !evidenceDegraded &&
      !evidenceCapped
    evidenceDegraded =
      evidenceDegraded ||
      !!cacheRetention?.persistenceFailed ||
      !profileStorageAvailable
    Object.assign(result, profiles)

    const displaced = (cacheRetention?.displacedPubkeys.size ?? 0) > 0
    const missingPubkeys = new Set(missing)
    const usesFreshCachedResult = pubkeys.some(
      (pubkey) =>
        !missingPubkeys.has(pubkey) && hasProfileContent(result[pubkey])
    )
    const usesUnconfirmedCachedResult =
      cacheRetention?.rows.some((row) => {
        if (!hasProfileContent(row) && !hasKnownProfileFrontier(row))
          return false
        const liveRow = liveRowsByPubkey.get(row.pubkey)
        return (
          !liveRow ||
          row.eventId !== liveRow.eventId ||
          row.eventCreatedAt !== liveRow.eventCreatedAt ||
          (query.evidenceScope === "payment"
            ? row.lud16 !== liveRow.lud16
            : query.evidenceScope === "profile_edit"
              ? false
              : !areProfileProjectionsEqual(
                  projectCachedProfile(row),
                  projectCachedProfile(liveRow)
                ))
        )
      }) ?? false
    const dependsOnCache = usesFreshCachedResult || usesUnconfirmedCachedResult
    const stale = displaced || usesUnconfirmedCachedResult
    const profileContexts = buildContexts(
      new Map([
        ...cachedRowsByPubkey,
        ...(cacheRetention?.rows ?? []).map(
          (row) => [row.pubkey, row] as const
        ),
      ]),
      liveRowsByPubkey,
      networkReadComplete
    )
    if (query.evidenceScope === "payment") {
      for (const [pubkey, context] of Object.entries(profileContexts)) {
        const frontier = context.frontier
        if (context.freshness !== "observed" || !frontier) continue
        const signed = events.find(
          (candidate) => candidate.id === frontier.eventId
        )
        if (
          !signed ||
          signed.kind !== EVENT_KINDS.PROFILE ||
          signed.pubkey !== pubkey ||
          signed.created_at !== frontier.eventCreatedAt ||
          signed.content !== frontier.rawContent ||
          !isValidSignedPublicNostrEvent(signed)
        )
          continue
        // The cache commit can select a newer frontier while this read awaits.
        // Carry only that final exact observed event, not an earlier display source.
        context.signedEvent = {
          id: signed.id,
          pubkey: signed.pubkey,
          created_at: signed.created_at,
          kind: signed.kind,
          tags: signed.tags.map((tag) => [...tag]),
          content: signed.content,
          sig: signed.sig,
        }
      }
    }

    return {
      data: result,
      profileContexts,
      meta: {
        ...createMeta(dependsOnCache ? "local_cache" : "public", {
          stale,
          degraded: stale || evidenceDegraded,
          capped: evidenceCapped,
        }),
        profileFrontierStates,
      },
    }
  } catch (error) {
    if (query.shouldContinue?.() === false) throw error
    const latestSnapshot = await loadProfileCacheSnapshot(pubkeys)
    profileStorageAvailable =
      profileStorageAvailable && latestSnapshot.storageAvailable
    const latestRows = latestSnapshot.rows
    const retainedRows = reduceCachedProfileRows(
      [
        ...cachedRowsByPubkey.values(),
        ...latestRows.filter((row): row is CachedProfile => !!row),
      ],
      []
    ).rows
    const retained = mergeProfileEvents(
      dependencies,
      pubkeys,
      result,
      [],
      new Map(retainedRows.map((row) => [row.pubkey, row]))
    )
    const hasAnyCached =
      Object.keys(result).length > 0 || retainedRows.some((row) => !!row)
    if (hasAnyCached || !profileStorageAvailable) {
      return {
        data: retained.profiles,
        profileContexts: buildContexts(
          new Map(retainedRows.map((row) => [row.pubkey, row]))
        ),
        meta: {
          ...createMeta("local_cache", {
            stale: true,
          }),
          profileFrontierStates: retained.profileFrontierStates,
        },
      }
    }
    throw error
  }
}
