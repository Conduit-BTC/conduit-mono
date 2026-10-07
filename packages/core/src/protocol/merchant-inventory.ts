import type {
  ConduitDB,
  MerchantInventoryAcceptedOrder,
  MerchantInventoryAssignment,
  MerchantInventoryProduct,
  MerchantInventoryPublicationJob,
} from "../db"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
} from "./event-market-assignment"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

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
            a.state === "active" &&
            (a.inventory.mode === "untracked") !== (stock === undefined)
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

export function effectiveAllocation(
  assignment: MerchantInventoryAssignment,
  nowMs: number
): number {
  return assignment.state === "active" &&
    !assignment.terminal &&
    nowMs < assignment.occurrenceEndMs &&
    assignment.inventory.mode === "tracked"
    ? assignment.inventory.quantity
    : 0
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
        (a) => a.inventory.mode !== "untracked" && a.state === "active"
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
      const priorMutation = existing?.publicationJobs.find(
        (j) => j.id === mutationId
      )
      if (priorMutation) {
        if (
          JSON.stringify(priorMutation.assignmentSnapshot) !==
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
      const nextReserved =
        state === "active" &&
        !terminal &&
        nowMs < occurrenceEndMs &&
        inventory.mode === "tracked"
          ? inventory.quantity
          : 0
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
        revision,
        signedAssignmentEvent: existing?.signedAssignmentEvent,
        publicationJobs: [...(existing?.publicationJobs ?? []), nextJob],
      }
      await db.merchantInventoryAssignments.put(assignment)
      return assignment
    }
  )
}

export type ValidatedOrderAdmission =
  | { kind: "validated-ordinary-product"; productEventId: string }
  | {
      kind: "validated-event-market-order"
      productEventId: string
      assignmentCoordinate: string
      assignmentEventId?: string
      marketEventId: string
      occurrenceEventId: string
      grantEventId: string
      scheduleEventId?: string
    }

export type MerchantInventoryOrderItem = {
  productCoordinate: string
  assignmentCoordinate?: string
  method: Method
  quantity: number
  admission: ValidatedOrderAdmission
}

/** The one merchant acceptance decision. All reads and debits share a Dexie write transaction. */
export async function acceptMerchantInventoryOrder(input: {
  db: ConduitDB
  orderId: string
  merchantPubkey: string
  identityBinding: string
  termsBinding: string
  evidence: string
  items: MerchantInventoryOrderItem[]
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
  const acceptedAt = input.acceptedAt ?? Date.now()
  if (
    !orderId ||
    !merchantPubkey ||
    !identityBinding ||
    !termsBinding ||
    !evidence ||
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
    if (ids.some((id) => id !== undefined && !HEX_ID.test(id)))
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
    db.merchantInventoryProducts,
    db.merchantInventoryAssignments,
    db.merchantInventoryAcceptedOrders,
    async () => {
      const prior = await db.merchantInventoryAcceptedOrders.get(orderId)
      if (prior) {
        if (
          prior.merchantPubkey !== merchantPubkey ||
          prior.identityBinding !== identityBinding ||
          prior.termsBinding !== termsBinding ||
          prior.evidence !== evidence ||
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
            )
        )
          throw new Error("Order ID is bound to different identity or terms")
        return { replayed: true, order: prior }
      }
      const products = new Map<string, MerchantInventoryProduct>()
      const assignments = new Map<string, MerchantInventoryAssignment>()
      const output: MerchantInventoryAcceptedOrder["items"] = []
      for (const item of items) {
        let product = products.get(item.productCoordinate)
        if (!product) {
          product = await db.merchantInventoryProducts.get(
            item.productCoordinate
          )
          if (!product || product.merchantPubkey !== merchantPubkey)
            throw new Error("Committed merchant product unavailable")
          products.set(item.productCoordinate, product)
        }
        const siblings = await listMerchantInventoryAssignments(
          db,
          item.productCoordinate
        )
        let assignment: MerchantInventoryAssignment | undefined
        if (item.assignmentCoordinate) {
          assignment =
            assignments.get(item.assignmentCoordinate) ??
            siblings.find((a) => a.coordinate === item.assignmentCoordinate)
          if (
            !assignment ||
            assignment.productCoordinate !== item.productCoordinate ||
            assignment.state !== "active" ||
            assignment.terminal ||
            acceptedAt >= assignment.occurrenceEndMs ||
            !assignment.fulfillmentMethods.includes(
              item.method as "pickup" | "shipping" | "digital"
            )
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
          if (
            siblings.some(
              (a) => a.state === "active" && a.inventory.mode !== "tracked"
            ) ||
            effective > product.stock
          )
            throw new Error("Committed inventory requires reconciliation")
          if (item.method === "pickup") {
            if (
              !assignment ||
              assignment.inventory.mode !== "tracked" ||
              effectiveAllocation(assignment, acceptedAt) < item.quantity
            )
              throw new Error("Insufficient pickup allocation")
          } else if (product.stock - effective < item.quantity) {
            throw new Error("Insufficient ordinary stock")
          }
          product.stock -= item.quantity
          if (
            item.method === "pickup" &&
            assignment?.inventory.mode === "tracked"
          ) {
            assignment.inventory = {
              mode: "tracked",
              quantity: assignment.inventory.quantity - item.quantity,
            }
          }
        } else if (
          siblings.some(
            (a) => a.state === "active" && a.inventory.mode !== "untracked"
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
      for (const product of products.values()) {
        product.revision += 1
        if (product.stock !== undefined) {
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
          }
          assignment.publicationJobs.push(nextJob)
          await db.merchantInventoryAssignments.put(assignment)
        }
      }
      const order: MerchantInventoryAcceptedOrder = {
        orderId,
        merchantPubkey,
        identityBinding,
        termsBinding,
        evidence,
        items: output,
        acceptedAt,
      }
      await db.merchantInventoryAcceptedOrders.add(order)
      return { replayed: false, order }
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
    const predecessor =
      previousJobs.at(-1)?.signedEvent ??
      (kind === "product"
        ? (record as MerchantInventoryProduct).signedProductEvent
        : (record as MerchantInventoryAssignment).signedAssignmentEvent)
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
  jobId: string
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
    work.state = "delivered"
    await table.put(record as never)
  })
}

/** Delivery may fail; the durable order decision and later acceptances remain intact. */
export async function resumeMerchantInventoryPublication(input: {
  db: ConduitDB
  merchantPubkey: string
  sign(draft: Draft): Promise<SignedPublicNostrEvent>
  publish(signed: SignedPublicNostrEvent): Promise<boolean>
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
    const current =
      record.kind === "product"
        ? await db.merchantInventoryProducts.get(record.coordinate)
        : await db.merchantInventoryAssignments.get(record.coordinate)
    for (const work of current?.publicationJobs ?? []) {
      if (work.state !== "signed" || !work.signedEvent) continue
      let acknowledged = false
      try {
        acknowledged = await publish(work.signedEvent)
      } catch {
        /* retained for retry */
      }
      if (acknowledged) {
        await markDelivered(db, record.kind, record.coordinate, work.id)
        delivered += 1
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
      record.publicationJobs.filter((work) => work.state !== "delivered")
        .length,
    0
  )
  return { signed, delivered, pending }
}
