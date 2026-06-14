/**
 * NIP-02 contact-list helpers.
 *
 * Contact lists are replaceable events with `p` tags for followed pubkeys.
 * These helpers stay deliberately bounded: they interpret known contact-list
 * events, but do not attempt expensive reverse follower discovery.
 */

import { NDKEvent } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS } from "./kinds"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { requireNdkConnected } from "./ndk"
import { publishWithPlanner } from "./relay-publish"
import {
  ReplaceablePublishSafetyError,
  assertSafeReplaceablePublish,
} from "./replaceable-safety"

export type FollowListEventLike = {
  pubkey?: string
  created_at?: number
  content?: string
  tags?: readonly (readonly string[])[]
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
  return Array.from(events).sort(
    (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
  )[0]
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
    nextTags.push(["p", normalizedTargetPubkey])
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

export async function publishContactListUpdate({
  ownerPubkey,
  targetPubkey,
  shouldFollow,
  appId,
}: {
  ownerPubkey: string
  targetPubkey: string
  shouldFollow: boolean
  appId: ConduitAppId
}): Promise<void> {
  const normalizedOwnerPubkey = normalizeHexPubkey(ownerPubkey)
  const normalizedTargetPubkey = normalizeHexPubkey(targetPubkey)

  if (!normalizedOwnerPubkey || !normalizedTargetPubkey) {
    throw new Error("Cannot update a follow list with an invalid pubkey")
  }

  const ndk = await requireNdkConnected()
  if (!ndk.signer) throw new Error("Signer not connected")

  const signerPubkey = normalizeHexPubkey((await ndk.signer.user()).pubkey)
  if (signerPubkey !== normalizedOwnerPubkey) {
    throw new Error("Active signer does not match this follow list")
  }

  const existingEvents = await ndk.fetchEvents({
    kinds: [EVENT_KINDS.CONTACT_LIST],
    authors: [normalizedOwnerPubkey],
    limit: 10,
  })
  const latest = selectLatestFollowListEvent(existingEvents)

  if (!latest) {
    throw new ReplaceablePublishSafetyError(
      "Refusing to publish a new tiny follow list without loading an existing contact-list snapshot."
    )
  }

  const nextTags = buildContactListUpdateTags({
    currentTags: latest.tags,
    targetPubkey: normalizedTargetPubkey,
    shouldFollow,
  })

  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.CONTACT_LIST
  event.created_at = Math.floor(Date.now() / 1000)
  event.content = latest.content ?? ""
  event.tags = appendConduitClientTag(nextTags, appId)

  const replaceableSafety = {
    contactList: {
      enforceMinimumPubkeys: false,
    },
  }

  assertSafeReplaceablePublish(event, replaceableSafety)
  await event.sign(ndk.signer)
  await publishWithPlanner(event, {
    intent: "author_event",
    authorPubkey: normalizedOwnerPubkey,
    replaceableSafety,
  })
}
