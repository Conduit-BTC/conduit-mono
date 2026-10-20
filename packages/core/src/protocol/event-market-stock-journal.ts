import type {
  ConduitDB,
  EventMarketOrganizerStockEntry,
  EventMarketOrganizerStockPool,
  EventMarketOrganizerStockWriter,
} from "../db"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockGrant,
} from "./event-market-stock-authority"
import { outstandingOrganizerStockHold } from "./merchant-inventory"
import type { AccountSigner } from "./nostr-event-signer"
import {
  wrapPrivateMessage,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import type { SignedPublicNostrEvent } from "./signed-event"
import { assertOrganizerStockWriterCurrent } from "./event-market-stock-writer-guard"
import { organizerStockWriterKey } from "./event-market-stock-writer-guard"
import { sameOrganizerStockRumor } from "./event-market-stock-import-authority"

const poolKey = (account: string, pool: string) => `${account}:${pool}`
const entryKey = (account: string, entry: string) => `${account}:${entry}`
const clone = <T>(value: T): T => structuredClone(value)

function requireTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid stock journal time")
}
function requireSession(input: { shouldContinue?: () => boolean }): void {
  if (input.shouldContinue?.() === false)
    throw new Error("Stock authority session changed")
}

function readGrant(rumor: PrivateMessageRumor): EventMarketStockGrant {
  const payload = parseEventMarketStockAuthorityRumor(rumor)
  if (payload.type !== "grant") throw new Error("Stock grant required")
  return payload
}

function assertPool(
  pool: EventMarketOrganizerStockPool
): EventMarketStockGrant {
  const grant = readGrant(pool.grantRumor)
  const count = (n: number) =>
    Number.isInteger(n) && n >= 0 && n <= grant.quantity
  if (
    pool.poolId !== pool.grantRumor.id ||
    pool.id !== poolKey(pool.accountPubkey, pool.poolId) ||
    ![grant.merchantPubkey, grant.organizerPubkey].includes(
      pool.accountPubkey
    ) ||
    pool.merchantPubkey !== grant.merchantPubkey ||
    pool.organizerPubkey !== grant.organizerPubkey ||
    pool.writerId !== grant.writerId ||
    pool.assignmentCoordinate !== grant.assignmentCoordinate ||
    pool.productCoordinate !== grant.productCoordinate ||
    pool.quantity !== grant.quantity ||
    !count(pool.acceptedQuantity) ||
    !count(pool.acceptedSequence) ||
    !count(pool.importedQuantity) ||
    !count(pool.importedSequence) ||
    pool.acceptedSequence > pool.acceptedQuantity ||
    pool.importedSequence > pool.importedQuantity ||
    pool.importedSequence > pool.acceptedSequence ||
    pool.importedQuantity > pool.acceptedQuantity ||
    (pool.importedSequence === pool.acceptedSequence &&
      (pool.importedQuantity !== pool.acceptedQuantity ||
        pool.lastImportedId !== pool.lastAcceptedId)) ||
    (pool.readOnlyRecovery !== undefined && pool.readOnlyRecovery !== true) ||
    (pool.state === "closed" &&
      (!pool.closingRumor ||
        pool.importedSequence !== pool.acceptedSequence ||
        pool.importedQuantity !== pool.acceptedQuantity)) ||
    (pool.acceptedSequence === 0 &&
      (pool.acceptedQuantity !== 0 || pool.lastAcceptedId !== pool.poolId)) ||
    (pool.importedSequence === 0 &&
      (pool.importedQuantity !== 0 || pool.lastImportedId !== pool.poolId)) ||
    !/^[0-9a-f]{64}$/.test(pool.lastAcceptedId) ||
    !/^[0-9a-f]{64}$/.test(pool.lastImportedId) ||
    !["prepared", "active", "closing", "closed"].includes(pool.state)
  )
    throw new Error("Organizer stock journal requires reconciliation")
  return grant
}

/** Internal reload validation; lifecycle coverage never substitutes for a frontier. */
export function validateOrganizerStockJournalPool(
  pool: EventMarketOrganizerStockPool
): EventMarketStockGrant {
  return assertPool(pool)
}

function newPool(
  accountPubkey: string,
  rumor: PrivateMessageRumor,
  state: "prepared" | "active"
): EventMarketOrganizerStockPool {
  const grant = readGrant(rumor)
  return {
    id: poolKey(accountPubkey, rumor.id),
    accountPubkey,
    poolId: rumor.id,
    merchantPubkey: grant.merchantPubkey,
    organizerPubkey: grant.organizerPubkey,
    writerId: grant.writerId,
    productCoordinate: grant.productCoordinate,
    assignmentCoordinate: grant.assignmentCoordinate,
    grantRumor: clone(rumor),
    quantity: grant.quantity,
    acceptedQuantity: 0,
    acceptedSequence: 0,
    lastAcceptedId: rumor.id,
    importedQuantity: 0,
    importedSequence: 0,
    lastImportedId: rumor.id,
    state,
  }
}

/** A retained Merchant close acknowledges the intact original writer's frontier. */
function reconcileOriginalOrganizerStockClose(input: {
  pool: EventMarketOrganizerStockPool
  entries: readonly EventMarketOrganizerStockEntry[]
  nextGrant: EventMarketStockGrant
  closedAssignmentEvents: readonly SignedPublicNostrEvent[]
  nowMs: number
}): EventMarketOrganizerStockPool {
  const { pool, nextGrant, nowMs } = input
  const grant = assertPool(pool)
  const fail = () => {
    throw new Error("An organizer writer already holds this assignment")
  }
  const closingRumor = pool.closingRumor
  if (
    pool.state !== "closing" ||
    pool.readOnlyRecovery ||
    pool.accountPubkey !== nextGrant.organizerPubkey ||
    pool.organizerPubkey !== nextGrant.organizerPubkey ||
    pool.merchantPubkey !== nextGrant.merchantPubkey ||
    pool.writerId !== nextGrant.writerId ||
    grant.marketCoordinate !== nextGrant.marketCoordinate ||
    grant.occurrenceCoordinate !== nextGrant.occurrenceCoordinate ||
    grant.assignmentCoordinate !== nextGrant.assignmentCoordinate ||
    grant.productCoordinate !== nextGrant.productCoordinate ||
    !closingRumor
  )
    return fail()
  const closing = parseEventMarketStockAuthorityRumor(closingRumor)
  if (
    closing.type !== "closed" ||
    closing.poolId !== pool.poolId ||
    closing.merchantPubkey !== grant.merchantPubkey ||
    closing.organizerPubkey !== grant.organizerPubkey ||
    closing.writerId !== grant.writerId ||
    closing.sequence !== pool.acceptedSequence ||
    closing.acceptedQuantity !== pool.acceptedQuantity ||
    closing.lastAcceptedId !== pool.lastAcceptedId ||
    closingRumor.created_at < pool.grantRumor.created_at ||
    closingRumor.created_at * 1000 > nowMs
  )
    return fail()
  const projections = input.closedAssignmentEvents
    .map(parseEventMarketAssignmentEvent)
    .filter(
      (assignment) =>
        assignment?.coordinate === grant.assignmentCoordinate &&
        assignment.stockPool.state === "valid" &&
        assignment.stockPool.pool.state === "closed" &&
        assignment.stockPool.pool.poolId === pool.poolId
    )
  if (
    !projections.length ||
    projections.some(
      (assignment) =>
        !assignment ||
        assignment.merchantPubkey !== grant.merchantPubkey ||
        assignment.organizerPubkey !== grant.organizerPubkey ||
        assignment.marketCoordinate !== grant.marketCoordinate ||
        assignment.occurrenceCoordinate !== grant.occurrenceCoordinate ||
        assignment.productCoordinate !== grant.productCoordinate ||
        assignment.createdAt < closingRumor.created_at ||
        assignment.createdAt * 1000 > nowMs ||
        assignment.stockPool.state !== "valid" ||
        assignment.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
        assignment.stockPool.pool.quantity !== grant.quantity ||
        assignment.stockPool.pool.importedQuantity !== closing.acceptedQuantity
    )
  )
    return fail()
  const entries = [...input.entries].sort((a, b) => a.sequence - b.sequence)
  if (entries.length !== closing.sequence) return fail()
  let previousId = pool.poolId,
    quantity = 0,
    previousTime = pool.grantRumor.created_at * 1000,
    importedId = pool.poolId,
    importedQuantity = 0
  for (const [index, entry] of entries.entries()) {
    const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
    if (
      accepted.type !== "accepted" ||
      entry.id !== entryKey(pool.accountPubkey, entry.rumor.id) ||
      entry.accountPubkey !== pool.accountPubkey ||
      entry.poolId !== pool.poolId ||
      entry.sequence !== index + 1 ||
      accepted.sequence !== entry.sequence ||
      accepted.poolId !== pool.poolId ||
      accepted.merchantPubkey !== grant.merchantPubkey ||
      accepted.organizerPubkey !== grant.organizerPubkey ||
      accepted.writerId !== grant.writerId ||
      accepted.orderId !== entry.orderId ||
      accepted.claimRef !== entry.claimRef ||
      accepted.quantity !== entry.quantity ||
      accepted.previousId !== previousId ||
      accepted.acceptedAtMs < previousTime ||
      accepted.acceptedAtMs >= grant.expiresAtMs ||
      accepted.acceptedAtMs > closingRumor.created_at * 1000 + 999
    )
      return fail()
    quantity += accepted.quantity
    previousId = entry.rumor.id
    previousTime = accepted.acceptedAtMs
    if (entry.sequence <= pool.importedSequence) {
      importedQuantity += accepted.quantity
      importedId = entry.rumor.id
    }
  }
  if (
    quantity !== closing.acceptedQuantity ||
    previousId !== closing.lastAcceptedId ||
    importedQuantity !== pool.importedQuantity ||
    importedId !== pool.lastImportedId
  )
    return fail()
  return {
    ...pool,
    state: "closed",
    importedQuantity: quantity,
    importedSequence: closing.sequence,
    lastImportedId: previousId,
  }
}

/**
 * Reserve before signing. The authenticated workflow must first verify current
 * roster/occurrence/admission evidence; these references do not replace it.
 * This local primitive does not publish, enable checkout, or grant handout.
 */
export async function prepareMerchantOrganizerStockPool(input: {
  db: ConduitDB
  authenticatedPubkey: string
  grantRumor: PrivateMessageRumor
  expectedAssignmentRevision: number
  shouldContinue?(): boolean
  nowMs?: number
}): Promise<EventMarketOrganizerStockPool> {
  input = { ...input, grantRumor: clone(input.grantRumor) }
  const rumor = clone(input.grantRumor)
  const grant = readGrant(rumor)
  const expectedRevision = input.expectedAssignmentRevision
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  requireSession(input)
  if (
    input.authenticatedPubkey !== grant.merchantPubkey ||
    rumor.created_at * 1000 > nowMs ||
    nowMs >= grant.expiresAtMs
  )
    throw new Error("Merchant stock handover is not current")
  const { db } = input
  return db.transaction(
    "rw",
    [
      db.merchantInventoryProducts,
      db.merchantInventoryAssignments,
      db.eventMarketOrganizerStockPools,
    ],
    async () => {
      const prior = await db.eventMarketOrganizerStockPools.get(
        poolKey(grant.merchantPubkey, rumor.id)
      )
      if (prior) {
        assertPool(prior)
        if (!sameOrganizerStockRumor(prior.grantRumor, rumor))
          throw new Error("Stock grant identity conflict")
        requireSession(input)
        return prior
      }
      const assignment = await db.merchantInventoryAssignments.get(
        grant.assignmentCoordinate
      )
      const product = await db.merchantInventoryProducts.get(
        grant.productCoordinate
      )
      if (
        !assignment ||
        !product ||
        assignment.merchantPubkey !== grant.merchantPubkey ||
        product.merchantPubkey !== grant.merchantPubkey ||
        assignment.productCoordinate !== grant.productCoordinate ||
        assignment.marketCoordinate !== grant.marketCoordinate ||
        assignment.occurrenceCoordinate !== grant.occurrenceCoordinate ||
        assignment.revision !== expectedRevision ||
        assignment.signedAssignmentEvent?.id !== grant.assignmentEventId ||
        product.signedProductEvent.id !== grant.productEventId ||
        assignment.state !== "active" ||
        assignment.terminal ||
        nowMs >= assignment.occurrenceEndMs ||
        grant.expiresAtMs > assignment.occurrenceEndMs ||
        !assignment.fulfillmentMethods.includes("pickup") ||
        assignment.inventory.mode !== "tracked" ||
        product.stock === undefined ||
        grant.quantity > assignment.inventory.quantity ||
        grant.quantity > product.stock
      )
        throw new Error("Committed assignment cannot entrust this stock")
      // A second grant cannot replace an unresolved writer, even when all of
      // its units appear imported. Only its authenticated close releases it.
      outstandingOrganizerStockHold(assignment)
      if (assignment.organizerStockHold?.closed === false)
        throw new Error(
          "Organizer stock handover still requires reconciliation"
        )
      if (
        [...product.publicationJobs, ...assignment.publicationJobs].some(
          (work) => work.state !== "delivered" && work.state !== "superseded"
        )
      )
        throw new Error(
          "Publish the current inventory revision before handover"
        )
      const hold = {
        poolId: rumor.id,
        organizerPubkey: grant.organizerPubkey,
        quantity: grant.quantity,
        importedQuantity: 0,
        closed: false,
      }
      assignment.organizerStockHold = hold
      assignment.revision += 1
      assignment.publicationJobs.push({
        id: `${rumor.id}:reserve`,
        revision: assignment.revision,
        state: "awaiting_signature",
        createdAt: nowMs,
        assignmentSnapshot: {
          state: assignment.state,
          inventory: clone(assignment.inventory),
          fulfillmentMethods: [...assignment.fulfillmentMethods],
          organizerStockHold: clone(hold),
        },
      })
      const pool = newPool(grant.merchantPubkey, rumor, "prepared")
      requireSession(input)
      await db.merchantInventoryAssignments.put(assignment)
      await db.eventMarketOrganizerStockPools.add(pool)
      requireSession(input)
      return pool
    }
  )
}

/**
 * Initial installation on the explicitly designated organizer writer only.
 * A fresh device must recover/handover its journal, never call this to reset it.
 * The public Merchant signature commits the exact private grant bytes.
 */
export async function installOrganizerStockHandover(input: {
  db: ConduitDB
  authenticatedPubkey: string
  writerId: string
  grantRumor: PrivateMessageRumor
  committedAssignmentEvent: SignedPublicNostrEvent
  /** Retained positive Merchant closure evidence, never inferred from a new grant. */
  closedAssignmentEvents?: readonly SignedPublicNostrEvent[]
  /** Captured by authenticated registration verification; constrains this attempt. */
  expectedWriterRegistration?: Pick<
    EventMarketOrganizerStockWriter,
    "deviceId" | "generation" | "installedPoolIds" | "transferId"
  >
  shouldContinue?(): boolean
  nowMs?: number
}): Promise<EventMarketOrganizerStockPool> {
  input = {
    ...input,
    grantRumor: clone(input.grantRumor),
    committedAssignmentEvent: clone(input.committedAssignmentEvent),
    closedAssignmentEvents: clone([...(input.closedAssignmentEvents ?? [])]),
    expectedWriterRegistration: input.expectedWriterRegistration
      ? clone(input.expectedWriterRegistration)
      : undefined,
  }
  const rumor = clone(input.grantRumor)
  const grant = readGrant(rumor)
  const assignment = parseEventMarketAssignmentEvent(
    clone(input.committedAssignmentEvent)
  )
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  requireSession(input)
  if (
    input.authenticatedPubkey !== grant.organizerPubkey ||
    input.writerId !== grant.writerId ||
    nowMs < rumor.created_at * 1000 ||
    nowMs >= grant.expiresAtMs ||
    !assignment ||
    assignment.coordinate !== grant.assignmentCoordinate ||
    assignment.productCoordinate !== grant.productCoordinate ||
    assignment.marketCoordinate !== grant.marketCoordinate ||
    assignment.occurrenceCoordinate !== grant.occurrenceCoordinate ||
    assignment.previousEventId !== grant.assignmentEventId ||
    assignment.state !== "active" ||
    assignment.inventory.mode !== "tracked" ||
    assignment.inventory.quantity < grant.quantity ||
    assignment.createdAt < rumor.created_at ||
    assignment.createdAt * 1000 > nowMs ||
    assignment.stockPool.state !== "valid" ||
    assignment.stockPool.pool.state !== "active" ||
    assignment.stockPool.pool.poolId !== rumor.id ||
    assignment.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
    assignment.stockPool.pool.quantity !== grant.quantity ||
    assignment.stockPool.pool.importedQuantity !== 0
  )
    throw new Error("Organizer stock handover does not match its commitment")
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
      input.db.eventMarketOrganizerStockWriters,
    ],
    async () => {
      await assertOrganizerStockWriterCurrent({
        db: input.db,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: grant.marketCoordinate,
        writerId: input.writerId,
      })
      const id = poolKey(grant.organizerPubkey, rumor.id)
      const prior = await input.db.eventMarketOrganizerStockPools.get(id)
      const registration = await input.db.eventMarketOrganizerStockWriters.get(
        organizerStockWriterKey(
          input.authenticatedPubkey,
          grant.marketCoordinate
        )
      )
      const expected = input.expectedWriterRegistration
      if (
        expected &&
        (!registration ||
          registration.deviceId !== expected.deviceId ||
          registration.generation !== expected.generation ||
          registration.transferId !== expected.transferId ||
          JSON.stringify(registration.installedPoolIds) !==
            JSON.stringify(expected.installedPoolIds))
      )
        throw new Error("The verified stock writer registration changed.")
      if (registration) {
        const missingJournal = () => {
          throw new Error(
            "The original stock journal is missing; recover it before continuing."
          )
        }
        if (
          !Array.isArray(registration.installedPoolIds) ||
          new Set(registration.installedPoolIds).size !==
            registration.installedPoolIds.length ||
          registration.installedPoolIds.some(
            (poolId) =>
              typeof poolId !== "string" || !/^[0-9a-f]{64}$/.test(poolId)
          )
        )
          missingJournal()
        const installed = await input.db.eventMarketOrganizerStockPools.bulkGet(
          registration.installedPoolIds.map((poolId) =>
            poolKey(input.authenticatedPubkey, poolId)
          )
        )
        for (const [index, saved] of installed.entries()) {
          if (
            !saved ||
            saved.poolId !== registration.installedPoolIds[index] ||
            saved.accountPubkey !== input.authenticatedPubkey ||
            saved.organizerPubkey !== input.authenticatedPubkey ||
            saved.writerId !== input.writerId ||
            saved.readOnlyRecovery
          )
            return missingJournal()
          if (assertPool(saved).marketCoordinate !== grant.marketCoordinate)
            missingJournal()
        }
      }
      if (registration?.installedPoolIds.includes(rumor.id) && !prior)
        throw new Error(
          "The original stock journal is missing; recover it before continuing."
        )
      if (prior) {
        assertPool(prior)
        if (!sameOrganizerStockRumor(prior.grantRumor, rumor))
          throw new Error("Stock grant identity conflict")
        requireSession(input)
        return prior
      }
      const overlapping = await input.db.eventMarketOrganizerStockPools
        .where("[accountPubkey+assignmentCoordinate]")
        .equals([grant.organizerPubkey, grant.assignmentCoordinate])
        .toArray()
      for (const previous of overlapping) {
        if (previous.state === "closed") continue
        const entries = await input.db.eventMarketOrganizerStockEntries
          .where("[accountPubkey+poolId]")
          .equals([input.authenticatedPubkey, previous.poolId])
          .toArray()
        const closed = reconcileOriginalOrganizerStockClose({
          pool: previous,
          entries,
          nextGrant: grant,
          closedAssignmentEvents: input.closedAssignmentEvents!,
          nowMs,
        })
        requireSession(input)
        await input.db.eventMarketOrganizerStockPools.put(closed)
      }
      const pool = newPool(grant.organizerPubkey, rumor, "active")
      requireSession(input)
      await input.db.eventMarketOrganizerStockPools.add(pool)
      if (registration) {
        registration.installedPoolIds = [
          ...new Set([...registration.installedPoolIds, rumor.id]),
        ]
        await input.db.eventMarketOrganizerStockWriters.put(registration)
      }
      requireSession(input)
      return pool
    }
  )
}

/** Durable consumption only; commerce settlement/claim verification is separate. */
export async function commitOrganizerStockAcceptance(input: {
  db: ConduitDB
  authenticatedPubkey: string
  writerId: string
  poolId: string
  orderId: string
  identityBinding: string
  termsBinding: string
  claimRef: string
  quantity: number
  /** Exact private, already validated original order evidence. */
  evidence: string
  /** Supplied only by the whole-order journal transaction. */
  orderPoolBinding?: string
  shouldContinue?(): boolean
  nowMs?: number
}): Promise<{ replayed: boolean; entry: EventMarketOrganizerStockEntry }> {
  input = { ...input }
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  requireSession(input)
  if (
    !input.evidence ||
    new TextEncoder().encode(input.evidence).length > 65_536
  )
    throw new Error("Invalid organizer order evidence")
  const { db } = input
  return db.transaction(
    "rw",
    [
      db.eventMarketOrganizerStockPools,
      db.eventMarketOrganizerStockEntries,
      db.eventMarketOrganizerStockWriters,
    ],
    async () => {
      const pool = await db.eventMarketOrganizerStockPools.get(
        poolKey(input.authenticatedPubkey, input.poolId)
      )
      if (
        !pool ||
        pool.organizerPubkey !== input.authenticatedPubkey ||
        pool.writerId !== input.writerId
      )
        throw new Error("Organizer stock writer unavailable")
      const grant = assertPool(pool)
      await assertOrganizerStockWriterCurrent({
        db,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: grant.marketCoordinate,
        writerId: input.writerId,
      })
      const prior = await db.eventMarketOrganizerStockEntries
        .where("[accountPubkey+poolId+orderId]")
        .equals([input.authenticatedPubkey, input.poolId, input.orderId])
        .first()
      if (prior) {
        const accepted = parseEventMarketStockAuthorityRumor(prior.rumor)
        if (
          accepted.type !== "accepted" ||
          accepted.identityBinding !== input.identityBinding ||
          accepted.termsBinding !== input.termsBinding ||
          accepted.claimRef !== input.claimRef ||
          accepted.quantity !== input.quantity ||
          (prior.orderPoolBinding !== undefined &&
            prior.orderPoolBinding !== input.orderPoolBinding) ||
          prior.evidence !== input.evidence
        )
          throw new Error("Organizer order ID is bound to different terms")
        requireSession(input)
        return { replayed: true, entry: prior }
      }
      if (
        pool.state !== "active" ||
        pool.readOnlyRecovery ||
        nowMs >= grant.expiresAtMs ||
        nowMs < pool.grantRumor.created_at * 1000
      )
        throw new Error("Organizer stock acceptance has ended")
      if (pool.acceptedSequence > 0) {
        const predecessor = await db.eventMarketOrganizerStockEntries.get(
          entryKey(input.authenticatedPubkey, pool.lastAcceptedId)
        )
        const previous =
          predecessor && parseEventMarketStockAuthorityRumor(predecessor.rumor)
        if (
          !previous ||
          previous.type !== "accepted" ||
          previous.sequence !== pool.acceptedSequence ||
          previous.poolId !== pool.poolId ||
          previous.acceptedAtMs > nowMs
        )
          throw new Error(
            "Organizer journal predecessor requires reconciliation"
          )
      }
      if (
        !Number.isInteger(input.quantity) ||
        input.quantity < 1 ||
        input.quantity > pool.quantity - pool.acceptedQuantity
      )
        throw new Error("Insufficient entrusted organizer stock")
      const rumor = createEventMarketStockAuthorityRumor({
        createdAt: Math.floor(nowMs / 1000),
        payload: {
          version: 1,
          type: "accepted",
          merchantPubkey: pool.merchantPubkey,
          organizerPubkey: pool.organizerPubkey,
          writerId: pool.writerId,
          poolId: pool.poolId,
          sequence: pool.acceptedSequence + 1,
          previousId: pool.lastAcceptedId,
          orderId: input.orderId,
          identityBinding: input.identityBinding,
          termsBinding: input.termsBinding,
          claimRef: input.claimRef,
          quantity: input.quantity,
          acceptedAtMs: nowMs,
        },
      })
      const entry: EventMarketOrganizerStockEntry = {
        id: entryKey(input.authenticatedPubkey, rumor.id),
        accountPubkey: input.authenticatedPubkey,
        poolId: pool.poolId,
        sequence: pool.acceptedSequence + 1,
        orderId: input.orderId,
        claimRef: input.claimRef,
        rumor,
        quantity: input.quantity,
        evidence: input.evidence,
        ...(input.orderPoolBinding
          ? { orderPoolBinding: input.orderPoolBinding }
          : {}),
        imported: false,
      }
      pool.acceptedQuantity += input.quantity
      pool.acceptedSequence += 1
      pool.lastAcceptedId = rumor.id
      requireSession(input)
      await db.eventMarketOrganizerStockEntries.add(entry)
      await db.eventMarketOrganizerStockPools.put(pool)
      requireSession(input)
      return { replayed: false, entry }
    }
  )
}

/** A multi-product order consumes all entrusted pools or none, before sealing. */
export async function commitOrganizerStockOrder(input: {
  db: ConduitDB
  authenticatedPubkey: string
  orderId: string
  identityBinding: string
  termsBinding: string
  claimRef: string
  evidence: string
  entries: readonly { poolId: string; writerId: string; quantity: number }[]
  shouldContinue?(): boolean
  nowMs?: number
}): Promise<{ replayed: boolean; entries: EventMarketOrganizerStockEntry[] }> {
  input = {
    ...input,
    entries: input.entries.map(({ poolId, writerId, quantity }) => ({
      poolId,
      writerId,
      quantity,
    })),
    nowMs: input.nowMs ?? Date.now(),
  }
  requireTime(input.nowMs!)
  requireSession(input)
  if (
    !input.entries.length ||
    input.entries.some(
      (entry) =>
        !/^[0-9a-f]{64}$/.test(entry.poolId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          entry.writerId
        ) ||
        !Number.isInteger(entry.quantity) ||
        entry.quantity < 1 ||
        entry.quantity > 2_147_483_647
    ) ||
    new Set(input.entries.map((entry) => entry.poolId)).size !==
      input.entries.length
  )
    throw new Error(
      "An exact unique organizer pool is required for every order line"
    )
  const orderPoolBinding = JSON.stringify(
    [...input.entries].sort((a, b) => a.poolId.localeCompare(b.poolId))
  )
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
      input.db.eventMarketOrganizerStockWriters,
    ],
    async () => {
      requireSession(input)
      const priorEntries = await input.db.eventMarketOrganizerStockEntries
        .where("accountPubkey")
        .equals(input.authenticatedPubkey)
        .filter((entry) => entry.orderId === input.orderId)
        .toArray()
      if (
        priorEntries.some(
          (entry) =>
            !input.entries.some(
              (candidate) => candidate.poolId === entry.poolId
            ) ||
            (entry.orderPoolBinding !== undefined &&
              entry.orderPoolBinding !== orderPoolBinding)
        )
      )
        throw new Error(
          "Organizer order is bound to a different complete pool manifest"
        )
      if (priorEntries.length && priorEntries.length !== input.entries.length)
        throw new Error(
          "Partial legacy organizer order needs reconciliation before whole-order replay"
        )
      const priorTimes = priorEntries.map((entry) => {
        const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
        if (accepted.type !== "accepted")
          throw new Error("Organizer order entry requires reconciliation")
        return accepted.acceptedAtMs
      })
      if (new Set(priorTimes).size > 1)
        throw new Error(
          "Organizer order acceptance times do not form one atomic decision"
        )
      const results = [] as Awaited<
        ReturnType<typeof commitOrganizerStockAcceptance>
      >[]
      for (const entry of input.entries)
        results.push(
          await commitOrganizerStockAcceptance({
            ...input,
            ...entry,
            orderPoolBinding,
          })
        )
      for (const result of results) {
        if (result.entry.orderPoolBinding === undefined) {
          result.entry.orderPoolBinding = orderPoolBinding
          await input.db.eventMarketOrganizerStockEntries.put(result.entry)
        }
      }
      requireSession(input)
      return {
        replayed: results.every((result) => result.replayed),
        entries: results.map((result) => result.entry),
      }
    }
  )
}

/** Closing is durable before any seal request and serializes with acceptance. */
export async function beginOrganizerStockClose(input: {
  db: ConduitDB
  authenticatedPubkey: string
  writerId: string
  poolId: string
  shouldContinue?(): boolean
  nowMs?: number
}): Promise<PrivateMessageRumor> {
  input = { ...input }
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  requireSession(input)
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
      input.db.eventMarketOrganizerStockWriters,
    ],
    async () => {
      const pool = await input.db.eventMarketOrganizerStockPools.get(
        poolKey(input.authenticatedPubkey, input.poolId)
      )
      if (
        !pool ||
        pool.organizerPubkey !== input.authenticatedPubkey ||
        pool.writerId !== input.writerId
      )
        throw new Error("Organizer stock writer unavailable")
      const grant = assertPool(pool)
      await assertOrganizerStockWriterCurrent({
        db: input.db,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: grant.marketCoordinate,
        writerId: input.writerId,
      })
      if (pool.closingRumor) {
        requireSession(input)
        return pool.closingRumor
      }
      if (pool.state !== "active")
        throw new Error("Organizer stock pool cannot close")
      if (nowMs < pool.grantRumor.created_at * 1000)
        throw new Error("Organizer stock close predates its grant")
      if (pool.acceptedSequence > 0) {
        const predecessor = await input.db.eventMarketOrganizerStockEntries.get(
          entryKey(input.authenticatedPubkey, pool.lastAcceptedId)
        )
        const previous =
          predecessor && parseEventMarketStockAuthorityRumor(predecessor.rumor)
        if (
          !previous ||
          previous.type !== "accepted" ||
          previous.sequence !== pool.acceptedSequence ||
          previous.poolId !== pool.poolId ||
          previous.acceptedAtMs > nowMs
        )
          throw new Error(
            "Organizer journal predecessor requires reconciliation"
          )
      }
      const rumor = createEventMarketStockAuthorityRumor({
        createdAt: Math.floor(nowMs / 1000),
        payload: {
          version: 1,
          type: "closed",
          merchantPubkey: pool.merchantPubkey,
          organizerPubkey: pool.organizerPubkey,
          writerId: pool.writerId,
          poolId: pool.poolId,
          sequence: pool.acceptedSequence,
          lastAcceptedId: pool.lastAcceptedId,
          acceptedQuantity: pool.acceptedQuantity,
        },
      })
      pool.state = "closing"
      pool.closingRumor = rumor
      requireSession(input)
      await input.db.eventMarketOrganizerStockPools.put(pool)
      requireSession(input)
      return rumor
    }
  )
}

/**
 * Prepare both recovery envelopes, save the winning exact bundle, then return.
 * This never publishes. Use the existing recipient-inbox delivery owner later.
 */
export async function prepareOrganizerStockEnvelopes(input: {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  poolId: string
  work: "grant" | "close" | { entryId: string }
  shouldContinue(): boolean
}): Promise<{
  recipient: SignedPublicNostrEvent
  self: SignedPublicNostrEvent
}> {
  input = {
    ...input,
    work: typeof input.work === "object" ? { ...input.work } : input.work,
  }
  const { db, work } = input
  const revision = input.signer.revision
  const authMethod = input.signer.authMethod
  const check = async () => {
    const pubkey = await input.signer.getPublicKey()
    if (
      !input.shouldContinue() ||
      !input.signer.authMethod ||
      input.signer.authMethod !== authMethod ||
      !input.signer.revision ||
      input.signer.revision !== revision ||
      !input.signer.capabilities.nip44 ||
      !input.signer.capabilities.signEvent ||
      pubkey !== input.authenticatedPubkey
    )
      throw new Error("Stock authority session changed")
  }
  await check()
  const pool = await db.eventMarketOrganizerStockPools.get(
    poolKey(input.authenticatedPubkey, input.poolId)
  )
  if (!pool) throw new Error("Stock pool unavailable")
  const grant = assertPool(pool)
  const checkWriter = async () => {
    await check()
    if (pool.accountPubkey === pool.organizerPubkey)
      await assertOrganizerStockWriterCurrent({
        db,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: grant.marketCoordinate,
        writerId: pool.writerId,
      })
    await check()
    // Identity confirmation may wait on the external signer. Re-observe the
    // durable fence after it, including before returning cached ciphertext.
    if (pool.accountPubkey === pool.organizerPubkey)
      await assertOrganizerStockWriterCurrent({
        db,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: grant.marketCoordinate,
        writerId: pool.writerId,
      })
  }
  const entry =
    typeof work === "object"
      ? await db.eventMarketOrganizerStockEntries.get(
          entryKey(input.authenticatedPubkey, work.entryId)
        )
      : undefined
  const rumor =
    work === "grant"
      ? pool.grantRumor
      : work === "close"
        ? pool.closingRumor
        : entry?.rumor
  if (!rumor || (entry && entry.poolId !== pool.poolId))
    throw new Error("Retained stock authority work unavailable")
  const payload = parseEventMarketStockAuthorityRumor(rumor)
  if (
    (work === "grant" && payload.type !== "grant") ||
    (work === "close" && payload.type !== "closed") ||
    (typeof work === "object" && payload.type !== "accepted")
  )
    throw new Error("Stock authority work type mismatch")
  const expectedAuthor =
    payload.type === "grant" ? pool.merchantPubkey : pool.organizerPubkey
  if (
    rumor.pubkey !== expectedAuthor ||
    expectedAuthor !== input.authenticatedPubkey
  )
    throw new Error("Stock authority author mismatch")
  const retained =
    work === "grant"
      ? pool.grantWraps
      : work === "close"
        ? pool.closingWraps
        : entry?.wraps
  await checkWriter()
  if (retained) return retained
  if (pool.readOnlyRecovery)
    throw new Error(
      "Recovered stock history cannot recreate missing delivery bytes"
    )
  const recipientPubkey =
    payload.type === "grant" ? pool.organizerPubkey : pool.merchantPubkey
  const recipient = await wrapPrivateMessage(
    rumor,
    { pubkey: recipientPubkey },
    input.signer
  )
  await checkWriter()
  const self = await wrapPrivateMessage(
    rumor,
    { pubkey: expectedAuthor },
    input.signer
  )
  await checkWriter()
  return db.transaction(
    "rw",
    [
      db.eventMarketOrganizerStockPools,
      db.eventMarketOrganizerStockEntries,
      db.eventMarketOrganizerStockWriters,
    ],
    async () => {
      // No asynchronous external signer work belongs inside this transaction.
      if (
        !input.shouldContinue() ||
        input.signer.pubkey !== input.authenticatedPubkey ||
        input.signer.revision !== revision ||
        input.signer.authMethod !== authMethod
      )
        throw new Error("Stock authority session changed")
      if (pool.accountPubkey === pool.organizerPubkey)
        await assertOrganizerStockWriterCurrent({
          db,
          accountPubkey: input.authenticatedPubkey,
          marketCoordinate: grant.marketCoordinate,
          writerId: pool.writerId,
        })
      if (typeof work === "object") {
        const current = await db.eventMarketOrganizerStockEntries.get(entry!.id)
        if (!current || JSON.stringify(current.rumor) !== JSON.stringify(rumor))
          throw new Error("Stock authority work changed")
        if (current.wraps) return current.wraps
        current.wraps = { recipient, self }
        await db.eventMarketOrganizerStockEntries.put(current)
      } else {
        const current = await db.eventMarketOrganizerStockPools.get(pool.id)
        const currentRumor =
          work === "grant" ? current?.grantRumor : current?.closingRumor
        if (!current || JSON.stringify(currentRumor) !== JSON.stringify(rumor))
          throw new Error("Stock authority work changed")
        const existing =
          work === "grant" ? current.grantWraps : current.closingWraps
        if (existing) return existing
        if (work === "grant") current.grantWraps = { recipient, self }
        else current.closingWraps = { recipient, self }
        await db.eventMarketOrganizerStockPools.put(current)
      }
      return { recipient, self }
    }
  )
}
