// Frozen assignment-preview v25 writer from PR #636 at 69b5b374d8dcf070300ccf3d3dbb4be26f01521d.
// Build installed-version state with this writer, then exercise the current
// writer only after upgrade. The old schema has no shared stock-checkpoint store.
import type {
  ConduitDB,
  MerchantInventoryAcceptedOrder,
  MerchantInventoryAssignment,
  MerchantInventoryProduct,
  MerchantInventoryPublicationJob,
} from "../../packages/core/src/db"
import type { MerchantInventoryOrderItem } from "../../packages/core/src/protocol/merchant-inventory"

const MAX_STOCK = 2_147_483_647
const HEX_ID = /^[0-9a-f]{64}$/

function job(
  id: string,
  revision: number,
  createdAt: number
): MerchantInventoryPublicationJob {
  return { id, revision, createdAt, state: "awaiting_signature" }
}

function listMerchantInventoryAssignments(
  db: ConduitDB,
  productCoordinate: string
) {
  return db.merchantInventoryAssignments
    .where("productCoordinate")
    .equals(productCoordinate)
    .toArray()
}

function effectiveAllocation(
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

export async function acceptInstalledAssignmentOrderV25(input: {
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
