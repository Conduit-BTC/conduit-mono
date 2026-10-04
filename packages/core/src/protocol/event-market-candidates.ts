import type { NDKFilter, NDKKind } from "@nostr-dev-kit/ndk"
import type { EventMarketReadPlan } from "./event-market"
import type { FetchEventsFanoutOptions } from "./ndk"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

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
  pendingCoordinates: string[]
}

/** Fair, bounded NIP-01 paging; a full timestamp boundary is never skipped. */
export async function scanEventMarketCandidates(input: {
  authors?: readonly string[]
  accountPubkey?: string | null
  plan: EventMarketReadPlan
  options: FetchEventsFanoutOptions
  continuation?: EventMarketDiscoveryContinuation
  fetch: (
    filter: NDKFilter,
    options: FetchEventsFanoutOptions
  ) => Promise<{
    events: SignedPublicNostrEvent[]
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
  incomplete: boolean
  available: boolean
}> {
  const relays = input.plan.relayUrls
  const scope = JSON.stringify([
    input.accountPubkey ?? null,
    input.authors ?? null,
    relays,
  ])
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
  const remaining: CandidatePage[] = []
  let requests = 0
  let incomplete =
    input.plan.relayHintTruncated || (batches.length > 0 && relays.length === 0)
  let available = false
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length && requests < 128) {
        input.assertCurrent()
        const page = queue.shift()!
        const authorSet = page.authors ? new Set(page.authors) : undefined
        requests++
        const limit = page.boundary ? 513 : 129
        const filter: NDKFilter = {
          kinds: [30409 as NDKKind],
          ...(page.authors ? { authors: page.authors } : {}),
          ...(page.until !== undefined ? { until: page.until } : {}),
          ...(page.boundary ? { since: page.until } : {}),
          limit,
        }
        try {
          const result = await input.fetch(filter, {
            ...input.options,
            relayUrls: [page.relayUrl],
            maxRelayAttempts: 1,
            connectTimeoutMs: 1_200,
            fetchTimeoutMs: 2_500,
          })
          input.assertCurrent()
          const status = result.relays.find(
            (relay) => relay.relayUrl === page.relayUrl
          )?.status
          available ||= status === "success" || status === "partial"
          const events = result.events.filter(
            (event) =>
              event.kind === 30409 &&
              (!authorSet || authorSet.has(event.pubkey)) &&
              (page.until === undefined || event.created_at <= page.until) &&
              (!page.boundary || event.created_at === page.until) &&
              isValidSignedPublicNostrEvent(event)
          )
          if (events.length !== result.events.length) incomplete = true
          await input.observe(events, page.relayUrl)
          input.assertCurrent()
          if (status !== "success" || events.length !== result.events.length) {
            incomplete = true
            remaining.push(page)
          } else if (result.events.length >= limit - 1) {
            if (!page.boundary && events.length)
              queue.push({
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
            queue.push({ ...page, until: page.until! - 1, boundary: false })
          }
        } catch {
          input.assertCurrent()
          incomplete = true
          remaining.push(page)
        }
      }
    })
  )
  input.assertCurrent()
  return { scope, pages: [...queue, ...remaining], incomplete, available }
}
