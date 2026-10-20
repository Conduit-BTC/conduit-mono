import { getEventHash } from "nostr-tools"
import type {
  ConduitDB,
  EventMarketOrganizerStockEntry,
  EventMarketOrganizerStockPool,
  EventMarketOrganizerStockWriter,
} from "../db"
import type { AccountSigner } from "./nostr-event-signer"
import type { CommerceInboxStore } from "./commerce-inbox-store"
import { parseAddressableCoordinate } from "./event-market"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import { createEventMarketEvidenceStore } from "./event-market-evidence-store"
import { parseEventMarketStockAuthorityRumor } from "./event-market-stock-authority"
import { sameOrganizerStockRumor } from "./event-market-stock-import-authority"
import { validateOrganizerStockJournalPool } from "./event-market-stock-journal"
import { organizerStockWriterKey } from "./event-market-stock-writer-guard"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import {
  completePrivateMessageEvent,
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import {
  isValidNostrPublicKey,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  assembleStockWriterPackets,
  buildStockWriterPackets,
  MAX_STOCK_WRITER_SNAPSHOT_BYTES,
  MAX_STOCK_WRITER_SNAPSHOT_ROWS,
  parseStockWriterPacket,
} from "./event-market-stock-writer-packets"

/** Conduit-private cooperative device handover, not a lock or public registry. */
export const EVENT_MARKET_STOCK_WRITER_HANDOVER_SUBJECT =
  "conduit-event-stock-handover"
const MARKER = ["conduit", "event-stock-handover", "1"]
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const MAX_ROWS = MAX_STOCK_WRITER_SNAPSHOT_ROWS
const MAX_BYTES = MAX_STOCK_WRITER_SNAPSHOT_BYTES
const clone = <T>(value: T): T => structuredClone(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const bounded = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0
const exactKeys = (value: object, keys: readonly string[]) =>
  same(Object.keys(value).sort(), [...keys].sort())

export interface OrganizerStockWriterHandoverPayload {
  version: 1
  type: "writer_handover"
  organizerPubkey: string
  marketCoordinate: string
  writerId: string
  sourceDeviceId: string
  targetDeviceId: string
  generation: number
  previousTransferId: string | null
  transferredAtMs: number
  snapshot: {
    pools: EventMarketOrganizerStockPool[]
    entries: EventMarketOrganizerStockEntry[]
    commitments: SignedPublicNostrEvent[]
  }
}
type Session = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}
type Delivery = Pick<
  Parameters<typeof retryPrivateMessageWraps>[0],
  | "deliveryStore"
  | "publishFn"
  | "resolveInboxRelays"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
>

function fail(): never {
  throw new Error("The complete stock-writer handover needs reconciliation.")
}
function session(input: Session) {
  const { revision, authMethod } = input.signer
  const check = () => {
    if (
      !input.shouldContinue() ||
      !revision ||
      !authMethod ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== authMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44 ||
      !input.signer.capabilities.signEvent
    )
      throw new Error("Stock-writer handover session changed.")
  }
  return {
    check,
    async authenticate() {
      check()
      if ((await input.signer.getPublicKey()) !== input.authenticatedPubkey)
        fail()
      check()
    },
  }
}
function tables(db: ConduitDB) {
  return [
    db.eventMarketOrganizerStockWriters,
    db.eventMarketOrganizerStockPools,
    db.eventMarketOrganizerStockEntries,
  ]
}
async function cohort(
  db: ConduitDB,
  account: string,
  market: string,
  writer: string
) {
  const retained = await db.eventMarketOrganizerStockPools
    .where("accountPubkey")
    .equals(account)
    .toArray()
  const pools = retained
    .filter((pool) => {
      const grant = validateOrganizerStockJournalPool(pool)
      if (
        grant.marketCoordinate === market &&
        pool.writerId !== writer &&
        (pool.state !== "closed" || !pool.readOnlyRecovery)
      )
        fail()
      return grant.marketCoordinate === market && pool.writerId === writer
    })
    .sort((a, b) => a.poolId.localeCompare(b.poolId))
  const ids = new Set(pools.map((pool) => pool.poolId))
  const allEntries = await db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(account)
    .toArray()
  if (
    allEntries.some(
      (entry) => !retained.some((pool) => pool.poolId === entry.poolId)
    )
  )
    fail()
  const registration = await db.eventMarketOrganizerStockWriters.get(
    organizerStockWriterKey(account, market)
  )
  if (
    registration?.writerId === writer &&
    (!Array.isArray(registration.installedPoolIds) ||
      !same([...registration.installedPoolIds].sort(), [...ids].sort()))
  )
    fail()
  const entries = allEntries
    .filter((entry) => ids.has(entry.poolId))
    .sort((a, b) => a.poolId.localeCompare(b.poolId) || a.sequence - b.sequence)
  return { pools, entries }
}

type StockWriterSnapshotView = Pick<
  OrganizerStockWriterHandoverPayload,
  | "organizerPubkey"
  | "marketCoordinate"
  | "writerId"
  | "transferredAtMs"
  | "snapshot"
>

function validateSnapshot(payload: StockWriterSnapshotView): void {
  const { pools, entries, commitments } = payload.snapshot
  if (
    ![pools, entries, commitments].every(
      (rows) => Array.isArray(rows) && rows.length <= MAX_ROWS
    ) ||
    !pools.length ||
    new Set(pools.map((pool) => pool.poolId)).size !== pools.length ||
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    new Set(commitments.map((event) => event.id)).size !== commitments.length
  )
    fail()
  for (const pool of pools) {
    const grant = validateOrganizerStockJournalPool(pool)
    if (
      pool.accountPubkey !== payload.organizerPubkey ||
      pool.organizerPubkey !== payload.organizerPubkey ||
      pool.writerId !== payload.writerId ||
      grant.marketCoordinate !== payload.marketCoordinate ||
      pool.readOnlyRecovery ||
      !pool.receivedEnvelope ||
      !isValidSignedPublicNostrEvent(pool.receivedEnvelope)
    )
      fail()
    const committed = commitments
      .map(parseEventMarketAssignmentEvent)
      .find(
        (assignment) =>
          assignment &&
          assignment.coordinate === grant.assignmentCoordinate &&
          assignment.previousEventId === grant.assignmentEventId &&
          assignment.stockPool.state === "valid" &&
          assignment.stockPool.pool.state === "active" &&
          assignment.stockPool.pool.poolId === pool.poolId &&
          assignment.stockPool.pool.quantity === pool.quantity &&
          assignment.stockPool.pool.importedQuantity === 0 &&
          assignment.stockPool.pool.organizerPubkey === payload.organizerPubkey
      )
    if (!committed) fail()
    const chain = entries.filter((entry) => entry.poolId === pool.poolId)
    let previous = pool.poolId,
      quantity = 0,
      priorTime = pool.grantRumor.created_at * 1000
    if (chain.length !== pool.acceptedSequence) fail()
    for (const [index, entry] of chain.entries()) {
      const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
      if (
        accepted.type !== "accepted" ||
        entry.id !== `${payload.organizerPubkey}:${entry.rumor.id}` ||
        entry.accountPubkey !== payload.organizerPubkey ||
        entry.sequence !== index + 1 ||
        accepted.sequence !== entry.sequence ||
        accepted.previousId !== previous ||
        accepted.poolId !== pool.poolId ||
        accepted.merchantPubkey !== pool.merchantPubkey ||
        accepted.organizerPubkey !== payload.organizerPubkey ||
        accepted.writerId !== payload.writerId ||
        accepted.orderId !== entry.orderId ||
        accepted.claimRef !== entry.claimRef ||
        accepted.quantity !== entry.quantity ||
        accepted.acceptedAtMs < priorTime ||
        accepted.acceptedAtMs >= grant.expiresAtMs ||
        accepted.acceptedAtMs > payload.transferredAtMs ||
        !entry.evidence ||
        !entry.orderPoolBinding
      )
        fail()
      previous = entry.rumor.id
      quantity += entry.quantity
      priorTime = accepted.acceptedAtMs
    }
    if (previous !== pool.lastAcceptedId || quantity !== pool.acceptedQuantity)
      fail()
    if (pool.closingRumor) {
      const close = parseEventMarketStockAuthorityRumor(pool.closingRumor)
      if (
        close.type !== "closed" ||
        close.poolId !== pool.poolId ||
        close.writerId !== pool.writerId ||
        close.sequence !== pool.acceptedSequence ||
        close.lastAcceptedId !== pool.lastAcceptedId ||
        close.acceptedQuantity !== quantity
      )
        fail()
    } else if (pool.state === "closing" || pool.state === "closed") fail()
  }
  for (const entry of entries) {
    const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
    if (accepted.type !== "accepted") fail()
    const order = entries
      .filter((candidate) => candidate.orderId === entry.orderId)
      .sort((a, b) => a.poolId.localeCompare(b.poolId))
    const manifest = order.map((candidate) => ({
      poolId: candidate.poolId,
      writerId: payload.writerId,
      quantity: candidate.quantity,
    }))
    if (
      !pools.some((pool) => pool.poolId === entry.poolId) ||
      entry.orderPoolBinding !== JSON.stringify(manifest) ||
      order.some(
        (candidate) => candidate.orderPoolBinding !== entry.orderPoolBinding
      )
    )
      fail()
    if (
      order.some((candidate) => {
        const other = parseEventMarketStockAuthorityRumor(candidate.rumor)
        return (
          other.type !== "accepted" ||
          other.merchantPubkey !== accepted.merchantPubkey ||
          other.identityBinding !== accepted.identityBinding ||
          other.termsBinding !== accepted.termsBinding ||
          other.claimRef !== accepted.claimRef ||
          other.acceptedAtMs !== accepted.acceptedAtMs ||
          candidate.evidence !== entry.evidence
        )
      })
    )
      fail()
    if (entry.handout) {
      const handout = parseEventMarketStockAuthorityRumor(entry.handout.rumor)
      if (
        handout.type !== "handed_out" ||
        handout.organizerPubkey !== payload.organizerPubkey ||
        handout.merchantPubkey !== accepted.merchantPubkey ||
        handout.writerId !== payload.writerId ||
        handout.orderId !== accepted.orderId ||
        handout.claimRef !== accepted.claimRef ||
        handout.identityBinding !== accepted.identityBinding ||
        handout.termsBinding !== accepted.termsBinding ||
        handout.handedOutAtMs < accepted.acceptedAtMs ||
        handout.handedOutAtMs > payload.transferredAtMs ||
        !same(
          handout.entries,
          order.map((candidate) => ({
            poolId: candidate.poolId,
            acceptedId: candidate.rumor.id,
            quantity: candidate.quantity,
          }))
        ) ||
        order.some(
          (candidate) =>
            !candidate.handout ||
            !same(candidate.handout.rumor, entry.handout!.rumor)
        )
      )
        fail()
    } else if (order.some((candidate) => candidate.handout)) fail()
  }
}

export function isOrganizerStockWriterHandoverRumor(rumor: {
  tags: unknown
}): boolean {
  return (
    Array.isArray(rumor.tags) &&
    rumor.tags.some(
      (tag) =>
        Array.isArray(tag) &&
        ((tag[0] === "subject" &&
          tag[1] === EVENT_MARKET_STOCK_WRITER_HANDOVER_SUBJECT) ||
          (tag[0] === "conduit" && tag[1] === "event-stock-handover"))
    )
  )
}
export function parseOrganizerStockWriterHandoverRumor(
  rumor: PrivateMessageRumor
): OrganizerStockWriterHandoverPayload {
  if (
    rumor.kind !== 14 ||
    !isValidNostrPublicKey(rumor.pubkey) ||
    rumor.id !== getEventHash(rumor) ||
    new TextEncoder().encode(rumor.content).length > MAX_BYTES
  )
    fail()
  let payload: OrganizerStockWriterHandoverPayload
  try {
    payload = JSON.parse(rumor.content)
  } catch {
    fail()
  }
  if (
    !payload ||
    !exactKeys(payload, [
      "version",
      "type",
      "organizerPubkey",
      "marketCoordinate",
      "writerId",
      "sourceDeviceId",
      "targetDeviceId",
      "generation",
      "previousTransferId",
      "transferredAtMs",
      "snapshot",
    ]) ||
    payload.version !== 1 ||
    payload.type !== "writer_handover" ||
    payload.organizerPubkey !== rumor.pubkey ||
    parseAddressableCoordinate(payload.marketCoordinate, [30409])
      ?.authorPubkey !== payload.organizerPubkey ||
    ![payload.writerId, payload.sourceDeviceId, payload.targetDeviceId].every(
      (id) => typeof id === "string" && UUID.test(id)
    ) ||
    payload.sourceDeviceId === payload.targetDeviceId ||
    !bounded(payload.generation) ||
    payload.generation < 1 ||
    (payload.generation === 1
      ? payload.previousTransferId !== null
      : !HASH.test(payload.previousTransferId ?? "")) ||
    !bounded(payload.transferredAtMs) ||
    Math.floor(payload.transferredAtMs / 1000) !== rumor.created_at ||
    !payload.snapshot ||
    !exactKeys(payload.snapshot, ["pools", "entries", "commitments"]) ||
    !same(rumor.tags, [
      ["p", payload.organizerPubkey],
      ["subject", EVENT_MARKET_STOCK_WRITER_HANDOVER_SUBJECT],
      MARKER,
    ])
  )
    fail()
  validateSnapshot(payload)
  return clone(payload)
}
function build(
  payload: OrganizerStockWriterHandoverPayload
): PrivateMessageRumor {
  const rumor = createPrivateMessageRumor({
    pubkey: payload.organizerPubkey,
    kind: 14,
    created_at: Math.floor(payload.transferredAtMs / 1000),
    content: JSON.stringify(payload),
    tags: [
      ["p", payload.organizerPubkey],
      ["subject", EVENT_MARKET_STOCK_WRITER_HANDOVER_SUBJECT],
      MARKER,
    ],
  })
  parseOrganizerStockWriterHandoverRumor(rumor)
  return rumor
}

/** Explicit first-device or intact-v28-journal binding; never relay adoption. */
export async function registerOrganizerStockWriterDevice(
  input: Session & {
    marketCoordinate: string
    writerId: string
    deviceId: string
    expectedPoolIds: readonly string[]
  }
): Promise<EventMarketOrganizerStockWriter> {
  input = { ...input, expectedPoolIds: [...input.expectedPoolIds] }
  const auth = session(input)
  await auth.authenticate()
  if (
    ![input.writerId, input.deviceId].every((id) => UUID.test(id)) ||
    parseAddressableCoordinate(input.marketCoordinate, [30409])
      ?.authorPubkey !== input.authenticatedPubkey
  )
    fail()
  return input.db.transaction("rw", tables(input.db), async () => {
    auth.check()
    const id = organizerStockWriterKey(
      input.authenticatedPubkey,
      input.marketCoordinate
    )
    const prior = await input.db.eventMarketOrganizerStockWriters.get(id)
    if (prior) {
      if (
        prior.state !== "active" ||
        prior.writerId !== input.writerId ||
        prior.deviceId !== input.deviceId
      )
        fail()
      auth.check()
      return prior
    }
    const current = await cohort(
      input.db,
      input.authenticatedPubkey,
      input.marketCoordinate,
      input.writerId
    )
    if (
      !same(
        current.pools.map((pool) => pool.poolId).sort(),
        [...input.expectedPoolIds].sort()
      ) ||
      current.pools.some((pool) => pool.readOnlyRecovery) ||
      (!current.pools.length && input.writerId !== input.deviceId)
    )
      fail()
    const row: EventMarketOrganizerStockWriter = {
      id,
      accountPubkey: input.authenticatedPubkey,
      marketCoordinate: input.marketCoordinate,
      writerId: input.writerId,
      deviceId: input.deviceId,
      state: "active",
      installedPoolIds: current.pools.map((pool) => pool.poolId),
      generation: 0,
    }
    await input.db.eventMarketOrganizerStockWriters.add(row)
    auth.check()
    return row
  })
}

/** Explicit fresh target only. This grants no pool, writer, payment or handout. */
export async function prepareOrganizerStockWriterTarget(
  input: Session & {
    marketCoordinate: string
    targetDeviceId: string
  }
): Promise<EventMarketOrganizerStockWriter> {
  const auth = session(input)
  await auth.authenticate()
  if (
    !UUID.test(input.targetDeviceId) ||
    parseAddressableCoordinate(input.marketCoordinate, [30409])
      ?.authorPubkey !== input.authenticatedPubkey
  )
    fail()
  return input.db.transaction("rw", tables(input.db), async () => {
    auth.check()
    const id = organizerStockWriterKey(
      input.authenticatedPubkey,
      input.marketCoordinate
    )
    const prior = await input.db.eventMarketOrganizerStockWriters.get(id)
    if (prior) {
      if (prior.state !== "target" || prior.deviceId !== input.targetDeviceId)
        fail()
      auth.check()
      return prior
    }
    const existing = await input.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(input.authenticatedPubkey)
      .toArray()
    if (
      existing.some(
        (pool) =>
          validateOrganizerStockJournalPool(pool).marketCoordinate ===
            input.marketCoordinate && !pool.readOnlyRecovery
      )
    )
      fail()
    const row: EventMarketOrganizerStockWriter = {
      id,
      accountPubkey: input.authenticatedPubkey,
      marketCoordinate: input.marketCoordinate,
      deviceId: input.targetDeviceId,
      state: "target",
      installedPoolIds: [],
      generation: 0,
    }
    await input.db.eventMarketOrganizerStockWriters.add(row)
    auth.check()
    return row
  })
}

async function authenticateGrants(
  input: Session,
  payload: Pick<OrganizerStockWriterHandoverPayload, "snapshot">
) {
  const auth = session(input)
  for (const pool of payload.snapshot.pools) {
    const rumor = completePrivateMessageEvent(
      await unwrapPrivateMessageEnvelope(pool.receivedEnvelope!, input.signer)
    )
    auth.check()
    if (!sameOrganizerStockRumor(rumor, pool.grantRumor)) fail()
    const grant = parseEventMarketStockAuthorityRumor(rumor)
    if (
      grant.type !== "grant" ||
      grant.merchantPubkey !== pool.merchantPubkey ||
      grant.organizerPubkey !== input.authenticatedPubkey
    )
      fail()
  }
}

/** Verify an intact registered writer; this never repairs or replaces its history. */
export async function verifyOrganizerStockWriterRegistration(
  input: Session & {
    marketCoordinate: string
    writerId: string
    deviceId: string
    generation: number
    transferId?: string
  }
): Promise<EventMarketOrganizerStockWriter> {
  input = { ...input }
  const auth = session(input)
  await auth.authenticate()
  if (
    ![input.writerId, input.deviceId].every((id) => UUID.test(id)) ||
    parseAddressableCoordinate(input.marketCoordinate, [30409])
      ?.authorPubkey !== input.authenticatedPubkey ||
    !bounded(input.generation) ||
    (input.generation === 0
      ? input.writerId !== input.deviceId || input.transferId !== undefined
      : !HASH.test(input.transferId ?? ""))
  )
    fail()
  const evidence = await createEventMarketEvidenceStore(input.db).load(
    input.marketCoordinate
  )
  auth.check()
  const key = organizerStockWriterKey(
    input.authenticatedPubkey,
    input.marketCoordinate
  )
  const captured = await input.db.transaction(
    "r",
    tables(input.db),
    async () => {
      auth.check()
      const registration =
        await input.db.eventMarketOrganizerStockWriters.get(key)
      if (
        !registration ||
        registration.id !== key ||
        registration.state !== "active" ||
        registration.accountPubkey !== input.authenticatedPubkey ||
        registration.marketCoordinate !== input.marketCoordinate ||
        registration.writerId !== input.writerId ||
        registration.deviceId !== input.deviceId ||
        registration.generation !== input.generation ||
        registration.transferId !== input.transferId ||
        !Array.isArray(registration.installedPoolIds) ||
        registration.installedPoolIds.length > MAX_ROWS ||
        registration.installedPoolIds.some((id) => !HASH.test(id)) ||
        new Set(registration.installedPoolIds).size !==
          registration.installedPoolIds.length ||
        (registration.generation > 0 &&
          (!registration.receivedEnvelope ||
            !isValidSignedPublicNostrEvent(registration.receivedEnvelope)))
      )
        fail()
      const current = await cohort(
        input.db,
        input.authenticatedPubkey,
        input.marketCoordinate,
        input.writerId
      )
      auth.check()
      return { registration, current }
    }
  )
  const snapshot: StockWriterSnapshotView = {
    organizerPubkey: input.authenticatedPubkey,
    marketCoordinate: input.marketCoordinate,
    writerId: input.writerId,
    transferredAtMs: Date.now(),
    snapshot: {
      ...captured.current,
      commitments: evidence.filter((event) => event.kind === 30410),
    },
  }
  if (snapshot.snapshot.pools.length) {
    validateSnapshot(snapshot)
    await authenticateGrants(input, snapshot)
    auth.check()
  } else if (snapshot.snapshot.entries.length) fail()
  return input.db.transaction("r", tables(input.db), async () => {
    auth.check()
    const registration =
      await input.db.eventMarketOrganizerStockWriters.get(key)
    const current = await cohort(
      input.db,
      input.authenticatedPubkey,
      input.marketCoordinate,
      input.writerId
    )
    if (
      !registration ||
      !same(registration, captured.registration) ||
      !same(current, captured.current)
    )
      fail()
    auth.check()
    return clone(registration)
  })
}

/** Freeze the complete cohort before requesting any external signature. */
export async function beginOrganizerStockWriterHandover(
  input: Session & {
    marketCoordinate: string
    writerId: string
    targetDeviceId: string
    nowMs?: number
  }
) {
  const auth = session(input)
  await auth.authenticate()
  const key = organizerStockWriterKey(
    input.authenticatedPubkey,
    input.marketCoordinate
  )
  const prior = await input.db.eventMarketOrganizerStockWriters.get(key)
  if (prior?.state === "retired" && prior.outgoing) {
    const payload = parseOrganizerStockWriterHandoverRumor(prior.outgoing.rumor)
    if (
      payload.targetDeviceId !== input.targetDeviceId ||
      payload.writerId !== input.writerId
    )
      fail()
    auth.check()
    return clone(prior)
  }
  if (
    !prior ||
    prior.state !== "active" ||
    prior.writerId !== input.writerId ||
    prior.deviceId === input.targetDeviceId
  )
    fail()
  const captured = await input.db.transaction("r", tables(input.db), () =>
    cohort(
      input.db,
      input.authenticatedPubkey,
      input.marketCoordinate,
      input.writerId
    )
  )
  auth.check()
  const evidence = await createEventMarketEvidenceStore(input.db).load(
    input.marketCoordinate
  )
  auth.check()
  const commitments = captured.pools.map((pool) => {
    const grant = validateOrganizerStockJournalPool(pool)
    const event = evidence.find((event) => {
      const assignment = parseEventMarketAssignmentEvent(event)
      return (
        assignment?.coordinate === grant.assignmentCoordinate &&
        assignment.previousEventId === grant.assignmentEventId &&
        assignment.stockPool.state === "valid" &&
        assignment.stockPool.pool.poolId === pool.poolId &&
        assignment.stockPool.pool.importedQuantity === 0
      )
    })
    if (!event) fail()
    return event
  })
  const payload: OrganizerStockWriterHandoverPayload = {
    version: 1,
    type: "writer_handover",
    organizerPubkey: input.authenticatedPubkey,
    marketCoordinate: input.marketCoordinate,
    writerId: input.writerId,
    sourceDeviceId: prior.deviceId,
    targetDeviceId: input.targetDeviceId,
    generation: prior.generation + 1,
    previousTransferId: prior.transferId ?? null,
    transferredAtMs: input.nowMs ?? Date.now(),
    snapshot: { ...captured, commitments },
  }
  const rumor = build(payload) // Bounds and full-manifest validation precede freeze.
  const packets = buildStockWriterPackets(rumor)
  await authenticateGrants(input, payload)
  auth.check()
  return input.db.transaction("rw", tables(input.db), async () => {
    auth.check()
    const current = await input.db.eventMarketOrganizerStockWriters.get(key)
    const currentCohort = await cohort(
      input.db,
      input.authenticatedPubkey,
      input.marketCoordinate,
      input.writerId
    )
    if (!same(current, prior) || !same(currentCohort, captured)) fail()
    const saved: EventMarketOrganizerStockWriter = {
      ...prior,
      state: "retired",
      generation: payload.generation,
      previousTransferId: prior.transferId,
      transferId: rumor.id,
      outgoing: {
        rumor,
        packets: packets.map((packet) => ({ rumor: packet })),
      },
    }
    await input.db.eventMarketOrganizerStockWriters.put(saved)
    auth.check()
    return clone(saved)
  })
}

/** Self-only exact ciphertext, through the existing private delivery owner. */
export async function publishOrganizerStockWriterHandover(
  input: Session & {
    marketCoordinate: string
    delivery?: Delivery
  }
) {
  const auth = session(input)
  await auth.authenticate()
  const key = organizerStockWriterKey(
    input.authenticatedPubkey,
    input.marketCoordinate
  )
  const row = await input.db.eventMarketOrganizerStockWriters.get(key)
  if (row?.state !== "retired" || !row.outgoing) fail()
  parseOrganizerStockWriterHandoverRumor(row.outgoing.rumor)
  const prepared = clone(
    row.outgoing.packets ?? [
      {
        rumor: row.outgoing.rumor,
        ...(row.outgoing.envelope ? { envelope: row.outgoing.envelope } : {}),
      },
    ]
  )
  for (const packet of prepared) {
    parseStockWriterPacket(packet.rumor)
    packet.envelope ??= await wrapPrivateMessage(
      packet.rumor,
      { pubkey: input.authenticatedPubkey },
      input.signer
    )
    auth.check()
  }
  // Commit the entire winning exact bundle before its first relay write.
  const packets = await input.db.transaction(
    "rw",
    input.db.eventMarketOrganizerStockWriters,
    async () => {
      auth.check()
      const current = await input.db.eventMarketOrganizerStockWriters.get(key)
      if (
        current?.state !== "retired" ||
        current.outgoing?.rumor.id !== row.outgoing!.rumor.id
      )
        fail()
      const existing = current.outgoing.packets
      if (existing?.every((packet) => packet.envelope)) return existing
      if (
        existing &&
        !same(
          existing.map((packet) => packet.rumor),
          prepared.map((packet) => packet.rumor)
        )
      )
        fail()
      current.outgoing.packets = prepared
      current.outgoing.envelope = prepared[0]!.envelope
      await input.db.eventMarketOrganizerStockWriters.put(current)
      auth.check()
      return prepared
    }
  )
  const delivery = [] as Awaited<ReturnType<typeof retryPrivateMessageWraps>>[]
  for (const [index, packet] of packets.entries()) {
    auth.check()
    if (packet.relayAccepted) continue
    const result = await retryPrivateMessageWraps({
      ...input.delivery,
      rumorId: packet.rumor.id,
      senderPubkey: input.authenticatedPubkey,
      recipientPubkey: input.authenticatedPubkey,
      accountPubkey: input.authenticatedPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      wrappedToRecipient: packet.envelope!,
      shouldContinue: () => {
        auth.check()
        return true
      },
    })
    auth.check()
    delivery.push(result)
    if (result.recipientDelivery?.successfulRelayUrls.length)
      await input.db.transaction(
        "rw",
        input.db.eventMarketOrganizerStockWriters,
        async () => {
          auth.check()
          const current =
            await input.db.eventMarketOrganizerStockWriters.get(key)
          const saved = current?.outgoing?.packets?.[index]
          if (!current?.outgoing || saved?.envelope?.id !== packet.envelope!.id)
            fail()
          saved.relayAccepted = true
          if (current.outgoing.packets!.every((part) => part.relayAccepted))
            current.outgoing.relayAccepted = true
          await input.db.eventMarketOrganizerStockWriters.put(current)
          auth.check()
          packet.relayAccepted = true
        }
      )
  }
  const envelopes = packets.map((packet) => packet.envelope!)
  return {
    envelope: envelopes[0]!,
    envelopes,
    relayAccepted: packets.every((packet) => packet.relayAccepted),
    delivery,
  }
}

async function open(
  input: Session & {
    envelope: SignedPublicNostrEvent
    envelopes?: readonly SignedPublicNostrEvent[]
  }
) {
  const auth = session(input)
  await auth.authenticate()
  const root = completePrivateMessageEvent(
    await unwrapPrivateMessageEnvelope(clone(input.envelope), input.signer)
  )
  auth.check()
  const parsed = parseStockWriterPacket(root)
  const parts: PrivateMessageRumor[] = []
  if (parsed.type === "manifest") {
    if (
      !input.envelopes ||
      input.envelopes.length > 258 ||
      input.envelopes.reduce(
        (sum, envelope) => sum + envelope.content.length,
        0
      ) >
        32 * 1024 * 1024
    )
      fail()
    for (const envelope of input.envelopes) {
      const part = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(envelope, input.signer)
      )
      auth.check()
      if (part.id !== root.id) parts.push(part)
    }
  }
  const rumor = assembleStockWriterPackets(root, parts)
  const payload = parseOrganizerStockWriterHandoverRumor(rumor)
  if (payload.organizerPubkey !== input.authenticatedPubkey) fail()
  return { rumor, payload }
}

/** Explicit activation on a positively pre-registered target, never relay absence. */
export async function restoreOrganizerStockWriterHandover(
  input: Session & {
    envelope: SignedPublicNostrEvent
    envelopes?: readonly SignedPublicNostrEvent[]
    expectedTargetDeviceId: string
    nowMs?: number
  }
) {
  input = {
    ...input,
    envelope: clone(input.envelope),
    envelopes: input.envelopes ? clone([...input.envelopes]) : undefined,
  }
  const auth = session(input)
  const { rumor, payload } = await open(input)
  if (
    payload.targetDeviceId !== input.expectedTargetDeviceId ||
    payload.transferredAtMs > (input.nowMs ?? Date.now())
  )
    fail()
  await authenticateGrants(input, payload)
  auth.check()
  return input.db.transaction(
    "rw",
    [...tables(input.db), input.db.eventMarketRosterEvidence],
    async () => {
      auth.check()
      const key = organizerStockWriterKey(
        input.authenticatedPubkey,
        payload.marketCoordinate
      )
      const writer = await input.db.eventMarketOrganizerStockWriters.get(key)
      if (
        !writer ||
        writer.deviceId !== input.expectedTargetDeviceId ||
        (writer.state !== "target" &&
          !(writer.state === "active" && writer.transferId === rumor.id)) ||
        writer.generation > payload.generation ||
        (writer.generation === payload.generation &&
          writer.transferId !== rumor.id)
      )
        fail()
      const known = await cohort(
        input.db,
        input.authenticatedPubkey,
        payload.marketCoordinate,
        payload.writerId
      )
      // An exact retry after activation preserves all newer local decisions.
      if (writer.state === "active") {
        for (const pool of payload.snapshot.pools) {
          const current = known.pools.find((row) => row.poolId === pool.poolId)
          if (
            !current ||
            !same(current.grantRumor, pool.grantRumor) ||
            current.readOnlyRecovery ||
            current.acceptedSequence < pool.acceptedSequence ||
            current.acceptedQuantity < pool.acceptedQuantity ||
            current.importedSequence < pool.importedSequence ||
            (pool.closingRumor &&
              !same(current.closingRumor, pool.closingRumor))
          )
            fail()
        }
        for (const entry of payload.snapshot.entries) {
          const current = known.entries.find((row) => row.id === entry.id)
          if (
            !current ||
            !same(current.rumor, entry.rumor) ||
            current.evidence !== entry.evidence ||
            current.orderPoolBinding !== entry.orderPoolBinding ||
            (entry.handout &&
              !same(current.handout?.rumor, entry.handout.rumor))
          )
            fail()
        }
        auth.check()
        return {
          writerId: payload.writerId,
          poolIds: known.pools.map((pool) => pool.poolId),
          transferId: rumor.id,
          generation: payload.generation,
        }
      }
      for (const pool of known.pools) {
        const incoming = payload.snapshot.pools.find(
          (row) => row.poolId === pool.poolId
        )
        if (
          !incoming ||
          !same(pool.grantRumor, incoming.grantRumor) ||
          pool.readOnlyRecovery ||
          pool.acceptedSequence > incoming.acceptedSequence ||
          pool.acceptedQuantity > incoming.acceptedQuantity ||
          pool.importedSequence > incoming.importedSequence ||
          (pool.closingRumor && !same(pool.closingRumor, incoming.closingRumor))
        )
          fail()
      }
      for (const entry of known.entries) {
        const incoming = payload.snapshot.entries.find(
          (row) => row.id === entry.id
        )
        if (
          !incoming ||
          !same(entry.rumor, incoming.rumor) ||
          entry.orderPoolBinding !== incoming.orderPoolBinding ||
          entry.evidence !== incoming.evidence ||
          (entry.handout && !same(entry.handout.rumor, incoming.handout?.rumor))
        )
          fail()
      }
      await input.db.eventMarketOrganizerStockPools.bulkPut(
        clone(payload.snapshot.pools)
      )
      await input.db.eventMarketOrganizerStockEntries.bulkPut(
        clone(payload.snapshot.entries)
      )
      await input.db.eventMarketRosterEvidence.bulkPut(
        payload.snapshot.commitments.map((event) => ({
          id: `${payload.marketCoordinate}:${event.id}`,
          marketCoordinate: payload.marketCoordinate,
          signedEvent: clone(event),
          cachedAt: Date.now(),
        }))
      )
      const saved: EventMarketOrganizerStockWriter = {
        id: key,
        accountPubkey: input.authenticatedPubkey,
        marketCoordinate: payload.marketCoordinate,
        writerId: payload.writerId,
        deviceId: payload.targetDeviceId,
        state: "active",
        installedPoolIds: payload.snapshot.pools.map((pool) => pool.poolId),
        generation: payload.generation,
        transferId: rumor.id,
        ...(payload.previousTransferId
          ? { previousTransferId: payload.previousTransferId }
          : {}),
        receivedEnvelope: clone(input.envelope),
      }
      await input.db.eventMarketOrganizerStockWriters.put(saved)
      auth.check()
      return {
        writerId: payload.writerId,
        poolIds: payload.snapshot.pools.map((pool) => pool.poolId),
        transferId: rumor.id,
        generation: payload.generation,
      }
    }
  )
}

declare const handoverCursorBrand: unique symbol
export interface OrganizerStockWriterHandoverCursor {
  readonly [handoverCursorBrand]: true
}
interface HandoverCandidate {
  type: "full" | "manifest" | "part"
  transferId: string
  partIds: readonly string[]
  envelope: SignedPublicNostrEvent
}
interface HandoverScan {
  store: CommerceInboxStore
  signer: AccountSigner
  revision: string
  authMethod: AccountSigner["authMethod"]
  account: string
  market: string
  target?: string
  afterId?: string
  restart: boolean
  expiresAt: number
  bytes: number
  capped: boolean
  candidates: Map<string, HandoverCandidate>
}
const handoverScans = new WeakMap<
  OrganizerStockWriterHandoverCursor,
  HandoverScan
>()
export function disposeOrganizerStockWriterHandoverCursor(
  cursor: OrganizerStockWriterHandoverCursor
): void {
  const scan = handoverScans.get(cursor)
  scan?.candidates.clear()
  handoverScans.delete(cursor)
}

/** Opaque resumable ciphertext scan over the same retained inbox owner. */
export async function readOrganizerStockWriterHandovers(
  input: Session & {
    store: CommerceInboxStore
    marketCoordinate: string
    targetDeviceId?: string
    cursor?: OrganizerStockWriterHandoverCursor
  }
) {
  const auth = session(input)
  await auth.authenticate()
  input.store.assertCurrent()
  if (input.store.principal !== input.authenticatedPubkey) fail()
  const cursor =
    input.cursor ?? (Object.freeze({}) as OrganizerStockWriterHandoverCursor)
  let scan = handoverScans.get(cursor)
  if (
    input.cursor &&
    (!scan ||
      scan.signer !== input.signer ||
      scan.store !== input.store ||
      scan.revision !== input.signer.revision ||
      scan.authMethod !== input.signer.authMethod ||
      scan.account !== input.authenticatedPubkey ||
      scan.market !== input.marketCoordinate ||
      scan.target !== input.targetDeviceId ||
      scan.expiresAt <= Date.now())
  ) {
    disposeOrganizerStockWriterHandoverCursor(cursor)
    throw new Error("Refresh this device's stock handover history.")
  }
  scan ??= {
    store: input.store,
    signer: input.signer,
    revision: input.signer.revision!,
    authMethod: input.signer.authMethod,
    account: input.authenticatedPubkey,
    market: input.marketCoordinate,
    target: input.targetDeviceId,
    restart: false,
    expiresAt: Date.now() + 5 * 60_000,
    bytes: 0,
    capped: false,
    candidates: new Map(),
  }
  handoverScans.set(cursor, scan)
  if (scan.restart) {
    scan.afterId = undefined
    scan.restart = false
  }
  const page = await input.store.wrappersPage({
    afterId: scan.afterId,
    limit: 128,
  })
  auth.check()
  const selections: Array<{
    envelope: SignedPublicNostrEvent
    envelopes: SignedPublicNostrEvent[]
    transferId: string
    writerId: string
    targetDeviceId: string
    generation: number
    poolCount: number
  }> = []
  let inspectedBytes = 0,
    processed = 0
  for (const row of page.rows) {
    if (
      processed > 0 &&
      inspectedBytes + row.event.content.length > 1024 * 1024
    )
      break
    processed++
    scan.afterId = row.id
    inspectedBytes += row.event.content.length
    if (
      row.event.kind !== 1059 ||
      row.state === "unrelated" ||
      row.state === "deleted"
    )
      continue
    try {
      const rumor = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(row.event, input.signer)
      )
      auth.check()
      if (!isOrganizerStockWriterHandoverRumor(rumor)) continue
      const packet = parseStockWriterPacket(rumor)
      const header =
        packet.type === "full"
          ? parseOrganizerStockWriterHandoverRumor(rumor)
          : packet.payload
      if (
        header.organizerPubkey !== input.authenticatedPubkey ||
        header.marketCoordinate !== input.marketCoordinate ||
        (input.targetDeviceId && header.targetDeviceId !== input.targetDeviceId)
      )
        continue
      if (scan.candidates.has(rumor.id)) continue
      if (
        scan.bytes + row.event.content.length > 32 * 1024 * 1024 ||
        scan.candidates.size >= 4096
      ) {
        scan.capped = true
        continue
      }
      scan.bytes += row.event.content.length
      scan.candidates.set(rumor.id, {
        type: packet.type,
        transferId:
          packet.type === "full" ? rumor.id : packet.payload.transferId,
        partIds: packet.type === "manifest" ? [...packet.payload.parts] : [],
        envelope: clone(row.event),
      })
    } catch {
      auth.check()
    }
  }
  for (const candidate of scan.candidates.values()) {
    if (candidate.type === "part") continue
    try {
      const parts = candidate.partIds.map((id) => scan!.candidates.get(id))
      if (parts.some((part) => !part)) continue
      const root = completePrivateMessageEvent(
        await unwrapPrivateMessageEnvelope(candidate.envelope, input.signer)
      )
      auth.check()
      const rumors: PrivateMessageRumor[] = []
      for (const part of parts) {
        rumors.push(
          completePrivateMessageEvent(
            await unwrapPrivateMessageEnvelope(part!.envelope, input.signer)
          )
        )
        auth.check()
      }
      const rumor = assembleStockWriterPackets(root, rumors)
      const payload = parseOrganizerStockWriterHandoverRumor(rumor)
      if (
        payload.organizerPubkey !== input.authenticatedPubkey ||
        payload.marketCoordinate !== input.marketCoordinate ||
        (input.targetDeviceId &&
          payload.targetDeviceId !== input.targetDeviceId)
      )
        continue
      if (!selections.some((selection) => selection.transferId === rumor.id))
        selections.push({
          envelope: candidate.envelope,
          envelopes: [
            candidate.envelope,
            ...parts.map((part) => part!.envelope),
          ],
          transferId: rumor.id,
          writerId: payload.writerId,
          targetDeviceId: payload.targetDeviceId,
          generation: payload.generation,
          poolCount: payload.snapshot.pools.length,
        })
    } catch {
      auth.check()
    }
  }
  scan.expiresAt = Date.now() + 5 * 60_000
  const hasMore = page.hasMore || processed < page.rows.length
  scan.restart = !hasMore
  return { selections, cursor, hasMore, capped: scan.capped }
}
