import type {
  ConduitDB,
  EventMarketOrganizerStockEntry,
  EventMarketOrganizerStockPool,
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

const poolKey = (account: string, pool: string) => `${account}:${pool}`
const entryKey = (account: string, entry: string) => `${account}:${entry}`
const clone = <T>(value: T): T => structuredClone(value)

function requireTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("Invalid stock journal time")
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
  nowMs?: number
}): Promise<EventMarketOrganizerStockPool> {
  input = { ...input, grantRumor: clone(input.grantRumor) }
  const rumor = clone(input.grantRumor)
  const grant = readGrant(rumor)
  const expectedRevision = input.expectedAssignmentRevision
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
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
        if (JSON.stringify(prior.grantRumor) !== JSON.stringify(rumor))
          throw new Error("Stock grant identity conflict")
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
      await db.merchantInventoryAssignments.put(assignment)
      await db.eventMarketOrganizerStockPools.add(pool)
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
  nowMs?: number
}): Promise<EventMarketOrganizerStockPool> {
  input = {
    ...input,
    grantRumor: clone(input.grantRumor),
    committedAssignmentEvent: clone(input.committedAssignmentEvent),
  }
  const rumor = clone(input.grantRumor)
  const grant = readGrant(rumor)
  const assignment = parseEventMarketAssignmentEvent(
    clone(input.committedAssignmentEvent)
  )
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
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
    input.db.eventMarketOrganizerStockPools,
    async () => {
      const id = poolKey(grant.organizerPubkey, rumor.id)
      const prior = await input.db.eventMarketOrganizerStockPools.get(id)
      if (prior) {
        assertPool(prior)
        if (JSON.stringify(prior.grantRumor) !== JSON.stringify(rumor))
          throw new Error("Stock grant identity conflict")
        return prior
      }
      const overlapping = await input.db.eventMarketOrganizerStockPools
        .where("[accountPubkey+assignmentCoordinate]")
        .equals([grant.organizerPubkey, grant.assignmentCoordinate])
        .toArray()
      if (overlapping.some((pool) => pool.state !== "closed"))
        throw new Error("An organizer writer already holds this assignment")
      const pool = newPool(grant.organizerPubkey, rumor, "active")
      await input.db.eventMarketOrganizerStockPools.add(pool)
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
  nowMs?: number
}): Promise<{ replayed: boolean; entry: EventMarketOrganizerStockEntry }> {
  input = { ...input }
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  if (
    !input.evidence ||
    new TextEncoder().encode(input.evidence).length > 65_536
  )
    throw new Error("Invalid organizer order evidence")
  const { db } = input
  return db.transaction(
    "rw",
    [db.eventMarketOrganizerStockPools, db.eventMarketOrganizerStockEntries],
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
          prior.evidence !== input.evidence
        )
          throw new Error("Organizer order ID is bound to different terms")
        return { replayed: true, entry: prior }
      }
      if (
        pool.state !== "active" ||
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
        imported: false,
      }
      pool.acceptedQuantity += input.quantity
      pool.acceptedSequence += 1
      pool.lastAcceptedId = rumor.id
      await db.eventMarketOrganizerStockEntries.add(entry)
      await db.eventMarketOrganizerStockPools.put(pool)
      return { replayed: false, entry }
    }
  )
}

/** Closing is durable before any seal request and serializes with acceptance. */
export async function beginOrganizerStockClose(input: {
  db: ConduitDB
  authenticatedPubkey: string
  writerId: string
  poolId: string
  nowMs?: number
}): Promise<PrivateMessageRumor> {
  input = { ...input }
  const nowMs = input.nowMs ?? Date.now()
  requireTime(nowMs)
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
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
      assertPool(pool)
      if (pool.closingRumor) return pool.closingRumor
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
      await input.db.eventMarketOrganizerStockPools.put(pool)
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
  assertPool(pool)
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
  await check()
  if (retained) return retained
  const recipientPubkey =
    payload.type === "grant" ? pool.organizerPubkey : pool.merchantPubkey
  const recipient = await wrapPrivateMessage(
    rumor,
    { pubkey: recipientPubkey },
    input.signer
  )
  await check()
  const self = await wrapPrivateMessage(
    rumor,
    { pubkey: expectedAuthor },
    input.signer
  )
  await check()
  return db.transaction(
    "rw",
    [db.eventMarketOrganizerStockPools, db.eventMarketOrganizerStockEntries],
    async () => {
      // No asynchronous external signer work belongs inside this transaction.
      if (
        !input.shouldContinue() ||
        input.signer.revision !== revision ||
        input.signer.authMethod !== authMethod
      )
        throw new Error("Stock authority session changed")
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
