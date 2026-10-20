import type {
  ConduitDB,
  EventMarketOrganizerStockPool,
  MerchantInventoryAcceptedOrder,
} from "../db"
import { orderSchema } from "../schemas"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import {
  admitEmbeddedEventMarketOrderEvidence,
  verifyEventMarketOrderEvidence,
} from "./event-market-order-evidence"
import { parseEventMarketStockAuthorityRumor } from "./event-market-stock-authority"
import {
  createVerifiedOrganizerStockImport,
  sameOrganizerStockRumor,
  validateMerchantOrganizerStockPool,
  type VerifiedImportEntry,
} from "./event-market-stock-import-authority"
import { getFutureMarketClaimRef } from "./future-market-handoff"
import {
  acceptMerchantInventoryOrder,
  outstandingOrganizerStockHold,
  type MerchantInventoryOrderItem,
} from "./merchant-inventory"
import {
  getOrganizerStockOrderBindings,
  merchantOccurrenceAcceptanceBindings,
} from "./merchant-order-acceptance-bindings"
import {
  merchantAcceptanceStore,
  openMerchantAcceptanceEvidence,
  protectMerchantAcceptanceHistory,
  sealMerchantAcceptanceEvidence,
} from "./merchant-acceptance-privacy"
export { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import type { AccountSigner } from "./nostr-event-signer"
import { parseOrderMessageRumorEvent } from "./orders"
import {
  completePrivateMessageEvent,
  unwrapPrivateMessageEnvelope,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import type { SignedPublicNostrEvent } from "./signed-event"

const MAX_STOCK = 2_147_483_647
const clone = <T>(value: T): T => structuredClone(value)

function session(input: {
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}) {
  const revision = input.signer.revision
  const authMethod = input.signer.authMethod
  const check = () => {
    if (
      !input.shouldContinue() ||
      !revision ||
      !authMethod ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== authMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44
    )
      throw new Error("Organizer stock import session changed")
  }
  return {
    check,
    authenticate: async () => {
      check()
      const pubkey = await input.signer.getPublicKey()
      check()
      if (pubkey !== input.authenticatedPubkey)
        throw new Error("Organizer stock import session changed")
    },
  }
}

async function unwrap(
  envelope: SignedPublicNostrEvent,
  signer: AccountSigner
): Promise<PrivateMessageRumor> {
  return completePrivateMessageEvent(
    await unwrapPrivateMessageEnvelope(envelope, signer)
  )
}

/** Import stock only. Payment settlement and organizer handout remain separate. */
export async function importMerchantOrganizerStockOrder(input: {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  originalOrderEnvelope: SignedPublicNostrEvent
  acceptedEnvelopes: readonly SignedPublicNostrEvent[]
  shouldContinue(): boolean
  nowMs?: number
}): Promise<{ replayed: boolean; order: MerchantInventoryAcceptedOrder }> {
  input = {
    ...input,
    originalOrderEnvelope: clone(input.originalOrderEnvelope),
    acceptedEnvelopes: clone([...input.acceptedEnvelopes]),
  }
  const authority = session(input)
  const nowMs = input.nowMs ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid stock import time")
  await authority.authenticate()
  const store = merchantAcceptanceStore(input.authenticatedPubkey, input.db)
  if (store.authorization.signer !== input.signer)
    throw new Error("Organizer stock import session changed")
  await protectMerchantAcceptanceHistory(store)
  const original = await unwrap(input.originalOrderEnvelope, input.signer)
  authority.check()
  const message = parseOrderMessageRumorEvent(original)
  if (message.type !== "order") throw new Error("Original buyer order required")
  const order = orderSchema.parse(message.payload)
  if (
    original.kind !== 16 ||
    original.pubkey !== order.buyerPubkey ||
    message.senderPubkey !== order.buyerPubkey ||
    message.recipientPubkey !== input.authenticatedPubkey ||
    message.orderId !== order.id ||
    order.merchantPubkey !== input.authenticatedPubkey ||
    order.items.some(
      (item) =>
        item.fulfillment?.type !== "event_market_pickup" ||
        item.fulfillment.mode !== "organizer_handoff"
    )
  )
    throw new Error("Buyer order does not authorize this Merchant stock import")
  const events = await admitEmbeddedEventMarketOrderEvidence(order)
  authority.check()
  const verification = verifyEventMarketOrderEvidence({ order, events })
  if (
    verification.status !== "verified" ||
    verification.mode !== "organizer_handoff"
  )
    throw new Error("Original signed organizer order evidence is invalid")
  const bindings = getOrganizerStockOrderBindings(order)
  const claimRef = getFutureMarketClaimRef({
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    organizerPubkey: verification.organizerPubkey,
    marketCoordinate: verification.marketCoordinate,
  })
  const entries: VerifiedImportEntry[] = []
  const items: MerchantInventoryOrderItem[] = []
  const seen = new Set<string>()
  for (const envelope of input.acceptedEnvelopes) {
    const rumor = await unwrap(envelope, input.signer)
    authority.check()
    const payload = parseEventMarketStockAuthorityRumor(rumor)
    if (
      payload.type !== "accepted" ||
      payload.merchantPubkey !== order.merchantPubkey ||
      payload.organizerPubkey !== verification.organizerPubkey ||
      payload.orderId !== order.id ||
      payload.identityBinding !== bindings.identityHash ||
      payload.termsBinding !== bindings.termsHash ||
      payload.claimRef !== claimRef ||
      payload.acceptedAtMs < order.createdAt ||
      payload.acceptedAtMs > nowMs ||
      seen.has(payload.poolId)
    )
      throw new Error("Organizer acceptance does not match the original order")
    seen.add(payload.poolId)
    const pool = await input.db.eventMarketOrganizerStockPools.get(
      `${order.merchantPubkey}:${payload.poolId}`
    )
    if (!pool) throw new Error("Original Merchant stock grant unavailable")
    const grant = validateMerchantOrganizerStockPool(pool, order.merchantPubkey)
    const poolItems = order.items.filter(
      (item) =>
        item.productId === grant.productCoordinate &&
        item.fulfillment?.type === "event_market_pickup" &&
        item.fulfillment.occurrenceAssignment?.coordinate ===
          grant.assignmentCoordinate
    )
    const quantity = poolItems.reduce((total, item) => total + item.quantity, 0)
    if (
      !poolItems.length ||
      quantity > MAX_STOCK ||
      quantity !== payload.quantity ||
      grant.writerId !== payload.writerId ||
      grant.organizerPubkey !== payload.organizerPubkey ||
      payload.acceptedAtMs < pool.grantRumor.created_at * 1000 ||
      payload.acceptedAtMs >= grant.expiresAtMs
    )
      throw new Error("Organizer stock acceptance exceeds its grant")
    for (const item of poolItems) {
      const fulfillment = item.fulfillment!
      if (fulfillment.type !== "event_market_pickup")
        throw new Error("Event pickup required")
      const committed = parseEventMarketAssignmentEvent(
        fulfillment.occurrenceAssignment!.signedEvent
      )
      if (
        !committed ||
        committed.previousEventId !== grant.assignmentEventId ||
        committed.stockPool.state !== "valid" ||
        committed.stockPool.pool.state !== "active" ||
        committed.stockPool.pool.poolId !== pool.poolId ||
        committed.stockPool.pool.quantity !== grant.quantity ||
        committed.stockPool.pool.importedQuantity !== 0 ||
        committed.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
        committed.createdAt * 1000 < pool.grantRumor.created_at * 1000 ||
        payload.acceptedAtMs < committed.createdAt * 1000 ||
        fulfillment.market.coordinate !== grant.marketCoordinate ||
        fulfillment.market.eventId !== grant.marketEventId ||
        fulfillment.calendar.coordinate !== grant.occurrenceCoordinate ||
        fulfillment.calendar.eventId !== grant.occurrenceEventId ||
        fulfillment.product.eventId !== grant.productEventId ||
        fulfillment.grant.eventId !== grant.grantEventId ||
        fulfillment.schedule?.eventId !== grant.scheduleEventId
      )
        throw new Error(
          "Order does not contain the exact public stock commitment"
        )
      items.push({
        productCoordinate: item.productId,
        assignmentCoordinate: grant.assignmentCoordinate,
        method: "pickup",
        quantity: item.quantity,
        admission: {
          kind: "validated-event-market-order",
          productEventId: grant.productEventId,
          assignmentCoordinate: grant.assignmentCoordinate,
          assignmentEventId: committed.eventId,
          marketEventId: grant.marketEventId,
          occurrenceEventId: grant.occurrenceEventId,
          grantEventId: grant.grantEventId,
          scheduleEventId: grant.scheduleEventId,
        },
      })
    }
    entries.push({
      rumor,
      payload,
      envelope: clone(envelope),
      grantRumor: clone(pool.grantRumor),
    })
  }
  if (!entries.length || items.length !== order.items.length)
    throw new Error("Every delegated order item requires its exact stock entry")
  const attribution: NonNullable<
    MerchantInventoryAcceptedOrder["organizerImport"]
  > = {
    originalOrderRumorId: original.id,
    organizerPubkey: verification.organizerPubkey,
    claimRef,
    entries: entries
      .map(({ rumor, payload }) => ({
        poolId: payload.poolId,
        entryId: rumor.id,
        writerId: payload.writerId,
        quantity: payload.quantity,
      }))
      .sort((a, b) => a.poolId.localeCompare(b.poolId)),
  }
  items.sort((a, b) => a.productCoordinate.localeCompare(b.productCoordinate))
  for (const item of items) {
    const product = await input.db.merchantInventoryProducts.get(
      item.productCoordinate
    )
    if (!product || product.merchantPubkey !== order.merchantPubkey)
      throw new Error("Committed Merchant product unavailable")
    item.admission.productTermsEventId = product.sourceProductEvent.id
  }
  const localBindings = merchantOccurrenceAcceptanceBindings(order)
  const sealed = await sealMerchantAcceptanceEvidence(
    store,
    order.id,
    bindings.termsBinding
  )
  const checkSession = () => {
    authority.check()
    store.assertCurrent()
  }
  const context = createVerifiedOrganizerStockImport({
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    ...localBindings,
    attribution,
    entries,
    checkSession,
  })
  authority.check()
  return acceptMerchantInventoryOrder({
    db: input.db,
    orderId: order.id,
    merchantPubkey: order.merchantPubkey,
    ...localBindings,
    ...sealed,
    assertCurrent: checkSession,
    items,
    organizerImport: context,
    acceptedAt: nowMs,
  })
}

/** An authenticated complete closing frontier, not expiry, releases unsold units. */
export async function reconcileMerchantOrganizerStockClose(input: {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  closingEnvelope: SignedPublicNostrEvent
  shouldContinue(): boolean
  nowMs?: number
}): Promise<{ replayed: boolean; pool: EventMarketOrganizerStockPool }> {
  input = { ...input, closingEnvelope: clone(input.closingEnvelope) }
  const authority = session(input)
  await authority.authenticate()
  const store = merchantAcceptanceStore(input.authenticatedPubkey, input.db)
  if (store.authorization.signer !== input.signer)
    throw new Error("Organizer stock import session changed")
  await protectMerchantAcceptanceHistory(store)
  const rumor = await unwrap(input.closingEnvelope, input.signer)
  authority.check()
  const close = parseEventMarketStockAuthorityRumor(rumor)
  if (
    close.type !== "closed" ||
    close.merchantPubkey !== input.authenticatedPubkey
  )
    throw new Error("Authenticated organizer closing frontier required")
  const id = `${input.authenticatedPubkey}:${close.poolId}`
  const before = await input.db.eventMarketOrganizerStockPools.get(id)
  if (!before) throw new Error("Merchant stock pool unavailable")
  const grant = validateMerchantOrganizerStockPool(
    before,
    input.authenticatedPubkey
  )
  if (
    close.organizerPubkey !== grant.organizerPubkey ||
    close.writerId !== grant.writerId ||
    rumor.created_at < before.grantRumor.created_at
  )
    throw new Error("Organizer close does not match the stock writer")
  const saved = await input.db.eventMarketOrganizerStockEntries
    .where("[accountPubkey+poolId]")
    .equals([input.authenticatedPubkey, close.poolId])
    .toArray()
  saved.sort((a, b) => a.sequence - b.sequence)
  let previousId = close.poolId
  let quantity = 0
  let previousTime = before.grantRumor.created_at * 1000
  if (saved.length !== close.sequence)
    throw new Error("Import every organizer acceptance before closing")
  for (const [index, entry] of saved.entries()) {
    if (!entry.receivedEnvelope || !entry.imported)
      throw new Error("Authenticated imported stock entry unavailable")
    const original = await unwrap(entry.receivedEnvelope, input.signer)
    authority.check()
    const accepted = parseEventMarketStockAuthorityRumor(original)
    if (
      accepted.type !== "accepted" ||
      !sameOrganizerStockRumor(original, entry.rumor) ||
      accepted.poolId !== close.poolId ||
      accepted.merchantPubkey !== close.merchantPubkey ||
      accepted.organizerPubkey !== close.organizerPubkey ||
      accepted.writerId !== close.writerId ||
      accepted.sequence !== index + 1 ||
      entry.sequence !== accepted.sequence ||
      entry.id !== `${input.authenticatedPubkey}:${original.id}` ||
      entry.orderId !== accepted.orderId ||
      entry.claimRef !== accepted.claimRef ||
      entry.quantity !== accepted.quantity ||
      accepted.previousId !== previousId ||
      accepted.acceptedAtMs < previousTime ||
      accepted.acceptedAtMs >= grant.expiresAtMs ||
      accepted.acceptedAtMs > rumor.created_at * 1000 + 999
    )
      throw new Error("Organizer closing journal is incomplete or conflicting")
    quantity += accepted.quantity
    previousId = original.id
    previousTime = accepted.acceptedAtMs
  }
  if (
    quantity !== close.acceptedQuantity ||
    quantity > grant.quantity ||
    previousId !== close.lastAcceptedId ||
    before.importedSequence !== close.sequence ||
    before.importedQuantity !== quantity ||
    before.lastImportedId !== previousId ||
    before.acceptedSequence !== close.sequence ||
    before.acceptedQuantity !== quantity ||
    before.lastAcceptedId !== previousId
  )
    throw new Error("Organizer close does not match the imported frontier")
  const nowMs = input.nowMs ?? Date.now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid stock closing time")
  if (rumor.created_at * 1000 > nowMs)
    throw new Error("Organizer close is future dated")
  authority.check()
  const acceptedOrders = new Map<string, MerchantInventoryAcceptedOrder>()
  for (const entry of saved) {
    const accepted = await input.db.merchantInventoryAcceptedOrders.get(
      entry.orderId
    )
    if (!accepted)
      throw new Error("Imported order attribution requires reconciliation")
    const order = orderSchema.parse(
      JSON.parse(await openMerchantAcceptanceEvidence(accepted, store))
    )
    const wire = getOrganizerStockOrderBindings(order)
    const local = merchantOccurrenceAcceptanceBindings(order)
    const payload = parseEventMarketStockAuthorityRumor(entry.rumor)
    if (
      payload.type !== "accepted" ||
      accepted.identityBinding !== local.identityBinding ||
      accepted.termsBinding !== local.termsBinding ||
      payload.identityBinding !== wire.identityHash ||
      payload.termsBinding !== wire.termsHash
    )
      throw new Error("Imported order attribution requires reconciliation")
    acceptedOrders.set(entry.orderId, accepted)
  }
  store.assertCurrent()
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
      input.db.merchantInventoryAssignments,
      input.db.merchantInventoryAcceptedOrders,
    ],
    async () => {
      authority.check()
      store.assertCurrent()
      const pool = await input.db.eventMarketOrganizerStockPools.get(id)
      const currentEntries = await input.db.eventMarketOrganizerStockEntries
        .where("[accountPubkey+poolId]")
        .equals([input.authenticatedPubkey, close.poolId])
        .toArray()
      currentEntries.sort((a, b) => a.sequence - b.sequence)
      if (
        !pool ||
        JSON.stringify(pool) !== JSON.stringify(before) ||
        JSON.stringify(currentEntries) !== JSON.stringify(saved)
      )
        throw new Error("Stock import frontier changed during closing")
      for (const entry of currentEntries) {
        const accepted = await input.db.merchantInventoryAcceptedOrders.get(
          entry.orderId
        )
        const payload = parseEventMarketStockAuthorityRumor(entry.rumor)
        if (
          payload.type !== "accepted" ||
          !accepted ||
          accepted.merchantPubkey !== input.authenticatedPubkey ||
          accepted.evidenceBinding !== entry.evidence ||
          JSON.stringify(accepted) !==
            JSON.stringify(acceptedOrders.get(entry.orderId)) ||
          accepted.organizerImport?.organizerPubkey !== close.organizerPubkey ||
          accepted.organizerImport.claimRef !== payload.claimRef ||
          !accepted?.organizerImport?.entries.some(
            (item) =>
              item.poolId === close.poolId &&
              item.entryId === entry.rumor.id &&
              item.writerId === close.writerId &&
              item.quantity === entry.quantity
          )
        )
          throw new Error("Imported order attribution requires reconciliation")
      }
      if (pool.state === "closed") {
        if (
          !pool.closingRumor ||
          !sameOrganizerStockRumor(pool.closingRumor, rumor)
        )
          throw new Error("Stock close identity conflict")
        store.assertCurrent()
        return { replayed: true, pool }
      }
      if (
        pool.closingRumor &&
        !sameOrganizerStockRumor(pool.closingRumor, rumor)
      )
        throw new Error("Stock close identity conflict")
      const assignment = await input.db.merchantInventoryAssignments.get(
        grant.assignmentCoordinate
      )
      if (
        !assignment ||
        assignment.merchantPubkey !== input.authenticatedPubkey ||
        assignment.organizerStockHold?.poolId !== close.poolId ||
        assignment.organizerStockHold.quantity !== grant.quantity ||
        assignment.organizerStockHold.importedQuantity !== quantity ||
        assignment.organizerStockHold.closed
      )
        throw new Error("Merchant stock hold requires reconciliation")
      outstandingOrganizerStockHold(assignment)
      assignment.organizerStockHold.closed = true
      assignment.revision += 1
      assignment.publicationJobs.push({
        id: `${rumor.id}:close`,
        revision: assignment.revision,
        state: "awaiting_signature",
        createdAt: nowMs,
        assignmentSnapshot: {
          state: assignment.state,
          inventory: clone(assignment.inventory),
          fulfillmentMethods: [...assignment.fulfillmentMethods],
          organizerStockHold: clone(assignment.organizerStockHold),
        },
      })
      pool.state = "closed"
      pool.closingRumor = rumor
      pool.receivedClosingEnvelope = clone(input.closingEnvelope)
      authority.check()
      await input.db.merchantInventoryAssignments.put(assignment)
      await input.db.eventMarketOrganizerStockPools.put(pool)
      store.assertCurrent()
      return { replayed: false, pool }
    }
  )
}
