import type { QueryClient } from "@tanstack/react-query"
import {
  getLocalProductDeletionSnapshot,
  reconcileProductRecordsWithDeletions,
  subscribeLocalProductDeletionChanges,
  type LocalProductDeletionSnapshot,
} from "@conduit/core"
import type { RawEventCatalog } from "./event-market-adapter"

/** Local evidence changes do not restart relay reads or renew their freshness. */
export function reconcileEventCatalog(
  raw: RawEventCatalog,
  snapshot: LocalProductDeletionSnapshot
): RawEventCatalog {
  const data = raw.result
    ? reconcileProductRecordsWithDeletions(raw.result.data, snapshot.evidence)
    : undefined
  const previewRecords = raw.previewRecords
    ? reconcileProductRecordsWithDeletions(
        raw.previewRecords,
        snapshot.evidence
      )
    : undefined
  const localEvidencePending = snapshot.status === "loading"
  if (
    data === raw.result?.data &&
    previewRecords === raw.previewRecords &&
    !!raw.localEvidencePending === localEvidencePending
  )
    return raw
  const retainedCoordinates = new Set(
    data?.flatMap((record) => [
      record.addressId,
      ...(record.family?.children.map((child) => child.addressId) ?? []),
    ])
  )
  const removedCoordinates = new Set(
    raw.result?.data
      .flatMap((record) => [
        record.addressId,
        ...(record.family?.children.map((child) => child.addressId) ?? []),
      ])
      .filter((coordinate) => !retainedCoordinates.has(coordinate))
  )
  return {
    ...raw,
    localEvidencePending: localEvidencePending || undefined,
    result:
      raw.result && data
        ? {
            ...raw.result,
            data,
            diagnostics: raw.result.diagnostics.map((diagnostic) =>
              removedCoordinates.has(
                diagnostic.addressId ?? diagnostic.productId
              )
                ? { ...diagnostic, issue: "listing_filtered" as const }
                : diagnostic
            ),
          }
        : raw.result,
    previewRecords,
  }
}

const bridges = new WeakMap<QueryClient, ReturnType<typeof createBridge>>()

function createBridge(client: QueryClient) {
  let snapshot = getLocalProductDeletionSnapshot()
  let stop: (() => void) | undefined
  let updating = false
  let starting = false
  const queries = () =>
    client.getQueryCache().findAll({ queryKey: ["event-market"] })
  const reconcile = (raw: RawEventCatalog) =>
    reconcileEventCatalog(raw, snapshot)
  const update = () => {
    if (updating) return
    updating = true
    try {
      for (const query of queries()) {
        const raw = query.state.data as RawEventCatalog | undefined
        if (!raw) continue
        const next = reconcile(raw)
        if (next !== raw) query.setState({ data: next })
      }
    } finally {
      updating = false
    }
  }
  const start = () => {
    if (stop || starting) return
    starting = true
    // Subscribe before a read or a retained cache entry can be observed.
    stop = subscribeLocalProductDeletionChanges((next) => {
      snapshot = next
      update()
    })
    starting = false
  }
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== "event-market") return
    if (event.type === "removed" && queries().length === 0) {
      stop?.()
      stop = undefined
    } else if (
      event.type === "added" ||
      (event.type === "updated" &&
        (event.action.type === "success" || event.action.type === "setState"))
    ) {
      start()
      update()
    }
  })
  if (queries().length > 0) {
    start()
    update()
  }
  return {
    reconcile,
    async settled() {
      if (snapshot.status !== "loading") return
      await new Promise<void>((resolve) => {
        const release = subscribeLocalProductDeletionChanges((next) => {
          if (next.status !== "loading") {
            // The subscription may synchronously deliver the current snapshot.
            queueMicrotask(() => {
              release()
              resolve()
            })
          }
        })
      })
    },
  }
}

export function eventCatalogCacheCoherence(client: QueryClient) {
  let bridge = bridges.get(client)
  if (!bridge) {
    bridge = createBridge(client)
    bridges.set(client, bridge)
  }
  return bridge
}
