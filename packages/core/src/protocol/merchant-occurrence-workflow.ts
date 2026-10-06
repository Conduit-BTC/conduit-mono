import { db } from "../db"
import { recoverMerchantInventoryProduct } from "./merchant-inventory-recovery"
import { orderSchema, type OrderSchema, type ProductSchema } from "../schemas"
import {
  computeEventMarketAssignmentDTag,
  parseEventMarketAssignmentEvent,
} from "./event-market-assignment"
import {
  parseEventMarketCalendarEvent,
  isEventMarketAddressableRevisionDeleted,
  decodeEventMarketReference,
} from "./event-market"
import { resolveEventMarketRoster } from "./event-market-roster"
import { resolveEventMarketAuthorization } from "./event-market-authorization"
import { readEventMarketAuthorization } from "./event-market-authorization-read"
import {
  readEventMarketRoster,
  loadRetainedSignedEventMarketEvidence,
  retainEventMarketCommerceEvidence,
} from "./event-market-roster-read"
import { parseEventMarketSeriesEvent } from "./event-market-schedule"
import { verifyEventMarketOrderEvidence } from "./event-market-order-evidence"
import { parseProductEvent } from "./products"
import { getProductsByIds, cacheSignedProductListingEvent } from "./commerce"
import { getAccountSigner } from "./session-signer"
import { publishWithPlanner } from "./relay-publish"
import { waitForVisibleDocument } from "./interactive-signer"
import {
  compareReplaceableEventFrontiers,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  commitMerchantInventoryAssignment,
  acceptMerchantInventoryOrder,
  readMerchantInventoryAvailability,
  resumeMerchantInventoryPublication,
  type MerchantInventoryOrderItem,
} from "./merchant-inventory"

interface MerchantOccurrenceSession {
  merchantPubkey: string
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
}
function assertSession(input: MerchantOccurrenceSession) {
  if (
    input.authenticatedPubkey !== input.merchantPubkey ||
    !input.shouldContinue()
  )
    throw new Error("Reconnect the merchant account before changing inventory.")
}
function cancelled(event: SignedPublicNostrEvent): boolean {
  const tags = event.tags.filter((tag) => tag[0] === "event_occurrence")
  return (
    tags.length > 1 ||
    tags.some(
      (tag) => tag.length !== 3 || tag[1] !== "1" || tag[2] !== "scheduled"
    )
  )
}
function newest(events: SignedPublicNostrEvent[], coordinate: string) {
  return events
    .filter(
      (event) =>
        `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
          coordinate && isValidSignedPublicNostrEvent(event)
    )
    .sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )[0]
}

/** A stale relay copy of this writer's own signed work is not a new stock writer. */
async function assertKnownAssignmentInventoryAuthority(input: {
  coordinate: string
  productCoordinate: string
  orderAssignmentEvent: SignedPublicNostrEvent
  retained: readonly SignedPublicNostrEvent[]
}) {
  const committed = await db.merchantInventoryAssignments.get(input.coordinate)
  if (
    !committed ||
    committed.productCoordinate !== input.productCoordinate ||
    committed.state !== "active"
  )
    throw new Error("Committed pickup assignment is unavailable.")
  const ownSigned = [
    ...(committed.signedAssignmentEvent
      ? [committed.signedAssignmentEvent]
      : []),
    ...committed.publicationJobs.flatMap((job) =>
      job.signedEvent ? [job.signedEvent] : []
    ),
  ]
  const known = [
    ...new Map(
      [...input.retained, input.orderAssignmentEvent, ...ownSigned]
        .filter((event) => isValidSignedPublicNostrEvent(event))
        .map((event) => [event.id, event])
    ).values(),
  ]
  const revisions = known
    .filter(
      (event) =>
        event.kind === 30410 &&
        `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
          input.coordinate
    )
    .sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )
  const strongest = revisions[0]
  if (!strongest) throw new Error("Signed pickup assignment is unavailable.")
  if (
    known.some(
      (event) =>
        event.kind === 5 &&
        event.pubkey === strongest.pubkey &&
        event.tags.some(
          (tag) =>
            (tag[0] === "e" && tag[1] === strongest.id) ||
            (tag[0] === "a" &&
              tag[1] === input.coordinate &&
              event.created_at >= strongest.created_at)
        )
    )
  )
    throw new Error("Known assignment deletion needs inventory reconciliation.")
  const localHead =
    ownSigned.sort(
      (a, b) =>
        -compareReplaceableEventFrontiers(
          { createdAt: a.created_at, eventId: a.id },
          { createdAt: b.created_at, eventId: b.id }
        )
    )[0] ?? input.orderAssignmentEvent
  const ownIds = new Set(ownSigned.map((event) => event.id))
  if (!ownSigned.length && strongest.id === input.orderAssignmentEvent.id) {
    const initialJob = committed.publicationJobs[0]
    const baseline = initialJob?.assignmentSnapshot
    const parsed = parseEventMarketAssignmentEvent(strongest)
    if (
      baseline &&
      initialJob &&
      strongest.created_at <= Math.floor(initialJob.createdAt / 1_000) &&
      parsed &&
      parsed.state === baseline.state &&
      JSON.stringify(parsed.inventory) === JSON.stringify(baseline.inventory) &&
      JSON.stringify([...parsed.fulfillmentMethods].sort()) ===
        JSON.stringify([...baseline.fulfillmentMethods].sort())
    )
      return
  }
  if (
    ownIds.has(strongest.id) ||
    (ownSigned.length > 0 &&
      compareReplaceableEventFrontiers(
        { createdAt: strongest.created_at, eventId: strongest.id },
        { createdAt: localHead.created_at, eventId: localHead.id }
      ) <= 0)
  )
    return
  const parsed = parseEventMarketAssignmentEvent(strongest)
  if (
    !parsed ||
    parsed.coordinate !== input.coordinate ||
    parsed.state !== committed.state ||
    JSON.stringify(parsed.inventory) !== JSON.stringify(committed.inventory) ||
    JSON.stringify([...parsed.fulfillmentMethods].sort()) !==
      JSON.stringify([...committed.fulfillmentMethods].sort())
  )
    throw new Error(
      "A newer independent assignment revision needs inventory reconciliation."
    )
}

/** Only observed organizer cancellation/current scoped deletion releases early. */
async function reconcileKnownOccurrenceLifecycle(merchantPubkey: string) {
  const assignments = await db.merchantInventoryAssignments
    .where("merchantPubkey")
    .equals(merchantPubkey)
    .toArray()
  for (const assignment of assignments) {
    if (assignment.terminal) continue
    const evidence = await loadRetainedSignedEventMarketEvidence(
      assignment.marketCoordinate
    )
    const occurrence = newest(evidence, assignment.occurrenceCoordinate)
    if (!occurrence) continue
    const hasCancellation = evidence.some(
      (event) =>
        event.kind === occurrence.kind &&
        event.pubkey === occurrence.pubkey &&
        event.tags.some(
          (tag) =>
            tag[0] === "d" &&
            tag[1] ===
              occurrence.tags.find((candidate) => candidate[0] === "d")?.[1]
        ) &&
        event.tags.filter((tag) => tag[0] === "event_occurrence").length ===
          1 &&
        event.tags.some(
          (tag) =>
            tag.length === 3 &&
            tag[0] === "event_occurrence" &&
            tag[1] === "1" &&
            tag[2] === "cancelled"
        )
    )
    const deleted = isEventMarketAddressableRevisionDeleted(
      {
        coordinate: assignment.occurrenceCoordinate,
        eventId: occurrence.id,
        createdAt: occurrence.created_at * 1000,
      },
      evidence.filter((event) => event.kind === 5)
    )
    if (hasCancellation || deleted)
      await db.transaction("rw", db.merchantInventoryAssignments, async () => {
        const current = await db.merchantInventoryAssignments.get(
          assignment.coordinate
        )
        if (current && !current.terminal) {
          current.terminal = true
          current.revision += 1
          await db.merchantInventoryAssignments.put(current)
        }
      })
  }
}

export async function readMerchantOccurrenceInventory(merchantPubkey: string) {
  await reconcileKnownOccurrenceLifecycle(merchantPubkey)
  const assignments = await db.merchantInventoryAssignments
    .where("merchantPubkey")
    .equals(merchantPubkey)
    .toArray()
  return Promise.all(
    assignments.map(async (assignment) => {
      const availability = await readMerchantInventoryAvailability(
        db,
        assignment.productCoordinate
      )
      return {
        ...assignment,
        quantity:
          assignment.inventory.mode === "tracked"
            ? assignment.inventory.quantity
            : undefined,
        ordinaryAvailable: availability.ordinaryAvailable,
        pending: assignment.publicationJobs.some(
          (job) => job.state !== "delivered"
        ),
      }
    })
  )
}

/** Assignment creation never republishes or rewrites the ordinary product. */
export async function saveMerchantOccurrenceAssignment(
  input: MerchantOccurrenceSession & {
    marketReference: string
    product: ProductSchema
    occurrenceCoordinate: string
    quantity?: number
    remove: boolean
  }
) {
  assertSession(input)
  if (input.remove) {
    const marketCoordinate = decodeEventMarketReference(
      input.marketReference,
      [30409]
    )?.coordinate
    if (!marketCoordinate) throw new Error("Choose a valid event.")
    const tuple = {
      marketCoordinate,
      occurrenceCoordinate: input.occurrenceCoordinate,
      productCoordinate: input.product.id,
    }
    const assignmentCoordinate = `30410:${input.merchantPubkey}:${computeEventMarketAssignmentDTag(tuple)}`
    const current =
      await db.merchantInventoryAssignments.get(assignmentCoordinate)
    if (!current || current.merchantPubkey !== input.merchantPubkey)
      throw new Error("Saved assignment is unavailable on this device.")
    assertSession(input)
    return commitMerchantInventoryAssignment({
      db,
      ...tuple,
      assignmentCoordinate,
      inventory:
        current.inventory.mode === "tracked"
          ? { mode: "tracked", quantity: 0 }
          : { mode: "untracked" },
      state: "removed",
      fulfillmentMethods: [],
      expectedRevision: current.revision,
      mutationId: crypto.randomUUID(),
      context: { kind: "merchant-assignment-removal" },
    })
  }
  const [marketRead, products] = await Promise.all([
    readEventMarketRoster({
      reference: input.marketReference,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    }),
    getProductsByIds([input.product.id], {
      includeMarketHidden: true,
      accountPubkey: input.merchantPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    }),
  ])
  assertSession(input)
  if (marketRead.resolution.state !== "current")
    throw new Error("Current event evidence is unavailable.")
  const market = marketRead.resolution.market
  const row = market.merchants.find(
    (entry) => entry.pubkey === input.merchantPubkey
  )
  const occurrence =
    marketRead.schedule?.kind === "series"
      ? marketRead.schedule.occurrences.find(
          (entry) => entry.occurrence.coordinate === input.occurrenceCoordinate
        )?.occurrence
      : marketRead.calendar
  const source = products.data.find(
    (entry) => entry.addressId === input.product.id
  )?.product.signedProductEvent
  if (
    !source ||
    !isValidSignedPublicNostrEvent(source) ||
    source.pubkey !== input.merchantPubkey
  )
    throw new Error("The current signed product could not be verified.")
  const product = parseProductEvent(source)
  if (product.type === "variable" || product.format !== "physical")
    throw new Error("Choose a sellable physical product for pickup.")
  if (product.type === "variation") {
    const parents = await getProductsByIds([product.parentProductId ?? ""], {
      accountPubkey: input.merchantPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
    const parent = parents.data.find(
      (entry) => entry.addressId === product.parentProductId
    )?.product
    if (
      !parent?.signedProductEvent ||
      parent.pubkey !== input.merchantPubkey ||
      parent.type !== "variable"
    )
      throw new Error("The variation's signed parent could not be verified.")
  }
  if (
    !occurrence?.signedEvent ||
    occurrence.coordinate !== input.occurrenceCoordinate
  )
    throw new Error("Choose a current organizer-authored occurrence.")
  const authorization = await readEventMarketAuthorization({
    marketCoordinate: market.coordinate,
    merchantPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (
    !input.remove &&
    (market.state !== "open" ||
      row?.mode !== "merchant_present" ||
      authorization.resolution.state !== "active" ||
      !authorization.actionable ||
      occurrence.end <= Date.now() ||
      cancelled(occurrence.signedEvent) ||
      (occurrence.kind === 31923 &&
        !occurrence.signedEvent.tags.some((tag) => tag[0] === "end")))
  )
    throw new Error(
      "Current merchant pickup approval and a non-ended occurrence are required. Organizer handout needs its delegation integration."
    )
  if (authorization.resolution.state !== "active")
    throw new Error("Current signed merchant authorization is unavailable.")
  assertSession(input)
  const recovery = await recoverMerchantInventoryProduct({
    db,
    productCoordinate: product.id,
    merchantPubkey: input.merchantPubkey,
    signedProductEvent: source,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  if (recovery.state === "unsafe_conflict")
    throw new Error(
      "Known inventory evidence needs reconciliation before another allocation."
    )
  const d = computeEventMarketAssignmentDTag({
    marketCoordinate: market.coordinate,
    occurrenceCoordinate: occurrence.coordinate,
    productCoordinate: product.id,
  })
  const coordinate = `30410:${input.merchantPubkey}:${d}`
  const current = await db.merchantInventoryAssignments.get(coordinate)
  await retainEventMarketCommerceEvidence(market.coordinate, [
    market.signedEvent,
    occurrence.signedEvent,
    ...authorization.resolution.ancestry.map((entry) => entry.signedEvent),
  ])
  assertSession(input)
  return commitMerchantInventoryAssignment({
    db,
    productCoordinate: product.id,
    assignmentCoordinate: coordinate,
    marketCoordinate: market.coordinate,
    occurrenceCoordinate: occurrence.coordinate,
    inventory:
      product.stock === undefined
        ? { mode: "untracked" }
        : { mode: "tracked", quantity: input.remove ? 0 : input.quantity! },
    state: input.remove ? "removed" : "active",
    fulfillmentMethods: input.remove ? [] : ["pickup"],
    expectedRevision: current?.revision ?? null,
    mutationId: crypto.randomUUID(),
    context: {
      kind: "validated-event-market-assignment",
      productEventId: source.id,
      marketEventId: market.eventId,
      occurrenceEventId: occurrence.eventId,
      grantEventId: authorization.resolution.tip.eventId,
      occurrenceEndMs: occurrence.end,
      terminal: cancelled(occurrence.signedEvent),
    },
  })
}

/** Resume immutable public projections. Delivery never decides whether the sale happened. */
export async function resumeMerchantOccurrencePublication(
  input: MerchantOccurrenceSession
) {
  assertSession(input)
  return resumeMerchantInventoryPublication({
    db,
    merchantPubkey: input.merchantPubkey,
    sign: async (draft) => {
      assertSession(input)
      const signer = getAccountSigner()
      if (!signer || (await signer.getPublicKey()) !== input.merchantPubkey)
        throw new Error("Merchant signer is unavailable.")
      await waitForVisibleDocument()
      assertSession(input)
      return signer.signEvent(draft)
    },
    publish: async (event) => {
      assertSession(input)
      const delivery = await publishWithPlanner(event, {
        intent: "commerce_author_event",
        authorPubkey: input.merchantPubkey,
        accountPubkey: input.merchantPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        deliveryMode: "critical",
        shouldContinue: input.shouldContinue,
      })
      if (event.kind === 30402)
        await cacheSignedProductListingEvent(event, {
          sourceRelayUrls: delivery.successfulRelayUrls,
        })
      if (event.kind === 30410) {
        const assignment = parseEventMarketAssignmentEvent(event)
        if (assignment)
          await retainEventMarketCommerceEvidence(assignment.marketCoordinate, [
            event,
          ])
      }
      return delivery.successfulRelayUrls.length > 0
    },
  })
}

/** Local acceptance uses committed inventory and known evidence, without a mandatory relay read. */
export async function acceptMerchantOccurrenceOrder(
  input: MerchantOccurrenceSession & {
    order: OrderSchema
    products: readonly ProductSchema[]
  }
) {
  assertSession(input)
  const order = orderSchema.parse(input.order)
  if (order.merchantPubkey !== input.merchantPubkey)
    throw new Error("Order belongs to another merchant.")
  const identityBinding = JSON.stringify([
    order.id,
    order.buyerPubkey,
    order.merchantPubkey,
  ])
  const termsBinding = JSON.stringify(order)
  const previous = await db.merchantInventoryAcceptedOrders.get(order.id)
  if (previous) {
    if (
      previous.identityBinding !== identityBinding ||
      previous.termsBinding !== termsBinding
    )
      throw new Error("Order ID has conflicting accepted terms.")
    return { replayed: true, order: previous }
  }
  const eventItems = order.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  if (
    eventItems.length &&
    verifyEventMarketOrderEvidence({ order, events: [] }).status !== "verified"
  )
    throw new Error("The order's exact signed event evidence is invalid.")
  await reconcileKnownOccurrenceLifecycle(input.merchantPubkey)
  const items: MerchantInventoryOrderItem[] = []
  for (const item of order.items) {
    const fulfillment = item.fulfillment
    const committed = await db.merchantInventoryProducts.get(item.productId)
    const observed = input.products.find(
      (product) => product.id === item.productId
    )?.signedProductEvent
    if (
      committed &&
      observed &&
      isValidSignedPublicNostrEvent(observed) &&
      compareReplaceableEventFrontiers(
        { createdAt: observed.created_at, eventId: observed.id },
        {
          createdAt: committed.signedProductEvent.created_at,
          eventId: committed.signedProductEvent.id,
        }
      ) > 0 &&
      !committed.publicationJobs.some(
        (job) => job.signedEvent?.id === observed.id
      )
    )
      throw new Error(
        "A newer independent product revision needs inventory reconciliation."
      )
    const tombstones = await db.productTombstones
      .where("pubkey")
      .equals(input.merchantPubkey)
      .toArray()
    const source =
      committed?.signedProductEvent ??
      input.products.find((product) => product.id === item.productId)
        ?.signedProductEvent
    if (!source || !isValidSignedPublicNostrEvent(source))
      throw new Error("Load the signed product before accepting this order.")
    if (
      tombstones.some(
        (entry) =>
          entry.signedEvent &&
          isEventMarketAddressableRevisionDeleted(
            {
              coordinate: item.productId,
              eventId: source.id,
              createdAt: source.created_at * 1000,
            },
            [entry.signedEvent]
          )
      )
    )
      throw new Error("Known deletion evidence blocks this product.")
    const product = parseProductEvent(source)
    if (
      product.pubkey !== input.merchantPubkey ||
      product.type === "variable" ||
      product.visibility !== "public"
    )
      throw new Error("The product is not currently sellable.")
    if (
      (product.sourcePrice?.amount ?? product.price) !==
        (item.sourcePrice?.amount ?? item.priceAtPurchase) ||
      product.currency.toUpperCase() !== item.currency.toUpperCase()
    )
      throw new Error(
        "Product terms changed. Review this order with the buyer."
      )
    const recovery = await recoverMerchantInventoryProduct({
      db,
      productCoordinate: product.id,
      merchantPubkey: input.merchantPubkey,
      signedProductEvent: source,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
    })
    if (recovery.state === "unsafe_conflict")
      throw new Error(
        "Known inventory evidence needs reconciliation before accepting this product."
      )
    if (fulfillment?.type === "event_market_pickup") {
      if (
        !fulfillment.occurrenceAssignment ||
        fulfillment.mode !== "merchant_present"
      )
        throw new Error(
          "This order needs its historical or delegated fulfillment workflow."
        )
      const retained = await loadRetainedSignedEventMarketEvidence(
        fulfillment.market.coordinate
      )
      const evidence = [
        ...new Map(
          [
            ...retained,
            fulfillment.market.signedEvent,
            fulfillment.calendar.signedEvent,
            ...fulfillment.grant.signedEvidence.ancestry,
            ...fulfillment.grant.signedEvidence.deletions,
            ...(fulfillment.schedule ? [fulfillment.schedule.signedEvent] : []),
          ].map((event) => [event.id, event])
        ).values(),
      ]
      const market = resolveEventMarketRoster({
        coordinate: fulfillment.market.coordinate,
        revisions: evidence.filter((event) => event.kind === 30409),
        deletions: evidence.filter((event) => event.kind === 5),
      })
      const auth = resolveEventMarketAuthorization({
        marketCoordinate: fulfillment.market.coordinate,
        merchantPubkey: input.merchantPubkey,
        transitions: evidence.filter((event) => event.kind === 3841),
        deletions: evidence.filter((event) => event.kind === 5),
      })
      const calendarEvent = newest(evidence, fulfillment.calendar.coordinate)
      const calendar =
        calendarEvent && parseEventMarketCalendarEvent(calendarEvent)
      const row =
        market.state === "current" &&
        market.market.merchants.find(
          (entry) => entry.pubkey === input.merchantPubkey
        )
      if (
        market.state !== "current" ||
        market.market.state !== "open" ||
        !row ||
        row.mode !== "merchant_present" ||
        row.assignment !== fulfillment.assignment ||
        auth.state !== "active" ||
        !calendar ||
        !calendarEvent ||
        calendar.end <= Date.now() ||
        cancelled(calendarEvent) ||
        evidence.some(
          (event) =>
            event.kind === calendarEvent.kind &&
            `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
              calendar.coordinate &&
            cancelled(event)
        ) ||
        isEventMarketAddressableRevisionDeleted(
          {
            coordinate: calendar.coordinate,
            eventId: calendar.eventId,
            createdAt: calendar.createdAt,
          },
          evidence.filter((event) => event.kind === 5)
        )
      )
        throw new Error(
          "Known event authority or occurrence state no longer permits new acceptance."
        )
      if (
        calendar.start !== fulfillment.calendar.start ||
        calendar.end !== fulfillment.calendar.end ||
        JSON.stringify(calendar.locations) !==
          JSON.stringify(
            parseEventMarketCalendarEvent(fulfillment.calendar.signedEvent)
              ?.locations
          )
      )
        throw new Error(
          "This occurrence changed. Preserve the order and review the replacement with the buyer."
        )
      if (fulfillment.schedule) {
        const scheduleEvent = newest(evidence, fulfillment.schedule.coordinate)
        const schedule =
          scheduleEvent && parseEventMarketSeriesEvent(scheduleEvent)
        if (
          !schedule ||
          !schedule.memberCoordinates.includes(calendar.coordinate)
        )
          throw new Error(
            "The selected occurrence is no longer in the current schedule."
          )
      }
      await assertKnownAssignmentInventoryAuthority({
        coordinate: fulfillment.occurrenceAssignment.coordinate,
        productCoordinate: item.productId,
        orderAssignmentEvent: fulfillment.occurrenceAssignment.signedEvent,
        retained,
      })
      items.push({
        productCoordinate: item.productId,
        assignmentCoordinate: fulfillment.occurrenceAssignment.coordinate,
        method: "pickup",
        quantity: item.quantity,
        admission: {
          kind: "validated-event-market-order",
          productEventId: source.id,
          assignmentCoordinate: fulfillment.occurrenceAssignment.coordinate,
          assignmentEventId: fulfillment.occurrenceAssignment.eventId,
          marketEventId: market.market.eventId,
          occurrenceEventId: calendar.eventId,
          grantEventId: auth.tip.eventId,
          scheduleEventId: fulfillment.schedule?.eventId,
        },
      })
    } else
      items.push({
        productCoordinate: item.productId,
        method: "ordinary",
        quantity: item.quantity,
        admission: {
          kind: "validated-ordinary-product",
          productEventId: source.id,
        },
      })
  }
  assertSession(input)
  return acceptMerchantInventoryOrder({
    db,
    orderId: order.id,
    merchantPubkey: input.merchantPubkey,
    identityBinding,
    termsBinding,
    evidence: termsBinding,
    items,
  })
}

/** Capture the committed head before the ordinary editor asks the signer. */
export async function prepareMerchantInventoryProductEdits(
  products: readonly { coordinate: string; eventId?: string }[]
) {
  const revisions: Record<string, number> = {}
  for (const product of products) {
    const current = await db.merchantInventoryProducts.get(product.coordinate)
    if (!current) continue
    if (
      current.publicationJobs.some((job) => !job.signedEvent) ||
      current.signedProductEvent.id !== product.eventId
    )
      throw new Error(
        "This product has newer committed inventory. Finish signing its saved updates and refresh before editing."
      )
    revisions[product.coordinate] = current.revision
  }
  return revisions
}

/** A signed ordinary edit joins the same transaction boundary as reservations and sales. */
export async function commitMerchantInventoryProductEdits(
  events: readonly SignedPublicNostrEvent[],
  revisions: Record<string, number>
) {
  await db.transaction(
    "rw",
    db.merchantInventoryProducts,
    db.merchantInventoryAssignments,
    async () => {
      for (const event of events) {
        if (event.kind !== 30402) continue
        const product = parseProductEvent(event)
        const expected = revisions[product.id]
        if (expected === undefined) continue
        const current = await db.merchantInventoryProducts.get(product.id)
        if (
          !current ||
          current.revision !== expected ||
          !isValidSignedPublicNostrEvent(event) ||
          event.pubkey !== current.merchantPubkey ||
          event.created_at <= current.signedProductEvent.created_at
        )
          throw new Error(
            "Inventory changed while signing. Refresh the product before retrying the edit."
          )
        const availability = await readMerchantInventoryAvailability(
          db,
          product.id
        )
        const reserved =
          current.stock === undefined
            ? undefined
            : current.stock - (availability.ordinaryAvailable ?? 0)
        if (
          (current.stock === undefined) !== (product.stock === undefined) ||
          (product.stock !== undefined && product.stock < (reserved ?? 0))
        )
          throw new Error(
            "Reconcile current occurrence allocations before changing this stock balance or tracking mode."
          )
        current.stock = product.stock
        current.revision += 1
        current.sourceProductEvent = event
        current.signedProductEvent = event
        current.publicationJobs.push({
          id: `product-edit:${event.id}`,
          revision: current.revision,
          createdAt: Date.now(),
          state: "signed",
          signedEvent: event,
          draft: {
            kind: event.kind,
            pubkey: event.pubkey,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
          },
          productStock: product.stock,
        })
        await db.merchantInventoryProducts.put(current)
      }
    }
  )
}
