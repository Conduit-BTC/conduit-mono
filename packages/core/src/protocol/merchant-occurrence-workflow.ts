import {
  merchantAcceptanceStore,
  protectMerchantAcceptanceHistory,
  sealMerchantAcceptanceEvidence,
} from "./merchant-acceptance-privacy"
import { verifySignedEventBatches } from "./relay-reader"
import { merchantOccurrenceAcceptanceBindings } from "./merchant-order-acceptance-bindings"
import { db, type MerchantInventoryAcceptedOrder } from "../db"
import { normalizeCurrencyIdentity } from "../pricing"
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
import {
  verifyEventMarketOrderEvidence,
  admitEmbeddedEventMarketOrderEvidence,
} from "./event-market-order-evidence"
import { parseProductEvent } from "./products"
import { hasEventMarketListingVisibility } from "./product-event-visibility"
import { getProductsByIds } from "./commerce"
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
  type MerchantInventoryPriorStockAdjustment,
  type MerchantStockCheckpointOutcome,
} from "./merchant-inventory"

import {
  isOccurrenceCancelled as cancelled,
  newestAddressableEvidence as newest,
  reconcileKnownOccurrenceLifecycle,
} from "./merchant-occurrence-lifecycle"

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
    /** Explicit pre-grant setup only; this baseline cannot authorize handout. */
    organizerHandoverSetup?: { organizerPubkey: string; writerId: string }
  }
) {
  if (input.organizerHandoverSetup)
    input = {
      ...input,
      product: structuredClone(input.product),
      organizerHandoverSetup: { ...input.organizerHandoverSetup },
    }
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
  const handover = input.organizerHandoverSetup
  if (
    handover &&
    (handover.organizerPubkey !== market.organizerPubkey ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        handover.writerId
      ) ||
      row?.mode !== "organizer_handoff")
  )
    throw new Error(
      "Choose the event organizer and an explicit stock writer for handover."
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
  const product = parseProductEvent(
    (await verifySignedEventBatches([source]))[0]!
  )
  if (product.type === "variable" || product.format !== "physical")
    throw new Error("Choose a sellable physical product for pickup.")
  // Assignment authoring only allocates Merchant inventory. The separate
  // explicit grant subsequently selects the organizer device and publishes
  // its commitment; an uncommitted assignment cannot admit delegated sales.
  if (
    (handover || row?.mode === "organizer_handoff") &&
    (product.stock === undefined ||
      !Number.isInteger(input.quantity) ||
      input.quantity! < 1)
  )
    throw new Error(
      "Organizer handover requires an explicit finite stock allocation."
    )
  if (product.type === "variation") {
    const parents = await getProductsByIds([product.parentProductId ?? ""], {
      includeMarketHidden: true,
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
      (row?.mode !== "merchant_present" && row?.mode !== "organizer_handoff") ||
      authorization.resolution.state !== "active" ||
      !authorization.actionable ||
      occurrence.end <= Date.now() ||
      cancelled(occurrence.signedEvent) ||
      (occurrence.kind === 31923 &&
        !occurrence.signedEvent.tags.some((tag) => tag[0] === "end")))
  )
    throw new Error(
      "Current merchant pickup approval and a non-ended occurrence are required."
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
  input: MerchantOccurrenceSession & {
    onStockCheckpoint?: (outcome: MerchantStockCheckpointOutcome) => void
    replayAcknowledgedCheckpointCoordinates?: readonly string[]
    publishProduct: (
      event: SignedPublicNostrEvent
    ) => Promise<boolean | "superseded">
  }
) {
  assertSession(input)
  const checkpointSigner = getAccountSigner()
  return resumeMerchantInventoryPublication({
    db,
    merchantPubkey: input.merchantPubkey,
    onStockCheckpoint: input.onStockCheckpoint,
    stockCheckpoint: checkpointSigner
      ? {
          signer: checkpointSigner,
          replayAcknowledgedCoordinates:
            input.replayAcknowledgedCheckpointCoordinates,
          shouldContinue: () => {
            assertSession(input)
            return getAccountSigner() === checkpointSigner
          },
        }
      : undefined,
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
      if (event.kind === 30402) return input.publishProduct(event)
      const delivery = await publishWithPlanner(event, {
        intent: "commerce_author_event",
        authorPubkey: input.merchantPubkey,
        accountPubkey: input.merchantPubkey,
        authenticatedPubkey: input.authenticatedPubkey,
        deliveryMode: "critical",
        shouldContinue: input.shouldContinue,
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

/** A saved stock decision authorizes only its original order, not an ID alias. */
export function matchesMerchantOccurrenceAcceptance(
  accepted: MerchantInventoryAcceptedOrder,
  candidate: OrderSchema
): boolean {
  const parsed = orderSchema.safeParse(candidate)
  if (!parsed.success) return false
  const binding = merchantOccurrenceAcceptanceBindings(parsed.data)
  return (
    accepted.orderId === parsed.data.id &&
    accepted.merchantPubkey === parsed.data.merchantPubkey &&
    accepted.identityBinding === binding.identityBinding &&
    accepted.termsBinding === binding.termsBinding
  )
}

export async function readMerchantOccurrenceAcceptedOrder(input: {
  merchantPubkey: string
  orderId: string
  order: OrderSchema | null
}): Promise<MerchantInventoryAcceptedOrder | undefined> {
  const store = merchantAcceptanceStore(input.merchantPubkey)
  await protectMerchantAcceptanceHistory(store)
  const saved = await db.merchantInventoryAcceptedOrders.get(input.orderId)
  store.assertCurrent()
  if (!saved) return undefined
  if (
    !input.order ||
    input.order.merchantPubkey !== input.merchantPubkey ||
    input.order.id !== input.orderId ||
    !matchesMerchantOccurrenceAcceptance(saved, input.order)
  )
    throw new Error("Order ID has conflicting accepted terms.")
  return saved
}

/** Input order is not evidence precedence; validate the signed coordinate itself. */
function strongestObservedProduct(
  products: readonly ProductSchema[],
  coordinate: string
): SignedPublicNostrEvent | undefined {
  let strongest: SignedPublicNostrEvent | undefined
  for (const product of products) {
    const event = product.signedProductEvent
    if (
      !event ||
      event.kind !== 30402 ||
      `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` !==
        coordinate ||
      !isValidSignedPublicNostrEvent(event)
    )
      continue
    if (
      !strongest ||
      compareReplaceableEventFrontiers(
        { createdAt: event.created_at, eventId: event.id },
        { createdAt: strongest.created_at, eventId: strongest.id }
      ) > 0
    )
      strongest = event
  }
  return strongest
}

/** Local acceptance uses committed inventory and known evidence, without a mandatory relay read. */
export async function acceptMerchantOccurrenceOrder(
  input: MerchantOccurrenceSession & {
    order: OrderSchema
    products: readonly ProductSchema[]
    priorStockAdjustments?: readonly MerchantInventoryPriorStockAdjustment[]
    /** Recording received payment may outlive the original occurrence. */
    purpose?: "payment-confirmation"
  }
) {
  assertSession(input)
  const order = orderSchema.parse(input.order)
  if (order.merchantPubkey !== input.merchantPubkey)
    throw new Error("Order belongs to another merchant.")
  const store = merchantAcceptanceStore(input.merchantPubkey)
  await protectMerchantAcceptanceHistory(store)
  assertSession(input)
  const { identityBinding, termsBinding } =
    merchantOccurrenceAcceptanceBindings(order)
  const previous = await db.merchantInventoryAcceptedOrders.get(order.id)
  if (previous) {
    assertSession(input)
    store.assertCurrent()
    if (!matchesMerchantOccurrenceAcceptance(previous, order))
      throw new Error("Order ID has conflicting accepted terms.")
    return { replayed: true, order: previous }
  }
  const eventItems = order.items.filter(
    (item) => item.fulfillment?.type === "event_market_pickup"
  )
  const orderEvidence = eventItems.length
    ? await admitEmbeddedEventMarketOrderEvidence(order)
    : []
  assertSession(input)
  if (
    eventItems.length &&
    verifyEventMarketOrderEvidence({ order, events: orderEvidence }).status !==
      "verified"
  )
    throw new Error("The order's exact signed event evidence is invalid.")
  await reconcileKnownOccurrenceLifecycle(input.merchantPubkey)
  const items: MerchantInventoryOrderItem[] = []
  for (const item of order.items) {
    const fulfillment = item.fulfillment
    const committed = await db.merchantInventoryProducts.get(item.productId)
    const observed = strongestObservedProduct(input.products, item.productId)
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
    const source = committed?.signedProductEvent ?? observed
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
    const productTermsEventId = committed?.sourceProductEvent.id ?? source.id
    const product = parseProductEvent(
      (await verifySignedEventBatches([source]))[0]!
    )
    // Only the exact-assignment lane below may use the explicit Event opt-in.
    // Historical hint-only and ordinary orders keep their public-product rule.
    const eventAssignment =
      fulfillment?.type === "event_market_pickup" &&
      !!fulfillment.occurrenceAssignment
    const visibilityAllowed = eventAssignment
      ? hasEventMarketListingVisibility(product)
      : product.visibility === "public" &&
        !product.eventOnly &&
        !product.eventOnlyMalformed
    if (
      product.pubkey !== input.merchantPubkey ||
      product.type === "variable" ||
      !visibilityAllowed
    )
      throw new Error("The product is not currently sellable.")
    if (
      item.sourcePrice &&
      normalizeCurrencyIdentity(item.sourcePrice.currency) !==
        normalizeCurrencyIdentity(item.sourcePrice.normalizedCurrency)
    )
      throw new Error(
        "Order source currency does not match its normalized currency."
      )
    // Explicit merchant acceptance honors the original order quote. Current
    // listing metadata remains the stock projection baseline, not a repricing.
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
    if (recovery.product.sourceProductEvent.id !== productTermsEventId)
      throw new Error(
        "The product changed during acceptance. Review it and try again."
      )
    if (fulfillment?.type === "event_market_pickup") {
      if (!fulfillment.occurrenceAssignment) {
        // Existing orders already verified their original signed authority above.
        // They consume ordinary stock, never manufacture a new assignment.
        items.push({
          productCoordinate: item.productId,
          method: "ordinary",
          quantity: item.quantity,
          admission: {
            kind: "validated-ordinary-product",
            productEventId: source.id,
            productTermsEventId,
          },
        })
        continue
      }
      if (fulfillment.mode !== "merchant_present")
        throw new Error("This order needs its delegated fulfillment workflow.")
      const settlement = input.purpose === "payment-confirmation"
      if (settlement && order.createdAt >= fulfillment.calendar.end)
        throw new Error(
          "Payment confirmation requires an order created before its signed occurrence end."
        )
      const retained = await loadRetainedSignedEventMarketEvidence(
        fulfillment.market.coordinate
      )
      const evidence = await verifySignedEventBatches([
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
      ])
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
        calendarEvent &&
        parseEventMarketCalendarEvent(
          (await verifySignedEventBatches([calendarEvent]))[0]!
        )
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
        (!settlement && calendar.end <= Date.now()) ||
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
      if (fulfillment.schedule) {
        const scheduleEvent = newest(evidence, fulfillment.schedule.coordinate)
        const schedule =
          scheduleEvent &&
          parseEventMarketSeriesEvent(
            (await verifySignedEventBatches([scheduleEvent]))[0]!
          )
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
          settlement,
          productEventId: source.id,
          productTermsEventId,
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
          productTermsEventId,
        },
      })
  }
  const sealed = await sealMerchantAcceptanceEvidence(
    store,
    order.id,
    JSON.stringify(order)
  )
  assertSession(input)
  return acceptMerchantInventoryOrder({
    db,
    orderId: order.id,
    merchantPubkey: input.merchantPubkey,
    identityBinding,
    termsBinding,
    ...sealed,
    assertCurrent: () => {
      assertSession(input)
      store.assertCurrent()
    },
    items,
    priorStockAdjustments: input.priorStockAdjustments,
  })
}
