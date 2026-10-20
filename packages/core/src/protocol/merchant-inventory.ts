import type {
  ConduitDB,
  MerchantInventoryAcceptedOrder,
  MerchantInventoryAssignment,
  MerchantInventoryProduct,
  MerchantInventoryPublicationJob,
  EventMarketOrganizerStockPool,
} from "../db"
import {
  readVerifiedOrganizerStockImport,
  sameOrganizerStockRumor,
  validateMerchantOrganizerStockPool,
  type VerifiedOrganizerStockImport,
} from "./event-market-stock-import-authority"
import { parseEventMarketStockAuthorityRumor } from "./event-market-stock-authority"
import {
  publishMerchantOrganizerStockCheckpoint,
  type MerchantStockCheckpointDelivery,
  type MerchantStockCheckpointPhase,
  type MerchantStockCheckpointWrappingOperation,
} from "./event-market-stock-checkpoint"
import { NostrSignerError, type AccountSigner } from "./nostr-event-signer"
import { SessionSignerError } from "./session-signer"
import { merchantAcceptanceBinding } from "./merchant-acceptance-privacy"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
} from "./event-market-assignment"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { reconcileKnownOccurrenceLifecycle } from "./merchant-occurrence-lifecycle"

const MAX_STOCK = 2_147_483_647
const HEX_ID = /^[0-9a-f]{64}$/
type Method = "ordinary" | "pickup" | "shipping" | "digital"
type Inventory = MerchantInventoryAssignment["inventory"]
type Draft = NonNullable<MerchantInventoryPublicationJob["draft"]>

function requireStock(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_STOCK)
    throw new Error(`Invalid ${name}`)
}

function coordinateParts(value: string): {
  kind: number
  pubkey: string
  d: string
} {
  const first = value.indexOf(":")
  const second = value.indexOf(":", first + 1)
  if (first < 1 || second < 0) throw new Error("Invalid coordinate")
  const kind = Number(value.slice(0, first))
  const pubkey = value.slice(first + 1, second)
  const d = value.slice(second + 1)
  if (!Number.isInteger(kind) || !HEX_ID.test(pubkey) || !d)
    throw new Error("Invalid coordinate")
  return { kind, pubkey, d }
}

function isExactSource(
  event: SignedPublicNostrEvent,
  coordinate: string
): boolean {
  const parts = coordinateParts(coordinate)
  return (
    isValidSignedPublicNostrEvent(event) &&
    event.kind === parts.kind &&
    event.pubkey === parts.pubkey &&
    event.tags.filter((tag) => tag[0] === "d").length === 1 &&
    event.tags.find((tag) => tag[0] === "d")?.[1] === parts.d
  )
}

function job(
  id: string,
  revision: number,
  createdAt: number
): MerchantInventoryPublicationJob {
  return { id, revision, createdAt, state: "awaiting_signature" }
}

/** Insert only. A stale relay product must never overwrite committed stock. */
export async function initializeMerchantInventoryProduct(input: {
  db: ConduitDB
  productCoordinate: string
  merchantPubkey: string
  stock?: number
  signedProductEvent: SignedPublicNostrEvent
}): Promise<MerchantInventoryProduct> {
  const { db, productCoordinate, merchantPubkey, stock, signedProductEvent } =
    input
  if (stock !== undefined) requireStock(stock, "stock")
  if (
    coordinateParts(productCoordinate).kind !== 30402 ||
    coordinateParts(productCoordinate).pubkey !== merchantPubkey ||
    !isExactSource(signedProductEvent, productCoordinate)
  )
    throw new Error("Product source does not match the merchant coordinate")
  const stockTags = signedProductEvent.tags.filter((tag) => tag[0] === "stock")
  if (
    stockTags.length > 1 ||
    (stock === undefined
      ? stockTags.length !== 0
      : stockTags.length !== 1 ||
        stockTags[0].length !== 2 ||
        stockTags[0][1] !== String(stock))
  )
    throw new Error("Committed stock must match the exact signed product")
  const typeTags = signedProductEvent.tags.filter((tag) => tag[0] === "type")
  if (
    typeTags.length > 1 ||
    (typeTags.length === 1 && !["simple", "variation"].includes(typeTags[0][1]))
  )
    throw new Error("Only sellable products have inventory")
  return db.transaction("rw", db.merchantInventoryProducts, async () => {
    const current = await db.merchantInventoryProducts.get(productCoordinate)
    if (current) return current
    const created: MerchantInventoryProduct = {
      coordinate: productCoordinate,
      merchantPubkey,
      stock,
      revision: 0,
      sourceProductEvent: signedProductEvent,
      signedProductEvent,
      publicationJobs: [],
    }
    await db.merchantInventoryProducts.add(created)
    return created
  })
}

export function getMerchantInventoryProduct(db: ConduitDB, coordinate: string) {
  return db.merchantInventoryProducts.get(coordinate)
}

export async function getMerchantInventoryAcceptedOrder(
  db: ConduitDB,
  merchantPubkey: string,
  orderId: string
): Promise<MerchantInventoryAcceptedOrder | undefined> {
  const order = await db.merchantInventoryAcceptedOrders.get(orderId)
  return order?.merchantPubkey === merchantPubkey ? order : undefined
}

/** Ordinary stock edits share the same serialized lane as assignments and acceptance. */
export async function commitMerchantInventoryStockEdit(input: {
  db: ConduitDB
  productCoordinate: string
  expectedRevision: number
  stock?: number
  mutationId: string
  nowMs?: number
}): Promise<MerchantInventoryProduct> {
  const { db, productCoordinate, expectedRevision, stock, mutationId } = input
  const nowMs = input.nowMs ?? Date.now()
  if (stock !== undefined) requireStock(stock, "stock")
  if (!mutationId || !Number.isSafeInteger(nowMs))
    throw new Error("Invalid stock edit")
  return db.transaction(
    "rw",
    db.merchantInventoryProducts,
    db.merchantInventoryAssignments,
    async () => {
      const product = await db.merchantInventoryProducts.get(productCoordinate)
      if (!product) throw new Error("Product inventory is not initialized")
      const priorMutation = product.publicationJobs.find(
        (work) => work.id === mutationId
      )
      if (priorMutation) {
        if (priorMutation.productStock !== stock)
          throw new Error("Stock mutation ID is bound to different stock")
        return product
      }
      if (product.revision !== expectedRevision)
        throw new Error("Stale product stock edit")
      const assignments = await listMerchantInventoryAssignments(
        db,
        productCoordinate
      )
      if (
        assignments.some(
          (a) =>
            (stock === undefined && outstandingOrganizerStockHold(a) > 0) ||
            (a.state === "active" &&
              (a.inventory.mode === "untracked") !== (stock === undefined))
        )
      )
        throw new Error("Tracking mode requires assignment reconciliation")
      const reserved = assignments.reduce(
        (sum, a) => sum + effectiveAllocation(a, nowMs),
        0
      )
      if (stock !== undefined && stock < reserved)
        throw new Error("Edited stock is below current allocations")
      product.stock = stock
      product.revision += 1
      const nextJob = job(mutationId, product.revision, nowMs)
      nextJob.productStock = stock
      product.publicationJobs.push(nextJob)
      await db.merchantInventoryProducts.put(product)
      return product
    }
  )
}

export function listMerchantInventoryAssignments(
  db: ConduitDB,
  productCoordinate: string
) {
  return db.merchantInventoryAssignments
    .where("productCoordinate")
    .equals(productCoordinate)
    .toArray()
}

/** Unreconciled organizer goods never return to seller stock merely because time passed. */
export function outstandingOrganizerStockHold(
  assignment: MerchantInventoryAssignment
): number {
  const hold = assignment.organizerStockHold
  if (hold === undefined) return 0
  if (
    !hold ||
    typeof hold.poolId !== "string" ||
    !hold.poolId.trim() ||
    typeof hold.organizerPubkey !== "string" ||
    !HEX_ID.test(hold.organizerPubkey) ||
    !Number.isInteger(hold.quantity) ||
    hold.quantity < 1 ||
    hold.quantity > MAX_STOCK ||
    !Number.isInteger(hold.importedQuantity) ||
    hold.importedQuantity < 0 ||
    hold.importedQuantity > hold.quantity ||
    typeof hold.closed !== "boolean"
  )
    throw new Error("Organizer stock hold requires reconciliation")
  const outstanding = hold.closed ? 0 : hold.quantity - hold.importedQuantity
  if (outstanding > 0 && assignment.inventory.mode !== "tracked")
    throw new Error("Organizer stock hold requires tracked inventory")
  return outstanding
}

export function effectiveAllocation(
  assignment: MerchantInventoryAssignment,
  nowMs: number
): number {
  const liveAllocation =
    assignment.state === "active" &&
    !assignment.terminal &&
    nowMs < assignment.occurrenceEndMs &&
    assignment.inventory.mode === "tracked"
      ? assignment.inventory.quantity
      : 0
  return Math.max(liveAllocation, outstandingOrganizerStockHold(assignment))
}

/** Current local stock math; an intact writer never waits for relay agreement. */
export async function readMerchantInventoryAvailability(
  db: ConduitDB,
  productCoordinate: string,
  nowMs = Date.now()
) {
  const product = await db.merchantInventoryProducts.get(productCoordinate)
  if (!product) throw new Error("Product inventory is not initialized")
  const assignments = await listMerchantInventoryAssignments(
    db,
    productCoordinate
  )
  if (product.stock === undefined) {
    if (
      assignments.some(
        (a) =>
          outstandingOrganizerStockHold(a) > 0 ||
          (a.inventory.mode !== "untracked" && a.state === "active")
      )
    )
      throw new Error("Inventory tracking mismatch")
    return { product, assignments, ordinaryAvailable: undefined }
  }
  if (
    assignments.some(
      (a) => a.inventory.mode !== "tracked" && a.state === "active"
    )
  )
    throw new Error("Inventory tracking mismatch")
  const reserved = assignments.reduce(
    (sum, a) => sum + effectiveAllocation(a, nowMs),
    0
  )
  if (reserved > product.stock)
    throw new Error("Committed allocations exceed stock")
  return { product, assignments, ordinaryAvailable: product.stock - reserved }
}

export type ValidatedAssignmentContext =
  | {
      kind: "validated-event-market-assignment"
      productEventId: string
      assignmentEventId?: string
      marketEventId: string
      occurrenceEventId: string
      scheduleEventId?: string
      grantEventId: string
      /** Derived from the exact signed occurrence, exclusive end in UTC. */
      occurrenceEndMs: number
      /** Verified organizer cancellation or applicable scoped deletion only. */
      terminal: boolean
    }
  | { kind: "merchant-assignment-removal" }

/** Explicit local assignment edit; signed evidence checks belong to the caller's admission boundary. */
export async function commitMerchantInventoryAssignment(input: {
  db: ConduitDB
  productCoordinate: string
  assignmentCoordinate: string
  marketCoordinate: string
  occurrenceCoordinate: string
  inventory: Inventory
  state: "active" | "removed"
  fulfillmentMethods: Array<"pickup" | "shipping" | "digital">
  context: ValidatedAssignmentContext
  expectedRevision: number | null
  mutationId: string
  nowMs?: number
}): Promise<MerchantInventoryAssignment> {
  const {
    db,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory,
    state,
    fulfillmentMethods,
    context,
    expectedRevision,
    mutationId,
  } = input
  const nowMs = input.nowMs ?? Date.now()
  if (!mutationId || !Number.isSafeInteger(nowMs))
    throw new Error("Invalid assignment context")
  if (context.kind === "merchant-assignment-removal") {
    if (state !== "removed")
      throw new Error("Removal context cannot activate an assignment")
  } else {
    if (
      !Number.isSafeInteger(context.occurrenceEndMs) ||
      context.occurrenceEndMs <= 0
    )
      throw new Error("Invalid occurrence end")
    for (const id of [
      context.productEventId,
      context.marketEventId,
      context.occurrenceEventId,
      context.grantEventId,
      context.scheduleEventId,
    ].filter(Boolean)) {
      if (!HEX_ID.test(id!)) throw new Error("Invalid assignment evidence")
    }
  }
  const productParts = coordinateParts(productCoordinate)
  const assignmentParts = coordinateParts(assignmentCoordinate)
  if (
    productParts.kind !== 30402 ||
    assignmentParts.kind !== 30410 ||
    productParts.pubkey !== assignmentParts.pubkey ||
    assignmentParts.d !==
      computeEventMarketAssignmentDTag({
        marketCoordinate,
        occurrenceCoordinate,
        productCoordinate,
      })
  )
    throw new Error("Assignment tuple mismatch")
  if (inventory.mode === "tracked")
    requireStock(inventory.quantity, "allocation")
  if (
    state === "removed" &&
    (fulfillmentMethods.length ||
      (inventory.mode === "tracked" && inventory.quantity !== 0))
  )
    throw new Error("Removed assignment must release its unused allocation")
  if (state === "active" && !fulfillmentMethods.length)
    throw new Error("Active assignment requires fulfillment")
  if (
    new Set(fulfillmentMethods).size !== fulfillmentMethods.length ||
    fulfillmentMethods.some(
      (m) => !["pickup", "shipping", "digital"].includes(m)
    )
  )
    throw new Error("Invalid fulfillment methods")
  if (
    state === "active" &&
    inventory.mode === "tracked" &&
    inventory.quantity > 0 &&
    !fulfillmentMethods.includes("pickup")
  )
    throw new Error("Positive allocation requires pickup")
  return db.transaction(
    "rw",
    db.merchantInventoryProducts,
    db.merchantInventoryAssignments,
    async () => {
      const product = await db.merchantInventoryProducts.get(productCoordinate)
      if (!product) throw new Error("Product inventory is not initialized")
      if ((product.stock === undefined) !== (inventory.mode === "untracked"))
        throw new Error("Inventory tracking mismatch")
      const existing =
        await db.merchantInventoryAssignments.get(assignmentCoordinate)
      const organizerHold = existing
        ? outstandingOrganizerStockHold(existing)
        : 0
      if (organizerHold > 0 && inventory.mode !== "tracked")
        throw new Error("Organizer stock hold requires tracked inventory")
      const priorMutation = existing?.publicationJobs.find(
        (j) => j.id === mutationId
      )
      if (priorMutation) {
        if (
          JSON.stringify(
            priorMutation.assignmentSnapshot && {
              state: priorMutation.assignmentSnapshot.state,
              inventory: priorMutation.assignmentSnapshot.inventory,
              fulfillmentMethods:
                priorMutation.assignmentSnapshot.fulfillmentMethods,
            }
          ) !==
          JSON.stringify({
            state,
            inventory,
            fulfillmentMethods,
          })
        )
          throw new Error("Assignment mutation ID is bound to different terms")
        return existing!
      }
      if (context.kind === "merchant-assignment-removal" && !existing)
        throw new Error("No committed assignment to remove")
      if ((existing?.revision ?? null) !== expectedRevision)
        throw new Error("Stale assignment revision")
      if (
        existing &&
        (existing.productCoordinate !== productCoordinate ||
          existing.marketCoordinate !== marketCoordinate ||
          existing.occurrenceCoordinate !== occurrenceCoordinate)
      )
        throw new Error("Assignment tuple changed")
      const occurrenceEndMs =
        context.kind === "merchant-assignment-removal"
          ? existing!.occurrenceEndMs
          : context.occurrenceEndMs
      const terminal =
        context.kind === "merchant-assignment-removal"
          ? existing!.terminal
          : context.terminal || existing?.terminal || false
      if (state === "active" && (terminal || nowMs >= occurrenceEndMs))
        throw new Error("Occurrence is no longer eligible")
      const siblings = await listMerchantInventoryAssignments(
        db,
        productCoordinate
      )
      const reservedElsewhere = siblings
        .filter((a) => a.coordinate !== assignmentCoordinate)
        .reduce((sum, a) => sum + effectiveAllocation(a, nowMs), 0)
      const liveReservation =
        state === "active" &&
        !terminal &&
        nowMs < occurrenceEndMs &&
        inventory.mode === "tracked"
          ? inventory.quantity
          : 0
      const nextReserved = Math.max(liveReservation, organizerHold)
      if (
        product.stock !== undefined &&
        reservedElsewhere + nextReserved > product.stock
      )
        throw new Error("Insufficient ordinary stock for allocation")
      const revision = (existing?.revision ?? 0) + 1
      const nextJob = job(mutationId, revision, nowMs)
      nextJob.assignmentSnapshot = {
        state,
        inventory,
        fulfillmentMethods: [...fulfillmentMethods],
        ...(existing?.organizerStockHold
          ? { organizerStockHold: structuredClone(existing.organizerStockHold) }
          : {}),
      }
      const assignment: MerchantInventoryAssignment = {
        coordinate: assignmentCoordinate,
        merchantPubkey: product.merchantPubkey,
        productCoordinate,
        marketCoordinate,
        occurrenceCoordinate,
        inventory,
        state,
        fulfillmentMethods: [...fulfillmentMethods],
        occurrenceEndMs,
        terminal,
        ...(existing?.organizerStockHold !== undefined
          ? { organizerStockHold: existing.organizerStockHold }
          : {}),
        revision,
        signedAssignmentEvent: existing?.signedAssignmentEvent,
        publicationJobs: [...(existing?.publicationJobs ?? []), nextJob],
      }
      await db.merchantInventoryAssignments.put(assignment)
      return assignment
    }
  )
}

export type ValidatedOrderAdmission = {
  /** Ordinary edits change this baseline; this writer's stock projections do not. */
  productTermsEventId?: string
} & (
  | { kind: "validated-ordinary-product"; productEventId: string }
  | {
      kind: "validated-event-market-order"
      /** Exact pre-expiry order; expiry cannot grant stock reserved elsewhere. */
      settlement?: boolean
      productEventId: string
      assignmentCoordinate: string
      assignmentEventId?: string
      marketEventId: string
      occurrenceEventId: string
      grantEventId: string
      scheduleEventId?: string
    }
)

export type MerchantInventoryOrderItem = {
  productCoordinate: string
  assignmentCoordinate?: string
  method: Method
  quantity: number
  admission: ValidatedOrderAdmission
}

/** Same-order local stock decisions made before the acceptance writer existed. */
export interface MerchantInventoryPriorStockAdjustment {
  productCoordinate: string
  quantity: number
  shortfall: number
  targetMode?: "custom"
}

/** The one merchant acceptance decision. All reads and debits share a Dexie write transaction. */
export async function acceptMerchantInventoryOrder(input: {
  db: ConduitDB
  orderId: string
  merchantPubkey: string
  identityBinding: string
  termsBinding: string
  evidence: string
  evidenceFormat?: MerchantInventoryAcceptedOrder["evidenceFormat"]
  evidenceBinding?: string
  /** Live account fence for private acceptance commits. */
  assertCurrent?: () => void
  items: MerchantInventoryOrderItem[]
  priorStockAdjustments?: readonly MerchantInventoryPriorStockAdjustment[]
  organizerImport?: VerifiedOrganizerStockImport
  acceptedAt?: number
}): Promise<{ replayed: boolean; order: MerchantInventoryAcceptedOrder }> {
  const {
    db,
    orderId,
    merchantPubkey,
    identityBinding,
    termsBinding,
    evidence,
    items,
  } = input
  input.assertCurrent?.()
  const acceptedAt = input.acceptedAt ?? Date.now()
  const delegated = input.organizerImport
    ? readVerifiedOrganizerStockImport(input.organizerImport)
    : undefined
  const orderPoolBinding = delegated
    ? JSON.stringify(
        delegated.entries
          .map(({ payload }) => ({
            poolId: payload.poolId,
            writerId: payload.writerId,
            quantity: payload.quantity,
          }))
          .sort((left, right) => left.poolId.localeCompare(right.poolId))
      )
    : undefined
  if (
    delegated &&
    (delegated.orderId !== orderId ||
      delegated.merchantPubkey !== merchantPubkey ||
      delegated.identityBinding !== identityBinding ||
      delegated.termsBinding !== termsBinding ||
      input.evidenceFormat !== "device-encrypted-v1" ||
      input.evidenceBinding !== delegated.evidenceBinding ||
      input.priorStockAdjustments?.length)
  )
    throw new Error("Organizer import does not match the stock decision")
  if (
    !orderId ||
    !merchantPubkey ||
    !identityBinding ||
    !termsBinding ||
    !evidence ||
    (input.evidenceFormat !== undefined &&
      (input.evidenceFormat !== "device-encrypted-v1" ||
        ![identityBinding, termsBinding, input.evidenceBinding].every(
          (binding) => binding && /^sha256:[0-9a-f]{64}$/.test(binding)
        ))) ||
    !Number.isSafeInteger(acceptedAt) ||
    !items.length
  )
    throw new Error("Invalid accepted order")
  for (const item of items) {
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > MAX_STOCK
    )
      throw new Error("Invalid order quantity")
    const admission = item.admission
    const ids =
      admission.kind === "validated-event-market-order"
        ? [
            admission.productEventId,
            admission.marketEventId,
            admission.occurrenceEventId,
            admission.grantEventId,
            admission.scheduleEventId,
            admission.assignmentEventId,
          ]
        : [admission.productEventId]
    if (
      [...ids, admission.productTermsEventId].some(
        (id) => id !== undefined && !HEX_ID.test(id)
      )
    )
      throw new Error("Invalid order evidence")
    if (
      (item.method === "ordinary") !==
        (admission.kind === "validated-ordinary-product") ||
      (item.method === "ordinary") !==
        (item.assignmentCoordinate === undefined) ||
      (admission.kind === "validated-event-market-order" &&
        admission.assignmentCoordinate !== item.assignmentCoordinate)
    )
      throw new Error("Order admission does not match its inventory lane")
  }
  return db.transaction(
    "rw",
    [
      db.merchantInventoryProducts,
      db.merchantInventoryAssignments,
      db.merchantInventoryAcceptedOrders,
      db.localProductStockCheckpoints,
      db.eventMarketOrganizerStockPools,
      db.eventMarketOrganizerStockEntries,
      db.eventMarketRosterEvidence,
    ],
    async () => {
      delegated?.checkSession()
      const prior = await db.merchantInventoryAcceptedOrders.get(orderId)
      if (prior) {
        if (
          prior.merchantPubkey !== merchantPubkey ||
          prior.identityBinding !== identityBinding ||
          prior.termsBinding !== termsBinding ||
          prior.evidenceFormat !== input.evidenceFormat ||
          (prior.evidenceBinding ?? prior.evidence) !==
            (input.evidenceBinding ?? evidence) ||
          ((!delegated || prior.organizerImport) &&
            JSON.stringify(
              prior.items.map(
                ({
                  productCoordinate,
                  assignmentCoordinate,
                  method,
                  quantity,
                }) => ({
                  productCoordinate,
                  assignmentCoordinate,
                  method,
                  quantity,
                })
              )
            ) !==
              JSON.stringify(
                items.map(
                  ({
                    productCoordinate,
                    assignmentCoordinate,
                    method,
                    quantity,
                  }) => ({
                    productCoordinate,
                    assignmentCoordinate,
                    method,
                    quantity,
                  })
                )
              ))
        )
          throw new Error("Order ID is bound to different identity or terms")
        input.assertCurrent?.()
        if (!delegated) return { replayed: true, order: prior }
        if (prior.organizerImport) {
          if (
            JSON.stringify(prior.organizerImport) !==
            JSON.stringify(delegated.attribution)
          )
            throw new Error(
              "Order ID is bound to different organizer provenance"
            )
          for (const entry of delegated.entries) {
            const saved = await db.eventMarketOrganizerStockEntries.get(
              `${merchantPubkey}:${entry.rumor.id}`
            )
            const pool = await db.eventMarketOrganizerStockPools.get(
              `${merchantPubkey}:${entry.payload.poolId}`
            )
            if (
              !saved?.imported ||
              !pool ||
              saved.accountPubkey !== merchantPubkey ||
              saved.poolId !== entry.payload.poolId ||
              saved.sequence !== entry.payload.sequence ||
              saved.quantity !== entry.payload.quantity ||
              saved.orderId !== orderId ||
              saved.claimRef !== entry.payload.claimRef ||
              saved.evidence !== input.evidenceBinding ||
              (saved.orderPoolBinding !== undefined &&
                saved.orderPoolBinding !== orderPoolBinding) ||
              !sameOrganizerStockRumor(saved.rumor, entry.rumor) ||
              JSON.stringify(pool.grantRumor) !==
                JSON.stringify(entry.grantRumor) ||
              pool.importedSequence < entry.payload.sequence
            )
              throw new Error(
                "Imported organizer provenance requires reconciliation"
              )
            validateMerchantOrganizerStockPool(pool, merchantPubkey)
            if (saved.orderPoolBinding === undefined)
              await db.eventMarketOrganizerStockEntries.update(saved.id, {
                orderPoolBinding,
              })
          }
          delegated.checkSession()
          input.assertCurrent?.()
          return { replayed: true, order: prior }
        }
      }
      const products = new Map<string, MerchantInventoryProduct>()
      const assignments = new Map<string, MerchantInventoryAssignment>()
      const debitedProducts = new Set<string>()
      const priorStock = await db.localProductStockCheckpoints
        .where("orderId")
        .equals(orderId)
        .filter((checkpoint) => checkpoint.merchantPubkey === merchantPubkey)
        .toArray()
      if (delegated && priorStock.some((row) => row.state !== "applied"))
        throw new Error("Prior stock debit is not durably confirmed")
      // An ordinary ID alone is not delegated provenance. Adoption is limited
      // to a positive, durable full same-order debit already applied by the
      // legacy stock owner; the shared credit loop below prevents a second one.
      if (
        delegated &&
        prior &&
        items.some((item) => {
          const quantity = items
            .filter(
              (candidate) =>
                candidate.productCoordinate === item.productCoordinate
            )
            .reduce((sum, candidate) => sum + candidate.quantity, 0)
          return !priorStock.some(
            (row) =>
              row.productAddressId === item.productCoordinate &&
              row.state === "applied" &&
              row.adjustment.quantity === quantity &&
              row.adjustment.shortfall === 0
          )
        })
      )
        throw new Error(
          "Existing acceptance lacks verified delegated stock provenance"
        )
      const delegatedPools = new Map<string, EventMarketOrganizerStockPool>()
      if (delegated) {
        for (const entry of delegated.entries) {
          const pool = await db.eventMarketOrganizerStockPools.get(
            `${merchantPubkey}:${entry.payload.poolId}`
          )
          if (
            !pool ||
            JSON.stringify(pool.grantRumor) !== JSON.stringify(entry.grantRumor)
          )
            throw new Error("Merchant stock grant changed during import")
          const grant = validateMerchantOrganizerStockPool(pool, merchantPubkey)
          const assignment = await db.merchantInventoryAssignments.get(
            grant.assignmentCoordinate
          )
          if (
            !assignment ||
            assignment.merchantPubkey !== merchantPubkey ||
            assignment.organizerStockHold?.poolId !== pool.poolId ||
            assignment.organizerStockHold.organizerPubkey !==
              pool.organizerPubkey ||
            assignment.organizerStockHold.quantity !== pool.quantity ||
            assignment.organizerStockHold.importedQuantity !==
              pool.importedQuantity ||
            assignment.organizerStockHold.closed ||
            pool.state === "closed" ||
            entry.payload.writerId !== pool.writerId ||
            entry.payload.sequence !== pool.importedSequence + 1 ||
            entry.payload.previousId !== pool.lastImportedId ||
            entry.payload.quantity > outstandingOrganizerStockHold(assignment)
          )
            throw new Error(
              "Organizer stock import is not the next held journal entry"
            )
          if (pool.importedSequence > 0) {
            const previous = await db.eventMarketOrganizerStockEntries.get(
              `${merchantPubkey}:${pool.lastImportedId}`
            )
            const payload =
              previous && parseEventMarketStockAuthorityRumor(previous.rumor)
            if (
              !previous?.imported ||
              !payload ||
              payload.type !== "accepted" ||
              payload.sequence !== pool.importedSequence ||
              payload.poolId !== pool.poolId ||
              payload.acceptedAtMs > entry.payload.acceptedAtMs
            )
              throw new Error(
                "Organizer stock predecessor requires reconciliation"
              )
          }
          const staged = await db.eventMarketOrganizerStockEntries.get(
            `${merchantPubkey}:${entry.rumor.id}`
          )
          if (
            staged &&
            (staged.imported ||
              staged.accountPubkey !== merchantPubkey ||
              staged.poolId !== pool.poolId ||
              staged.sequence !== entry.payload.sequence ||
              staged.quantity !== entry.payload.quantity ||
              staged.claimRef !== entry.payload.claimRef ||
              staged.orderId !== orderId ||
              (staged.evidence !== input.evidenceBinding &&
                staged.evidence !== entry.payload.termsBinding &&
                merchantAcceptanceBinding("evidence", staged.evidence) !==
                  input.evidenceBinding) ||
              (staged.orderPoolBinding !== undefined &&
                staged.orderPoolBinding !== orderPoolBinding) ||
              !sameOrganizerStockRumor(staged.rumor, entry.rumor))
          )
            throw new Error("Organizer entry conflicts with its accepted order")
          if (
            pool.acceptedSequence === entry.payload.sequence &&
            (pool.lastAcceptedId !== entry.rumor.id ||
              pool.acceptedQuantity !==
                pool.importedQuantity + entry.payload.quantity)
          )
            throw new Error(
              "Organizer entry conflicts with the observed frontier"
            )
          delegatedPools.set(grant.assignmentCoordinate, pool)
        }
      }
      const consumed = new Map<string, number>()
      for (const coordinate of new Set(
        items.map((item) => item.productCoordinate)
      )) {
        const quantity = items
          .filter((item) => item.productCoordinate === coordinate)
          .reduce((sum, item) => sum + item.quantity, 0)
        const adjustments = [
          ...priorStock
            .filter((row) => row.productAddressId === coordinate)
            .map((row) => row.adjustment),
          ...(input.priorStockAdjustments ?? []).filter(
            (row) => row.productCoordinate === coordinate
          ),
        ]
        let alreadyConsumed: number | undefined
        for (const adjustment of adjustments) {
          if (
            adjustment.quantity !== quantity ||
            !Number.isSafeInteger(adjustment.shortfall) ||
            adjustment.shortfall < 0 ||
            adjustment.shortfall > quantity
          )
            throw new Error(
              "Existing order stock decision needs reconciliation"
            )
          const count =
            adjustment.targetMode === "custom"
              ? quantity
              : quantity - adjustment.shortfall
          if (alreadyConsumed !== undefined && alreadyConsumed !== count)
            throw new Error(
              "Conflicting order stock decisions need reconciliation"
            )
          alreadyConsumed = count
        }
        consumed.set(coordinate, alreadyConsumed ?? 0)
      }
      const output: MerchantInventoryAcceptedOrder["items"] = []
      for (const item of items) {
        let product = products.get(item.productCoordinate)
        if (!product) {
          product = await db.merchantInventoryProducts.get(
            item.productCoordinate
          )
          if (!product || product.merchantPubkey !== merchantPubkey)
            throw new Error("Committed merchant product unavailable")
          if (
            item.admission.productTermsEventId !== undefined &&
            product.sourceProductEvent.id !== item.admission.productTermsEventId
          )
            throw new Error(
              "The product changed during acceptance. Review it and try again."
            )
          // Retained postponements and stock debits must share one transaction.
          // Encryption and other admission work may have yielded since the
          // workflow last reconciled the occurrence frontier.
          await reconcileKnownOccurrenceLifecycle(
            merchantPubkey,
            item.productCoordinate,
            db
          )
          products.set(item.productCoordinate, product)
        }
        const siblings = await listMerchantInventoryAssignments(
          db,
          item.productCoordinate
        )
        let assignment: MerchantInventoryAssignment | undefined
        let expiredSettlement = false
        if (item.assignmentCoordinate) {
          assignment =
            assignments.get(item.assignmentCoordinate) ??
            siblings.find((a) => a.coordinate === item.assignmentCoordinate)
          expiredSettlement =
            !delegated &&
            item.admission.kind === "validated-event-market-order" &&
            item.admission.settlement === true &&
            !!assignment &&
            acceptedAt >= assignment.occurrenceEndMs
          if (
            !assignment ||
            assignment.productCoordinate !== item.productCoordinate ||
            (!delegated &&
              (assignment.state !== "active" ||
                assignment.terminal ||
                (!expiredSettlement &&
                  acceptedAt >= assignment.occurrenceEndMs) ||
                !assignment.fulfillmentMethods.includes(
                  item.method as "pickup" | "shipping" | "digital"
                ))) ||
            (delegated && !delegatedPools.has(assignment.coordinate))
          )
            throw new Error("Assignment is not available for this order")
          assignments.set(assignment.coordinate, assignment)
        }
        const effective = siblings.reduce(
          (sum, a) =>
            sum +
            effectiveAllocation(assignments.get(a.coordinate) ?? a, acceptedAt),
          0
        )
        if (product.stock !== undefined) {
          const credited = Math.min(
            item.quantity,
            consumed.get(item.productCoordinate) ?? 0
          )
          const debit = item.quantity - credited
          consumed.set(
            item.productCoordinate,
            (consumed.get(item.productCoordinate) ?? 0) - credited
          )
          if (
            !delegated &&
            (siblings.some(
              (a) => a.state === "active" && a.inventory.mode !== "tracked"
            ) ||
              effective >
                product.stock +
                  (item.method === "pickup" && !expiredSettlement
                    ? credited
                    : 0))
          )
            throw new Error("Committed inventory requires reconciliation")
          if (delegated) {
            if (
              !assignment ||
              assignment.inventory.mode !== "tracked" ||
              product.stock < debit ||
              outstandingOrganizerStockHold(assignment) < item.quantity
            )
              throw new Error("Insufficient held organizer stock")
            assignment.organizerStockHold!.importedQuantity += item.quantity
            const remainingEffective = siblings.reduce(
              (sum, sibling) =>
                sum +
                effectiveAllocation(
                  assignments.get(sibling.coordinate) ?? sibling,
                  acceptedAt
                ),
              0
            )
            // A removed/reduced public allocation cannot discard an already
            // authenticated organizer sale. The hold shrinks with its debit.
            const nextQuantity = Math.max(
              0,
              assignment.inventory.quantity - item.quantity
            )
            const currentEffective = effectiveAllocation(assignment, acceptedAt)
            const nextEffective = Math.max(
              assignment.state === "active" &&
                !assignment.terminal &&
                acceptedAt < assignment.occurrenceEndMs
                ? nextQuantity
                : 0,
              outstandingOrganizerStockHold(assignment)
            )
            if (
              product.stock - debit <
              remainingEffective - currentEffective + nextEffective
            )
              throw new Error("Organizer inventory requires reconciliation")
          } else if (item.method === "pickup") {
            if (!assignment || assignment.inventory.mode !== "tracked")
              throw new Error("Insufficient pickup allocation")
            if (expiredSettlement) {
              // Effective allocations include unreconciled organizer holds even
              // after expiry. Only the unallocated remainder may be consumed.
              if (product.stock - effective < debit)
                throw new Error(
                  "Insufficient unallocated stock for settled pickup"
                )
            } else if (
              effectiveAllocation(assignment, acceptedAt) -
                outstandingOrganizerStockHold(assignment) <
                item.quantity ||
              product.stock - debit < effective - item.quantity
            )
              throw new Error("Insufficient pickup allocation")
          } else if (product.stock - effective < debit) {
            throw new Error("Insufficient ordinary stock")
          }
          product.stock -= debit
          if (debit > 0) debitedProducts.add(product.coordinate)
          if (
            item.method === "pickup" &&
            assignment?.inventory.mode === "tracked"
          ) {
            assignment.inventory = {
              mode: "tracked",
              quantity:
                delegated || expiredSettlement
                  ? Math.max(0, assignment.inventory.quantity - item.quantity)
                  : assignment.inventory.quantity - item.quantity,
            }
          }
        } else if (
          siblings.some(
            (a) =>
              outstandingOrganizerStockHold(a) > 0 ||
              (a.state === "active" && a.inventory.mode !== "untracked")
          )
        ) {
          throw new Error("Inventory tracking mismatch")
        }
        output.push({
          productCoordinate: item.productCoordinate,
          assignmentCoordinate: item.assignmentCoordinate,
          method: item.method,
          quantity: item.quantity,
          remainingStock: product.stock,
          remainingAllocation:
            assignment?.inventory.mode === "tracked"
              ? assignment.inventory.quantity
              : undefined,
        })
      }
      if (delegated) {
        for (const entry of delegated.entries) {
          const pool = [...delegatedPools.values()].find(
            (candidate) => candidate.poolId === entry.payload.poolId
          )!
          pool.importedSequence = entry.payload.sequence
          pool.lastImportedId = entry.rumor.id
          pool.importedQuantity += entry.payload.quantity
          if (pool.acceptedSequence < pool.importedSequence) {
            pool.acceptedSequence = pool.importedSequence
            pool.lastAcceptedId = pool.lastImportedId
            pool.acceptedQuantity = pool.importedQuantity
          }
          if (pool.state === "prepared") pool.state = "active"
          await db.eventMarketOrganizerStockEntries.put({
            id: `${merchantPubkey}:${entry.rumor.id}`,
            accountPubkey: merchantPubkey,
            poolId: pool.poolId,
            sequence: entry.payload.sequence,
            orderId,
            claimRef: entry.payload.claimRef,
            rumor: structuredClone(entry.rumor),
            quantity: entry.payload.quantity,
            evidence: input.evidenceBinding!,
            orderPoolBinding,
            receivedEnvelope: structuredClone(entry.envelope),
            imported: true,
          })
          await db.eventMarketOrganizerStockPools.put(pool)
        }
      }
      for (const product of products.values()) {
        product.revision += 1
        if (
          product.stock !== undefined &&
          debitedProducts.has(product.coordinate)
        ) {
          const nextJob = job(
            `${orderId}:product:${product.coordinate}`,
            product.revision,
            acceptedAt
          )
          nextJob.productStock = product.stock
          product.publicationJobs.push(nextJob)
        }
        await db.merchantInventoryProducts.put(product)
      }
      for (const assignment of assignments.values()) {
        if (
          assignment.inventory.mode === "tracked" &&
          output.some(
            (i) =>
              i.assignmentCoordinate === assignment.coordinate &&
              i.method === "pickup"
          )
        ) {
          assignment.revision += 1
          const nextJob = job(
            `${orderId}:assignment:${assignment.coordinate}`,
            assignment.revision,
            acceptedAt
          )
          nextJob.assignmentSnapshot = {
            state: assignment.state,
            inventory: assignment.inventory,
            fulfillmentMethods: [...assignment.fulfillmentMethods],
            ...(assignment.organizerStockHold
              ? {
                  organizerStockHold: structuredClone(
                    assignment.organizerStockHold
                  ),
                }
              : {}),
          }
          assignment.publicationJobs.push(nextJob)
          await db.merchantInventoryAssignments.put(assignment)
        }
      }
      input.assertCurrent?.()
      const order: MerchantInventoryAcceptedOrder = {
        orderId,
        merchantPubkey,
        identityBinding,
        termsBinding,
        evidence,
        ...(input.evidenceFormat
          ? {
              evidenceFormat: input.evidenceFormat,
              evidenceBinding: input.evidenceBinding,
            }
          : {}),
        items: output,
        acceptedAt,
        ...(delegated
          ? { organizerImport: structuredClone(delegated.attribution) }
          : {}),
      }
      delegated?.checkSession()
      if (prior) await db.merchantInventoryAcceptedOrders.put(order)
      else await db.merchantInventoryAcceptedOrders.add(order)
      input.assertCurrent?.()
      return { replayed: Boolean(prior), order }
    }
  )
}

function makeProductDraft(
  product: MerchantInventoryProduct,
  work: MerchantInventoryPublicationJob,
  predecessor: SignedPublicNostrEvent
): Draft {
  const tags = predecessor.tags
    .filter((tag) => tag[0] !== "stock")
    .map((tag) => [...tag])
  if (work.productStock !== undefined)
    tags.push(["stock", String(work.productStock)])
  return {
    pubkey: product.merchantPubkey,
    kind: 30402,
    created_at: Math.max(
      Math.floor(work.createdAt / 1000),
      predecessor.created_at + 1
    ),
    tags,
    content: predecessor.content,
  }
}

function makeAssignmentDraft(
  assignment: MerchantInventoryAssignment,
  work: MerchantInventoryPublicationJob,
  predecessor?: SignedPublicNostrEvent
): Draft {
  const snapshot = work.assignmentSnapshot
  if (!snapshot) throw new Error("Missing assignment publication snapshot")
  const draft = buildEventMarketAssignmentDraft({
    merchantPubkey: assignment.merchantPubkey,
    marketCoordinate: assignment.marketCoordinate,
    occurrenceCoordinate: assignment.occurrenceCoordinate,
    productCoordinate: assignment.productCoordinate,
    state: snapshot.state,
    inventory: snapshot.inventory,
    fulfillmentMethods: snapshot.fulfillmentMethods,
    ...(snapshot.organizerStockHold
      ? {
          organizerStockPool: {
            state: snapshot.organizerStockHold.closed
              ? ("closed" as const)
              : ("active" as const),
            poolId: snapshot.organizerStockHold.poolId,
            organizerPubkey: snapshot.organizerStockHold.organizerPubkey,
            quantity: snapshot.organizerStockHold.quantity,
            importedQuantity: snapshot.organizerStockHold.importedQuantity,
          },
        }
      : {}),
    previousEventId: predecessor?.id,
  })
  return {
    pubkey: assignment.merchantPubkey,
    kind: draft.kind,
    created_at: Math.max(
      Math.floor(work.createdAt / 1000),
      (predecessor?.created_at ?? -1) + 1
    ),
    tags: draft.tags,
    content: draft.content,
  }
}

/** Save exact unsigned bytes before asking an external account signer. */
async function prepareNextPublication(
  db: ConduitDB,
  kind: "product" | "assignment",
  coordinate: string
) {
  const table =
    kind === "product"
      ? db.merchantInventoryProducts
      : db.merchantInventoryAssignments
  return db.transaction("rw", table, async () => {
    const record = await table.get(coordinate)
    if (!record) return undefined
    const pending = record.publicationJobs.find(
      (j) => j.state === "awaiting_signature"
    )
    if (!pending) return undefined
    const previousJobs = record.publicationJobs.filter(
      (j) => j.revision < pending.revision
    )
    if (previousJobs.some((j) => !j.signedEvent)) return undefined
    const predecessors = [
      ...previousJobs.flatMap((work) =>
        work.signedEvent ? [work.signedEvent] : []
      ),
      ...(kind === "product"
        ? [(record as MerchantInventoryProduct).signedProductEvent]
        : (record as MerchantInventoryAssignment).signedAssignmentEvent
          ? [(record as MerchantInventoryAssignment).signedAssignmentEvent!]
          : []),
    ]
    const predecessor = predecessors.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    )[0]
    if (!pending.draft) {
      pending.draft =
        kind === "product"
          ? makeProductDraft(
              record as MerchantInventoryProduct,
              pending,
              predecessor!
            )
          : makeAssignmentDraft(
              record as MerchantInventoryAssignment,
              pending,
              predecessor
            )
      await table.put(record as never)
    }
    return { kind, coordinate, jobId: pending.id, draft: pending.draft }
  })
}

async function saveSignedPublication(
  db: ConduitDB,
  kind: "product" | "assignment",
  coordinate: string,
  jobId: string,
  signedEvent: SignedPublicNostrEvent
): Promise<boolean> {
  const table =
    kind === "product"
      ? db.merchantInventoryProducts
      : db.merchantInventoryAssignments
  return db.transaction("rw", table, async () => {
    const record = await table.get(coordinate)
    const work = record?.publicationJobs.find((j) => j.id === jobId)
    if (
      !record ||
      !work?.draft ||
      !isValidSignedPublicNostrEvent(signedEvent) ||
      JSON.stringify({
        pubkey: signedEvent.pubkey,
        kind: signedEvent.kind,
        created_at: signedEvent.created_at,
        tags: signedEvent.tags,
        content: signedEvent.content,
      }) !== JSON.stringify(work.draft)
    )
      throw new Error("Signed publication does not match retained draft")
    // Another tab may have signed the same retained draft meanwhile. Its first
    // durable signature owns this job; discard this valid competing signature.
    if (work.signedEvent) return false
    work.signedEvent = signedEvent
    work.state = "signed"
    if (kind === "product")
      (record as MerchantInventoryProduct).signedProductEvent = signedEvent
    else
      (record as MerchantInventoryAssignment).signedAssignmentEvent =
        signedEvent
    await table.put(record as never)
    return true
  })
}

async function markDelivered(
  db: ConduitDB,
  kind: "product" | "assignment",
  coordinate: string,
  jobId: string,
  state: "delivered" | "superseded" = "delivered"
): Promise<void> {
  const table =
    kind === "product"
      ? db.merchantInventoryProducts
      : db.merchantInventoryAssignments
  await db.transaction("rw", table, async () => {
    const record = await table.get(coordinate)
    const work = record?.publicationJobs.find((j) => j.id === jobId)
    if (!record || !work?.signedEvent)
      throw new Error("Signed publication missing")
    work.state = state
    await table.put(record as never)
  })
}

const CHECKPOINT_SIGNER_CODES = [
  "authorization_denied",
  "timeout",
  "unavailable",
  "unsupported_operation",
  "disconnected",
  "authority_changed",
  "invalid_response",
] as const
const CHECKPOINT_SESSION_CODES = [
  "authority_changed",
  "identity_changed",
  "timeout",
  "invalid_response",
  "background_paused",
  "queue_full",
  "provider_unavailable",
] as const
export type MerchantStockCheckpointFailure =
  | { source: "signer"; code: (typeof CHECKPOINT_SIGNER_CODES)[number] }
  | { source: "session"; code: (typeof CHECKPOINT_SESSION_CODES)[number] }
  | { source: "unclassified" }

function checkpointFailure(error: unknown): MerchantStockCheckpointFailure {
  try {
    if (error instanceof NostrSignerError) {
      const code = error.code
      if (CHECKPOINT_SIGNER_CODES.includes(code))
        return { source: "signer", code }
    } else if (error instanceof SessionSignerError) {
      const code = error.code
      if (CHECKPOINT_SESSION_CODES.includes(code))
        return { source: "session", code }
    }
  } catch {
    // Even error inspection is observational, never a replacement failure.
  }
  return { source: "unclassified" }
}

export type MerchantStockCheckpointOutcome = {
  /** Internal correlation only; never render or log this coordinate. */
  productCoordinate: string
  status: "acknowledged" | "pending"
  phase: MerchantStockCheckpointPhase
  wrappingOperation?: MerchantStockCheckpointWrappingOperation
  failure?: MerchantStockCheckpointFailure
  /** Transient summary of an explicitly replayed checkpoint, not a recipient readback. */
  checkpointSummary?: { sequence: number; orderCount: number }
}

/** Delivery may fail; the durable order decision and later acceptances remain intact. */
export async function resumeMerchantInventoryPublication(input: {
  db: ConduitDB
  merchantPubkey: string
  /** Optional explicit action scope; omitted preserves the ordinary queue. */
  coordinates?: readonly string[]
  stockCheckpoint?: {
    signer: AccountSigner
    shouldContinue(): boolean
    delivery?: MerchantStockCheckpointDelivery
    /** Explicit repair scope; ordinary publication keeps acknowledged checkpoints deduplicated. */
    replayAcknowledgedCoordinates?: readonly string[]
  }
  /** Optional transient observation; queue counts and retry behavior are unchanged. */
  onStockCheckpoint?: (outcome: MerchantStockCheckpointOutcome) => void
  sign(draft: Draft): Promise<SignedPublicNostrEvent>
  publish(signed: SignedPublicNostrEvent): Promise<boolean | "superseded">
}): Promise<{ signed: number; delivered: number; pending: number }> {
  const { db, merchantPubkey, sign, publish } = input
  let signed = 0
  let delivered = 0
  const records = [
    ...(
      await db.merchantInventoryProducts
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray()
    ).map((r) => ({ kind: "product" as const, coordinate: r.coordinate })),
    ...(
      await db.merchantInventoryAssignments
        .where("merchantPubkey")
        .equals(merchantPubkey)
        .toArray()
    ).map((r) => ({ kind: "assignment" as const, coordinate: r.coordinate })),
  ]
  for (const record of records) {
    if (input.coordinates && !input.coordinates.includes(record.coordinate))
      continue
    // Signing is sequential per address, so each prev points at exact saved bytes.
    while (true) {
      const prepared = await prepareNextPublication(
        db,
        record.kind,
        record.coordinate
      )
      if (!prepared) break
      let event: SignedPublicNostrEvent
      try {
        event = await sign(prepared.draft)
      } catch {
        break
      }
      // A failed local save must prevent publication, including on retry.
      if (
        await saveSignedPublication(
          db,
          record.kind,
          record.coordinate,
          prepared.jobId,
          event
        )
      )
        signed += 1
    }
  }
  // Sign the complete selected batch first. A cold device must never pair a
  // newer product debit with a stale assignment imported frontier.
  const blockedProducts = new Set<string>()
  const checkpointEvents = new Map<string, Set<string>>()
  const pools = await db.eventMarketOrganizerStockPools
    .where("accountPubkey")
    .equals(merchantPubkey)
    .toArray()
  for (const coordinate of new Set(
    pools.map((pool) => pool.productCoordinate)
  )) {
    const observation: {
      phase: MerchantStockCheckpointPhase
      wrappingOperation?: MerchantStockCheckpointWrappingOperation
      checkpointSummary?: MerchantStockCheckpointOutcome["checkpointSummary"]
    } = {
      phase: "snapshot",
    }
    const observe = (
      status: MerchantStockCheckpointOutcome["status"],
      error?: unknown
    ) => {
      try {
        void Promise.resolve(
          input.onStockCheckpoint?.({
            productCoordinate: coordinate,
            status,
            phase: observation.phase,
            ...(status === "pending" && observation.phase === "wrapping"
              ? { wrappingOperation: observation.wrappingOperation }
              : {}),
            ...(status === "pending"
              ? { failure: checkpointFailure(error) }
              : {}),
            ...(status === "acknowledged" && observation.checkpointSummary
              ? { checkpointSummary: { ...observation.checkpointSummary } }
              : {}),
          })
        ).catch(() => {})
      } catch {
        // Observation must not change signing, delivery or retained failures.
      }
    }
    try {
      if (!input.stockCheckpoint)
        throw new Error("Stock checkpoint signer required")
      const replayAcknowledgedCheckpoint =
        input.stockCheckpoint.replayAcknowledgedCoordinates?.includes(
          coordinate
        ) === true
      const checkpoint = await publishMerchantOrganizerStockCheckpoint({
        db,
        authenticatedPubkey: merchantPubkey,
        productCoordinate: coordinate,
        ...input.stockCheckpoint,
        replayAcknowledgedCheckpoint,
        onPhase: (phase) => {
          observation.phase = phase
        },
        onWrappingOperation: (operation) => {
          observation.wrappingOperation = operation
        },
      })
      const state = JSON.parse(checkpoint.rumor.content).snapshot
      if (input.onStockCheckpoint && replayAcknowledgedCheckpoint)
        observation.checkpointSummary = {
          sequence: checkpoint.sequence,
          orderCount: state.orders.length,
        }
      checkpointEvents.set(
        coordinate,
        new Set<string>([
          state.product.signedProductEvent.id,
          ...state.assignments.map(
            (assignment: MerchantInventoryAssignment) =>
              assignment.signedAssignmentEvent!.id
          ),
          ...state.pools.map(
            (row: { initialCommitment: SignedPublicNostrEvent }) =>
              row.initialCommitment.id
          ),
        ])
      )
      observe("acknowledged")
    } catch (error) {
      blockedProducts.add(coordinate)
      observe("pending", error)
    }
  }
  for (const record of records) {
    if (input.coordinates && !input.coordinates.includes(record.coordinate))
      continue
    const current =
      record.kind === "product"
        ? await db.merchantInventoryProducts.get(record.coordinate)
        : await db.merchantInventoryAssignments.get(record.coordinate)
    const productCoordinate =
      record.kind === "product"
        ? record.coordinate
        : (current as MerchantInventoryAssignment | undefined)
            ?.productCoordinate
    if (productCoordinate && blockedProducts.has(productCoordinate)) continue
    for (const work of current?.publicationJobs ?? []) {
      if (work.state !== "signed" || !work.signedEvent) continue
      if (
        productCoordinate &&
        checkpointEvents.has(productCoordinate) &&
        !checkpointEvents.get(productCoordinate)!.has(work.signedEvent.id)
      )
        continue
      let acknowledged: boolean | "superseded" = false
      try {
        acknowledged = await publish(work.signedEvent)
      } catch {
        /* retained for retry */
      }
      if (acknowledged) {
        await markDelivered(
          db,
          record.kind,
          record.coordinate,
          work.id,
          acknowledged === "superseded" ? "superseded" : "delivered"
        )
        if (acknowledged === true) delivered += 1
      }
    }
    if (productCoordinate && checkpointEvents.has(productCoordinate)) {
      const latest =
        record.kind === "product"
          ? await db.merchantInventoryProducts.get(record.coordinate)
          : await db.merchantInventoryAssignments.get(record.coordinate)
      const deliveredRevision = Math.max(
        -1,
        ...(latest?.publicationJobs ?? [])
          .filter(
            (work) =>
              work.state === "delivered" &&
              work.signedEvent &&
              checkpointEvents.get(productCoordinate)!.has(work.signedEvent.id)
          )
          .map((work) => work.revision)
      )
      for (const work of latest?.publicationJobs ?? []) {
        if (work.state === "signed" && work.revision < deliveredRevision)
          await markDelivered(
            db,
            record.kind,
            record.coordinate,
            work.id,
            "superseded"
          )
      }
    }
  }
  const products = await db.merchantInventoryProducts
    .where("merchantPubkey")
    .equals(merchantPubkey)
    .toArray()
  const assignments = await db.merchantInventoryAssignments
    .where("merchantPubkey")
    .equals(merchantPubkey)
    .toArray()
  const pending = [...products, ...assignments].reduce(
    (sum, record) =>
      sum +
      record.publicationJobs.filter(
        (work) => work.state !== "delivered" && work.state !== "superseded"
      ).length,
    0
  )
  return { signed, delivered, pending }
}
