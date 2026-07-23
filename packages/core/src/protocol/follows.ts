/**
 * NIP-02 contact-list helpers.
 *
 * Contact lists are replaceable events with `p` tags for followed pubkeys.
 * These helpers stay deliberately bounded: they interpret known contact-list
 * events, but do not attempt expensive reverse follower discovery.
 */

import NDK, { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS } from "./kinds"
import { buildConduitClientTag, type ConduitAppId } from "./nip89"
import {
  fetchEventsFanoutDetailed,
  requireNdkConnected,
  type FetchEventsFanoutResult,
} from "./ndk"
import {
  getRelayLists,
  parseRelayListEvent,
  type RelayList,
} from "./relay-list"
import { planRelayReads, planRelayWrites } from "./relay-planner"
import { publishWithPlanner } from "./relay-publish"
import {
  ReplaceablePublishSafetyError,
  assertSafeReplaceablePublish,
} from "./replaceable-safety"

export type FollowListEventLike = {
  id?: string
  kind?: number
  pubkey?: string
  created_at?: number
  content?: string
  tags?: readonly (readonly string[])[]
}

export type ContactListSnapshot =
  | { state: "found"; event: FollowListEventLike }
  | { state: "confirmed_absent" }
  | { state: "unavailable" }

interface FollowTestOverrides {
  requireNdkConnected?: typeof requireNdkConnected
  getRelayLists?: typeof getRelayLists
  fetchEventsFanoutDetailed?: typeof fetchEventsFanoutDetailed
  createEvent?: (ndk: NDK) => NDKEvent
  signEvent?: (event: NDKEvent, signer: NDKSigner) => Promise<void>
  publishWithPlanner?: typeof publishWithPlanner
  now?: () => number
}

let testOverrides: FollowTestOverrides = {}

export function __setFollowTestOverrides(
  overrides: Partial<FollowTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetFollowTestOverrides(): void {
  testOverrides = {}
}

export interface MerchantTrustSocialSummary {
  merchantFollowingCount: number
  viewerFollowsMerchant: boolean | null
  merchantFollowsViewer: boolean | null
  mutualFollowCount: number | null
}

function normalizeHexPubkey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed || !/^[0-9a-f]{64}$/.test(trimmed)) return null
  return trimmed
}

export function extractFollowPubkeys(
  tags: readonly (readonly string[])[] | undefined
): string[] {
  const seen = new Set<string>()

  for (const tag of tags ?? []) {
    if (tag[0] !== "p") continue
    const pubkey = normalizeHexPubkey(tag[1])
    if (pubkey) seen.add(pubkey)
  }

  return Array.from(seen)
}

export function selectLatestFollowListEvent<T extends FollowListEventLike>(
  events: Iterable<T>
): T | undefined {
  return Array.from(events).sort((a, b) => {
    const timestampDifference = (b.created_at ?? 0) - (a.created_at ?? 0)
    if (timestampDifference !== 0) return timestampDifference
    return (a.id ?? "").localeCompare(b.id ?? "")
  })[0]
}

export function classifyContactListSnapshot(
  result: FetchEventsFanoutResult,
  ownerPubkey: string
): ContactListSnapshot {
  if (
    result.relays.length === 0 ||
    result.relays.some((relay) => relay.status !== "success")
  ) {
    return { state: "unavailable" }
  }

  const event = selectLatestFollowListEvent(
    result.events.filter(
      (candidate) =>
        candidate.kind === EVENT_KINDS.CONTACT_LIST &&
        normalizeHexPubkey(candidate.pubkey) === ownerPubkey
    )
  )
  return event ? { state: "found", event } : { state: "confirmed_absent" }
}

export function getFollowListPubkeySet(
  event: FollowListEventLike | null | undefined
): Set<string> {
  return new Set(extractFollowPubkeys(event?.tags))
}

export function buildMerchantTrustSocialSummary({
  viewerFollowPubkeys,
  merchantFollowPubkeys,
  merchantPubkey,
  viewerPubkey,
}: {
  viewerFollowPubkeys?: Iterable<string> | null
  merchantFollowPubkeys?: Iterable<string> | null
  merchantPubkey: string
  viewerPubkey?: string | null
}): MerchantTrustSocialSummary {
  const normalizedMerchantPubkey = normalizeHexPubkey(merchantPubkey)
  const normalizedViewerPubkey = normalizeHexPubkey(viewerPubkey ?? undefined)
  const viewerFollows = new Set(
    Array.from(viewerFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  const merchantFollows = new Set(
    Array.from(merchantFollowPubkeys ?? [])
      .map((pubkey) => normalizeHexPubkey(pubkey))
      .filter(Boolean) as string[]
  )
  let mutualFollowCount: number | null = null

  if (viewerFollowPubkeys && merchantFollowPubkeys) {
    mutualFollowCount = 0
    for (const pubkey of viewerFollows) {
      if (merchantFollows.has(pubkey)) mutualFollowCount += 1
    }
  }

  return {
    merchantFollowingCount: merchantFollows.size,
    viewerFollowsMerchant:
      normalizedMerchantPubkey && viewerFollowPubkeys
        ? viewerFollows.has(normalizedMerchantPubkey)
        : null,
    merchantFollowsViewer:
      normalizedViewerPubkey && merchantFollowPubkeys
        ? merchantFollows.has(normalizedViewerPubkey)
        : null,
    mutualFollowCount,
  }
}

function copyMutableTags(
  tags: readonly (readonly string[])[] | undefined
): string[][] {
  return (tags ?? []).map((tag) => [...tag])
}

export function buildContactListUpdateTags({
  currentTags,
  targetPubkey,
  shouldFollow,
}: {
  currentTags: readonly (readonly string[])[] | undefined
  targetPubkey: string
  shouldFollow: boolean
}): string[][] {
  const normalizedTargetPubkey = normalizeHexPubkey(targetPubkey)
  if (!normalizedTargetPubkey) {
    throw new Error("Cannot update a follow list with an invalid target pubkey")
  }

  const nextTags = copyMutableTags(currentTags)
  const currentFollowPubkeys = getFollowListPubkeySet({ tags: currentTags })
  const alreadyFollowing = currentFollowPubkeys.has(normalizedTargetPubkey)

  if (shouldFollow && !alreadyFollowing) {
    nextTags.push(["p", normalizedTargetPubkey, ""])
  }
  if (!shouldFollow && alreadyFollowing) {
    for (let index = nextTags.length - 1; index >= 0; index -= 1) {
      const tag = nextTags[index]
      if (
        tag[0] === "p" &&
        normalizeHexPubkey(tag[1]) === normalizedTargetPubkey
      ) {
        nextTags.splice(index, 1)
      }
    }
  }

  return nextTags
}

function appendClientTagWithoutReplacingExisting(
  tags: string[][],
  appId: ConduitAppId
): string[][] {
  const clientTag = buildConduitClientTag(appId)
  if (!clientTag) return tags
  if (tags.some((tag) => JSON.stringify(tag) === JSON.stringify(clientTag))) {
    return tags
  }
  return [...tags, clientTag]
}

type LoadedContactListSnapshot = {
  snapshot: ContactListSnapshot
  publishRelayUrls: string[]
}

async function loadContactListSnapshot(
  ownerPubkey: string
): Promise<LoadedContactListSnapshot> {
  const resolveRelayLists = testOverrides.getRelayLists ?? getRelayLists
  const cachedRelayLists = await resolveRelayLists([ownerPubkey], {
    cacheOnly: true,
    allowInsecureRelayUrlsForPubkey: ownerPubkey,
  })
  const discoveryPlan = planRelayReads({
    intent: "relay_lists",
    authenticatedPubkey: ownerPubkey,
    maxRelays: 0,
    skipHealthFilter: true,
  })
  if (discoveryPlan.relayUrls.length === 0) {
    return { snapshot: { state: "unavailable" }, publishRelayUrls: [] }
  }

  const fetchDetailed =
    testOverrides.fetchEventsFanoutDetailed ?? fetchEventsFanoutDetailed
  const relayListResult = await fetchCompleteSnapshot(
    fetchDetailed,
    {
      kinds: [EVENT_KINDS.RELAY_LIST],
      authors: [ownerPubkey],
      limit: 5,
    },
    discoveryPlan.relayUrls
  )
  if (relayListResult.state === "unavailable") {
    return { snapshot: relayListResult, publishRelayUrls: [] }
  }

  const relayLists = new Map<string, RelayList>(cachedRelayLists)
  if (relayListResult.state === "found") {
    relayLists.set(
      ownerPubkey,
      parseRelayListEvent(relayListResult.event as NDKEvent)
    )
  }
  const readPlan = planRelayReads({
    intent: "profile_social_feed",
    authors: [ownerPubkey],
    relayLists,
    authenticatedPubkey: ownerPubkey,
    maxRelays: 0,
    skipHealthFilter: true,
  })
  const writePlan = planRelayWrites({
    intent: "author_event",
    authorPubkey: ownerPubkey,
    relayLists,
    authenticatedPubkey: ownerPubkey,
    maxPrimaryRelays: 0,
    skipHealthFilter: true,
  })
  const relayUrls = Array.from(
    new Set([
      ...readPlan.relayUrls,
      ...readPlan.parkedRelayUrls,
      ...writePlan.primaryRelayUrls,
      ...writePlan.parkedRelayUrls,
      ...(relayLists.get(ownerPubkey)?.writeRelayUrls ?? []),
      ...(relayLists.get(ownerPubkey)?.sourceRelayUrls ?? []),
    ])
  )
  if (relayUrls.length === 0) {
    return { snapshot: { state: "unavailable" }, publishRelayUrls: [] }
  }

  return {
    snapshot: await fetchCompleteSnapshot(
      fetchDetailed,
      {
        kinds: [EVENT_KINDS.CONTACT_LIST],
        authors: [ownerPubkey],
        limit: 10,
      },
      relayUrls,
      ownerPubkey
    ),
    publishRelayUrls: Array.from(
      new Set([
        ...(relayLists.get(ownerPubkey)?.writeRelayUrls ?? []),
        ...writePlan.primaryRelayUrls,
      ])
    ),
  }
}

async function fetchCompleteSnapshot(
  fetchDetailed: typeof fetchEventsFanoutDetailed,
  filter: Parameters<typeof fetchEventsFanoutDetailed>[0],
  relayUrls: string[],
  ownerPubkey?: string
): Promise<ContactListSnapshot> {
  const classify = (result: FetchEventsFanoutResult): ContactListSnapshot => {
    if (ownerPubkey) return classifyContactListSnapshot(result, ownerPubkey)
    if (
      result.relays.length === 0 ||
      result.relays.some((relay) => relay.status !== "success")
    ) {
      return { state: "unavailable" }
    }
    const event = selectLatestFollowListEvent(
      result.events.filter(
        (candidate) =>
          candidate.kind === EVENT_KINDS.RELAY_LIST &&
          normalizeHexPubkey(candidate.pubkey) === filter.authors?.[0]
      )
    )
    return event ? { state: "found", event } : { state: "confirmed_absent" }
  }
  const first = classify(
    await fetchDetailed(filter, {
      relayUrls,
      connectTimeoutMs: 3_000,
      fetchTimeoutMs: 6_000,
      skipHealthFilter: true,
    })
  )
  if (first.state !== "unavailable") return first
  return classify(
    await fetchDetailed(filter, {
      relayUrls,
      connectTimeoutMs: 5_000,
      fetchTimeoutMs: 10_000,
      skipHealthFilter: true,
    })
  )
}

export async function publishContactListUpdate({
  ownerPubkey,
  targetPubkey,
  shouldFollow,
  appId,
  isSessionCurrent,
}: {
  ownerPubkey: string
  targetPubkey: string
  shouldFollow: boolean
  appId: ConduitAppId
  isSessionCurrent?: () => boolean
}): Promise<void> {
  const normalizedOwnerPubkey = normalizeHexPubkey(ownerPubkey)
  const normalizedTargetPubkey = normalizeHexPubkey(targetPubkey)

  if (!normalizedOwnerPubkey || !normalizedTargetPubkey) {
    throw new Error("Cannot update a follow list with an invalid pubkey")
  }

  const connectNdk = testOverrides.requireNdkConnected ?? requireNdkConnected
  const ndk = await connectNdk()
  if (!ndk.signer) throw new Error("Signer not connected")
  const signer = ndk.signer

  const signerPubkey = normalizeHexPubkey((await signer.user()).pubkey)
  if (signerPubkey !== normalizedOwnerPubkey) {
    throw new Error("Active signer does not match this follow list")
  }

  const loaded = await loadContactListSnapshot(normalizedOwnerPubkey)
  const { snapshot } = loaded
  if (snapshot.state === "unavailable") {
    throw new ReplaceablePublishSafetyError(
      "Could not load the complete follow list from its relays. Check your connection and try again."
    )
  }
  if (snapshot.state === "confirmed_absent" && !shouldFollow) return

  const assertCurrentSignerSession = () => {
    if (ndk.signer !== signer || isSessionCurrent?.() === false) {
      throw new Error("Signer session changed while updating the follow list")
    }
  }
  assertCurrentSignerSession()

  const latest = snapshot.state === "found" ? snapshot.event : undefined

  const nextTags = buildContactListUpdateTags({
    currentTags: latest?.tags,
    targetPubkey: normalizedTargetPubkey,
    shouldFollow,
  })

  const nowSeconds = Math.floor((testOverrides.now?.() ?? Date.now()) / 1_000)
  const latestCreatedAt = latest?.created_at ?? 0
  if (latestCreatedAt >= nowSeconds + 5 * 60) {
    throw new ReplaceablePublishSafetyError(
      "The loaded follow list is dated too far in the future to update safely."
    )
  }

  const event = testOverrides.createEvent?.(ndk) ?? new NDKEvent(ndk)
  event.kind = EVENT_KINDS.CONTACT_LIST
  event.created_at = Math.max(nowSeconds, latestCreatedAt + 1)
  event.content = latest?.content ?? ""
  event.tags = appendClientTagWithoutReplacingExisting(nextTags, appId)

  const replaceableSafety = {
    contactList: {
      enforceMinimumPubkeys: false,
    },
  }

  assertSafeReplaceablePublish(event, replaceableSafety)
  assertCurrentSignerSession()
  if (testOverrides.signEvent) {
    await testOverrides.signEvent(event, signer)
  } else {
    await event.sign(signer)
  }
  assertCurrentSignerSession()
  const publish = testOverrides.publishWithPlanner ?? publishWithPlanner
  await publish(event, {
    intent: "author_event",
    authorPubkey: normalizedOwnerPubkey,
    authenticatedPubkey: normalizedOwnerPubkey,
    extraRelayUrls: loaded.publishRelayUrls,
    shouldContinue: () => {
      try {
        assertCurrentSignerSession()
        return true
      } catch {
        return false
      }
    },
    replaceableSafety,
  })
}
