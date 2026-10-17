import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketOrganizerStockPool,
  type MerchantInventoryAssignment,
  type MerchantInventoryProduct,
  type ParsedEventMarketCalendar,
  type ParsedEventMarketRoster,
  type PrivateMessageRumor,
} from "@conduit/core"

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
export interface OrganizerStockDevice {
  version: 1
  writerId: string
  /** Written before installation. Missing journal then requires recovery, never reset. */
  installedPoolIds: string[]
}
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">
const key = (account: string, market: string) =>
  `conduit:event-stock-device:1:${account}:${market}`

export function readOrganizerStockDevice(
  storage: Storage,
  account: string,
  market: string
): OrganizerStockDevice | null {
  const raw = storage.getItem(key(account, market))
  if (raw === null) return null
  let value: OrganizerStockDevice
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("This device's handover record needs recovery.")
  }
  if (
    value?.version !== 1 ||
    !UUID.test(value.writerId) ||
    !Array.isArray(value.installedPoolIds) ||
    value.installedPoolIds.length > 1024 ||
    value.installedPoolIds.some((id) => !HASH.test(id)) ||
    new Set(value.installedPoolIds).size !== value.installedPoolIds.length
  )
    throw new Error("This device's handover record needs recovery.")
  return value
}

function saveDevice(
  storage: Storage,
  account: string,
  market: string,
  device: OrganizerStockDevice
) {
  const serialized = JSON.stringify(device)
  storage.setItem(key(account, market), serialized)
  if (storage.getItem(key(account, market)) !== serialized)
    throw new Error(
      "Save this device's handover record before receiving stock."
    )
  return device
}

/** Explicit user action only. Never adopt the writer identifier from a relay message. */
export function createOrganizerStockDevice(input: {
  storage: Storage
  account: string
  market: string
  hasRetainedPools: boolean
  randomUUID?: () => string
}): OrganizerStockDevice {
  const prior = readOrganizerStockDevice(
    input.storage,
    input.account,
    input.market
  )
  if (prior) return prior
  if (input.hasRetainedPools)
    throw new Error(
      "Recover the original handover device; do not create a replacement writer."
    )
  const writerId = (input.randomUUID ?? (() => crypto.randomUUID()))()
  if (!UUID.test(writerId))
    throw new Error("A fresh device handover ID is required.")
  return saveDevice(input.storage, input.account, input.market, {
    version: 1,
    writerId,
    installedPoolIds: [],
  })
}

/** A missing journal after a prior installation cannot be reset from its original grant. */
export function reserveOrganizerStockInstallation(input: {
  storage: Storage
  account: string
  market: string
  poolId: string
  writerId: string
  existingPool?: EventMarketOrganizerStockPool
}): OrganizerStockDevice {
  const device = readOrganizerStockDevice(
    input.storage,
    input.account,
    input.market
  )
  if (!device || device.writerId !== input.writerId || !HASH.test(input.poolId))
    throw new Error("This grant belongs to a different handover device.")
  if (device.installedPoolIds.includes(input.poolId)) {
    if (!input.existingPool || input.existingPool.writerId !== device.writerId)
      throw new Error(
        "The original stock journal is missing. Recover it before continuing."
      )
    return device
  }
  if (device.installedPoolIds.length >= 1024)
    throw new Error(
      "This device needs handover reconciliation before receiving more stock."
    )
  return saveDevice(input.storage, input.account, input.market, {
    ...device,
    installedPoolIds: [...device.installedPoolIds, input.poolId],
  })
}

/** Form composition only; the shared workflow independently validates signed current admission. */
export function buildMerchantOrganizerStockGrant(input: {
  market: ParsedEventMarketRoster
  occurrence: ParsedEventMarketCalendar
  assignment: MerchantInventoryAssignment
  product: MerchantInventoryProduct
  authenticatedPubkey: string
  grantEventId: string
  scheduleEventId?: string
  writerId: string
  quantityText: string
  nowMs: number
}): PrivateMessageRumor {
  const { market, occurrence, assignment, product } = input
  const quantityText = input.quantityText.trim()
  if (!/^[1-9]\d*$/.test(quantityText) || !UUID.test(input.writerId.trim()))
    throw new Error(
      "Enter a whole stock quantity and the organizer's device handover ID."
    )
  const quantity = Number(quantityText)
  if (
    !Number.isSafeInteger(quantity) ||
    quantity > 2_147_483_647 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    market.state !== "open" ||
    occurrence.end <= input.nowMs ||
    market.organizerPubkey === input.authenticatedPubkey ||
    market.merchants.find((row) => row.pubkey === input.authenticatedPubkey)
      ?.mode !== "organizer_handoff" ||
    assignment.merchantPubkey !== input.authenticatedPubkey ||
    product.merchantPubkey !== input.authenticatedPubkey ||
    assignment.productCoordinate !== product.coordinate ||
    assignment.marketCoordinate !== market.coordinate ||
    assignment.occurrenceCoordinate !== occurrence.coordinate ||
    assignment.state !== "active" ||
    assignment.terminal ||
    assignment.inventory.mode !== "tracked" ||
    quantity > assignment.inventory.quantity ||
    product.stock === undefined ||
    quantity > product.stock ||
    !assignment.signedAssignmentEvent ||
    (assignment.organizerStockHold && !assignment.organizerStockHold.closed)
  )
    throw new Error(
      "Choose a current tracked pickup assignment with enough unentrusted stock."
    )
  return createEventMarketStockAuthorityRumor({
    createdAt: Math.floor(input.nowMs / 1000),
    payload: {
      type: "grant",
      version: 1,
      nonce: crypto.randomUUID(),
      merchantPubkey: input.authenticatedPubkey,
      organizerPubkey: market.organizerPubkey,
      writerId: input.writerId.trim(),
      productCoordinate: product.coordinate,
      assignmentCoordinate: assignment.coordinate,
      marketCoordinate: market.coordinate,
      occurrenceCoordinate: occurrence.coordinate,
      productEventId: product.signedProductEvent.id,
      assignmentEventId: assignment.signedAssignmentEvent.id,
      marketEventId: market.eventId,
      occurrenceEventId: occurrence.eventId,
      grantEventId: input.grantEventId,
      ...(input.scheduleEventId
        ? { scheduleEventId: input.scheduleEventId }
        : {}),
      quantity,
      expiresAtMs: occurrence.end,
    },
  })
}

export function stockPoolBelongsToOccurrence(
  pool: EventMarketOrganizerStockPool,
  market: string,
  occurrence: string
): boolean {
  const grant = parseEventMarketStockAuthorityRumor(pool.grantRumor)
  return (
    grant.type === "grant" &&
    grant.marketCoordinate === market &&
    grant.occurrenceCoordinate === occurrence
  )
}
