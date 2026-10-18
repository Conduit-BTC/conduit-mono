import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  validateOrganizerStockJournalPool,
  type EventMarketOrganizerStockPool,
  type MerchantInventoryAssignment,
  type MerchantInventoryProduct,
  type ParsedEventMarketCalendar,
  type ParsedEventMarketRoster,
  type PrivateMessageRumor,
} from "@conduit/core"
import type { ConduitDB } from "@conduit/core/db"

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const MAX_DEVICE_STOCK_POOLS = 2048
export interface OrganizerStockDevice {
  version: 1 | 2
  writerId: string
  /** Distinct from the immutable logical writer after a verified handover. */
  deviceId?: string
  mode?: "writer" | "target"
  transferId?: string
  generation?: number
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
  let raw: string | null
  try {
    raw = storage.getItem(key(account, market))
  } catch {
    throw new Error(
      "Private device storage is unavailable. Keep the original stock journal safe."
    )
  }
  if (raw === null) return null
  let value: OrganizerStockDevice
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("This device's handover record needs recovery.")
  }
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    !UUID.test(value.writerId) ||
    !Array.isArray(value.installedPoolIds) ||
    value.installedPoolIds.length > MAX_DEVICE_STOCK_POOLS ||
    value.installedPoolIds.some((id) => !HASH.test(id)) ||
    new Set(value.installedPoolIds).size !== value.installedPoolIds.length
  )
    throw new Error("This device's handover record needs recovery.")
  const keys =
    value.version === 1
      ? ["version", "writerId", "installedPoolIds"]
      : [
          "version",
          "writerId",
          "deviceId",
          "mode",
          "installedPoolIds",
          ...(value.transferId !== undefined
            ? ["transferId", "generation"]
            : []),
        ]
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((field) => !Object.hasOwn(value, field)) ||
    (value.version === 2 &&
      (!UUID.test(value.deviceId ?? "") ||
        !["writer", "target"].includes(value.mode ?? "") ||
        (value.transferId === undefined
          ? value.writerId !== value.deviceId
          : !HASH.test(value.transferId) ||
            !Number.isSafeInteger(value.generation) ||
            value.generation! < 1) ||
        (value.mode === "target" &&
          (value.installedPoolIds.length > 0 ||
            value.transferId !== undefined))))
  )
    throw new Error("This device's handover record needs recovery.")
  return structuredClone(value)
}

export const organizerStockDeviceId = (device: OrganizerStockDevice): string =>
  device.version === 2 ? device.deviceId! : device.writerId

function saveDevice(
  storage: Storage,
  account: string,
  market: string,
  device: OrganizerStockDevice
) {
  const serialized = JSON.stringify(device)
  try {
    storage.setItem(key(account, market), serialized)
    if (storage.getItem(key(account, market)) === serialized)
      return structuredClone(device)
  } catch {
    /* A label that cannot be read back grants no device authority. */
  }
  throw new Error("Save this device's handover record before receiving stock.")
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
  if (prior) {
    if (prior.mode === "target")
      throw new Error(
        "Verify the complete handover before using this replacement device."
      )
    return prior
  }
  if (input.hasRetainedPools)
    throw new Error(
      "Recover the original handover device; do not create a replacement writer."
    )
  const writerId = (input.randomUUID ?? (() => crypto.randomUUID()))()
  if (!UUID.test(writerId))
    throw new Error("A fresh device handover ID is required.")
  return saveDevice(input.storage, input.account, input.market, {
    version: 2,
    writerId,
    deviceId: writerId,
    mode: "writer",
    installedPoolIds: [],
  })
}

/** A local target label only. The core must separately register and authenticate it. */
export function prepareOrganizerStockTargetDevice(input: {
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
  if (prior?.mode === "target") return prior
  if (prior || input.hasRetainedPools)
    throw new Error(
      "Prepare a fresh browser or device; do not replace an existing stock writer."
    )
  const deviceId = (input.randomUUID ?? (() => crypto.randomUUID()))()
  if (!UUID.test(deviceId))
    throw new Error("A fresh replacement device ID is required.")
  return saveDevice(input.storage, input.account, input.market, {
    version: 2,
    mode: "target",
    deviceId,
    writerId: deviceId,
    installedPoolIds: [],
  })
}

/** Refresh only from this device's positively verified durable core registration. */
export async function confirmOrganizerStockDeviceRegistration(input: {
  db: ConduitDB
  storage: Storage
  account: string
  market: string
  expectedDeviceId: string
  restored?: {
    writerId: string
    poolIds: readonly string[]
    transferId: string
    generation: number
  }
  shouldContinue(): boolean
}): Promise<OrganizerStockDevice> {
  input = {
    ...input,
    ...(input.restored
      ? {
          restored: { ...input.restored, poolIds: [...input.restored.poolIds] },
        }
      : {}),
  }
  const prior = readOrganizerStockDevice(
    input.storage,
    input.account,
    input.market
  )
  const check = () => {
    if (
      !input.shouldContinue() ||
      !prior ||
      organizerStockDeviceId(prior) !== input.expectedDeviceId ||
      JSON.stringify(
        readOrganizerStockDevice(input.storage, input.account, input.market)
      ) !== JSON.stringify(prior)
    )
      throw new Error("This device's stock registration changed.")
  }
  check()
  const row = await input.db.eventMarketOrganizerStockWriters.get(
    `${input.account}:${input.market}`
  )
  check()
  if (
    !row ||
    row.state !== "active" ||
    row.accountPubkey !== input.account ||
    row.marketCoordinate !== input.market ||
    row.deviceId !== input.expectedDeviceId ||
    !row.writerId ||
    !UUID.test(row.writerId) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0 ||
    !Array.isArray(row.installedPoolIds) ||
    row.installedPoolIds.length > MAX_DEVICE_STOCK_POOLS ||
    row.installedPoolIds.some(
      (id) => typeof id !== "string" || !HASH.test(id)
    ) ||
    new Set(row.installedPoolIds).size !== row.installedPoolIds.length ||
    (row.generation === 0
      ? row.writerId !== row.deviceId || prior!.writerId !== row.writerId
      : !HASH.test(row.transferId ?? "") || !row.receivedEnvelope)
  )
    throw new Error("Verify the complete stock handover on this device first.")
  if (
    input.restored &&
    (input.restored.writerId !== row.writerId ||
      input.restored.transferId !== row.transferId ||
      input.restored.generation !== row.generation ||
      new Set(input.restored.poolIds).size !== input.restored.poolIds.length)
  )
    throw new Error(
      "The verified handover does not match this device's registration."
    )
  const pools = (
    await input.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(input.account)
      .toArray()
  ).filter((pool) => {
    const grant = validateOrganizerStockJournalPool(pool)
    return (
      grant.type === "grant" &&
      grant.marketCoordinate === input.market &&
      pool.writerId === row.writerId
    )
  })
  check()
  const expectedPoolIds = input.restored?.poolIds ?? prior!.installedPoolIds
  if (
    pools.some(
      (pool) => pool.organizerPubkey !== input.account || pool.readOnlyRecovery
    ) ||
    pools.length > MAX_DEVICE_STOCK_POOLS ||
    (row.generation > 0 &&
      (pools.length === 0 || (prior!.mode === "target" && !input.restored))) ||
    JSON.stringify(pools.map((pool) => pool.poolId).sort()) !==
      JSON.stringify([...expectedPoolIds].sort()) ||
    JSON.stringify([...row.installedPoolIds].sort()) !==
      JSON.stringify([...expectedPoolIds].sort())
  )
    throw new Error("The original complete stock journal needs recovery.")
  return saveDevice(input.storage, input.account, input.market, {
    version: 2,
    mode: "writer",
    deviceId: row.deviceId,
    writerId: row.writerId,
    installedPoolIds: pools.map((pool) => pool.poolId).sort(),
    ...(row.generation > 0
      ? { transferId: row.transferId!, generation: row.generation }
      : {}),
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
  if (
    !device ||
    device.mode === "target" ||
    device.writerId !== input.writerId ||
    !HASH.test(input.poolId)
  )
    throw new Error("This grant belongs to a different handover device.")
  if (device.installedPoolIds.includes(input.poolId)) {
    if (!input.existingPool || input.existingPool.writerId !== device.writerId)
      throw new Error(
        "The original stock journal is missing. Recover it before continuing."
      )
    return device
  }
  if (device.installedPoolIds.length >= MAX_DEVICE_STOCK_POOLS)
    throw new Error(
      "This device's complete stock history needs expanded support before receiving more stock."
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
