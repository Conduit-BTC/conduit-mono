import { describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  resolveEventMarketEvidence,
  type DiscoverPerspectiveEventMarketsInput,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"
import {
  getSettledMerchantEventMarketRead,
  merchantEventMarketQueryIdentity,
  merchantEventMarketQueryOptions,
  merchantEventTimelineQueryOptions,
  type MerchantEventMarketQueryLoaderOptions,
  type MerchantEventMarketQueryScope,
} from "../src/lib/merchant-event-query"
import type { MerchantOrganizerEventMarketDeletion } from "../src/lib/event-market"

const organizer = "a".repeat(64)
const collectionCoordinate = `30405:${organizer}:summer-market`
const scope: MerchantEventMarketQueryScope = {
  relayScope: "relay-a",
  authenticatedPubkey: null,
  authGeneration: 1,
}

function deletedRead(
  eventId = "1".repeat(64)
): MerchantOrganizerEventMarketDeletion {
  return {
    terminal: true,
    state: "deleted",
    organizerPubkey: organizer,
    collectionCoordinate,
    collectionCreatedAt: 100,
    collectionEventId: eventId,
    deletion: {
      record: "collection",
      coordinate: collectionCoordinate,
      eventId,
      createdAt: 100,
      deletions: [
        {
          deletionEventId: "d".repeat(64),
          deletionCreatedAt: 101,
          authorPubkey: organizer,
          eventTargets: [eventId],
          addressableTargets: [collectionCoordinate],
        },
      ],
    },
    naddr: encodeEventMarketNaddr(collectionCoordinate),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("merchant event market query", () => {
  it("canonicalizes coordinate hints within the account and relay scope", () => {
    const first = encodeEventMarketNaddr(collectionCoordinate, [
      "wss://relay-b.example",
      "wss://relay-a.example",
      "wss://relay-a.example",
    ])
    const second = encodeEventMarketNaddr(collectionCoordinate, [
      "wss://relay-a.example",
      "wss://relay-b.example",
    ])
    const firstIdentity = merchantEventMarketQueryIdentity(first, scope)
    const secondIdentity = merchantEventMarketQueryIdentity(second, scope)

    expect(firstIdentity.queryKey).toEqual(secondIdentity.queryKey)
    expect(firstIdentity.organizerPubkey).toBe(organizer)
    expect(
      decodeEventMarketReference(firstIdentity.reference, [30405])?.relayHints
    ).toEqual(["wss://relay-a.example", "wss://relay-b.example"])
    expect(
      merchantEventMarketQueryIdentity(first, {
        ...scope,
        authGeneration: 2,
      }).queryKey
    ).not.toEqual(firstIdentity.queryKey)
  })

  it("paints progress as non-authoritative data and caches the settled read", async () => {
    const client = new QueryClient()
    const pending = deferred<MerchantOrganizerEventMarketDeletion>()
    let loaderOptions!: MerchantEventMarketQueryLoaderOptions
    const options = merchantEventMarketQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async (_reference, received) => {
        loaderOptions = received
        return pending.promise
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})

    const preview = deletedRead("2".repeat(64))
    loaderOptions.onProgress(preview)
    expect(observer.getCurrentResult().data).toEqual({
      read: preview,
      complete: false,
    })
    expect(getSettledMerchantEventMarketRead(observer.getCurrentResult())).toBe(
      null
    )
    expect(observer.getCurrentResult().isStale).toBe(true)
    expect(loaderOptions.organizerPubkey).toBe(organizer)

    const settled = deletedRead("3".repeat(64))
    pending.resolve(settled)
    await tick()
    expect(observer.getCurrentResult().data).toEqual({
      read: settled,
      complete: true,
    })
    expect(
      getSettledMerchantEventMarketRead(observer.getCurrentResult())
    ).toEqual(settled)
    expect(observer.getCurrentResult().isStale).toBe(false)
    expect(options.gcTime).toBe(30 * 60_000)
    expect(options.retry).toBe(false)

    loaderOptions.onProgress(deletedRead("4".repeat(64)))
    expect(observer.getCurrentResult().data?.read).toEqual(settled)
    stop()
    client.clear()
  })

  it("deduplicates concurrent reads for the same scoped coordinate and hints", async () => {
    const client = new QueryClient()
    const pending = deferred<MerchantOrganizerEventMarketDeletion>()
    let reads = 0
    const loader = async () => {
      reads += 1
      return pending.promise
    }
    const first = merchantEventMarketQueryOptions(
      client,
      encodeEventMarketNaddr(collectionCoordinate, [
        "wss://relay-b.example",
        "wss://relay-a.example",
      ]),
      scope,
      () => true,
      loader
    )
    const second = merchantEventMarketQueryOptions(
      client,
      encodeEventMarketNaddr(collectionCoordinate, [
        "wss://relay-a.example",
        "wss://relay-b.example",
      ]),
      scope,
      () => true,
      loader
    )

    const firstRead = client.fetchQuery(first)
    const secondRead = client.fetchQuery(second)
    expect(reads).toBe(1)
    pending.resolve(deletedRead())
    await Promise.all([firstRead, secondRead])
    expect(reads).toBe(1)
    client.clear()
  })
})

const perspective = {
  source: "conduit",
  coverage: "complete",
  eventObserved: false,
  snapshotState: "curated",
  truncated: false,
} as const

function timelineSnapshot(
  names: string[],
  state: PerspectiveEventMarketDiscoveryResult["state"] = "partial"
): PerspectiveEventMarketDiscoveryResult {
  return {
    markets: names.map((name) =>
      resolveEventMarketEvidence({ reference: `30405:${organizer}:${name}` })
    ),
    state,
    perspective: { ...perspective, authorCount: 1 },
    candidateCollectionCount: names.length,
    candidateScanState: "partial",
    candidateScanCoverage: {
      plannedRelayUrls: [],
      authorChunkCount: 0,
      plannedReadCount: 0,
      requestCount: 0,
      skippedReadCount: 0,
      executionBoundedReadCount: 0,
      reads: [],
      completeReadCount: 0,
      partialReadCount: 0,
      failedReadCount: 0,
      mainPageCount: 0,
      boundaryPageCount: 0,
      saturatedPageCount: 0,
      pageBudgetExhaustedReadCount: 0,
      verificationTruncatedReadCount: 0,
    },
    searchedOrganizerCount: 0,
    incompleteOrganizerCount: 0,
    failedOrganizerCount: 0,
    boundedOrganizerCount: 0,
    truncated: false,
  }
}

type TimelineProgress = NonNullable<
  DiscoverPerspectiveEventMarketsInput["onProgress"]
>

describe("merchant event timeline query", () => {
  it("renders cumulative discovery progress before the final timeline settles", async () => {
    const client = new QueryClient()
    const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
    let emit!: TimelineProgress
    const key = ["merchant-event-timeline", "relay-a", null, 1] as const
    const options = merchantEventTimelineQueryOptions(
      client,
      key,
      {
        organizerPubkeys: [organizer],
        perspective,
        includeEnded: true,
        authenticatedPubkey: null,
      },
      () => true,
      async (input) => {
        emit = input.onProgress!
        return pending.promise
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})

    emit(timelineSnapshot(["cached"], "complete"))
    expect(observer.getCurrentResult().data?.state).toBe("partial")
    expect(observer.getCurrentResult().data?.markets).toHaveLength(1)
    expect(observer.getCurrentResult().isStale).toBe(true)

    const finalSnapshot = timelineSnapshot(["cached", "network"], "complete")
    pending.resolve(finalSnapshot)
    await tick()
    expect(observer.getCurrentResult().data).toEqual(finalSnapshot)
    expect(observer.getCurrentResult().isStale).toBe(false)

    emit(timelineSnapshot(["late"]))
    expect(observer.getCurrentResult().data).toEqual(finalSnapshot)
    stop()
    client.clear()
  })
})
