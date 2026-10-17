import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { getEventHash } from "nostr-tools"
import type {
  ConduitDB,
  EventMarketOrganizerStockEntry,
  EventMarketOrganizerStockPool,
  MerchantInventoryAcceptedOrder,
  MerchantInventoryAssignment,
  MerchantInventoryProduct,
} from "../db"
import { orderSchema } from "../schemas"
import { CommerceInboxStore } from "./commerce-inbox-store"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import { parseEventMarketStockAuthorityRumor } from "./event-market-stock-authority"
import {
  sameOrganizerStockRumor,
  validateMerchantOrganizerStockPool,
} from "./event-market-stock-import-authority"
import { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import type { AccountSigner } from "./nostr-event-signer"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import {
  assertPrivateMessageFitsTransport,
  completePrivateMessageEvent,
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import {
  assertProtectedReadAuthorization,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export const EVENT_MARKET_STOCK_CHECKPOINT_SUBJECT =
  "conduit-event-stock-checkpoint"
const MARKER = ["conduit", "event-stock-checkpoint", "1"]
const MAX_BYTES = 240_000
const MAX_ROWS = 128
const sameSigned = (a: SignedPublicNostrEvent, b: SignedPublicNostrEvent) => {
  const fields = (event: SignedPublicNostrEvent) => [
    event.id,
    event.pubkey,
    event.kind,
    event.created_at,
    event.tags,
    event.content,
    event.sig,
  ]
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b))
}
const clone = <T>(value: T): T => structuredClone(value)
const digest = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
const exact = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)
type ProductSnapshot = Omit<
  MerchantInventoryProduct,
  "publicationJobs" | "organizerStockCheckpoint"
>
type AssignmentSnapshot = Omit<MerchantInventoryAssignment, "publicationJobs">
interface StockSnapshot {
  product: ProductSnapshot
  assignments: AssignmentSnapshot[]
  pools: Array<{
    pool: EventMarketOrganizerStockPool
    initialCommitment: SignedPublicNostrEvent
  }>
  entries: EventMarketOrganizerStockEntry[]
  orders: MerchantInventoryAcceptedOrder[]
}
export interface EventMarketStockCheckpointPayload {
  version: 1
  type: "merchant_checkpoint"
  merchantPubkey: string
  sequence: number
  previousId: string | null
  snapshotKey: string
  snapshot: StockSnapshot
}
type CheckpointSession = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}
export type MerchantStockCheckpointDelivery = Pick<
  Parameters<typeof retryPrivateMessageWraps>[0],
  | "deliveryStore"
  | "publishFn"
  | "resolveInboxRelays"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
>

function fail(): never {
  throw new Error("Merchant stock checkpoint requires reconciliation")
}
interface CheckpointObservation {
  sequence: number
  rumorId: string
  previousId: string | null
  snapshotKey: string
  envelope: SignedPublicNostrEvent
  conflicting?: true
}
function preservesFrontiers(
  next: StockSnapshot,
  before: StockSnapshot
): boolean {
  return (
    next.product.coordinate === before.product.coordinate &&
    before.pools.every(({ pool }) =>
      next.pools.some(
        ({ pool: saved }) =>
          pool.poolId === saved.poolId &&
          sameOrganizerStockRumor(pool.grantRumor, saved.grantRumor) &&
          pool.acceptedSequence <= saved.acceptedSequence &&
          pool.importedSequence <= saved.importedSequence &&
          (pool.acceptedSequence !== saved.acceptedSequence ||
            pool.lastAcceptedId === saved.lastAcceptedId) &&
          (pool.importedSequence !== saved.importedSequence ||
            pool.lastImportedId === saved.lastImportedId) &&
          (!pool.closingRumor ||
            (saved.closingRumor &&
              sameOrganizerStockRumor(
                pool.closingRumor,
                saved.closingRumor
              ))) &&
          (pool.state !== "closed" || saved.state === "closed")
      )
    ) &&
    before.entries.every((entry) =>
      next.entries.some(
        (saved) =>
          entry.id === saved.id &&
          sameOrganizerStockRumor(entry.rumor, saved.rumor) &&
          (!entry.imported || saved.imported) &&
          (!entry.handout ||
            (saved.handout &&
              sameOrganizerStockRumor(
                entry.handout.rumor,
                saved.handout.rumor
              )))
      )
    ) &&
    before.orders.every((order) =>
      next.orders.some(
        (saved) =>
          order.orderId === saved.orderId &&
          order.merchantPubkey === saved.merchantPubkey &&
          order.identityBinding === saved.identityBinding &&
          order.termsBinding === saved.termsBinding &&
          exact(order.organizerImport, saved.organizerImport)
      )
    )
  )
}
const observationId = (coordinate: string) =>
  `event-stock-checkpoint:${coordinate}`
const sameCipher = (a: { nonce: Uint8Array }, b: { nonce: Uint8Array }) =>
  exact(Array.from(a.nonce), Array.from(b.nonce))

/** Durable encrypted high-water evidence, never a resumable transport job. */
export async function observeMerchantOrganizerStockCheckpoint(
  input: CheckpointSession & {
    authorization: ProtectedReadAuthorization
    store: CommerceInboxStore
    envelope: SignedPublicNostrEvent
  }
) {
  input = { ...input, envelope: clone(input.envelope) }
  const authority = session(input)
  const check = () => {
    authority.check()
    assertProtectedReadAuthorization(
      input.authorization,
      input.authenticatedPubkey
    )
    input.store.assertCurrent()
    if (
      input.authorization.signer !== input.signer ||
      input.store.principal !== input.authenticatedPubkey ||
      input.store.database !== input.db
    )
      fail()
  }
  await authority.authenticate()
  check()
  const observed = await input.db.commerceInboxWrappers.get(
    input.store.key(input.envelope.id)
  )
  check()
  if (
    !observed?.sources.length ||
    !exact(observed.event, input.envelope) ||
    ["deleted", "expired", "invalid_envelope"].includes(observed.state)
  )
    fail()
  const rumor = completePrivateMessageEvent(
    await unwrapPrivateMessageEnvelope(input.envelope, input.signer)
  )
  check()
  const payload = parseEventMarketStockCheckpointRumor(rumor)
  if (payload.merchantPubkey !== input.authenticatedPubkey) fail()
  const logicalId = observationId(payload.snapshot.product.coordinate)
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await input.db.commerceInboxDeliveries.get(
      input.store.key(logicalId)
    )
    check()
    if (row && row.kind !== "merchant_stock_recovery") fail()
    const previous =
      row &&
      (await input.store.open<CheckpointObservation>(row.value, logicalId))
    check()
    if (
      previous &&
      (!Number.isSafeInteger(previous.sequence) ||
        previous.sequence < 1 ||
        !/^[0-9a-f]{64}$/.test(previous.rumorId) ||
        !/^[0-9a-f]{64}$/.test(previous.snapshotKey))
    )
      fail()
    if (previous?.conflicting) fail()
    if (previous && previous.sequence > payload.sequence)
      return {
        rumor,
        payload,
        row,
        observation: previous,
        sources: [...observed.sources],
      }
    if (
      previous &&
      previous.sequence === payload.sequence &&
      previous.rumorId === rumor.id
    )
      return {
        rumor,
        payload,
        row: row!,
        observation: previous,
        sources: [...observed.sources],
      }
    let conflict =
      previous &&
      (previous.sequence === payload.sequence ||
        (previous.sequence + 1 === payload.sequence &&
          payload.previousId !== previous.rumorId))
    if (previous && payload.sequence > previous.sequence && !conflict) {
      const oldRumor = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(previous.envelope, input.signer)
      )
      check()
      const old = parseEventMarketStockCheckpointRumor(oldRumor)
      if (
        oldRumor.id !== previous.rumorId ||
        old.snapshotKey !== previous.snapshotKey ||
        old.sequence !== previous.sequence ||
        old.merchantPubkey !== input.authenticatedPubkey
      )
        fail()
      conflict = !preservesFrontiers(payload.snapshot, old.snapshot)
    }
    const observation: CheckpointObservation = conflict
      ? { ...previous!, conflicting: true }
      : {
          sequence: payload.sequence,
          rumorId: rumor.id,
          previousId: payload.previousId,
          snapshotKey: payload.snapshotKey,
          envelope: input.envelope,
        }
    const value = await input.store.seal(observation, logicalId)
    check()
    const saved = await input.db.transaction(
      "rw",
      input.db.commerceInboxDeliveries,
      async () => {
        check()
        const current = await input.db.commerceInboxDeliveries.get(
          input.store.key(logicalId)
        )
        if (
          Boolean(current) !== Boolean(row) ||
          (current && row && !sameCipher(current.value, row.value))
        )
          return null
        const next = {
          id: input.store.key(logicalId),
          accountPubkey: input.authenticatedPubkey,
          kind: "merchant_stock_recovery" as const,
          value,
          updatedAt: Date.now(),
        }
        await input.db.commerceInboxDeliveries.put(next)
        check()
        return next
      }
    )
    if (saved) {
      if (conflict) fail()
      return {
        rumor,
        payload,
        row: saved,
        observation,
        sources: [...observed.sources],
      }
    }
  }
  throw new Error(
    "Merchant stock checkpoint observation changed; retry saved work"
  )
}
function bounded(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
}
function coordinate(event: SignedPublicNostrEvent) {
  return `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}`
}
function signed(event: SignedPublicNostrEvent, owner: string, address: string) {
  if (
    !isValidSignedPublicNostrEvent(event) ||
    event.pubkey !== owner ||
    coordinate(event) !== address
  )
    fail()
}
function session(input: CheckpointSession) {
  const revision = input.signer.revision,
    method = input.signer.authMethod
  const check = () => {
    if (
      !revision ||
      !method ||
      !input.shouldContinue() ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== method ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44
    )
      throw new Error("Merchant stock checkpoint session changed")
  }
  return {
    check,
    authenticate: async () => {
      check()
      const pubkey = await input.signer.getPublicKey()
      check()
      if (pubkey !== input.authenticatedPubkey) fail()
    },
  }
}

/** This namespace is private machine evidence, not a human conversation. */
export function isEventMarketStockCheckpointRumor(rumor: {
  readonly tags: unknown
}) {
  return (
    Array.isArray(rumor.tags) &&
    rumor.tags.some(
      (tag) =>
        Array.isArray(tag) &&
        ((tag[0] === "subject" &&
          tag[1] === EVENT_MARKET_STOCK_CHECKPOINT_SUBJECT) ||
          (tag[0] === MARKER[0] && tag[1] === MARKER[1]))
    )
  )
}

/** Shape/hash checks only; authority requires the Merchant-authenticated seal. */
export function parseEventMarketStockCheckpointRumor(
  rumor: PrivateMessageRumor
): EventMarketStockCheckpointPayload {
  if (
    rumor.kind !== 14 ||
    !Number.isSafeInteger(rumor.created_at) ||
    rumor.created_at < 0 ||
    rumor.id !== getEventHash(rumor) ||
    new TextEncoder().encode(rumor.content).length > MAX_BYTES
  )
    fail()
  const payload = JSON.parse(rumor.content) as EventMarketStockCheckpointPayload
  if (
    !payload ||
    payload.version !== 1 ||
    payload.type !== "merchant_checkpoint" ||
    payload.merchantPubkey !== rumor.pubkey ||
    !/^[0-9a-f]{64}$/.test(payload.merchantPubkey) ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 1 ||
    (payload.sequence === 1
      ? payload.previousId !== null
      : !/^[0-9a-f]{64}$/.test(payload.previousId ?? "")) ||
    !exact(rumor.tags, [
      ["p", rumor.pubkey],
      ["subject", EVENT_MARKET_STOCK_CHECKPOINT_SUBJECT],
      MARKER,
    ]) ||
    payload.snapshotKey !== digest(payload.snapshot)
  )
    fail()
  validateSnapshot(payload.snapshot, payload.merchantPubkey)
  return payload
}

/** A complete prefix is required; caps never silently omit a debit or close. */
function validateSnapshot(snapshot: StockSnapshot, merchant: string): void {
  if (
    !snapshot?.product ||
    ![
      snapshot.assignments,
      snapshot.pools,
      snapshot.entries,
      snapshot.orders,
    ].every((rows) => Array.isArray(rows) && rows.length <= MAX_ROWS) ||
    !snapshot.pools.length ||
    snapshot.product.merchantPubkey !== merchant ||
    !bounded(snapshot.product.revision) ||
    !bounded(snapshot.product.stock!)
  )
    fail()
  const product = snapshot.product
  signed(product.sourceProductEvent, merchant, product.coordinate)
  signed(product.signedProductEvent, merchant, product.coordinate)
  const stockTags = product.signedProductEvent.tags.filter(
    (tag) => tag[0] === "stock"
  )
  if (!exact(stockTags, [["stock", String(product.stock)]])) fail()
  const assignments = new Map(
    snapshot.assignments.map((row) => [row.coordinate, row])
  )
  const pools = new Map(snapshot.pools.map((row) => [row.pool.poolId, row]))
  const orders = new Map(snapshot.orders.map((row) => [row.orderId, row]))
  if (
    assignments.size !== snapshot.assignments.length ||
    pools.size !== snapshot.pools.length ||
    orders.size !== snapshot.orders.length ||
    new Set(snapshot.entries.map((row) => row.id)).size !==
      snapshot.entries.length
  )
    fail()
  for (const row of assignments.values()) {
    if (
      row.merchantPubkey !== merchant ||
      row.productCoordinate !== product.coordinate ||
      !bounded(row.revision) ||
      !Number.isSafeInteger(row.occurrenceEndMs) ||
      typeof row.terminal !== "boolean" ||
      !row.signedAssignmentEvent
    )
      fail()
    signed(row.signedAssignmentEvent, merchant, row.coordinate)
    const parsed = parseEventMarketAssignmentEvent(row.signedAssignmentEvent)
    if (
      !parsed ||
      parsed.productCoordinate !== row.productCoordinate ||
      parsed.marketCoordinate !== row.marketCoordinate ||
      parsed.occurrenceCoordinate !== row.occurrenceCoordinate ||
      parsed.state !== row.state ||
      !exact(parsed.inventory, row.inventory) ||
      !exact(parsed.fulfillmentMethods, row.fulfillmentMethods)
    )
      fail()
    const hold = row.organizerStockHold
    if (hold) {
      const pool = pools.get(hold.poolId)?.pool
      if (
        !pool ||
        pool.assignmentCoordinate !== row.coordinate ||
        pool.organizerPubkey !== hold.organizerPubkey ||
        pool.quantity !== hold.quantity ||
        pool.importedQuantity !== hold.importedQuantity ||
        (pool.state === "closed") !== hold.closed ||
        parsed.stockPool.state !== "valid" ||
        !exact(parsed.stockPool.pool, {
          state: hold.closed ? "closed" : "active",
          poolId: hold.poolId,
          organizerPubkey: hold.organizerPubkey,
          quantity: hold.quantity,
          importedQuantity: hold.importedQuantity,
        })
      )
        fail()
    } else if (parsed.stockPool.state !== "absent") fail()
  }
  for (const { pool, initialCommitment } of pools.values()) {
    const grant = validateMerchantOrganizerStockPool(pool, merchant)
    const assignment = assignments.get(grant.assignmentCoordinate)
    const initial = parseEventMarketAssignmentEvent(initialCommitment)
    if (
      grant.productCoordinate !== product.coordinate ||
      !assignment ||
      !pool.grantWraps?.self ||
      !isValidSignedPublicNostrEvent(initialCommitment) ||
      !initial ||
      initial.coordinate !== grant.assignmentCoordinate ||
      initial.previousEventId !== grant.assignmentEventId ||
      initial.stockPool.state !== "valid" ||
      initial.stockPool.pool.poolId !== pool.poolId ||
      initial.stockPool.pool.state !== "active" ||
      initial.stockPool.pool.importedQuantity !== 0 ||
      initial.stockPool.pool.quantity !== grant.quantity ||
      initial.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
      (pool.state !== "closed" &&
        assignment.organizerStockHold?.poolId !== pool.poolId)
    )
      fail()
    const entries = snapshot.entries
      .filter((entry) => entry.poolId === pool.poolId)
      .sort((a, b) => a.sequence - b.sequence)
    if (entries.length !== pool.acceptedSequence) fail()
    let previous = pool.poolId,
      quantity = 0,
      imported = 0,
      previousTime = pool.grantRumor.created_at * 1000
    for (const [index, entry] of entries.entries()) {
      const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
      if (
        accepted.type !== "accepted" ||
        entry.accountPubkey !== merchant ||
        entry.id !== `${merchant}:${entry.rumor.id}` ||
        entry.sequence !== index + 1 ||
        accepted.sequence !== entry.sequence ||
        accepted.previousId !== previous ||
        accepted.poolId !== pool.poolId ||
        accepted.writerId !== pool.writerId ||
        accepted.merchantPubkey !== merchant ||
        accepted.organizerPubkey !== pool.organizerPubkey ||
        accepted.orderId !== entry.orderId ||
        accepted.claimRef !== entry.claimRef ||
        accepted.quantity !== entry.quantity ||
        accepted.acceptedAtMs < previousTime ||
        accepted.acceptedAtMs >= grant.expiresAtMs ||
        !entry.receivedEnvelope ||
        entry.imported !== entry.sequence <= pool.importedSequence
      )
        fail()
      if (entry.imported) {
        imported += entry.quantity
        const order = orders.get(entry.orderId)
        if (!order) fail()
        const bindings = getOrganizerStockOrderBindings(
          orderSchema.parse(JSON.parse(order.termsBinding))
        )
        if (
          order.merchantPubkey !== merchant ||
          order.evidence !== order.termsBinding ||
          order.identityBinding !== bindings.identityBinding ||
          order.termsBinding !== bindings.termsBinding ||
          accepted.identityBinding !== bindings.identityHash ||
          accepted.termsBinding !== bindings.termsHash ||
          entry.evidence !== order.evidence ||
          order.organizerImport?.organizerPubkey !== pool.organizerPubkey ||
          order.organizerImport.claimRef !== entry.claimRef ||
          !order.organizerImport.entries.some(
            (attribution) =>
              attribution.poolId === pool.poolId &&
              attribution.entryId === entry.rumor.id &&
              attribution.writerId === pool.writerId &&
              attribution.quantity === entry.quantity
          )
        )
          fail()
      }
      if (entry.handout) {
        const handout = parseEventMarketStockAuthorityRumor(entry.handout.rumor)
        if (
          handout.type !== "handed_out" ||
          handout.merchantPubkey !== merchant ||
          handout.organizerPubkey !== pool.organizerPubkey ||
          handout.writerId !== pool.writerId ||
          handout.orderId !== entry.orderId ||
          handout.claimRef !== entry.claimRef ||
          handout.identityBinding !== accepted.identityBinding ||
          handout.termsBinding !== accepted.termsBinding ||
          handout.handedOutAtMs < accepted.acceptedAtMs ||
          !handout.entries.some(
            (item) =>
              item.poolId === pool.poolId &&
              item.acceptedId === entry.rumor.id &&
              item.quantity === entry.quantity
          )
        )
          fail()
      }
      previous = entry.rumor.id
      previousTime = accepted.acceptedAtMs
      quantity += entry.quantity
    }
    if (
      quantity !== pool.acceptedQuantity ||
      imported !== pool.importedQuantity ||
      previous !== pool.lastAcceptedId ||
      (pool.importedSequence
        ? entries[pool.importedSequence - 1]?.rumor.id
        : pool.poolId) !== pool.lastImportedId
    )
      fail()
    if (
      pool.state === "closed" &&
      pool.importedSequence !== pool.acceptedSequence
    )
      fail()
    if (pool.closingRumor) {
      const close = parseEventMarketStockAuthorityRumor(pool.closingRumor)
      if (
        close.type !== "closed" ||
        !pool.receivedClosingEnvelope ||
        close.poolId !== pool.poolId ||
        close.writerId !== pool.writerId ||
        close.sequence !== pool.acceptedSequence ||
        close.acceptedQuantity !== quantity ||
        close.lastAcceptedId !== previous ||
        pool.closingRumor.created_at * 1000 + 999 < previousTime
      )
        fail()
    } else if (pool.state === "closed" || pool.state === "closing") fail()
  }
  if (snapshot.entries.some((entry) => !pools.has(entry.poolId))) fail()
}

async function snapshot(
  db: ConduitDB,
  merchant: string,
  address: string
): Promise<StockSnapshot> {
  const product = await db.merchantInventoryProducts.get(address)
  if (!product || product.merchantPubkey !== merchant) fail()
  const assignments = await db.merchantInventoryAssignments
    .where("productCoordinate")
    .equals(address)
    .limit(MAX_ROWS + 1)
    .toArray()
  if (assignments.length > MAX_ROWS) fail()
  if (
    [product, ...assignments].some((row) =>
      row.publicationJobs.some((job) => job.state === "awaiting_signature")
    )
  )
    throw new Error("Sign every stock projection before checkpointing")
  const pools = await db.eventMarketOrganizerStockPools
    .where("accountPubkey")
    .equals(merchant)
    .filter((pool) => pool.productCoordinate === address)
    .limit(MAX_ROWS + 1)
    .toArray()
  if (pools.length > MAX_ROWS) fail()
  const entries: EventMarketOrganizerStockEntry[] = []
  const orders = new Map<string, MerchantInventoryAcceptedOrder>(
    (
      await db.merchantInventoryAcceptedOrders
        .where("merchantPubkey")
        .equals(merchant)
        .filter((order) =>
          order.items.some((item) => item.productCoordinate === address)
        )
        .limit(MAX_ROWS + 1)
        .toArray()
    ).map((order) => [order.orderId, order])
  )
  if (orders.size > MAX_ROWS) fail()
  const markets = [...new Set(assignments.map((row) => row.marketCoordinate))]
  const publicRows = markets.length
    ? await db.eventMarketRosterEvidence
        .where("marketCoordinate")
        .anyOf(markets)
        .limit(2_049)
        .toArray()
    : []
  const resultPools: StockSnapshot["pools"] = []
  for (const pool of pools.sort((a, b) => a.poolId.localeCompare(b.poolId))) {
    const grant = validateMerchantOrganizerStockPool(pool, merchant)
    const assignment = assignments.find(
      (row) => row.coordinate === pool.assignmentCoordinate
    )
    const candidates = [
      ...(assignment?.publicationJobs.flatMap((job) =>
        job.signedEvent ? [job.signedEvent] : []
      ) ?? []),
      ...publicRows.map((row) => row.signedEvent),
      ...(assignment?.signedAssignmentEvent
        ? [assignment.signedAssignmentEvent]
        : []),
    ]
    const initialCommitment = candidates.find((event) => {
      const parsed = parseEventMarketAssignmentEvent(event)
      return (
        parsed?.coordinate === grant.assignmentCoordinate &&
        parsed.previousEventId === grant.assignmentEventId &&
        parsed.stockPool.state === "valid" &&
        parsed.stockPool.pool.poolId === pool.poolId &&
        parsed.stockPool.pool.importedQuantity === 0
      )
    })
    if (!initialCommitment) fail()
    resultPools.push({
      pool: clone(pool),
      initialCommitment: clone(initialCommitment),
    })
    const rows = await db.eventMarketOrganizerStockEntries
      .where("[accountPubkey+poolId]")
      .equals([merchant, pool.poolId])
      .limit(MAX_ROWS + 1)
      .toArray()
    if (entries.length + rows.length > MAX_ROWS) fail()
    entries.push(...rows)
    for (const entry of rows.filter((row) => row.imported)) {
      const order = await db.merchantInventoryAcceptedOrders.get(entry.orderId)
      if (!order) fail()
      orders.set(order.orderId, order)
    }
  }
  const {
    publicationJobs: _jobs,
    organizerStockCheckpoint: _checkpoint,
    ...productSnapshot
  } = product
  void _jobs
  void _checkpoint
  const result: StockSnapshot = {
    product: productSnapshot,
    assignments: assignments
      .sort((a, b) => a.coordinate.localeCompare(b.coordinate))
      .map(({ publicationJobs, ...row }) => {
        void publicationJobs
        return row
      }),
    pools: resultPools,
    entries: entries.sort(
      (a, b) => a.poolId.localeCompare(b.poolId) || a.sequence - b.sequence
    ),
    orders: [...orders.values()].sort((a, b) =>
      a.orderId.localeCompare(b.orderId)
    ),
  }
  validateSnapshot(result, merchant)
  return result
}

const inventoryTables = (db: ConduitDB) => [
  db.merchantInventoryProducts,
  db.merchantInventoryAssignments,
  db.merchantInventoryAcceptedOrders,
  db.eventMarketOrganizerStockPools,
  db.eventMarketOrganizerStockEntries,
  db.eventMarketRosterEvidence,
  db.commerceInboxDeliveries,
  db.products,
]

/** Retain exact self ciphertext and obtain an inbox ACK before public projection. */
type PublishCheckpointInput = CheckpointSession & {
  productCoordinate: string
  delivery?: MerchantStockCheckpointDelivery
}
export function publishMerchantOrganizerStockCheckpoint(
  input: PublishCheckpointInput
) {
  return publishCheckpoint(input, 0)
}
async function publishCheckpoint(
  input: PublishCheckpointInput,
  attempt: number
): Promise<NonNullable<MerchantInventoryProduct["organizerStockCheckpoint"]>> {
  input = {
    ...input,
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  const authority = session(input)
  await authority.authenticate()
  let product = await input.db.merchantInventoryProducts.get(
    input.productCoordinate
  )
  if (!product) fail()
  let saved = product.organizerStockCheckpoint
  // An interrupted older checkpoint is delivered byte-for-byte before advancing.
  if (!saved || saved.acknowledgedRelayUrls.length) {
    const current = await input.db.transaction(
      "r",
      inventoryTables(input.db),
      () =>
        snapshot(input.db, input.authenticatedPubkey, input.productCoordinate)
    )
    authority.check()
    const snapshotKey = digest(current)
    if (saved?.snapshotKey === snapshotKey) return clone(saved)
    const payload: EventMarketStockCheckpointPayload = {
      version: 1,
      type: "merchant_checkpoint",
      merchantPubkey: input.authenticatedPubkey,
      sequence: (saved?.sequence ?? 0) + 1,
      previousId: saved?.rumor.id ?? null,
      snapshotKey,
      snapshot: current,
    }
    const rumor = createPrivateMessageRumor({
      kind: 14,
      pubkey: input.authenticatedPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["p", input.authenticatedPubkey],
        ["subject", EVENT_MARKET_STOCK_CHECKPOINT_SUBJECT],
        MARKER,
      ],
      content: JSON.stringify(payload),
    })
    parseEventMarketStockCheckpointRumor(rumor)
    assertPrivateMessageFitsTransport(rumor)
    saved = await input.db.transaction(
      "rw",
      inventoryTables(input.db),
      async () => {
        authority.check()
        const row = await input.db.merchantInventoryProducts.get(
          input.productCoordinate
        )
        if (
          !row ||
          !exact(
            row.organizerStockCheckpoint,
            product!.organizerStockCheckpoint
          ) ||
          digest(
            await snapshot(
              input.db,
              input.authenticatedPubkey,
              input.productCoordinate
            )
          ) !== snapshotKey
        )
          fail()
        row.organizerStockCheckpoint = {
          sequence: payload.sequence,
          previousId: payload.previousId,
          snapshotKey,
          rumor,
          acknowledgedRelayUrls: [],
        }
        await input.db.merchantInventoryProducts.put(row)
        authority.check()
        return row.organizerStockCheckpoint
      }
    )
  }
  if (!saved.selfEnvelope) {
    const selfEnvelope = await wrapPrivateMessage(
      saved.rumor,
      { pubkey: input.authenticatedPubkey },
      input.signer
    )
    authority.check()
    saved = await input.db.transaction(
      "rw",
      input.db.merchantInventoryProducts,
      async () => {
        authority.check()
        const row = await input.db.merchantInventoryProducts.get(
          input.productCoordinate
        )
        if (
          !row?.organizerStockCheckpoint ||
          row.organizerStockCheckpoint.rumor.id !== saved!.rumor.id
        )
          fail()
        row.organizerStockCheckpoint.selfEnvelope ??= selfEnvelope
        await input.db.merchantInventoryProducts.put(row)
        authority.check()
        return row.organizerStockCheckpoint
      }
    )
  }
  const result = await retryPrivateMessageWraps({
    ...input.delivery,
    rumorId: saved.rumor.id,
    senderPubkey: input.authenticatedPubkey,
    recipientPubkey: input.authenticatedPubkey,
    accountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    wrappedToRecipient: saved.selfEnvelope!,
    shouldContinue: () => {
      authority.check()
      return true
    },
  })
  authority.check()
  if (!result.recipientDelivery?.successfulRelayUrls.length)
    throw new Error(
      "Merchant stock checkpoint still awaits inbox acknowledgement"
    )
  await input.db.transaction(
    "rw",
    input.db.merchantInventoryProducts,
    async () => {
      authority.check()
      product = await input.db.merchantInventoryProducts.get(
        input.productCoordinate
      )
      if (
        !product?.organizerStockCheckpoint ||
        product.organizerStockCheckpoint.rumor.id !== saved!.rumor.id
      )
        fail()
      product.organizerStockCheckpoint.acknowledgedRelayUrls = [
        ...new Set([
          ...product.organizerStockCheckpoint.acknowledgedRelayUrls,
          ...result.recipientDelivery!.successfulRelayUrls,
        ]),
      ]
      await input.db.merchantInventoryProducts.put(product)
      authority.check()
    }
  )
  // A sale may have committed during encryption/delivery. Never publish its
  // newer projections under the previous checkpoint's acknowledgement.
  const current = await input.db.transaction(
    "r",
    inventoryTables(input.db),
    () => snapshot(input.db, input.authenticatedPubkey, input.productCoordinate)
  )
  authority.check()
  if (digest(current) !== saved.snapshotKey) {
    if (attempt >= 3)
      throw new Error(
        "Stock changed during checkpointing; retry the saved work"
      )
    return publishCheckpoint(input, attempt + 1)
  }
  return clone(product!.organizerStockCheckpoint!)
}

/** Positive exact self-copy + projections restore one existing inventory owner. */
export async function restoreMerchantOrganizerStockCheckpoint(
  input: CheckpointSession & {
    authorization: ProtectedReadAuthorization
    store: CommerceInboxStore
    envelope: SignedPublicNostrEvent
    signedProductEvent: SignedPublicNostrEvent
    signedAssignmentEvents: readonly SignedPublicNostrEvent[]
  }
) {
  input = {
    ...input,
    envelope: clone(input.envelope),
    signedProductEvent: clone(input.signedProductEvent),
    signedAssignmentEvents: clone([...input.signedAssignmentEvents]),
  }
  const authority = session(input)
  const check = () => {
    authority.check()
    assertProtectedReadAuthorization(
      input.authorization,
      input.authenticatedPubkey
    )
    input.store.assertCurrent()
    if (
      input.authorization.signer !== input.signer ||
      input.store.principal !== input.authenticatedPubkey ||
      input.store.database !== input.db
    )
      fail()
  }
  await authority.authenticate()
  check()
  const retained = await observeMerchantOrganizerStockCheckpoint(input)
  check()
  const { rumor, payload } = retained
  if (
    retained.observation.sequence !== payload.sequence ||
    retained.observation.rumorId !== rumor.id
  )
    fail()
  const state = payload.snapshot
  if (
    !sameSigned(input.signedProductEvent, state.product.signedProductEvent) ||
    input.signedAssignmentEvents.length !== state.assignments.length ||
    state.assignments.some(
      (assignment) =>
        !input.signedAssignmentEvents.some((event) =>
          sameSigned(event, assignment.signedAssignmentEvent!)
        )
    )
  )
    fail()
  // A Merchant self checkpoint binds authenticated imported history; re-open
  // original grants and organizer evidence rather than trusting serialized rows.
  for (const { pool } of state.pools) {
    const grant = completePrivateMessageEvent(
      await unwrapPrivateMessageEnvelope(pool.grantWraps!.self, input.signer)
    )
    check()
    if (!sameOrganizerStockRumor(grant, pool.grantRumor)) fail()
    if (pool.closingRumor) {
      const close = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(
          pool.receivedClosingEnvelope!,
          input.signer
        )
      )
      check()
      if (!sameOrganizerStockRumor(close, pool.closingRumor)) fail()
    }
  }
  for (const entry of state.entries) {
    const accepted = completePrivateMessageEvent(
      await unwrapPrivateMessageEnvelope(entry.receivedEnvelope!, input.signer)
    )
    check()
    if (!sameOrganizerStockRumor(accepted, entry.rumor)) fail()
    if (entry.handout) {
      const envelope =
        entry.handout.receivedEnvelope ?? entry.handout.wraps?.recipient
      if (!envelope) fail()
      const handout = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(envelope, input.signer)
      )
      check()
      if (
        !sameOrganizerStockRumor(handout, entry.handout.rumor) ||
        parseEventMarketStockAuthorityRumor(handout).type !== "handed_out"
      )
        fail()
    }
  }
  return input.db.transaction("rw", inventoryTables(input.db), async () => {
    check()
    const observation = await input.db.commerceInboxDeliveries.get(
      retained.row!.id
    )
    if (!observation || !sameCipher(observation.value, retained.row!.value))
      fail()
    const before = await input.db.merchantInventoryProducts.get(
      state.product.coordinate
    )
    const prior = before?.organizerStockCheckpoint
    if (
      prior &&
      (prior.sequence > payload.sequence ||
        (prior.sequence === payload.sequence && prior.rumor.id !== rumor.id) ||
        (prior.sequence + 1 === payload.sequence &&
          payload.previousId !== prior.rumor.id))
    )
      fail()
    // Retained later public observations or local decisions prevent rollback.
    const markets = [
      ...new Set(
        state.assignments.map((assignment) => assignment.marketCoordinate)
      ),
    ]
    const known = markets.length
      ? await input.db.eventMarketRosterEvidence
          .where("marketCoordinate")
          .anyOf(markets)
          .limit(2_049)
          .toArray()
      : []
    if (known.length > 2_048) fail()
    const cached = await input.db.products.get(state.product.coordinate)
    if (
      cached?.signedProductEvent &&
      isValidSignedPublicNostrEvent(cached.signedProductEvent)
    )
      known.push({
        id: cached.signedProductEvent.id,
        marketCoordinate: "",
        signedEvent: cached.signedProductEvent,
        cachedAt: cached.cachedAt,
      })
    for (const event of [
      input.signedProductEvent,
      ...input.signedAssignmentEvents,
    ]) {
      if (
        known.some(
          (row) =>
            coordinate(row.signedEvent) === coordinate(event) &&
            (row.signedEvent.created_at > event.created_at ||
              (row.signedEvent.created_at === event.created_at &&
                row.signedEvent.id !== event.id))
        )
      )
        fail()
    }
    if (before) {
      if (
        !prior ||
        digest(
          await snapshot(
            input.db,
            input.authenticatedPubkey,
            state.product.coordinate
          )
        ) !== prior.snapshotKey
      )
        fail()
      if (prior.rumor.id === rumor.id)
        return { product: before, replayed: true }
      if (
        prior.sequence + 1 !== payload.sequence ||
        payload.previousId !== prior.rumor.id
      )
        fail()
    }
    const assignments = await input.db.merchantInventoryAssignments
      .where("productCoordinate")
      .equals(state.product.coordinate)
      .toArray()
    if (
      assignments.some(
        (row) =>
          !state.assignments.some(
            (saved) =>
              row.coordinate === saved.coordinate &&
              row.revision <= saved.revision &&
              (!row.organizerStockHold ||
                (row.organizerStockHold.poolId ===
                  saved.organizerStockHold?.poolId &&
                  row.organizerStockHold.importedQuantity <=
                    saved.organizerStockHold.importedQuantity &&
                  (!row.organizerStockHold.closed ||
                    saved.organizerStockHold.closed)))
          )
      )
    )
      fail()
    const pools = await input.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(input.authenticatedPubkey)
      .filter((pool) => pool.productCoordinate === state.product.coordinate)
      .toArray()
    if (
      pools.some(
        (pool) =>
          !state.pools.some(
            ({ pool: saved }) =>
              saved.poolId === pool.poolId &&
              pool.acceptedSequence <= saved.acceptedSequence &&
              pool.importedSequence <= saved.importedSequence &&
              (pool.acceptedSequence !== saved.acceptedSequence ||
                pool.lastAcceptedId === saved.lastAcceptedId) &&
              (pool.importedSequence !== saved.importedSequence ||
                pool.lastImportedId === saved.lastImportedId) &&
              (!pool.closingRumor ||
                (saved.closingRumor &&
                  sameOrganizerStockRumor(
                    pool.closingRumor,
                    saved.closingRumor
                  )))
          )
      )
    )
      fail()
    const existingEntries = await input.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(input.authenticatedPubkey)
      .filter((entry) => pools.some((pool) => pool.poolId === entry.poolId))
      .toArray()
    if (
      existingEntries.some(
        (entry) =>
          !state.entries.some(
            (saved) =>
              saved.id === entry.id &&
              sameOrganizerStockRumor(saved.rumor, entry.rumor) &&
              (!entry.imported || saved.imported) &&
              (!entry.handout ||
                (saved.handout &&
                  sameOrganizerStockRumor(
                    entry.handout.rumor,
                    saved.handout.rumor
                  )))
          )
      )
    )
      fail()
    for (const order of state.orders) {
      const existing = await input.db.merchantInventoryAcceptedOrders.get(
        order.orderId
      )
      if (existing && !exact(existing, order)) fail()
      await input.db.merchantInventoryAcceptedOrders.put(clone(order))
    }
    await input.db.merchantInventoryAssignments.bulkPut(
      state.assignments.map((row) => ({
        ...clone(row),
        publicationJobs: [
          {
            id: `${rumor.id}:assignment:${row.coordinate}`,
            revision: row.revision,
            createdAt: rumor.created_at * 1000,
            state: "signed" as const,
            signedEvent: clone(row.signedAssignmentEvent!),
          },
        ],
      }))
    )
    await input.db.eventMarketOrganizerStockPools.bulkPut(
      state.pools.map(({ pool }) => clone(pool))
    )
    await input.db.eventMarketOrganizerStockEntries.bulkPut(
      clone(state.entries)
    )
    const product: MerchantInventoryProduct = {
      ...clone(state.product),
      publicationJobs: [
        {
          id: `${rumor.id}:product:${state.product.coordinate}`,
          revision: state.product.revision,
          createdAt: rumor.created_at * 1000,
          state: "signed",
          signedEvent: clone(state.product.signedProductEvent),
        },
      ],
      organizerStockCheckpoint: {
        sequence: payload.sequence,
        previousId: payload.previousId,
        snapshotKey: payload.snapshotKey,
        rumor,
        selfEnvelope: clone(input.envelope),
        acknowledgedRelayUrls: retained.sources,
      },
    }
    await input.db.merchantInventoryProducts.put(product)
    for (const event of [
      ...input.signedAssignmentEvents,
      ...state.pools.map((pool) => pool.initialCommitment),
    ]) {
      const parsed = parseEventMarketAssignmentEvent(event)
      if (!parsed) fail()
      await input.db.eventMarketRosterEvidence.put({
        id: `${parsed.marketCoordinate}:${event.id}`,
        marketCoordinate: parsed.marketCoordinate,
        signedEvent: event,
        cachedAt: Date.now(),
      })
    }
    check()
    return { product, replayed: false }
  })
}
