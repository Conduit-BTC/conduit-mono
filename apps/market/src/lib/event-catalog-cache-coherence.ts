import type { QueryClient } from "@tanstack/react-query"
import {
  getLocalProductDeletionSnapshot,
  getLocalEventMarketEvidenceSnapshot,
  getEventMarketSupersededEvidence,
  subscribeLocalEventMarketEvidenceChanges,
  type LocalEventMarketEvidenceSnapshot,
  reconcileProductRecordsWithRevisions,
  subscribeLocalProductRevisionChanges,
  type CommerceProductRecord,
  type LocalProductRevisionSnapshot,
  reconcileProductRecordsWithDeletions,
  subscribeLocalProductDeletionChanges,
  type LocalProductDeletionSnapshot,
} from "@conduit/core"
import {
  buildPickupFulfillmentTerms,
  type RawEventCatalog,
} from "./event-market-adapter"

/** Local evidence changes do not restart relay reads or renew their freshness. */
export function reconcileEventCatalog(
  raw: RawEventCatalog,
  snapshot: LocalProductDeletionSnapshot,
  revisions: readonly CommerceProductRecord[] = [],
  revisionsPending = false
): RawEventCatalog {
  const revisedData = raw.result
    ? reconcileProductRecordsWithRevisions(raw.result.data, revisions)
    : undefined
  const data = raw.result
    ? reconcileProductRecordsWithDeletions(revisedData!, snapshot.evidence)
    : undefined
  const previewRecords = raw.previewRecords
    ? reconcileProductRecordsWithDeletions(
        reconcileProductRecordsWithRevisions(raw.previewRecords, revisions),
        snapshot.evidence
      )
    : undefined
  const localEvidencePending = snapshot.status === "loading" || revisionsPending
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
  const changedCoordinates = new Set<string>()
  for (const record of raw.result?.data ?? []) {
    const next = revisedData?.find(
      (candidate) => candidate.addressId === record.addressId
    )
    if (next && next !== record) {
      changedCoordinates.add(record.addressId)
      for (const child of record.family?.children ?? [])
        changedCoordinates.add(child.addressId)
      for (const child of next.family?.children ?? [])
        changedCoordinates.add(child.addressId)
    }
  }
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
                : changedCoordinates.has(
                      diagnostic.addressId ?? diagnostic.productId
                    )
                  ? {
                      ...diagnostic,
                      issue: "cached_only" as const,
                      coverage: {
                        deletion:
                          diagnostic.coverage?.deletion ?? "unavailable",
                        listing: "unavailable" as const,
                      },
                    }
                  : diagnostic
            ),
          }
        : raw.result,
    previewRecords,
  }
}

/** Event graph evidence is retained separately from product rows. Revoke only
 * the old dependencies; observing cached new terms never authorizes them. */
export function reconcileEventCatalogGraph(
  raw: RawEventCatalog,
  snapshot: LocalEventMarketEvidenceSnapshot
): RawEventCatalog {
  if (!raw.resolution) return raw
  const records = (raw.result?.data ?? []).flatMap((record) => [
    record,
    ...(record.family?.children ?? []),
  ])
  const superseded = getEventMarketSupersededEvidence(
    raw.resolution,
    snapshot.events,
    records
  )
  const affected = new Set([
    ...superseded.productCoordinates,
    ...superseded.removedProductCoordinates,
  ])
  for (const record of records) {
    const pickup = buildPickupFulfillmentTerms(
      record.product,
      raw.resolution,
      record
    )
    if (
      pickup &&
      superseded.pickupCoordinates.includes(pickup.option.coordinate)
    )
      affected.add(record.addressId)
  }
  const diagnostics = raw.result?.diagnostics.map((diagnostic) =>
    affected.has(diagnostic.addressId ?? diagnostic.productId) &&
    diagnostic.issue !== "cached_only"
      ? {
          ...diagnostic,
          issue: "cached_only" as const,
          coverage: {
            listing: "unavailable" as const,
            deletion: diagnostic.coverage?.deletion ?? ("unavailable" as const),
          },
        }
      : diagnostic
  )
  const pending = !!raw.localEvidencePending || snapshot.status === "loading"
  const sameRemovedProducts =
    (raw.localRemovedProductCoordinates?.length ?? 0) ===
      superseded.removedProductCoordinates.length &&
    superseded.removedProductCoordinates.every(
      (coordinate, index) =>
        raw.localRemovedProductCoordinates?.[index] === coordinate
    )
  if (
    !!raw.localGraphSuperseded === superseded.graph &&
    !!raw.localGraphRevoked === superseded.graphRevoked &&
    sameRemovedProducts &&
    !!raw.localEvidencePending === pending &&
    (!diagnostics ||
      diagnostics.every(
        (diagnostic, index) => diagnostic === raw.result?.diagnostics[index]
      ))
  )
    return raw
  return {
    ...raw,
    localGraphSuperseded: superseded.graph || undefined,
    localGraphRevoked: superseded.graphRevoked || undefined,
    localRemovedProductCoordinates:
      superseded.removedProductCoordinates.length > 0
        ? superseded.removedProductCoordinates
        : undefined,
    localEvidencePending: pending || undefined,
    result:
      raw.result && diagnostics ? { ...raw.result, diagnostics } : raw.result,
  }
}

const bridges = new WeakMap<QueryClient, ReturnType<typeof createBridge>>()

function createBridge(client: QueryClient) {
  let snapshot = getLocalProductDeletionSnapshot()
  let stop: (() => void) | undefined
  let revisionSnapshot: LocalProductRevisionSnapshot = {
    status: "ready",
    records: [],
  }
  let stopRevisions: (() => void) | undefined
  let watchedCoordinates = new Set<string>()
  const readyCoordinates = new Set<string>()
  // Dependencies stay with their query even after negative evidence removes a
  // card. Otherwise a late snapshot could forget why that card was removed.
  const owners = new Map<
    string,
    { coordinates: Set<string>; organizer?: string }
  >()
  const graphSnapshots = new Map<string, LocalEventMarketEvidenceSnapshot>()
  const graphSubscriptions = new Map<string, () => void>()
  const waiters = new Set<() => void>()
  let revisionGeneration = 0
  let updating = false
  let starting = false
  const queries = () =>
    client.getQueryCache().findAll({ queryKey: ["event-market"] })
  const notify = () => {
    for (const check of waiters) check()
  }
  const coordinates = (raw: RawEventCatalog) =>
    new Set([
      ...(raw.resolution?.acceptedProductCoordinates ?? []),
      ...[...(raw.result?.data ?? []), ...(raw.previewRecords ?? [])].flatMap(
        (record) => [
          record.addressId,
          ...(record.exactReadContext?.records.map((row) => row.addressId) ??
            []),
          ...(record.family
            ? [
                record.family.parent.addressId,
                ...record.family.children.map((row) => row.addressId),
              ]
            : []),
        ]
      ),
    ])
  const watchRevisions = () => {
    const wanted = new Set(
      [...owners.values()].flatMap((owner) => [...owner.coordinates])
    )
    if (
      wanted.size === watchedCoordinates.size &&
      [...wanted].every((id) => watchedCoordinates.has(id))
    )
      return
    const previousStop = stopRevisions
    watchedCoordinates = wanted
    for (const id of readyCoordinates)
      if (!wanted.has(id)) readyCoordinates.delete(id)
    const generation = ++revisionGeneration
    // Subscribe before releasing the previous scope so stronger in-memory
    // evidence remains retained throughout a growing/shrinking dependency set.
    stopRevisions = subscribeLocalProductRevisionChanges(
      [...wanted],
      (next) => {
        if (generation !== revisionGeneration) return
        revisionSnapshot = next
        if (next.status !== "loading")
          for (const id of wanted) readyCoordinates.add(id)
        update()
        notify()
      }
    )
    previousStop?.()
  }
  const ensure = (raw: RawEventCatalog, ownerKey: string) => {
    const owner = owners.get(ownerKey) ?? {
      coordinates: new Set<string>(),
      organizer: raw.resolution?.organizerPubkey,
    }
    for (const id of coordinates(raw)) owner.coordinates.add(id)
    owner.organizer = raw.resolution?.organizerPubkey ?? owner.organizer
    owners.set(ownerKey, owner)
    watchRevisions()
    const organizer = owner.organizer
    if (!organizer || graphSnapshots.has(organizer)) return
    graphSnapshots.set(
      organizer,
      getLocalEventMarketEvidenceSnapshot(organizer)
    )
    graphSubscriptions.set(
      organizer,
      subscribeLocalEventMarketEvidenceChanges(organizer, (next) => {
        graphSnapshots.set(organizer, next)
        update()
        notify()
      })
    )
  }
  const reconcile = (raw: RawEventCatalog, ownerKey: string) => {
    ensure(raw, ownerKey)
    const revised = reconcileEventCatalog(
      raw,
      snapshot,
      revisionSnapshot.records,
      [...coordinates(raw)].some((id) => !readyCoordinates.has(id))
    )
    const graph = graphSnapshots.get(raw.resolution?.organizerPubkey ?? "")
    return graph ? reconcileEventCatalogGraph(revised, graph) : revised
  }
  const update = () => {
    if (updating) return
    updating = true
    try {
      for (const query of queries()) {
        const raw = query.state.data as RawEventCatalog | undefined
        if (!raw) continue
        const next = reconcile(raw, query.queryHash)
        if (next !== raw) query.setState({ data: next })
      }
    } finally {
      updating = false
    }
  }
  const start = () => {
    if (stop || starting) return
    starting = true
    stop = subscribeLocalProductDeletionChanges((next) => {
      snapshot = next
      update()
      notify()
    })
    starting = false
  }
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== "event-market") return
    if (event.type === "removed") {
      owners.delete(event.query.queryHash)
      watchRevisions()
      const organizers = new Set(
        [...owners.values()].map((owner) => owner.organizer)
      )
      for (const [organizer, release] of graphSubscriptions) {
        if (organizers.has(organizer)) continue
        release()
        graphSubscriptions.delete(organizer)
        graphSnapshots.delete(organizer)
      }
      if (queries().length === 0) {
        stop?.()
        stop = undefined
        stopRevisions?.()
        stopRevisions = undefined
        ++revisionGeneration
        revisionSnapshot = { status: "ready", records: [] }
      }
      notify()
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
    async settled(
      raw: RawEventCatalog,
      ownerKey: string,
      signal?: AbortSignal
    ) {
      if (signal?.aborted) return
      ensure(raw, ownerKey)
      // Wait for this bridge's own initial reads; a separate subscription could
      // finish first and accidentally expose an unreconciled successful result.
      await new Promise<void>((resolve) => {
        const finish = () => {
          waiters.delete(check)
          signal?.removeEventListener("abort", finish)
          resolve()
        }
        const check = () => {
          const owner = owners.get(ownerKey)
          if (
            owner &&
            (snapshot.status === "loading" ||
              [...owner.coordinates].some((id) => !readyCoordinates.has(id)) ||
              (owner.organizer &&
                graphSnapshots.get(owner.organizer)?.status === "loading"))
          )
            return
          finish()
        }
        waiters.add(check)
        signal?.addEventListener("abort", finish, { once: true })
        if (signal?.aborted) finish()
        else check()
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
