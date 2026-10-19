import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  beginOrganizerStockWriterHandover,
  disposeOrganizerStockWriterHandoverCursor,
  prepareOrganizerStockWriterTarget,
  publishOrganizerStockWriterHandover,
  readOrganizerStockWriterHandovers,
  registerOrganizerStockWriterDevice,
  restoreOrganizerStockWriterHandover,
  type OrganizerStockWriterHandoverCursor,
} from "@conduit/core/protocol/event-market-stock-writer-handover"
import {
  closeAndPublishOrganizerStockPool,
  createEventMarketStockDiscovery,
  db,
  getAccountSigner,
  getCommerceInbox,
  getProtectedReadAuthorization,
  importMerchantOrganizerStockOrder,
  loadRetainedSignedEventMarketEvidence,
  parseEventMarketStockAuthorityRumor,
  publishEventMarketStockWork,
  readEventMarketAssignment,
  readRetainedMerchantOrganizerStockImports,
  receiveOrganizerStockGrant,
  reconcileMerchantOrganizerStockClose,
  recoverMerchantOrganizerStockFromInbox,
  restoreClosedOrganizerStockFromInbox,
  restoreOrganizerStockOrderHandout,
  startMerchantOrganizerStockGrant,
  useAuth,
  validateOrganizerStockJournalPool,
  type AuthenticatedEventMarketStockPacket,
  type EventMarketOrganizerStockPool,
  type EventMarketRosterReadResult,
  type EventMarketStockDiscoveryPage,
  type MerchantInventoryAssignment,
  type MerchantOrganizerStockImportSelection,
  type ParsedEventMarketCalendar,
  type ParsedEventMarketRoster,
} from "@conduit/core"
import {
  Button,
  Checkbox,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  confirmOrganizerStockDeviceRegistration,
  createOrganizerStockDevice,
  readOrganizerStockDevice,
  organizerStockDeviceId,
  prepareOrganizerStockTargetDevice,
  reserveOrganizerStockInstallation,
  reserveMerchantOrganizerStockForAssignment,
  stockPoolBelongsToOccurrence,
  type OrganizerStockDevice,
} from "../lib/event-market-stock-handover"
import { EventMarketOrganizerRecoveryQueue } from "./EventMarketOrganizerPickupCard"
import { resumeMerchantOccurrencePublication } from "../lib/merchant-occurrence-publication"

type StockAction = "retry" | "close" | "reconcile"
export function EventMarketStockPoolList(props: {
  pools: readonly EventMarketOrganizerStockPool[]
  accountPubkey: string
  writerId?: string
  writerBlocked?: boolean
  busy: boolean
  onAction(pool: EventMarketOrganizerStockPool, action: StockAction): void
}) {
  return (
    <div className="space-y-3">
      {props.pools.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">
          No reserved stock is saved on this device. Checking messages cannot
          prove there are no older grants.
        </p>
      ) : null}
      {props.pools.map((pool) => {
        const organizer = pool.organizerPubkey === props.accountPubkey
        const ownWriter =
          organizer &&
          props.writerId === pool.writerId &&
          !pool.readOnlyRecovery &&
          !props.writerBlocked
        return (
          <section
            key={pool.poolId}
            className="space-y-2 border-t border-[var(--border)] pt-3"
          >
            <p className="font-medium">Reserved stock · {pool.state}</p>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-[var(--text-secondary)]">Reserved</dt>
                <dd>{pool.quantity}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-secondary)]">Accepted</dt>
                <dd>{pool.acceptedQuantity}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-secondary)]">Remaining</dt>
                <dd>{pool.quantity - pool.acceptedQuantity}</dd>
              </div>
            </dl>
            <p className="break-all text-sm text-[var(--text-secondary)]">
              Product: {pool.productCoordinate.split(":").slice(2).join(":")}
            </p>
            {organizer && !ownWriter ? (
              <p className="text-sm text-[var(--warning-text)]">
                Read-only here. Continue on the designated handover device or
                recover its complete journal.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {!organizer || pool.state === "closing" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.busy || (organizer && props.writerBlocked)}
                  onClick={() => props.onAction(pool, "retry")}
                >
                  Retry saved {organizer ? "closing" : "grant"} delivery
                </Button>
              ) : null}
              {ownWriter && pool.state === "active" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onAction(pool, "close")}
                >
                  Stop new sales and close pool
                </Button>
              ) : null}
              {!organizer && pool.state !== "closed" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onAction(pool, "reconcile")}
                >
                  Reconcile organizer close
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              Closing stops new sales. Unsold stock returns only after the
              seller imports the complete accepted-order history.
            </p>
          </section>
        )
      })}
    </div>
  )
}

export function EventMarketStockPanel(props: {
  market: ParsedEventMarketRoster
  occurrence?: ParsedEventMarketCalendar
  marketRead: EventMarketRosterReadResult
  authenticatedPubkey: string
}) {
  const { market, occurrence, authenticatedPubkey: account } = props
  const { authGeneration, isAuthGenerationCurrent } = useAuth()
  const shouldContinue = () => isAuthGenerationCurrent(authGeneration)
  const organizer = market.organizerPubkey === account
  const merchant = market.merchants.find((row) => row.pubkey === account)
  const [device, setDevice] = useState<OrganizerStockDevice | null>(null)
  const [deviceError, setDeviceError] = useState("")
  const [assignmentId, setAssignmentId] = useState("")
  const [writerId, setWriterId] = useState("")
  const [quantity, setQuantity] = useState("")
  const [replacementId, setReplacementId] = useState("")
  const [confirmMove, setConfirmMove] = useState(false)
  const [writerHandovers, setWriterHandovers] = useState<
    Awaited<ReturnType<typeof readOrganizerStockWriterHandovers>>["selections"]
  >([])
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [packets, setPackets] = useState<
    readonly AuthenticatedEventMarketStockPacket[]
  >([])
  const [stockHasMore, setStockHasMore] = useState(false)
  const [handoverHasMore, setHandoverHasMore] = useState(false)
  const hasMore = stockHasMore || handoverHasMore
  const [stockImports, setStockImports] = useState<
    readonly MerchantOrganizerStockImportSelection[]
  >([])
  const [importAttention, setImportAttention] = useState(false)
  const discovery = useRef<Awaited<
    ReturnType<typeof createEventMarketStockDiscovery>
  > | null>(null)
  const handoverScan = useRef<{
    epoch: number
    cursor?: OrganizerStockWriterHandoverCursor
  }>({ epoch: 0 })
  const targetDeviceId = device ? organizerStockDeviceId(device) : undefined
  useEffect(() => {
    const scan = handoverScan.current
    setWriterHandovers([])
    setHandoverHasMore(false)
    return () => {
      scan.epoch++
      if (scan.cursor) disposeOrganizerStockWriterHandoverCursor(scan.cursor)
      scan.cursor = undefined
    }
  }, [account, market.coordinate, authGeneration, targetDeviceId])
  useEffect(() => {
    setDevice(null)
    setDeviceError("")
    setWriterHandovers([])
    setConfirmMove(false)
    setReplacementId("")
    setPackets([])
    setStockHasMore(false)
    setStockImports([])
    if (organizer) {
      try {
        setDevice(
          readOrganizerStockDevice(localStorage, account, market.coordinate)
        )
      } catch (cause) {
        setDeviceError(message(cause))
      }
    }
    return () => {
      discovery.current?.dispose()
      discovery.current = null
    }
  }, [account, market.coordinate, organizer, authGeneration])
  const local = useQuery({
    queryKey: [
      "event-stock-panel",
      account,
      market.coordinate,
      occurrence?.coordinate ?? "history",
      authGeneration,
    ],
    queryFn: async () => {
      const retainedPools = (
        await db.eventMarketOrganizerStockPools
          .where("accountPubkey")
          .equals(account)
          .toArray()
      ).filter((pool) => {
        validateOrganizerStockJournalPool(pool)
        const grant = parseEventMarketStockAuthorityRumor(pool.grantRumor)
        return (
          grant.type === "grant" && grant.marketCoordinate === market.coordinate
        )
      })
      const pools = retainedPools.filter(
        (pool) =>
          !occurrence ||
          stockPoolBelongsToOccurrence(
            pool,
            market.coordinate,
            occurrence.coordinate
          )
      )
      const assignments = (
        await db.merchantInventoryAssignments
          .where("merchantPubkey")
          .equals(account)
          .toArray()
      ).filter(
        (row) =>
          row.marketCoordinate === market.coordinate &&
          (!occurrence || row.occurrenceCoordinate === occurrence.coordinate)
      )
      if (!shouldContinue()) throw new Error("Account session changed.")
      const writerRegistration = organizer
        ? await db.eventMarketOrganizerStockWriters.get(
            `${account}:${market.coordinate}`
          )
        : undefined
      if (!shouldContinue()) throw new Error("Account session changed.")
      return {
        pools,
        assignments,
        hasRetainedPools: retainedPools.length > 0,
        writerRegistration,
      }
    },
    retry: false,
  })
  const pools = local.data?.pools ?? []
  const assignments = local.data?.assignments ?? []
  const registration = local.data?.writerRegistration
  const deviceReady =
    !!device &&
    device.mode !== "target" &&
    registration?.state === "active" &&
    registration.deviceId === organizerStockDeviceId(device) &&
    registration.writerId === device.writerId
  const writerRetired = registration?.state === "retired"
  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try {
      if (!shouldContinue()) throw new Error("Account session changed.")
      await operation()
    } catch (cause) {
      if (shouldContinue()) setError(message(cause))
    } finally {
      if (shouldContinue()) await local.refetch()
      inFlight.current = false
      setBusy(false)
    }
  }
  function session() {
    const signer = getAccountSigner()
    if (!signer || signer.pubkey !== account || !shouldContinue())
      throw new Error("Reconnect the selected account signer.")
    return { db, signer, authenticatedPubkey: account, shouldContinue }
  }
  async function discover() {
    const current = session()
    if (!discovery.current) {
      const authorization = getProtectedReadAuthorization(account)
      if (!authorization)
        throw new Error(
          "Reconnect the account to check private stock messages."
        )
      discovery.current = await createEventMarketStockDiscovery({
        ...current,
        authorization,
      })
    }
    let page: EventMarketStockDiscoveryPage
    try {
      page = await discovery.current.nextPage()
    } catch (cause) {
      discovery.current?.dispose()
      discovery.current = null
      throw cause
    }
    if (!shouldContinue()) return
    setPackets(page.packets)
    let moreHandovers = false,
      handoverCapped = false
    if (organizer && targetDeviceId) {
      const epoch = handoverScan.current.epoch
      try {
        const handovers = await readOrganizerStockWriterHandovers({
          ...current,
          store: getCommerceInbox(account).store,
          marketCoordinate: market.coordinate,
          targetDeviceId,
          cursor: handoverScan.current.cursor,
        })
        if (!shouldContinue() || epoch !== handoverScan.current.epoch) {
          disposeOrganizerStockWriterHandoverCursor(handovers.cursor)
          return
        }
        handoverScan.current.cursor = handovers.cursor
        moreHandovers = handovers.hasMore
        handoverCapped = handovers.capped
        setHandoverHasMore(moreHandovers)
        setWriterHandovers(handovers.selections)
      } catch (cause) {
        if (epoch === handoverScan.current.epoch) {
          if (handoverScan.current.cursor)
            disposeOrganizerStockWriterHandoverCursor(
              handoverScan.current.cursor
            )
          handoverScan.current.cursor = undefined
          setHandoverHasMore(false)
        }
        throw cause
      }
    }
    if (!organizer) {
      const result = await readRetainedMerchantOrganizerStockImports({
        inbox: getCommerceInbox(account),
        marketCoordinate: market.coordinate,
        packets: page.packets,
        shouldContinue,
      })
      if (!shouldContinue()) return
      setStockImports(result.selections)
      setImportAttention(result.capped || result.conflictingOrders > 0)
    }
    setStockHasMore(page.hasMore)
    setNotice(
      handoverCapped
        ? "The saved handover check reached its safe bound. No partial handover was activated; keep the original device history intact."
        : page.pageStatus === "unavailable"
          ? "Private stock messages are unavailable. Saved stock remains unchanged."
          : page.hasMore || moreHandovers
            ? "More stock history can be checked. Missing messages do not reset reserved stock."
            : "The bounded message check finished. Saved stock remains authoritative; older history may still exist elsewhere."
    )
  }
  async function registerDevice(selected: OrganizerStockDevice) {
    const current = session()
    const id = organizerStockDeviceId(selected)
    await registerOrganizerStockWriterDevice({
      ...current,
      marketCoordinate: market.coordinate,
      writerId: selected.writerId,
      deviceId: id,
      expectedPoolIds: selected.installedPoolIds,
    })
    const confirmed = await confirmOrganizerStockDeviceRegistration({
      db,
      storage: localStorage,
      account,
      market: market.coordinate,
      expectedDeviceId: id,
      shouldContinue,
    })
    if (shouldContinue()) {
      setDevice(confirmed)
      setDeviceError("")
    }
  }
  async function prepareReplacement() {
    const selected = prepareOrganizerStockTargetDevice({
      storage: localStorage,
      account,
      market: market.coordinate,
      hasRetainedPools: local.data?.hasRetainedPools ?? true,
    })
    if (shouldContinue()) setDevice(selected)
    await prepareOrganizerStockWriterTarget({
      ...session(),
      marketCoordinate: market.coordinate,
      targetDeviceId: organizerStockDeviceId(selected),
    })
    if (shouldContinue())
      setNotice(
        "Replacement device is prepared. Copy its ID to the original device; no stock or payment authority has moved yet."
      )
  }
  async function moveWriter() {
    if (!device || !deviceReady || !confirmMove)
      throw new Error(
        "Confirm the original active device and replacement ID first."
      )
    const current = session()
    await beginOrganizerStockWriterHandover({
      ...current,
      marketCoordinate: market.coordinate,
      writerId: device.writerId,
      targetDeviceId: replacementId.trim(),
    })
    await local.refetch()
    if (shouldContinue())
      setNotice(
        "This device is frozen. Its complete stock history is saved for the selected replacement device."
      )
    await publishOrganizerStockWriterHandover({
      ...current,
      marketCoordinate: market.coordinate,
    })
    if (shouldContinue())
      setNotice(
        "The exact complete handover was sent privately to your account. Verify and restore it on the prepared replacement device."
      )
  }
  async function restoreWriter(selection: (typeof writerHandovers)[number]) {
    if (!device)
      throw new Error(
        "Prepare this replacement device before restoring its handover."
      )
    const id = organizerStockDeviceId(device)
    const result = await restoreOrganizerStockWriterHandover({
      ...session(),
      envelope: selection.envelope,
      envelopes: selection.envelopes,
      expectedTargetDeviceId: id,
    })
    const restored = await confirmOrganizerStockDeviceRegistration({
      db,
      storage: localStorage,
      account,
      market: market.coordinate,
      expectedDeviceId: id,
      restored: result,
      shouldContinue,
    })
    if (shouldContinue()) {
      setDevice(restored)
      setDeviceError("")
      setNotice(
        "Complete stock history is verified on this device. Existing payment attempts and prior handouts are preserved; do not repeat them."
      )
    }
  }
  async function grant(assignment: MerchantInventoryAssignment) {
    if (!occurrence)
      throw new Error("Choose a current event date before reserving new stock.")
    const current = session()
    await reserveMerchantOrganizerStockForAssignment({
      ...current,
      market,
      occurrence,
      assignment,
      marketRead: props.marketRead,
      writerId,
      quantityText: quantity,
    })
    if (shouldContinue())
      setNotice(
        "The exact stock reservation is saved and its grant delivery was attempted. The organizer must receive it on the selected device."
      )
  }
  async function receive(packet: AuthenticatedEventMarketStockPacket) {
    const payload = packet.payload
    if (
      payload.type !== "grant" ||
      !device ||
      !deviceReady ||
      payload.writerId !== device.writerId
    )
      throw new Error("This grant is for another handover device.")
    const assignment = await readEventMarketAssignment({
      ...payload,
      authenticatedPubkey: account,
      shouldContinue,
    })
    if (assignment.state !== "active" || !assignment.assignment)
      throw new Error(
        "The seller's exact signed stock commitment is unavailable."
      )
    const existingPool = await db.eventMarketOrganizerStockPools.get(
      `${account}:${packet.rumor.id}`
    )
    reserveOrganizerStockInstallation({
      storage: localStorage,
      account,
      market: market.coordinate,
      poolId: packet.rumor.id,
      writerId: device.writerId,
      existingPool,
    })
    await receiveOrganizerStockGrant({
      ...session(),
      expectedWriterId: device.writerId,
      grantEnvelope: packet.envelope,
      committedAssignmentEvent: assignment.assignment.signedEvent,
    })
    if (shouldContinue())
      setNotice(
        "Reserved stock received on this device. Payment verification is still required before each physical handout."
      )
  }
  async function poolAction(
    pool: EventMarketOrganizerStockPool,
    action: StockAction
  ) {
    const current = session()
    if (action === "close") {
      if (!device || !deviceReady || device.writerId !== pool.writerId)
        throw new Error("Use the designated handover device.")
      await closeAndPublishOrganizerStockPool({
        ...current,
        poolId: pool.poolId,
        writerId: device.writerId,
      })
      if (shouldContinue())
        setNotice(
          "New sales are stopped for this pool. Its exact closing record is saved for delivery and seller reconciliation."
        )
    } else if (action === "reconcile") {
      const closing = packets.find(
        (packet) =>
          packet.payload.type === "closed" &&
          packet.payload.poolId === pool.poolId
      )
      if (!closing)
        throw new Error(
          "Check stock messages to find the organizer's signed closing record."
        )
      await reconcileMerchantOrganizerStockClose({
        ...current,
        closingEnvelope: closing.envelope,
      })
      await resumeMerchantOccurrencePublication({
        merchantPubkey: account,
        authenticatedPubkey: account,
        shouldContinue,
      })
      if (shouldContinue())
        setNotice(
          "The complete closing history is reconciled; unused stock is released and its public update was attempted."
        )
    } else if (organizer) {
      await publishEventMarketStockWork({
        ...current,
        poolId: pool.poolId,
        work: "close",
      })
      if (shouldContinue())
        setNotice(
          "Retried the exact saved closing delivery; no stock was consumed."
        )
    } else {
      const assignment = await db.merchantInventoryAssignments.get(
        pool.assignmentCoordinate
      )
      if (!assignment)
        throw new Error("The original inventory assignment needs recovery.")
      await startMerchantOrganizerStockGrant({
        ...current,
        grantRumor: pool.grantRumor,
        expectedAssignmentRevision: assignment.revision,
        admissionEvidence: await loadRetainedSignedEventMarketEvidence(
          market.coordinate
        ),
      })
      if (shouldContinue())
        setNotice(
          "Retried the original saved stock reservation and grant; no new pool was created."
        )
    }
  }
  const incoming = packets.filter(
    (packet) =>
      packet.payload.type === "grant" &&
      packet.payload.organizerPubkey === account &&
      packet.payload.marketCoordinate === market.coordinate &&
      (!occurrence ||
        packet.payload.occurrenceCoordinate === occurrence.coordinate) &&
      !pools.some((pool) => pool.poolId === packet.rumor.id)
  )
  const checkpoints = packets.filter(
    (packet) =>
      packet.payload.type === "merchant_checkpoint" &&
      packet.payload.merchantPubkey === account &&
      packet.payload.snapshot.assignments.some(
        (assignment) => assignment.marketCoordinate === market.coordinate
      )
  )
  const closedRecoveries = organizer
    ? packets.filter((packet) => {
        const close = packet.payload
        return (
          close.type === "closed" &&
          close.organizerPubkey === account &&
          packets.some((candidate) => {
            const grant = candidate.payload
            return (
              grant.type === "grant" &&
              candidate.rumor.id === close.poolId &&
              grant.marketCoordinate === market.coordinate &&
              (!occurrence ||
                grant.occurrenceCoordinate === occurrence.coordinate)
            )
          })
        )
      })
    : []
  async function restoreClosedHistory(poolId: string) {
    await restoreClosedOrganizerStockFromInbox({
      ...session(),
      poolId,
      packets,
    })
    if (shouldContinue())
      setNotice(
        "The complete closed stock history is recovered read-only. Prior handouts and stock use remain preserved; this does not start another selling device."
      )
  }
  async function restoreCheckpoint(
    packet: AuthenticatedEventMarketStockPacket
  ) {
    const authorization = getProtectedReadAuthorization(account)
    if (!authorization)
      throw new Error("Reconnect the seller signer to recover saved stock.")
    const result = await recoverMerchantOrganizerStockFromInbox({
      ...session(),
      authorization,
      store: getCommerceInbox(account).store,
      envelope: packet.envelope,
    })
    if (result.state !== "ready")
      throw new Error(
        "The saved stock checkpoint conflicts with current signed inventory. Reconcile it before making another stock promise."
      )
    if (shouldContinue())
      setNotice(
        result.coverage === "complete"
          ? "Seller stock, outstanding holds and exact accepted history are recovered. This does not authorize a new sale or physical handout."
          : "Seller stock history is recovered with incomplete current discovery. Existing holds and accepted decisions remain preserved; new sale admission is checked separately."
      )
  }
  async function importStock(selection: MerchantOrganizerStockImportSelection) {
    const current = session()
    const result = await importMerchantOrganizerStockOrder({
      ...current,
      originalOrderEnvelope: selection.originalOrderEnvelope,
      acceptedEnvelopes: selection.acceptedEnvelopes,
    })
    // Acceptance debits stock. A distinct authenticated organizer operation
    // proves physical handout; neither the stock debit nor a paid label does.
    const handouts = packets.filter(
      (packet) =>
        packet.payload.type === "handed_out" &&
        packet.payload.merchantPubkey === account &&
        packet.payload.orderId === selection.orderId
    )
    for (const packet of handouts)
      await restoreOrganizerStockOrderHandout({
        ...current,
        envelope: packet.envelope,
      })
    await resumeMerchantOccurrencePublication({
      merchantPubkey: account,
      authenticatedPubkey: account,
      shouldContinue,
    })
    if (shouldContinue())
      setNotice(
        result.replayed
          ? "This order was already reconciled. No stock was deducted again."
          : handouts.length
            ? "The organizer's exact accepted order and handout are reconciled once. Payment remains separately verified."
            : "The organizer's exact accepted order is reconciled once. Payment and physical handout remain separately verified."
      )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organizer stock handover</CardTitle>
        <CardDescription>
          Reserve a finite quantity for one organizer device. This does not
          share wallet keys, change product ownership, or confirm payment.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {organizer ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              Use one designated browser for stock sales and pickup. A
              replacement must be prepared first, then receive the original
              device's complete saved history. A grant alone cannot restart a
              stock writer.
            </p>
            {device ? (
              <>
                <Field
                  label={
                    device.mode === "target"
                      ? "Replacement device handover ID"
                      : "This device's handover ID"
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      readOnly
                      value={
                        device.mode === "target"
                          ? organizerStockDeviceId(device)
                          : device.writerId
                      }
                    />
                  )}
                </Field>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(
                        device.mode === "target"
                          ? organizerStockDeviceId(device)
                          : device.writerId
                      )
                      setNotice("Device handover ID copied.")
                    })
                  }
                >
                  {device.mode === "target"
                    ? "Copy replacement device ID"
                    : "Copy handover ID"}
                </Button>
                {device.mode !== "target" &&
                !registration &&
                local.isSuccess ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await registerDevice(device)
                        if (shouldContinue())
                          setNotice(
                            "This original device and its complete saved stock journal are verified."
                          )
                      })
                    }
                  >
                    Verify this original device
                  </Button>
                ) : null}
              </>
            ) : !writerRetired && !registration ? (
              <Button
                type="button"
                disabled={
                  busy || !!deviceError || local.isPending || local.isError
                }
                onClick={() =>
                  void run(async () => {
                    setDevice(
                      createOrganizerStockDevice({
                        storage: localStorage,
                        account,
                        market: market.coordinate,
                        hasRetainedPools: local.data?.hasRetainedPools ?? true,
                      })
                    )
                    const selected = readOrganizerStockDevice(
                      localStorage,
                      account,
                      market.coordinate
                    )!
                    await registerDevice(selected)
                    setNotice(
                      "This device's handover ID is saved. Share it with the seller."
                    )
                  })
                }
              >
                Use this device for stock handover
              </Button>
            ) : null}
            {!device || (device.mode === "target" && !registration) ? (
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  !!deviceError ||
                  !local.isSuccess ||
                  local.data.hasRetainedPools ||
                  !!registration
                }
                onClick={() => void run(prepareReplacement)}
              >
                Prepare replacement device
              </Button>
            ) : null}
            {device?.mode === "target" && registration?.state === "target" ? (
              <p role="status" className="text-sm text-[var(--info-text)]">
                This replacement is prepared, not active. Copy its ID to the
                original device, then check private stock messages and verify
                the complete handover here.
              </p>
            ) : null}
            {writerRetired ? (
              <div className="space-y-3">
                <p role="status" className="text-sm text-[var(--warning-text)]">
                  This device's stock writer has moved. Continue on the
                  replacement device.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await publishOrganizerStockWriterHandover({
                        ...session(),
                        marketCoordinate: market.coordinate,
                      })
                      if (shouldContinue())
                        setNotice(
                          "Retried the exact saved private device handover. This device remains stopped."
                        )
                    })
                  }
                >
                  Retry saved device handover
                </Button>
              </div>
            ) : null}
            {deviceReady && local.data?.hasRetainedPools ? (
              <section className="space-y-3 border-t border-[var(--border)] pt-3">
                <h3 className="font-medium">Move stock to another device</h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  Prepare the replacement first. Moving freezes this device
                  before sending the complete journal, including accepted orders
                  and previous handouts. It does not restart payments.
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  If the complete history exceeds the safe transfer limit, this
                  device stays active for normal work. Moving a larger history
                  needs expanded transfer support; never prune, reset or move
                  only part of the history.
                </p>
                <Field label="Replacement device ID">
                  {(control) => (
                    <Input
                      {...control}
                      value={replacementId}
                      disabled={busy}
                      autoCapitalize="none"
                      autoComplete="off"
                      onChange={(event) => setReplacementId(event.target.value)}
                    />
                  )}
                </Field>
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox
                    checked={confirmMove}
                    onCheckedChange={setConfirmMove}
                    disabled={busy}
                    aria-label="I understand this stops stock sales and pickup on this device"
                  />
                  <span>
                    I understand this stops stock sales and pickup on this
                    device
                  </span>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !confirmMove || !replacementId.trim()}
                  onClick={() => void run(moveWriter)}
                >
                  Freeze this device and send handover
                </Button>
              </section>
            ) : null}
          </div>
        ) : occurrence && merchant?.mode === "organizer_handoff" ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              const assignment = assignments.find(
                (row) => row.coordinate === assignmentId
              )
              if (assignment) void run(() => grant(assignment))
            }}
          >
            <Field label="Pickup stock assignment">
              {(control) => (
                <Select
                  value={assignmentId}
                  disabled={busy}
                  onValueChange={setAssignmentId}
                >
                  <SelectTrigger {...control}>
                    <SelectValue placeholder="Choose event stock" />
                  </SelectTrigger>
                  <SelectContent>
                    {assignments
                      .filter(
                        (row) =>
                          row.state === "active" &&
                          row.inventory.mode === "tracked"
                      )
                      .map((row) => (
                        <SelectItem key={row.coordinate} value={row.coordinate}>
                          {row.productCoordinate.split(":").slice(2).join(":")}{" "}
                          ·{" "}
                          {row.inventory.mode === "tracked"
                            ? row.inventory.quantity
                            : ""}{" "}
                          allocated
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Quantity to reserve">
                {(control) => (
                  <Input
                    {...control}
                    inputMode="numeric"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    disabled={busy}
                  />
                )}
              </Field>
              <Field label="Organizer's device handover ID">
                {(control) => (
                  <Input
                    {...control}
                    value={writerId}
                    onChange={(event) => setWriterId(event.target.value)}
                    disabled={busy}
                    autoCapitalize="none"
                  />
                )}
              </Field>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              This stock stays held until the organizer closes the pool and
              every accepted order is reconciled, even after the date ends. New
              sales stop at the selected date's end.
            </p>
            <Button
              type="submit"
              disabled={busy || !assignmentId || !quantity || !writerId}
            >
              Reserve stock and send grant
            </Button>
          </form>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(discover)}
          >
            {hasMore
              ? "Check more stock history"
              : "Check private stock messages"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void local.refetch()}
          >
            Refresh saved stock
          </Button>
          {!organizer ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await resumeMerchantOccurrencePublication({
                    merchantPubkey: account,
                    authenticatedPubkey: account,
                    shouldContinue,
                  })
                  if (shouldContinue())
                    setNotice(
                      "Retried the exact saved stock updates; no stock decision was repeated."
                    )
                })
              }
            >
              Retry saved stock updates
            </Button>
          ) : null}
        </div>
        {incoming.map((packet) => (
          <section
            key={packet.rumor.id}
            className="space-y-2 border-t border-[var(--border)] pt-3"
          >
            <p className="text-sm">
              A seller's reserved stock grant is available for{" "}
              {packet.payload.type === "grant" ? packet.payload.quantity : ""}{" "}
              items.
            </p>
            <Button
              type="button"
              disabled={
                busy ||
                !device ||
                !deviceReady ||
                packet.payload.type !== "grant" ||
                packet.payload.writerId !== device.writerId
              }
              onClick={() => void run(() => receive(packet))}
            >
              Receive reserved stock on this device
            </Button>
            {packet.payload.type === "grant" &&
            packet.payload.writerId !== device?.writerId ? (
              <p className="text-sm text-[var(--warning-text)]">
                This grant selects a different handover device.
              </p>
            ) : null}
          </section>
        ))}
        {organizer &&
          device &&
          writerHandovers.map((selection) => (
            <section
              key={selection.transferId}
              className="space-y-3 border-t border-[var(--border)] pt-3"
            >
              <p className="text-sm">
                A complete private handover for this replacement is available
                for {selection.poolCount} stock{" "}
                {selection.poolCount === 1 ? "pool" : "pools"}. Verification
                preserves accepted orders, previous handouts and the original
                stock writer.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy || writerRetired}
                onClick={() => void run(() => restoreWriter(selection))}
              >
                Verify and restore complete handover
              </Button>
            </section>
          ))}
        {checkpoints.map((packet) => (
          <section
            key={packet.rumor.id}
            className="space-y-2 border-t border-[var(--border)] pt-3"
          >
            <p className="text-sm">
              An encrypted seller stock checkpoint is available. Recovery
              preserves entrusted stock, accepted orders and prior handouts; it
              never resets them.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => restoreCheckpoint(packet))}
            >
              Recover saved seller stock history
            </Button>
          </section>
        ))}
        {closedRecoveries.map((packet) =>
          packet.payload.type === "closed" ? (
            <section
              key={packet.rumor.id}
              className="space-y-2 border-t border-[var(--border)] pt-3"
            >
              <p className="text-sm">
                Saved closing history can recover stock use and prior handouts
                on a replacement device. It cannot reopen this pool for new
                sales.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    restoreClosedHistory(
                      packet.payload.type === "closed"
                        ? packet.payload.poolId
                        : ""
                    )
                  )
                }
              >
                Recover completed organizer stock history
              </Button>
            </section>
          ) : null
        )}
        {stockImports.map((selection) => (
          <section
            key={selection.orderId}
            className="space-y-2 border-t border-[var(--border)] pt-3"
          >
            <p className="text-sm">
              Saved organizer acceptance for order {selection.orderId.slice(-8)}
              .
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => importStock(selection))}
            >
              Reconcile accepted order stock
            </Button>
          </section>
        ))}
        {importAttention ? (
          <p role="status" className="text-sm text-[var(--warning-text)]">
            Some accepted-order history is incomplete or conflicting. Check more
            history before returning unused stock.
          </p>
        ) : null}
        <EventMarketStockPoolList
          pools={pools}
          accountPubkey={account}
          writerId={deviceReady ? device?.writerId : undefined}
          writerBlocked={organizer && !deviceReady}
          busy={busy}
          onAction={(pool, action) => void run(() => poolAction(pool, action))}
        />
        {organizer && device && deviceReady ? (
          <EventMarketOrganizerRecoveryQueue
            authenticatedPubkey={account}
            marketCoordinate={market.coordinate}
            writerId={device.writerId}
          />
        ) : null}
        {local.isError || deviceError ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {deviceError ||
              "Saved stock could not be loaded. Do not start another pool."}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-[var(--success-text)]">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--error-text)]">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function message(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "The stock operation could not finish. Saved reservations remain held."
}
