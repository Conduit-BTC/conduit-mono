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
import {
  merchantAcceptanceStore,
  merchantAcceptanceForPrivateTransport,
  protectMerchantAcceptanceRecord,
  protectMerchantAcceptanceHistory,
  sealMerchantStockCheckpoint,
  merchantStockCheckpointKey,
  merchantPrivateStorageJSON,
} from "./merchant-acceptance-privacy"
import type { AccountSigner } from "./nostr-event-signer"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import {
  assertPrivateMessageFitsTransport,
  completePrivateMessageEvent,
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
  type PrivateMessageRumor,
  type PrivateMessageWrappingOperation,
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
const MAX_CATCH_UP_WRAPPERS = 512
const MAX_CATCH_UP_BYTES = 4 * 1024 * 1024
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
  merchantPrivateStorageJSON(a) === merchantPrivateStorageJSON(b)
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
type StoredCheckpoint = NonNullable<
  MerchantInventoryProduct["organizerStockCheckpoint"]
>
type OpenCheckpoint = StoredCheckpoint & { rumor: PrivateMessageRumor }
const checkpointId = (checkpoint: StoredCheckpoint) => {
  const id = checkpoint.rumorId ?? checkpoint.rumor?.id
  if (!id) fail()
  return id
}

/** Device ciphertext is never transported as portable recovery authority. */
export async function openMerchantOrganizerStockCheckpoint(input: {
  db: ConduitDB
  authenticatedPubkey: string
  productCoordinate: string
  checkpoint: StoredCheckpoint
}): Promise<OpenCheckpoint> {
  const store = merchantAcceptanceStore(input.authenticatedPubkey, input.db)
  let saved = input.checkpoint
  if (saved.rumor) {
    await protectMerchantAcceptanceHistory(store)
    const repaired = (
      await input.db.merchantInventoryProducts.get(input.productCoordinate)
    )?.organizerStockCheckpoint
    if (!repaired || checkpointId(repaired) !== checkpointId(saved)) fail()
    saved = repaired
  }
  const rumor = saved.sealedRumor
    ? await store.open<PrivateMessageRumor>(
        saved.sealedRumor,
        merchantStockCheckpointKey(checkpointId(saved))
      )
    : clone(saved.rumor)
  if (!rumor || rumor.id !== checkpointId(saved)) fail()
  const payload = parseEventMarketStockCheckpointRumor(rumor)
  if (
    payload.merchantPubkey !== store.principal ||
    payload.snapshot.product.coordinate !== input.productCoordinate ||
    payload.snapshotKey !== saved.snapshotKey ||
    payload.sequence !== saved.sequence ||
    payload.previousId !== saved.previousId
  )
    fail()
  store.assertCurrent()
  return { ...clone(saved), rumor }
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
type ObservedCheckpointInput = CheckpointSession & {
  authorization: ProtectedReadAuthorization
  store: CommerceInboxStore
  envelope: SignedPublicNostrEvent
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
  input: ObservedCheckpointInput
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

/** Select positive retained ancestry without installing an intermediate snapshot. */
export async function readMerchantStockCheckpointPredecessors(
  input: ObservedCheckpointInput
): Promise<SignedPublicNostrEvent[]> {
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
      input.store.database !== input.db ||
      input.store.principal !== input.authenticatedPubkey
    )
      fail()
  }
  await authority.authenticate()
  check()
  const target = await observeMerchantOrganizerStockCheckpoint(input)
  check()
  if (target.observation.rumorId !== target.rumor.id) fail()
  const productCoordinate = target.payload.snapshot.product.coordinate
  const prior = (
    await input.db.merchantInventoryProducts.get(productCoordinate)
  )?.organizerStockCheckpoint
  check()
  if (!prior || target.payload.sequence <= prior.sequence + 1) return []
  if (target.payload.sequence - prior.sequence > MAX_ROWS) fail()
  const candidates = new Map<
    string,
    {
      envelope: SignedPublicNostrEvent
      rumor: PrivateMessageRumor
      payload: EventMarketStockCheckpointPayload
    }
  >()
  const sequences = new Map<number, string>([
    [prior.sequence, checkpointId(prior)],
  ])
  const progress: { afterId?: string; count: number; bytes: number } = {
    count: 0,
    bytes: 0,
  }
  while (true) {
    const page = await input.store.wrappersPage({
      afterId: progress.afterId,
      limit: 128,
    })
    check()
    for (const row of page.rows) {
      if (++progress.count > MAX_CATCH_UP_WRAPPERS) fail()
      progress.bytes += new TextEncoder().encode(
        JSON.stringify(row.event)
      ).length
      if (progress.bytes > MAX_CATCH_UP_BYTES) fail()
      if (
        !row.sources.length ||
        ["deleted", "expired", "invalid_envelope"].includes(row.state) ||
        row.event.id === input.envelope.id
      )
        continue
      let candidate: {
        rumor: PrivateMessageRumor
        payload: EventMarketStockCheckpointPayload
      }
      try {
        const rumor = completePrivateMessageEvent(
          await unwrapPrivateMessageEnvelope(row.event, input.signer)
        )
        check()
        if (!isEventMarketStockCheckpointRumor(rumor)) continue
        candidate = {
          rumor,
          payload: parseEventMarketStockCheckpointRumor(rumor),
        }
      } catch {
        check()
        // Unrelated or unusable inbox packets cannot supply a predecessor.
        continue
      }
      const { rumor, payload } = candidate
      if (
        payload.merchantPubkey !== input.authenticatedPubkey ||
        payload.snapshot.product.coordinate !== productCoordinate ||
        payload.sequence < prior.sequence
      )
        continue
      if (payload.sequence >= target.payload.sequence) {
        await observeMerchantOrganizerStockCheckpoint({
          ...input,
          envelope: row.event,
        })
        check()
        if (rumor.id !== target.rumor.id) fail()
        continue
      }
      const known = sequences.get(payload.sequence)
      if (known && known !== rumor.id) fail()
      sequences.set(payload.sequence, rumor.id)
      candidates.set(rumor.id, { ...candidate, envelope: clone(row.event) })
    }
    if (!page.hasMore) break
    if (!page.rows.length || progress.count >= MAX_CATCH_UP_WRAPPERS) fail()
    progress.afterId = page.rows.at(-1)!.id
  }
  const result: SignedPublicNostrEvent[] = []
  const next = {
    sequence: target.payload.sequence,
    previousId: target.payload.previousId,
  }
  while (next.sequence > prior.sequence + 1) {
    const predecessor = next.previousId && candidates.get(next.previousId)
    if (!predecessor || predecessor.payload.sequence !== next.sequence - 1)
      fail()
    result.push(predecessor.envelope)
    next.sequence = predecessor.payload.sequence
    next.previousId = predecessor.payload.previousId
  }
  if (next.previousId !== checkpointId(prior)) fail()
  check()
  return result.reverse()
}

async function authenticateCheckpointPredecessor(
  input: ObservedCheckpointInput,
  envelope: SignedPublicNostrEvent,
  check: () => void
) {
  const row = await input.db.commerceInboxWrappers.get(
    input.store.key(envelope.id)
  )
  check()
  if (
    !row?.sources.length ||
    row.accountPubkey !== input.authenticatedPubkey ||
    !exact(row.event, envelope) ||
    ["deleted", "expired", "invalid_envelope"].includes(row.state)
  )
    fail()
  const rumor = completePrivateMessageEvent(
    await unwrapPrivateMessageEnvelope(envelope, input.signer)
  )
  check()
  const payload = parseEventMarketStockCheckpointRumor(rumor)
  if (payload.merchantPubkey !== input.authenticatedPubkey) fail()
  return { rumor, payload, row }
}

function preservesSignedFrontier(
  next: SignedPublicNostrEvent,
  before: SignedPublicNostrEvent
) {
  return (
    next.created_at > before.created_at ||
    (next.created_at === before.created_at && next.id === before.id)
  )
}

function preservesCheckpointHistory(
  next: StockSnapshot,
  before: StockSnapshot
) {
  return (
    preservesFrontiers(next, before) &&
    preservesSignedFrontier(
      next.product.signedProductEvent,
      before.product.signedProductEvent
    ) &&
    next.product.revision >= before.product.revision &&
    (next.product.revision !== before.product.revision ||
      sameSigned(
        next.product.signedProductEvent,
        before.product.signedProductEvent
      )) &&
    before.assignments.every((row) =>
      next.assignments.some(
        (saved) =>
          saved.coordinate === row.coordinate &&
          row.revision <= saved.revision &&
          preservesSignedFrontier(
            saved.signedAssignmentEvent!,
            row.signedAssignmentEvent!
          ) &&
          (row.revision !== saved.revision ||
            sameSigned(
              row.signedAssignmentEvent!,
              saved.signedAssignmentEvent!
            )) &&
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
    snapshot.orders.some(
      (order) =>
        order.evidenceFormat !== undefined ||
        order.evidenceBinding !== undefined
    ) ||
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

async function readSnapshot(
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
  return result
}

/** Read one atomic DB view, then decrypt outside Dexie's transaction lifetime. */
async function captureSnapshot(
  db: ConduitDB,
  merchant: string,
  address: string
) {
  const store = merchantAcceptanceStore(merchant, db)
  const raw = await db.transaction("r", inventoryTables(db), () =>
    readSnapshot(db, merchant, address)
  )
  const portable = clone(raw)
  const originals = new Map<string, string>()
  portable.orders = await Promise.all(
    raw.orders.map(async (accepted) => {
      const wire = await merchantAcceptanceForPrivateTransport(accepted, store)
      orderSchema.parse(JSON.parse(wire.evidence))
      originals.set(accepted.orderId, wire.evidence)
      return wire
    })
  )
  portable.entries = raw.entries.map((entry) => {
    if (!entry.imported) return clone(entry)
    const accepted = raw.orders.find((order) => order.orderId === entry.orderId)
    const evidence = originals.get(entry.orderId)
    if (!accepted || !evidence || entry.evidence !== accepted.evidenceBinding)
      fail()
    return { ...clone(entry), evidence }
  })
  validateSnapshot(portable, merchant)
  store.assertCurrent()
  return { snapshot: portable, rawKey: digest(raw) }
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
export type MerchantStockCheckpointPhase =
  "snapshot" | "wrapping" | "delivery_ack" | "freshness"
export type MerchantStockCheckpointWrappingOperation =
  PrivateMessageWrappingOperation | "checkpoint_retention"

type PublishCheckpointInput = CheckpointSession & {
  productCoordinate: string
  delivery?: MerchantStockCheckpointDelivery
  /** Transient observation only; never part of a checkpoint or its authority. */
  onPhase?: (phase: MerchantStockCheckpointPhase) => void
  onWrappingOperation?: (
    operation: MerchantStockCheckpointWrappingOperation
  ) => void
}

function observeCheckpointPhase(
  input: PublishCheckpointInput,
  phase: MerchantStockCheckpointPhase
): void {
  try {
    void Promise.resolve(input.onPhase?.(phase)).catch(() => {})
  } catch {
    // An observer cannot change the original checkpoint result.
  }
}
function observeCheckpointWrappingOperation(
  input: PublishCheckpointInput,
  operation: MerchantStockCheckpointWrappingOperation
): void {
  try {
    void Promise.resolve(input.onWrappingOperation?.(operation)).catch(() => {})
  } catch {
    // An observer cannot change the original checkpoint result.
  }
}
export function publishMerchantOrganizerStockCheckpoint(
  input: PublishCheckpointInput
) {
  return publishCheckpoint(input, 0)
}
async function publishCheckpoint(
  input: PublishCheckpointInput,
  attempt: number
): Promise<OpenCheckpoint> {
  input = {
    ...input,
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  observeCheckpointPhase(input, "snapshot")
  const authority = session(input)
  await authority.authenticate()
  const store = merchantAcceptanceStore(input.authenticatedPubkey, input.db)
  if (store.authorization.signer !== input.signer) fail()
  if (
    input.delivery?.deliveryStore &&
    (input.delivery.deliveryStore.database !== input.db ||
      input.delivery.deliveryStore.principal !== input.authenticatedPubkey ||
      input.delivery.deliveryStore.authorization.signer !== input.signer)
  )
    fail()
  await protectMerchantAcceptanceHistory(store)
  let product = await input.db.merchantInventoryProducts.get(
    input.productCoordinate
  )
  if (!product) fail()
  let saved = product.organizerStockCheckpoint
  // An interrupted older checkpoint is delivered byte-for-byte before advancing.
  if (!saved || saved.acknowledgedRelayUrls.length) {
    const captured = await captureSnapshot(
      input.db,
      input.authenticatedPubkey,
      input.productCoordinate
    )
    const current = captured.snapshot
    authority.check()
    const snapshotKey = digest(current)
    if (saved?.snapshotKey === snapshotKey)
      return openMerchantOrganizerStockCheckpoint({
        ...input,
        checkpoint: saved,
      })
    const payload: EventMarketStockCheckpointPayload = {
      version: 1,
      type: "merchant_checkpoint",
      merchantPubkey: input.authenticatedPubkey,
      sequence: (saved?.sequence ?? 0) + 1,
      previousId: saved ? checkpointId(saved) : null,
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
    const protectedCheckpoint = await sealMerchantStockCheckpoint(store, {
      sequence: payload.sequence,
      previousId: payload.previousId,
      snapshotKey,
      rumor,
      acknowledgedRelayUrls: [],
    })
    authority.check()
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
            await readSnapshot(
              input.db,
              input.authenticatedPubkey,
              input.productCoordinate
            )
          ) !== captured.rawKey
        )
          fail()
        row.organizerStockCheckpoint = protectedCheckpoint
        await input.db.merchantInventoryProducts.put(row)
        authority.check()
        return row.organizerStockCheckpoint
      }
    )
  }
  if (!saved.selfEnvelope) {
    const opened = await openMerchantOrganizerStockCheckpoint({
      ...input,
      checkpoint: saved,
    })
    observeCheckpointPhase(input, "wrapping")
    const selfEnvelope = await wrapPrivateMessage(
      opened.rumor,
      { pubkey: input.authenticatedPubkey },
      input.signer,
      {
        onOperation: (operation) =>
          observeCheckpointWrappingOperation(input, operation),
      }
    )
    observeCheckpointWrappingOperation(input, "checkpoint_retention")
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
          checkpointId(row.organizerStockCheckpoint) !== checkpointId(saved!)
        )
          fail()
        row.organizerStockCheckpoint.selfEnvelope ??= selfEnvelope
        await input.db.merchantInventoryProducts.put(row)
        authority.check()
        return row.organizerStockCheckpoint
      }
    )
  }
  observeCheckpointPhase(input, "delivery_ack")
  const result = await retryPrivateMessageWraps({
    ...input.delivery,
    deliveryStore: input.delivery?.deliveryStore ?? store,
    rumorId: checkpointId(saved),
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
        checkpointId(product.organizerStockCheckpoint) !== checkpointId(saved!)
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
  observeCheckpointPhase(input, "freshness")
  const current = (
    await captureSnapshot(
      input.db,
      input.authenticatedPubkey,
      input.productCoordinate
    )
  ).snapshot
  authority.check()
  if (digest(current) !== saved.snapshotKey) {
    if (attempt >= 3)
      throw new Error(
        "Stock changed during checkpointing; retry the saved work"
      )
    return publishCheckpoint(input, attempt + 1)
  }
  return openMerchantOrganizerStockCheckpoint({
    ...input,
    checkpoint: product!.organizerStockCheckpoint!,
  })
}

/** Positive exact self-copy + projections restore one existing inventory owner. */
export async function restoreMerchantOrganizerStockCheckpoint(
  input: ObservedCheckpointInput & {
    signedProductEvent: SignedPublicNostrEvent
    signedAssignmentEvents: readonly SignedPublicNostrEvent[]
    /** Positive retained ancestry only; a gap without every exact link rejects. */
    predecessorEnvelopes?: readonly SignedPublicNostrEvent[]
  }
) {
  input = {
    ...input,
    envelope: clone(input.envelope),
    signedProductEvent: clone(input.signedProductEvent),
    signedAssignmentEvents: clone([...input.signedAssignmentEvents]),
    predecessorEnvelopes: input.predecessorEnvelopes
      ? clone([...input.predecessorEnvelopes])
      : undefined,
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
  await protectMerchantAcceptanceHistory(input.store)
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
  // Portable checkpoint rows retain their original canonical terms. Device
  // encryption must be renewed here, never copied from the source device.
  const localOrders = new Map<string, MerchantInventoryAcceptedOrder>()
  for (const order of state.orders) {
    orderSchema.parse(JSON.parse(order.evidence))
    localOrders.set(
      order.orderId,
      await protectMerchantAcceptanceRecord(input.store, order)
    )
    check()
  }
  const localEntries = state.entries.map((entry) => ({
    ...clone(entry),
    evidence: entry.imported
      ? localOrders.get(entry.orderId)!.evidenceBinding!
      : entry.evidence,
  }))
  const protectedCheckpoint = await sealMerchantStockCheckpoint(input.store, {
    sequence: payload.sequence,
    previousId: payload.previousId,
    snapshotKey: payload.snapshotKey,
    rumor,
    selfEnvelope: clone(input.envelope),
    acknowledgedRelayUrls: retained.sources,
  })
  check()
  const beforeProduct = await input.db.merchantInventoryProducts.get(
    state.product.coordinate
  )
  const beforeCapture = beforeProduct
    ? await captureSnapshot(
        input.db,
        input.authenticatedPubkey,
        state.product.coordinate
      )
    : undefined
  check()
  const ancestryBase = beforeProduct?.organizerStockCheckpoint
  const checkedPredecessors: { id: string; event: SignedPublicNostrEvent }[] =
    []
  const gap = ancestryBase && payload.sequence > ancestryBase.sequence + 1
  if ((input.predecessorEnvelopes?.length ?? 0) > MAX_ROWS) fail()
  if (gap) {
    if (
      !input.predecessorEnvelopes?.length ||
      !beforeCapture ||
      payload.sequence - ancestryBase.sequence > MAX_ROWS
    )
      fail()
    const previous = {
      sequence: ancestryBase.sequence,
      rumorId: checkpointId(ancestryBase),
      snapshot: beforeCapture.snapshot,
    }
    for (const envelope of input.predecessorEnvelopes) {
      const predecessor = await authenticateCheckpointPredecessor(
        input,
        envelope,
        check
      )
      if (
        predecessor.payload.sequence !== previous.sequence + 1 ||
        predecessor.payload.previousId !== previous.rumorId ||
        !preservesCheckpointHistory(
          predecessor.payload.snapshot,
          previous.snapshot
        )
      )
        fail()
      checkedPredecessors.push({
        id: predecessor.row.id,
        event: clone(envelope),
      })
      previous.sequence = predecessor.payload.sequence
      previous.rumorId = predecessor.rumor.id
      previous.snapshot = predecessor.payload.snapshot
    }
    if (
      payload.sequence !== previous.sequence + 1 ||
      payload.previousId !== previous.rumorId ||
      !preservesCheckpointHistory(state, previous.snapshot)
    )
      fail()
  } else if (input.predecessorEnvelopes?.length) fail()
  check()
  const tables = [...inventoryTables(input.db), input.db.commerceInboxWrappers]
  return input.db.transaction("rw", tables, async () => {
    check()
    for (const predecessor of checkedPredecessors) {
      const row = await input.db.commerceInboxWrappers.get(predecessor.id)
      if (
        !row?.sources.length ||
        row.accountPubkey !== input.authenticatedPubkey ||
        !exact(row.event, predecessor.event) ||
        ["deleted", "expired", "invalid_envelope"].includes(row.state)
      )
        fail()
    }
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
        (prior.sequence === payload.sequence &&
          checkpointId(prior) !== rumor.id) ||
        (prior.sequence + 1 === payload.sequence &&
          payload.previousId !== checkpointId(prior)))
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
    if (Boolean(before) !== Boolean(beforeCapture)) fail()
    if (before) {
      if (
        !prior ||
        digest(beforeCapture!.snapshot) !== prior.snapshotKey ||
        digest(
          await readSnapshot(
            input.db,
            input.authenticatedPubkey,
            state.product.coordinate
          )
        ) !== beforeCapture!.rawKey
      )
        fail()
      if (checkpointId(prior) === rumor.id)
        return { product: before, replayed: true }
      if (
        gap
          ? !exact(prior, ancestryBase)
          : prior.sequence + 1 !== payload.sequence ||
            payload.previousId !== checkpointId(prior)
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
      if (
        existing &&
        !exact(
          beforeCapture?.snapshot.orders.find(
            (saved) => saved.orderId === order.orderId
          ),
          order
        )
      )
        fail()
      await input.db.merchantInventoryAcceptedOrders.put(
        existing ?? localOrders.get(order.orderId)!
      )
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
    await input.db.eventMarketOrganizerStockEntries.bulkPut(localEntries)
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
      organizerStockCheckpoint: protectedCheckpoint,
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
