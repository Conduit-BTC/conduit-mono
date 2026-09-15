import { describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  resolveEventMarketEvidence,
  type DiscoverPerspectiveEventMarketsInput,
  type PerspectiveEventMarketDiscoveryResult,
} from "@conduit/core"
import {
  eventTimelineQueryOptions,
  getEventTimelineQueryDisplayState,
} from "../src/lib/event-timeline-query"

const organizer = "a".repeat(64)
const perspective = {
  source: "conduit",
  coverage: "complete",
  eventObserved: false,
  snapshotState: "curated",
  truncated: false,
} as const
const input = {
  organizerPubkeys: [organizer],
  perspective,
  includeEnded: true,
  authenticatedPubkey: null,
}
const key = [
  "market-event-timeline",
  "relay-a",
  null,
  1,
  "conduit",
  organizer,
  organizer,
  "complete",
  false,
  "curated",
  false,
] as const

function snapshot(
  names: string[] = [],
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
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
type Progress = NonNullable<DiscoverPerspectiveEventMarketsInput["onProgress"]>
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("progressive event timeline queries", () => {
  it("shows cache and completed-organizer snapshots before a held discovery finishes", async () => {
    const client = new QueryClient()
    const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
    let emit!: Progress
    const options = eventTimelineQueryOptions(
      client,
      key,
      input,
      () => true,
      async (request) => {
        emit = request.onProgress!
        return pending.promise
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    emit(snapshot())
    expect(observer.getCurrentResult().isPending).toBe(false)
    expect(
      getEventTimelineQueryDisplayState(observer.getCurrentResult())
        .isInitialLoading
    ).toBe(true)
    emit(snapshot(["cached"], "complete"))
    expect(observer.getCurrentResult().data?.state).toBe("partial")
    expect(observer.getCurrentResult().isStale).toBe(true)
    expect(observer.getCurrentResult().data?.markets).toHaveLength(1)
    expect(observer.getCurrentResult().isFetching).toBe(true)
    expect(
      getEventTimelineQueryDisplayState(observer.getCurrentResult())
        .isInitialLoading
    ).toBe(false)
    emit(snapshot(["cached", "completed-organizer"]))
    expect(observer.getCurrentResult().data?.markets).toHaveLength(2)
    expect(observer.getCurrentResult().isFetching).toBe(true)
    pending.resolve(snapshot(["cached", "completed-organizer"], "complete"))
    await tick()
    expect(observer.getCurrentResult().data?.state).toBe("complete")
    expect(observer.getCurrentResult().isStale).toBe(false)
    expect(observer.getCurrentResult().isFetching).toBe(false)
    stop()
    client.clear()
  })

  it("retains progressive cards after a read fails and rejects post-failure emissions", async () => {
    const client = new QueryClient()
    const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
    let emit!: Progress
    const options = eventTimelineQueryOptions(
      client,
      key,
      input,
      () => true,
      async (request) => {
        emit = request.onProgress!
        return pending.promise
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    emit(snapshot(["cached"]))
    pending.reject(new Error("bounded discovery unavailable"))
    await tick()
    expect(observer.getCurrentResult().isError).toBe(true)
    expect(observer.getCurrentResult().data?.markets).toHaveLength(1)
    expect(
      getEventTimelineQueryDisplayState(observer.getCurrentResult())
    ).toEqual({ isInitialLoading: false, isRefreshStale: true })
    emit(snapshot(["late", "incorrect"]))
    expect(observer.getCurrentResult().data?.markets).toHaveLength(1)
    stop()
    client.clear()
  })

  it("stops accepting callbacks once final discovery has settled", async () => {
    const client = new QueryClient()
    let emit!: Progress
    const options = eventTimelineQueryOptions(
      client,
      key,
      input,
      () => true,
      async (request) => {
        emit = request.onProgress!
        return snapshot(["final"], "complete")
      }
    )
    await client.fetchQuery(options)
    emit(snapshot(["late"]))
    expect(
      client.getQueryData(options.queryKey)?.markets[0]?.reference
    ).toEndWith(":final")
    expect(client.getQueryData(options.queryKey)?.state).toBe("complete")
    client.clear()
  })

  for (const changed of ["account", "relay"] as const) {
    it(`ignores late progress and final results after a ${changed} scope switch`, async () => {
      const client = new QueryClient()
      const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
      let emit!: Progress
      let currentScope = "original"
      const options = eventTimelineQueryOptions(
        client,
        key,
        input,
        () => currentScope === "original",
        async (request) => {
          emit = request.onProgress!
          return pending.promise
        }
      )
      const running = client.fetchQuery(options)
      emit(snapshot(["original"]))
      currentScope = changed
      const nextKey =
        changed === "account"
          ? [...key.slice(0, 2), "b".repeat(64), 2, ...key.slice(4)]
          : [key[0], "relay-b", ...key.slice(2)]
      client.setQueryData(nextKey, snapshot(["new-scope"]))
      emit(snapshot(["wrong", "scope"]))
      pending.resolve(snapshot(["wrong-final"], "complete"))
      await expect(running).rejects.toThrow("cancelled")
      expect(
        client.getQueryData(options.queryKey)?.markets[0]?.reference
      ).toEndWith(":original")
      expect(
        client.getQueryData<PerspectiveEventMarketDiscoveryResult>(nextKey)
          ?.markets[0]?.reference
      ).toEndWith(":new-scope")
      client.clear()
    })
  }

  it("uses cumulative retractions and keeps empty progress loading until settled", async () => {
    const client = new QueryClient()
    const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
    let emit!: Progress
    const options = eventTimelineQueryOptions(
      client,
      key,
      input,
      () => true,
      async (request) => {
        emit = request.onProgress!
        return pending.promise
      }
    )
    const observer = new QueryObserver(client, options)
    const stop = observer.subscribe(() => {})
    emit(snapshot(["removed-by-newer-evidence"]))
    emit(snapshot())
    expect(observer.getCurrentResult().data?.markets).toHaveLength(0)
    expect(
      getEventTimelineQueryDisplayState(observer.getCurrentResult())
        .isInitialLoading
    ).toBe(true)
    pending.resolve(snapshot([], "complete_empty"))
    await tick()
    expect(
      getEventTimelineQueryDisplayState(observer.getCurrentResult())
        .isInitialLoading
    ).toBe(false)
    expect(observer.getCurrentResult().data?.state).toBe("complete_empty")
    stop()
    client.clear()
  })

  it("cancels only after the last observer leaves and ignores transport late completions", async () => {
    const client = new QueryClient()
    const pending = deferred<PerspectiveEventMarketDiscoveryResult>()
    let emit!: Progress
    let signal!: AbortSignal
    const options = eventTimelineQueryOptions(
      client,
      key,
      input,
      () => true,
      async (request) => {
        emit = request.onProgress!
        signal = request.signal!
        return pending.promise
      }
    )
    const first = new QueryObserver(client, options)
    const second = new QueryObserver(client, options)
    const stopFirst = first.subscribe(() => {})
    const stopSecond = second.subscribe(() => {})
    stopFirst()
    expect(signal.aborted).toBe(false)
    stopSecond()
    expect(signal.aborted).toBe(true)
    emit(snapshot(["late"]))
    pending.resolve(snapshot(["late-final"], "complete"))
    await tick()
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    client.clear()
  })
})
