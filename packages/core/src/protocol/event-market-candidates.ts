import type { Filter } from "nostr-tools"
import type { EventMarketReadPlan } from "./event-market"
import {
  verifySignedEventBatches,
  type PublicRelayReadOptions,
} from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"

interface CandidatePage {
  relayUrl: string
  authors?: string[]
  until?: number
  boundary?: boolean
}

export interface EventMarketDiscoveryContinuation {
  /** Prevent reuse across an audience, account, or selected-relay change. */
  scope: string
  pages: CandidatePage[]
  /** Keep the same distinct admitted relay budget across continuation. */
  admittedRelayUrls?: string[]
  /** Coordinate-specific observed sources, retained under the same scope. */
  pendingCoordinates: Array<{ coordinate: string; relayHints: string[] }>
}

export function getEventMarketDiscoveryScope(input: {
  authors?: readonly string[]
  accountPubkey?: string | null
  plan: EventMarketReadPlan
}): string {
  return JSON.stringify([
    input.accountPubkey ?? null,
    input.authors ?? null,
    input.plan.relayUrls,
    input.plan.maxRelayAttempts ?? null,
  ])
}

/** Fair, bounded NIP-01 paging; a full timestamp boundary is never skipped. */
export async function scanEventMarketCandidates(input: {
  authors?: readonly string[]
  accountPubkey?: string | null
  plan: EventMarketReadPlan
  options: PublicRelayReadOptions
  continuation?: EventMarketDiscoveryContinuation
  fetch: (
    filter: Filter,
    options: PublicRelayReadOptions
  ) => Promise<{
    events: SignedPublicNostrEvent[]
    admittedRelayUrls?: string[]
    relays: Array<{
      relayUrl: string
      status: "success" | "partial" | "failed"
    }>
  }>
  observe: (events: SignedPublicNostrEvent[], relayUrl: string) => Promise<void>
  assertCurrent: () => void
}): Promise<{
  scope: string
  pages: CandidatePage[]
  admittedRelayUrls: string[]
  incomplete: boolean
  available: boolean
}> {
  const relays = input.plan.relayUrls
  const scope = getEventMarketDiscoveryScope(input)
  const prior =
    input.continuation?.scope === scope ? input.continuation : undefined
  const batches: Array<string[] | undefined> =
    input.authors === undefined ? [undefined] : []
  for (let offset = 0; offset < (input.authors?.length ?? 0); offset += 64)
    batches.push(input.authors!.slice(offset, offset + 64))
  // Visit every author batch before spending another request on older records.
  const queue: CandidatePage[] = prior
    ? [...prior.pages]
    : batches.flatMap((authors) =>
        relays.map((relayUrl) => ({ relayUrl, authors }))
      )
  const pageKey = (page: CandidatePage) =>
    JSON.stringify([
      page.relayUrl,
      page.authors ?? null,
      page.until ?? null,
      !!page.boundary,
    ])
  const scheduledPages = new Set(queue.map(pageKey))
  const enqueue = (page: CandidatePage) => {
    const key = pageKey(page)
    if (scheduledPages.has(key)) return
    scheduledPages.add(key)
    queue.push(page)
  }
  const remaining: CandidatePage[] = []
  const admittedRelays = new Set(prior?.admittedRelayUrls ?? [])
  const suppressedRelays = new Set<string>()
  const selecting = new Map<string, Promise<void>>()
  const maxRelays = input.plan.maxRelayAttempts ?? Infinity
  let requests = 0
  let incomplete =
    input.plan.relayHintTruncated || (batches.length > 0 && relays.length === 0)
  let available = false
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length && requests < 128) {
        input.assertCurrent()
        const page = queue.shift()!
        // Reserve distinct first admissions before yielding. The shared reader
        // decides eligibility; denied candidates release their reservation.
        let release: (() => void) | undefined
        while (
          !admittedRelays.has(page.relayUrl) &&
          !suppressedRelays.has(page.relayUrl)
        ) {
          const selection = selecting.get(page.relayUrl)
          if (selection) await selection
          else if (admittedRelays.size + selecting.size < maxRelays) {
            selecting.set(
              page.relayUrl,
              new Promise<void>((resolve) => {
                release = resolve
              })
            )
            break
          } else if (selecting.size) await Promise.race(selecting.values())
          else break
          input.assertCurrent()
        }
        if (
          suppressedRelays.has(page.relayUrl) ||
          (!admittedRelays.has(page.relayUrl) && !release)
        )
          continue
        // Other workers may have spent the request budget while admission waited.
        if (requests >= 128) {
          if (release) {
            selecting.delete(page.relayUrl)
            release()
          }
          queue.unshift(page)
          break
        }
        const authorSet = page.authors ? new Set(page.authors) : undefined
        requests++
        const limit = page.boundary ? 513 : 129
        const filter: Filter = {
          kinds: [30409],
          ...(page.authors ? { authors: page.authors } : {}),
          ...(page.until !== undefined ? { until: page.until } : {}),
          ...(page.boundary ? { since: page.until } : {}),
          limit,
        }
        try {
          input.assertCurrent()
          const result = await input.fetch(filter, {
            ...input.options,
            relayUrls: [page.relayUrl],
            maxRelayAttempts: 1,
            connectTimeoutMs: 1_200,
            fetchTimeoutMs: 2_500,
          })
          input.assertCurrent()
          // The shared reader performs live policy admission immediately before
          // I/O. Legacy injected adapters report their attempted relay statuses.
          const admitted =
            result.admittedRelayUrls ??
            result.relays.map((relay) => relay.relayUrl)
          if (!admitted.includes(page.relayUrl)) {
            suppressedRelays.add(page.relayUrl)
            requests--
            continue
          }
          admittedRelays.add(page.relayUrl)
          const status = result.relays.find(
            (relay) => relay.relayUrl === page.relayUrl
          )?.status
          available ||= status === "success" || status === "partial"
          const verified = await verifySignedEventBatches(result.events, {
            signal: input.options.signal,
          })
          input.assertCurrent()
          const events = verified.filter(
            (event) =>
              event.kind === 30409 &&
              (!authorSet || authorSet.has(event.pubkey)) &&
              (page.until === undefined || event.created_at <= page.until) &&
              (!page.boundary || event.created_at === page.until)
          )
          if (events.length !== result.events.length) incomplete = true
          await input.observe(events, page.relayUrl)
          input.assertCurrent()
          if (status !== "success" || events.length !== result.events.length) {
            incomplete = true
            remaining.push(page)
            // Rejected or unavailable evidence cannot establish completion, but
            // verified timestamps can still lead to older records. Retry the
            // incomplete range while progressing, without duplicating cursors.
            if (events.length) {
              if (!page.boundary)
                enqueue({
                  ...page,
                  until: Math.min(...events.map((event) => event.created_at)),
                  boundary: true,
                })
              else if (page.until! > 0)
                enqueue({ ...page, until: page.until! - 1, boundary: false })
            }
          } else if (result.events.length >= limit - 1) {
            if (!page.boundary && events.length)
              enqueue({
                ...page,
                until: Math.min(...events.map((event) => event.created_at)),
                boundary: true,
              })
            // NIP-01 has no ID cursor: a saturated same-second range cannot be
            // enumerated safely. Keep it retryable rather than jump past it.
            else {
              incomplete = true
              remaining.push(page)
            }
          } else if (page.boundary && page.until! > 0) {
            enqueue({ ...page, until: page.until! - 1, boundary: false })
          }
        } catch {
          // With no terminal admission result, conservatively retain the slot.
          admittedRelays.add(page.relayUrl)
          input.assertCurrent()
          incomplete = true
          remaining.push(page)
        } finally {
          if (release) {
            selecting.delete(page.relayUrl)
            release()
          }
        }
      }
    })
  )
  input.assertCurrent()
  incomplete ||= batches.length > 0 && admittedRelays.size === 0
  return {
    scope,
    pages: [...queue, ...remaining],
    admittedRelayUrls: [...admittedRelays],
    incomplete,
    available,
  }
}
