import type {
  ConduitDB,
  EventMarketOrganizerStockEntry,
  EventMarketOrganizerStockPool,
} from "../db"
import { CommerceInboxStore } from "./commerce-inbox-store"
import { parseEventMarketAssignmentEvent } from "./event-market-assignment"
import {
  isEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockAuthorityPayload,
  type EventMarketStockGrant,
} from "./event-market-stock-authority"
import { sameOrganizerStockRumor } from "./event-market-stock-import-authority"
import {
  installOrganizerStockHandover,
  beginOrganizerStockClose,
  commitOrganizerStockOrder,
  prepareMerchantOrganizerStockPool,
  prepareOrganizerStockEnvelopes,
  validateOrganizerStockJournalPool,
} from "./event-market-stock-journal"
import { resumeMerchantInventoryPublication } from "./merchant-inventory"
import type { AccountSigner } from "./nostr-event-signer"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import {
  completePrivateMessageEvent,
  unwrapPrivateMessageEnvelope,
  type PrivateMessageRumor,
} from "./private-message-primitives"
import {
  resolveInboxDeclaration,
  type InboxDeclarationResolution,
} from "./private-message-routing"
import {
  visitProtectedInboxHistoryPage,
  type ProtectedInboxHistoryCursor,
  type ProtectedInboxHistoryPageStatus,
  type VisitProtectedInboxHistoryPageOptions,
} from "./protected-inbox-history"
import {
  assertProtectedReadAuthorization,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import { relayTargetsFromUrls } from "./relay-authority"
import { publishWithPlanner } from "./relay-publish"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  verifySignedEventBatches,
  fetchSignedEventsFanoutDetailed,
} from "./relay-reader"
import { readEventMarketAssignment } from "./event-market-roster-read"
import { resolveEventMarketRoster } from "./event-market-roster"
import { resolveEventMarketAuthorization } from "./event-market-authorization"
import {
  resolveEventMarketOccurrence,
  resolveEventMarketSeries,
} from "./event-market-schedule"
import { createEventMarketEvidenceStore } from "./event-market-evidence-store"
import { isOccurrenceCancelled } from "./merchant-occurrence-lifecycle"
import { parseProductEvent } from "./products"
import {
  isEventMarketAddressableRevisionDeleted,
  getEventMarketReadPlan,
} from "./event-market"
import {
  isEventMarketStockCheckpointRumor,
  parseEventMarketStockCheckpointRumor,
  observeMerchantOrganizerStockCheckpoint,
  type EventMarketStockCheckpointPayload,
} from "./event-market-stock-checkpoint"
import { isOrganizerStockWriterHandoverRumor } from "./event-market-stock-writer-handover"
import { assertOrganizerStockWriterCurrent } from "./event-market-stock-writer-guard"

type StockSession = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}
type DeliveryOptions = Pick<
  Parameters<typeof retryPrivateMessageWraps>[0],
  | "deliveryStore"
  | "publishFn"
  | "resolveInboxRelays"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
>
const clone = <T>(value: T): T => structuredClone(value)
const poolKey = (account: string, pool: string) => `${account}:${pool}`
const MAX_RETAINED_PACKETS = 512
const MAX_RETAINED_BYTES = 4 * 1024 * 1024
const DISCOVERY_LIFETIME_MS = 5 * 60_000

function session(
  input: Pick<StockSession, "signer" | "authenticatedPubkey" | "shouldContinue">
) {
  const revision = input.signer.revision,
    authMethod = input.signer.authMethod
  const check = () => {
    if (
      !input.shouldContinue() ||
      !revision ||
      !authMethod ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== authMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44
    )
      throw new Error("Stock workflow account session changed")
  }
  return {
    check,
    authenticate: async () => {
      check()
      const identity = await input.signer.getPublicKey()
      check()
      if (identity !== input.authenticatedPubkey)
        throw new Error("Stock workflow account session changed")
    },
  }
}

export interface AuthenticatedEventMarketStockPacket {
  /** Private account evidence, never a conversation projection or diagnostics. */
  envelope: SignedPublicNostrEvent
  rumor: PrivateMessageRumor
  payload: EventMarketStockAuthorityPayload | EventMarketStockCheckpointPayload
}
class InvalidStockPacketError extends Error {
  constructor() {
    super("Authenticated stock packet is malformed")
  }
}

/** Authenticate both seals; reserved unknown versions remain machine-only. */
export async function inspectEventMarketStockPacket(
  input: Pick<
    StockSession,
    "signer" | "authenticatedPubkey" | "shouldContinue"
  > & { envelope: SignedPublicNostrEvent }
): Promise<AuthenticatedEventMarketStockPacket | null> {
  input = { ...input, envelope: clone(input.envelope) }
  const authority = session(input)
  await authority.authenticate()
  const rumor = completePrivateMessageEvent(
    await unwrapPrivateMessageEnvelope(input.envelope, input.signer)
  )
  authority.check()
  // This self-only subtype has its own bounded transfer consumer, not a
  // Merchant-stock packet or a malformed human message.
  if (isOrganizerStockWriterHandoverRumor(rumor)) return null
  if (!isEventMarketStockAuthorityRumor(rumor)) return null
  let payload: AuthenticatedEventMarketStockPacket["payload"]
  try {
    payload = isEventMarketStockCheckpointRumor(rumor)
      ? parseEventMarketStockCheckpointRumor(rumor)
      : parseEventMarketStockAuthorityRumor(rumor)
  } catch {
    throw new InvalidStockPacketError()
  }
  if (
    input.authenticatedPubkey !== payload.merchantPubkey &&
    (payload.type === "merchant_checkpoint" ||
      input.authenticatedPubkey !== payload.organizerPubkey)
  )
    throw new InvalidStockPacketError()
  return { envelope: input.envelope, rumor, payload }
}

/** Saved exact ciphertext goes through the existing declared-inbox delivery owner. */
export async function publishEventMarketStockWork(
  input: StockSession & {
    poolId: string
    work: "grant" | "close" | { entryId: string }
    delivery?: DeliveryOptions
  }
) {
  input = {
    ...input,
    work: typeof input.work === "object" ? { ...input.work } : input.work,
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  const authority = session(input)
  await authority.authenticate()
  const wraps = await prepareOrganizerStockEnvelopes(input)
  authority.check()
  const pool = await input.db.eventMarketOrganizerStockPools.get(
    poolKey(input.authenticatedPubkey, input.poolId)
  )
  if (!pool) throw new Error("Saved stock pool unavailable")
  const entry =
    typeof input.work === "object"
      ? await input.db.eventMarketOrganizerStockEntries.get(
          `${input.authenticatedPubkey}:${input.work.entryId}`
        )
      : undefined
  const rumor =
    input.work === "grant"
      ? pool.grantRumor
      : input.work === "close"
        ? pool.closingRumor
        : entry?.rumor
  if (!rumor) throw new Error("Exact saved stock work unavailable")
  if (pool.accountPubkey === pool.organizerPubkey) {
    const grant = validateOrganizerStockJournalPool(pool)
    await assertOrganizerStockWriterCurrent({
      db: input.db,
      accountPubkey: input.authenticatedPubkey,
      marketCoordinate: grant.marketCoordinate,
      writerId: pool.writerId,
    })
  }
  authority.check()
  const result = await retryPrivateMessageWraps({
    ...input.delivery,
    rumorId: rumor.id,
    senderPubkey: input.authenticatedPubkey,
    recipientPubkey:
      input.work === "grant" ? pool.organizerPubkey : pool.merchantPubkey,
    accountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    wrappedToRecipient: wraps.recipient,
    wrappedToSelf: wraps.self,
    shouldContinue: () => {
      authority.check()
      return true
    },
  })
  authority.check()
  return result
}

/** Authenticated order reservation is atomic; delivery retries its exact saved entries. */
export async function acceptAndPublishOrganizerStockOrder(
  input: StockSession &
    Omit<
      Parameters<typeof commitOrganizerStockOrder>[0],
      "db" | "authenticatedPubkey" | "shouldContinue"
    > & { delivery?: DeliveryOptions }
) {
  input = {
    ...input,
    entries: input.entries.map((entry) => ({ ...entry })),
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  const authority = session(input)
  await authority.authenticate()
  const result = await commitOrganizerStockOrder({
    ...input,
    shouldContinue: () => {
      authority.check()
      return true
    },
  })
  const delivery = [] as Awaited<
    ReturnType<typeof publishEventMarketStockWork>
  >[]
  for (const entry of result.entries)
    delivery.push(
      await publishEventMarketStockWork({
        ...input,
        poolId: entry.poolId,
        work: { entryId: entry.rumor.id },
      })
    )
  authority.check()
  return { ...result, delivery }
}

/** The durable close serializes with acceptance before its exact message is sent. */
export async function closeAndPublishOrganizerStockPool(
  input: StockSession & {
    poolId: string
    writerId: string
    nowMs?: number
    delivery?: DeliveryOptions
  }
) {
  input = {
    ...input,
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  const authority = session(input)
  await authority.authenticate()
  const rumor = await beginOrganizerStockClose({
    ...input,
    shouldContinue: () => {
      authority.check()
      return true
    },
  })
  const delivery = await publishEventMarketStockWork({
    ...input,
    work: "close",
  })
  authority.check()
  return { rumor, delivery }
}

/**
 * Compose an already validated occurrence assignment's grant. Its local hold
 * precedes signing; its signed public commitment precedes private delivery.
 * A failed publication leaves the same saved reservation and bytes retryable.
 */
export async function startMerchantOrganizerStockGrant(
  input: StockSession & {
    grantRumor: PrivateMessageRumor
    /** Exact public source graph from the existing verified occurrence read. */
    admissionEvidence: readonly SignedPublicNostrEvent[]
    expectedAssignmentRevision: number
    nowMs?: number
    publishPublic?: (event: SignedPublicNostrEvent) => Promise<boolean>
    delivery?: DeliveryOptions
  }
) {
  input = {
    ...input,
    grantRumor: clone(input.grantRumor),
    admissionEvidence: clone([...input.admissionEvidence]),
    delivery: input.delivery ? { ...input.delivery } : undefined,
  }
  const authority = session(input)
  await authority.authenticate()
  const grant = parseEventMarketStockAuthorityRumor(input.grantRumor)
  if (
    grant.type !== "grant" ||
    grant.merchantPubkey !== input.authenticatedPubkey
  )
    throw new Error("Merchant stock grant required")
  const nowMs = input.nowMs ?? Date.now()
  const evidenceStore = createEventMarketEvidenceStore(input.db)
  const retained = await evidenceStore.load(grant.marketCoordinate)
  const evidence = await verifySignedEventBatches([
    ...new Map(
      [...retained, ...input.admissionEvidence].map((event) => [
        event.id,
        event,
      ])
    ).values(),
  ])
  authority.check()
  const market = resolveEventMarketRoster({
    coordinate: grant.marketCoordinate,
    revisions: evidence.filter((event) => event.kind === 30409),
    deletions: evidence.filter((event) => event.kind === 5),
  })
  const approval = resolveEventMarketAuthorization({
    marketCoordinate: grant.marketCoordinate,
    merchantPubkey: grant.merchantPubkey,
    transitions: evidence.filter((event) => event.kind === 3841),
    deletions: evidence.filter((event) => event.kind === 5),
  })
  const occurrence = resolveEventMarketOccurrence({
    coordinate: grant.occurrenceCoordinate,
    organizerPubkey: grant.organizerPubkey,
    revisions: evidence,
    deletions: evidence.filter((event) => event.kind === 5),
  })
  if (
    market.state !== "current" ||
    market.market.state !== "open" ||
    market.market.eventId !== grant.marketEventId ||
    market.market.organizerPubkey !== grant.organizerPubkey ||
    market.market.merchants.find((row) => row.pubkey === grant.merchantPubkey)
      ?.mode !== "organizer_handoff" ||
    approval.state !== "active" ||
    approval.tip.eventId !== grant.grantEventId ||
    !occurrence ||
    occurrence.occurrence.eventId !== grant.occurrenceEventId ||
    occurrence.occurrence.end <= nowMs ||
    grant.expiresAtMs > occurrence.occurrence.end ||
    isOccurrenceCancelled(occurrence.signedEvent)
  )
    throw new Error(
      "Current signed organizer handover admission is unavailable"
    )
  if (grant.scheduleEventId) {
    const series = resolveEventMarketSeries({
      coordinate: market.market.calendarCoordinate,
      organizerPubkey: grant.organizerPubkey,
      revisions: evidence,
      deletions: evidence.filter((event) => event.kind === 5),
    })
    if (
      series.state !== "current" ||
      series.series.eventId !== grant.scheduleEventId ||
      !series.series.memberCoordinates.includes(grant.occurrenceCoordinate)
    )
      throw new Error(
        "Current signed organizer schedule does not contain this occurrence"
      )
  } else if (market.market.calendarCoordinate !== grant.occurrenceCoordinate)
    throw new Error("Exact organizer schedule evidence required")
  const source = evidence.find((event) => event.id === grant.productEventId)
  if (!source) throw new Error("Exact signed Merchant product required")
  const newestProduct = evidence
    .filter(
      (event) =>
        event.kind === 30402 &&
        `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
          grant.productCoordinate
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  if (newestProduct?.id !== grant.productEventId)
    throw new Error(
      "A newer signed Merchant product needs reconciliation before handover"
    )
  const product = parseProductEvent(source)
  if (
    product.id !== grant.productCoordinate ||
    product.pubkey !== grant.merchantPubkey ||
    product.format !== "physical" ||
    product.type === "variable" ||
    product.visibility !== "public" ||
    product.stock === undefined ||
    product.stock < grant.quantity ||
    isEventMarketAddressableRevisionDeleted(
      {
        coordinate: product.id,
        eventId: source.id,
        createdAt: source.created_at * 1000,
      },
      evidence.filter((event) => event.kind === 5)
    )
  )
    throw new Error(
      "Signed Merchant stock product is not eligible for handover"
    )
  if (product.type === "variation") {
    const parents = evidence
      .filter(
        (event) =>
          event.kind === 30402 &&
          event.pubkey === grant.merchantPubkey &&
          `30402:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` ===
            product.parentProductId
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    const parent = parents[0] && parseProductEvent(parents[0])
    if (
      !parent ||
      parent.type !== "variable" ||
      parent.visibility !== "public" ||
      isEventMarketAddressableRevisionDeleted(
        {
          coordinate: parent.id,
          eventId: parents[0]!.id,
          createdAt: parents[0]!.created_at * 1000,
        },
        evidence.filter((event) => event.kind === 5)
      )
    )
      throw new Error("Exact signed variation parent required for handover")
  }
  await evidenceStore.retain(grant.marketCoordinate, evidence)
  authority.check()
  const pool = await prepareMerchantOrganizerStockPool(input)
  authority.check()
  await prepareOrganizerStockEnvelopes({
    ...input,
    poolId: pool.poolId,
    work: "grant",
  })
  authority.check()
  await resumeMerchantInventoryPublication({
    db: input.db,
    merchantPubkey: input.authenticatedPubkey,
    coordinates: [grant.assignmentCoordinate],
    stockCheckpoint: {
      signer: input.signer,
      shouldContinue: input.shouldContinue,
      delivery: input.delivery,
    },
    sign: async (draft) => {
      authority.check()
      const result = await input.signer.signEvent(draft)
      authority.check()
      return result
    },
    publish: async (event) => {
      authority.check()
      const accepted = input.publishPublic
        ? await input.publishPublic(event)
        : (
            await publishWithPlanner(event, {
              intent: "commerce_author_event",
              authorPubkey: input.authenticatedPubkey,
              accountPubkey: input.authenticatedPubkey,
              authenticatedPubkey: input.authenticatedPubkey,
              deliveryMode: "critical",
              shouldContinue: input.shouldContinue,
            })
          ).successfulRelayUrls.length > 0
      authority.check()
      return accepted
    },
  })
  const assignment = await input.db.merchantInventoryAssignments.get(
    grant.assignmentCoordinate
  )
  authority.check()
  const commitment = assignment?.signedAssignmentEvent
  if (
    !commitment ||
    !assignment.publicationJobs.some(
      (work) =>
        work.id === `${pool.poolId}:reserve` &&
        work.state === "delivered" &&
        work.signedEvent?.id === commitment.id
    )
  )
    throw new Error(
      "Publish the exact stock commitment before delivering its grant"
    )
  assertStockCommitment(input.grantRumor, commitment)
  await evidenceStore.retain(grant.marketCoordinate, [commitment])
  authority.check()
  const delivery = await publishEventMarketStockWork({
    ...input,
    poolId: pool.poolId,
    work: "grant",
  })
  return { pool, commitment, delivery }
}

function assertStockCommitment(
  rumor: PrivateMessageRumor,
  event: SignedPublicNostrEvent
): EventMarketStockGrant {
  const grant = parseEventMarketStockAuthorityRumor(rumor)
  const assignment = parseEventMarketAssignmentEvent(event)
  if (
    grant.type !== "grant" ||
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
    assignment.stockPool.state !== "valid" ||
    assignment.stockPool.pool.state !== "active" ||
    assignment.stockPool.pool.poolId !== rumor.id ||
    assignment.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
    assignment.stockPool.pool.quantity !== grant.quantity ||
    assignment.stockPool.pool.importedQuantity !== 0
  )
    throw new Error("Merchant signature does not commit this exact stock grant")
  return grant
}

/** Initial installation only on the device explicitly selected before grant delivery. */
export async function receiveOrganizerStockGrant(
  input: StockSession & {
    expectedWriterId: string
    grantEnvelope: SignedPublicNostrEvent
    committedAssignmentEvent: SignedPublicNostrEvent
    nowMs?: number
  }
) {
  input = {
    ...input,
    grantEnvelope: clone(input.grantEnvelope),
    committedAssignmentEvent: clone(input.committedAssignmentEvent),
  }
  const packet = await inspectEventMarketStockPacket({
    ...input,
    envelope: input.grantEnvelope,
  })
  if (
    !packet ||
    packet.payload.type !== "grant" ||
    packet.payload.organizerPubkey !== input.authenticatedPubkey ||
    packet.payload.writerId !== input.expectedWriterId
  )
    throw new Error(
      "This device was not selected as the organizer stock writer"
    )
  await createEventMarketEvidenceStore(input.db).retain(
    packet.payload.marketCoordinate,
    [input.committedAssignmentEvent]
  )
  const pool = await installOrganizerStockHandover({
    ...input,
    writerId: input.expectedWriterId,
    grantRumor: packet.rumor,
  })
  const authority = session(input)
  return input.db.transaction(
    "rw",
    input.db.eventMarketOrganizerStockPools,
    async () => {
      authority.check()
      const current = await input.db.eventMarketOrganizerStockPools.get(pool.id)
      if (
        !current ||
        !sameOrganizerStockRumor(current.grantRumor, packet.rumor)
      )
        throw new Error("Organizer stock grant changed")
      current.receivedEnvelope ??= clone(input.grantEnvelope)
      await input.db.eventMarketOrganizerStockPools.put(current)
      authority.check()
      return current
    }
  )
}

export interface EventMarketStockDiscoveryPage {
  packets: readonly AuthenticatedEventMarketStockPacket[]
  pageStatus: ProtectedInboxHistoryPageStatus
  hasMore: boolean
  retentionLimitReached: boolean
  malformedCount: number
  decryptFailureCount: number
}

/**
 * A dedicated bounded consumer over the existing protected inbox transport.
 * EOSE, an empty page, or a cap is never stock/writer absence authority.
 */
export async function createEventMarketStockDiscovery(
  input: StockSession & {
    authorization: ProtectedReadAuthorization
    store?: CommerceInboxStore
    signal?: AbortSignal
    resolveDeclaration?: typeof resolveInboxDeclaration
    read?: VisitProtectedInboxHistoryPageOptions["read"]
  }
) {
  input = { ...input }
  const authority = session(input)
  await authority.authenticate()
  const store =
    input.store ?? new CommerceInboxStore(input.authorization, input.db)
  const check = () => {
    authority.check()
    assertProtectedReadAuthorization(
      input.authorization,
      input.authenticatedPubkey
    )
    if (
      input.authorization.signer !== input.signer ||
      store.principal !== input.authenticatedPubkey ||
      input.signal?.aborted
    )
      throw new Error("Stock discovery session changed")
  }
  check()
  const declaration: InboxDeclarationResolution = await (
    input.resolveDeclaration ?? resolveInboxDeclaration
  )(input.authenticatedPubkey, {
    requestingAccountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  check()
  const sources = (
    declaration.state === "declared" ? declaration.relayUrls : []
  ).map((relayUrl) => ({
    relayUrl,
    cursor: undefined as ProtectedInboxHistoryCursor | undefined,
    done: false,
  }))
  const packets = new Map<string, AuthenticatedEventMarketStockPacket>()
  const retained = await store.wrappers()
  let retainedIndex = 0
  const visited = new Set<string>()
  const malformed = new Set<string>(),
    failed = new Set<string>()
  let bytes = 0,
    retentionLimitReached = false,
    disposed = false,
    busy = false,
    sourceIndex = 0
  const expiresAt = Date.now() + DISCOVERY_LIFETIME_MS
  const assertCurrent = () => {
    check()
    if (disposed || Date.now() >= expiresAt)
      throw new Error("Stock discovery session ended")
  }
  const project = (
    pageStatus: ProtectedInboxHistoryPageStatus
  ): EventMarketStockDiscoveryPage => ({
    packets: clone([...packets.values()]),
    pageStatus,
    hasMore:
      !retentionLimitReached &&
      (retainedIndex < retained.length ||
        sources.some((source) => !source.done)),
    retentionLimitReached,
    malformedCount: malformed.size,
    decryptFailureCount: failed.size,
  })
  const inspect = async (
    event: SignedPublicNostrEvent,
    relayUrls: readonly string[]
  ) => {
    assertCurrent()
    if (visited.has(event.id) || retentionLimitReached) return
    await store.receive(event, relayUrls)
    assertCurrent()
    let packet: AuthenticatedEventMarketStockPacket | null
    try {
      packet = await inspectEventMarketStockPacket({
        ...input,
        envelope: event,
      })
    } catch (error) {
      assertCurrent()
      if (error instanceof InvalidStockPacketError) {
        malformed.add(event.id)
        visited.add(event.id)
      } else failed.add(event.id)
      if (
        failed.size >= MAX_RETAINED_PACKETS ||
        malformed.size >= MAX_RETAINED_PACKETS
      )
        retentionLimitReached = true
      return
    }
    assertCurrent()
    failed.delete(event.id)
    // A retained self-copy is not relay observation. Leave this authenticated
    // checkpoint eligible for the same wrapper's later positive source evidence.
    if (packet?.payload.type === "merchant_checkpoint" && !relayUrls.length)
      return
    visited.add(event.id)
    if (visited.size > 1024) visited.delete(visited.values().next().value!)
    if (!packet) return
    let packetKey = packet.rumor.id
    if (packet.payload.type === "merchant_checkpoint") {
      const observed = await observeMerchantOrganizerStockCheckpoint({
        ...input,
        store,
        envelope: event,
      })
      assertCurrent()
      if (observed.observation.rumorId !== packet.rumor.id) return
      packetKey = `checkpoint:${packet.payload.snapshot.product.coordinate}`
    }
    const size = new TextEncoder().encode(JSON.stringify(event)).length
    const previous = packets.get(packetKey)
    if (
      previous &&
      packet.payload.type !== "merchant_checkpoint" &&
      !sameOrganizerStockRumor(previous.rumor, packet.rumor)
    ) {
      malformed.add(event.id)
      return
    }
    if (
      (!previous && packets.size >= MAX_RETAINED_PACKETS) ||
      bytes +
        size -
        (previous
          ? new TextEncoder().encode(JSON.stringify(previous.envelope)).length
          : 0) >
        MAX_RETAINED_BYTES
    ) {
      retentionLimitReached = true
      return
    }
    if (!previous || packet.payload.type === "merchant_checkpoint") {
      packets.set(packetKey, packet)
      bytes +=
        size -
        (previous
          ? new TextEncoder().encode(JSON.stringify(previous.envelope)).length
          : 0)
    }
  }
  return {
    async nextPage(): Promise<EventMarketStockDiscoveryPage> {
      assertCurrent()
      if (busy) throw new Error("Stock discovery page already in progress")
      if (retentionLimitReached) return project("capped")
      // Large unrelated histories must not trigger unbounded signer work.
      if (retainedIndex < retained.length) {
        busy = true
        try {
          const end = Math.min(retained.length, retainedIndex + 50)
          for (; retainedIndex < end; retainedIndex++) {
            const row = retained[retainedIndex]!
            assertCurrent()
            if (row.event.kind === 1059) await inspect(row.event, row.sources)
            if (retentionLimitReached) break
          }
          return project(retentionLimitReached ? "capped" : "partial")
        } finally {
          busy = false
        }
      }
      const candidates = sources.filter((source) => !source.done)
      if (!candidates.length)
        return project(sources.length ? "source_eose" : "unavailable")
      const source = candidates[sourceIndex++ % candidates.length]!
      busy = true
      try {
        const page = await visitProtectedInboxHistoryPage({
          principalPubkey: input.authenticatedPubkey,
          relayUrl: source.relayUrl,
          declaredRelayUrls: sources.map((item) => item.relayUrl),
          relayTargets: relayTargetsFromUrls([source.relayUrl], {
            kind: "owner_nip17",
            operation: "read",
            ownerPubkey: input.authenticatedPubkey,
          }),
          authorization: input.authorization,
          cursor: source.cursor,
          signal: input.signal,
          read: input.read,
          visit: async (event, assertVisitCurrent) => {
            assertCurrent()
            assertVisitCurrent()
            await inspect(event, [source.relayUrl])
            assertVisitCurrent()
          },
        })
        assertCurrent()
        if (!retentionLimitReached) {
          if (page.status === "source_eose") source.done = true
          else if (page.status === "advanced" && page.nextCursor)
            source.cursor = page.nextCursor
        }
        return project(retentionLimitReached ? "capped" : page.status)
      } finally {
        busy = false
      }
    },
    getSnapshot: () => {
      assertCurrent()
      return project(retentionLimitReached ? "capped" : "partial")
    },
    dispose: () => {
      disposed = true
      packets.clear()
      visited.clear()
      malformed.clear()
      failed.clear()
      sources.length = 0
    },
  }
}

/**
 * Positive closed history only. It is safe to reconcile on a replacement device,
 * but never safe to assume an unseen acceptance did not exist and resume it.
 */
export async function restoreClosedOrganizerStockFromInbox(
  input: StockSession & {
    poolId: string
    packets: readonly AuthenticatedEventMarketStockPacket[]
    nowMs?: number
  },
  dependencies: { readAssignment?: typeof readEventMarketAssignment } = {}
): Promise<EventMarketOrganizerStockPool> {
  if (
    input.packets.length > MAX_RETAINED_PACKETS ||
    new TextEncoder().encode(
      JSON.stringify(input.packets.map((packet) => packet.envelope))
    ).length > MAX_RETAINED_BYTES
  )
    throw new Error("Stock recovery packet budget exceeded")
  input = { ...input, packets: clone([...input.packets]) }
  const authority = session(input)
  await authority.authenticate()
  const authenticated = new Map<string, AuthenticatedEventMarketStockPacket>()
  for (const candidate of input.packets) {
    const packet = await inspectEventMarketStockPacket({
      ...input,
      envelope: candidate.envelope,
    })
    authority.check()
    if (!packet) continue
    const previous = authenticated.get(packet.rumor.id)
    if (previous && !sameOrganizerStockRumor(previous.rumor, packet.rumor))
      throw new Error("Stock recovery packets conflict")
    authenticated.set(packet.rumor.id, packet)
  }
  const packets = [...authenticated.values()]
  const grant = authenticated.get(input.poolId)
  if (
    !grant ||
    grant.payload.type !== "grant" ||
    grant.payload.organizerPubkey !== input.authenticatedPubkey
  )
    throw new Error("Authenticated original Merchant grant required")
  const terms = grant.payload
  const matching = packets.filter(
    (packet) =>
      packet.payload.type === "closed" && packet.payload.poolId === input.poolId
  )
  if (matching.length !== 1)
    throw new Error("One exact complete closing frontier required")
  const evidence = createEventMarketEvidenceStore(input.db)
  const read = await (
    dependencies.readAssignment ??
    ((query) =>
      readEventMarketAssignment(query, {
        plan: getEventMarketReadPlan,
        fetch: fetchSignedEventsFanoutDetailed,
        load: evidence.load,
        retain: evidence.retain,
      }))
  )({
    marketCoordinate: grant.payload.marketCoordinate,
    occurrenceCoordinate: grant.payload.occurrenceCoordinate,
    productCoordinate: grant.payload.productCoordinate,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
  })
  authority.check()
  if (["conflicting", "malformed", "incomplete"].includes(read.state))
    throw new Error("Signed stock commitment history needs reconciliation")
  const sources = [
    ...(await evidence.load(grant.payload.marketCoordinate)),
    ...(read.assignment ? [read.assignment.signedEvent] : []),
  ]
  authority.check()
  const commitments = sources
    .map(parseEventMarketAssignmentEvent)
    .filter(
      (assignment) =>
        assignment &&
        assignment.coordinate === terms.assignmentCoordinate &&
        assignment.stockPool.state === "valid" &&
        assignment.stockPool.pool.poolId === input.poolId
    )
    .sort(
      (a, b) =>
        b!.createdAt - a!.createdAt || a!.eventId.localeCompare(b!.eventId)
    )
  const commitment = commitments[0]
  if (!commitment)
    throw new Error("Exact signed Merchant pool commitment unavailable")
  const accepted = packets.filter(
    (packet) =>
      packet.payload.type === "accepted" &&
      packet.payload.poolId === input.poolId
  )
  const handedOut = packets.filter(
    (packet) =>
      packet.payload.type === "handed_out" &&
      packet.payload.entries.some((entry) => entry.poolId === input.poolId)
  )
  return restoreClosedOrganizerStockJournal({
    ...input,
    grantEnvelope: grant.envelope,
    committedAssignmentEvent: commitment.signedEvent,
    closingEnvelope: matching[0]!.envelope,
    acceptedEnvelopes: accepted.map((packet) => packet.envelope),
    handoutEnvelopes: handedOut.map((packet) => packet.envelope),
    closedAssignmentEvent:
      commitment.stockPool.state === "valid" &&
      commitment.stockPool.pool.state === "closed"
        ? commitment.signedEvent
        : undefined,
  })
}

export async function restoreClosedOrganizerStockJournal(
  input: StockSession & {
    grantEnvelope: SignedPublicNostrEvent
    committedAssignmentEvent: SignedPublicNostrEvent
    acceptedEnvelopes: readonly SignedPublicNostrEvent[]
    /** Positive handout records only; absence never permits another release. */
    handoutEnvelopes?: readonly SignedPublicNostrEvent[]
    closingEnvelope: SignedPublicNostrEvent
    /** Positive Merchant reconciliation; absent means closing, not closed. */
    closedAssignmentEvent?: SignedPublicNostrEvent
    nowMs?: number
  }
): Promise<EventMarketOrganizerStockPool> {
  if (
    input.acceptedEnvelopes.length > MAX_RETAINED_PACKETS ||
    (input.handoutEnvelopes?.length ?? 0) > MAX_RETAINED_PACKETS
  )
    throw new Error("Stock recovery packet budget exceeded")
  if (
    new TextEncoder().encode(
      JSON.stringify([
        input.grantEnvelope,
        input.closingEnvelope,
        ...input.acceptedEnvelopes,
        ...(input.handoutEnvelopes ?? []),
      ])
    ).length > MAX_RETAINED_BYTES
  )
    throw new Error("Stock recovery packet budget exceeded")
  input = {
    ...input,
    grantEnvelope: clone(input.grantEnvelope),
    committedAssignmentEvent: clone(input.committedAssignmentEvent),
    acceptedEnvelopes: clone([...input.acceptedEnvelopes]),
    handoutEnvelopes: clone([...(input.handoutEnvelopes ?? [])]),
    closingEnvelope: clone(input.closingEnvelope),
    closedAssignmentEvent: input.closedAssignmentEvent
      ? clone(input.closedAssignmentEvent)
      : undefined,
  }
  const authority = session(input)
  const grantPacket = await inspectEventMarketStockPacket({
    ...input,
    envelope: input.grantEnvelope,
  })
  if (
    !grantPacket ||
    grantPacket.payload.type !== "grant" ||
    grantPacket.payload.organizerPubkey !== input.authenticatedPubkey
  )
    throw new Error("Authenticated Merchant grant for this organizer required")
  const grant = grantPacket.payload
  const commitment = parseEventMarketAssignmentEvent(
    input.committedAssignmentEvent
  )
  if (
    !commitment ||
    commitment.coordinate !== grant.assignmentCoordinate ||
    commitment.marketCoordinate !== grant.marketCoordinate ||
    commitment.occurrenceCoordinate !== grant.occurrenceCoordinate ||
    commitment.productCoordinate !== grant.productCoordinate ||
    commitment.createdAt < grantPacket.rumor.created_at ||
    commitment.stockPool.state !== "valid" ||
    commitment.stockPool.pool.poolId !== grantPacket.rumor.id ||
    commitment.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
    commitment.stockPool.pool.quantity !== grant.quantity
  )
    throw new Error(
      "Exact Merchant stock commitment required for read-only recovery"
    )
  const closing = await inspectEventMarketStockPacket({
    ...input,
    envelope: input.closingEnvelope,
  })
  if (
    !closing ||
    closing.payload.type !== "closed" ||
    closing.payload.poolId !== grantPacket.rumor.id ||
    closing.payload.writerId !== grant.writerId ||
    closing.payload.merchantPubkey !== grant.merchantPubkey ||
    closing.payload.organizerPubkey !== grant.organizerPubkey ||
    closing.rumor.created_at < grantPacket.rumor.created_at
  )
    throw new Error("Positive matching organizer closing frontier required")
  const close = closing.payload
  const nowMs = input.nowMs ?? Date.now()
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    closing.rumor.created_at * 1000 > nowMs ||
    input.committedAssignmentEvent.created_at * 1000 > nowMs
  )
    throw new Error("Closed stock history is future dated")
  const entries: EventMarketOrganizerStockEntry[] = []
  const packets: AuthenticatedEventMarketStockPacket[] = []
  for (const envelope of input.acceptedEnvelopes) {
    const packet = await inspectEventMarketStockPacket({ ...input, envelope })
    if (!packet || packet.payload.type !== "accepted")
      throw new Error("Authenticated organizer acceptance required")
    packets.push(packet)
  }
  packets.sort(
    (a, b) =>
      (a.payload.type === "accepted" ? a.payload.sequence : 0) -
      (b.payload.type === "accepted" ? b.payload.sequence : 0)
  )
  let previousId = grantPacket.rumor.id,
    total = 0,
    previousTime =
      (commitment.previousEventId === grant.assignmentEventId &&
      commitment.stockPool.pool.state === "active" &&
      commitment.stockPool.pool.importedQuantity === 0
        ? Math.max(grantPacket.rumor.created_at, commitment.createdAt)
        : grantPacket.rumor.created_at) * 1000
  if (packets.length !== close.sequence)
    throw new Error("Complete closed organizer prefix required")
  for (const [index, packet] of packets.entries()) {
    const accepted = packet.payload
    if (
      accepted.type !== "accepted" ||
      accepted.poolId !== grantPacket.rumor.id ||
      accepted.merchantPubkey !== grant.merchantPubkey ||
      accepted.organizerPubkey !== grant.organizerPubkey ||
      accepted.writerId !== grant.writerId ||
      accepted.sequence !== index + 1 ||
      accepted.previousId !== previousId ||
      accepted.acceptedAtMs < previousTime ||
      accepted.acceptedAtMs >= grant.expiresAtMs ||
      accepted.acceptedAtMs > closing.rumor.created_at * 1000 + 999
    )
      throw new Error("Closed organizer history is incomplete or conflicting")
    total += accepted.quantity
    previousId = packet.rumor.id
    previousTime = accepted.acceptedAtMs
    entries.push({
      id: `${input.authenticatedPubkey}:${packet.rumor.id}`,
      accountPubkey: input.authenticatedPubkey,
      poolId: grantPacket.rumor.id,
      sequence: accepted.sequence,
      orderId: accepted.orderId,
      claimRef: accepted.claimRef,
      rumor: packet.rumor,
      quantity: accepted.quantity,
      evidence: JSON.stringify({
        identityBinding: accepted.identityBinding,
        termsBinding: accepted.termsBinding,
      }),
      receivedEnvelope: packet.envelope,
      imported: false,
    })
  }
  if (
    total > grant.quantity ||
    total !== close.acceptedQuantity ||
    previousId !== close.lastAcceptedId
  )
    throw new Error("Closed organizer quantity/frontier mismatch")
  for (const envelope of input.handoutEnvelopes ?? []) {
    const handout = await inspectEventMarketStockPacket({ ...input, envelope })
    if (
      !handout ||
      handout.payload.type !== "handed_out" ||
      handout.payload.organizerPubkey !== grant.organizerPubkey ||
      handout.payload.merchantPubkey !== grant.merchantPubkey ||
      handout.payload.writerId !== grant.writerId ||
      handout.payload.handedOutAtMs > nowMs
    )
      throw new Error("Authenticated matching handout history required")
    const payload = handout.payload
    const released = payload.entries.find(
      (entry) => entry.poolId === grantPacket.rumor.id
    )
    const accepted =
      released &&
      entries.find((entry) => entry.rumor.id === released.acceptedId)
    const terms =
      accepted && parseEventMarketStockAuthorityRumor(accepted.rumor)
    if (
      !released ||
      !accepted ||
      !terms ||
      terms.type !== "accepted" ||
      terms.orderId !== payload.orderId ||
      terms.identityBinding !== payload.identityBinding ||
      terms.termsBinding !== payload.termsBinding ||
      terms.claimRef !== payload.claimRef ||
      released.quantity !== accepted.quantity ||
      payload.handedOutAtMs < terms.acceptedAtMs ||
      (accepted.handout &&
        !sameOrganizerStockRumor(accepted.handout.rumor, handout.rumor))
    )
      throw new Error(
        "Handout history conflicts with the complete closing prefix"
      )
    accepted.orderPoolBinding = JSON.stringify(
      payload.entries.map((entry) => ({
        poolId: entry.poolId,
        writerId: payload.writerId,
        quantity: entry.quantity,
      }))
    )
    accepted.handout = {
      rumor: clone(handout.rumor),
      receivedEnvelope: clone(handout.envelope),
    }
  }
  let reconciled = false
  if (input.closedAssignmentEvent) {
    const assignment = parseEventMarketAssignmentEvent(
      input.closedAssignmentEvent
    )
    if (
      !assignment ||
      input.closedAssignmentEvent.created_at * 1000 > nowMs ||
      assignment.coordinate !== grant.assignmentCoordinate ||
      assignment.createdAt < closing.rumor.created_at ||
      assignment.stockPool.state !== "valid" ||
      assignment.stockPool.pool.state !== "closed" ||
      assignment.stockPool.pool.poolId !== grantPacket.rumor.id ||
      assignment.stockPool.pool.organizerPubkey !== grant.organizerPubkey ||
      assignment.stockPool.pool.quantity !== grant.quantity ||
      assignment.stockPool.pool.importedQuantity !== total
    )
      throw new Error(
        "Merchant closed stock projection does not match the journal"
      )
    reconciled = true
  }
  await createEventMarketEvidenceStore(input.db).retain(
    grant.marketCoordinate,
    [
      input.committedAssignmentEvent,
      ...(input.closedAssignmentEvent ? [input.closedAssignmentEvent] : []),
    ]
  )
  authority.check()
  return input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
    ],
    async () => {
      authority.check()
      const id = poolKey(input.authenticatedPubkey, grantPacket.rumor.id)
      const prior = await input.db.eventMarketOrganizerStockPools.get(id)
      if (prior) validateOrganizerStockJournalPool(prior)
      const existing = await input.db.eventMarketOrganizerStockEntries
        .where("[accountPubkey+poolId]")
        .equals([input.authenticatedPubkey, grantPacket.rumor.id])
        .toArray()
      if (
        prior &&
        (!sameOrganizerStockRumor(prior.grantRumor, grantPacket.rumor) ||
          prior.writerId !== grant.writerId ||
          prior.acceptedSequence > close.sequence ||
          prior.acceptedQuantity > total ||
          prior.importedSequence > close.sequence ||
          prior.importedQuantity > total ||
          (prior.closingRumor &&
            !sameOrganizerStockRumor(prior.closingRumor, closing.rumor)))
      )
        throw new Error("Retained organizer history is stronger or conflicting")
      for (const entry of existing) {
        const exact = entries.find((candidate) => candidate.id === entry.id)
        if (
          !exact ||
          entry.accountPubkey !== exact.accountPubkey ||
          entry.poolId !== exact.poolId ||
          entry.sequence !== exact.sequence ||
          entry.orderId !== exact.orderId ||
          entry.claimRef !== exact.claimRef ||
          entry.quantity !== exact.quantity ||
          !sameOrganizerStockRumor(entry.rumor, exact.rumor) ||
          (entry.handout &&
            exact.handout &&
            !sameOrganizerStockRumor(entry.handout.rumor, exact.handout.rumor))
        )
          throw new Error(
            "Retained organizer entries conflict with the closing prefix"
          )
      }
      const overlapping = await input.db.eventMarketOrganizerStockPools
        .where("[accountPubkey+assignmentCoordinate]")
        .equals([input.authenticatedPubkey, grant.assignmentCoordinate])
        .toArray()
      if (
        overlapping.some(
          (pool) =>
            pool.poolId !== grantPacket.rumor.id && pool.state !== "closed"
        )
      )
        throw new Error(
          "Another organizer writer already holds this assignment"
        )
      const pool: EventMarketOrganizerStockPool = {
        ...(prior ?? {}),
        id,
        accountPubkey: input.authenticatedPubkey,
        poolId: grantPacket.rumor.id,
        merchantPubkey: grant.merchantPubkey,
        organizerPubkey: grant.organizerPubkey,
        writerId: grant.writerId,
        assignmentCoordinate: grant.assignmentCoordinate,
        productCoordinate: grant.productCoordinate,
        grantRumor: grantPacket.rumor,
        receivedEnvelope: clone(input.grantEnvelope),
        quantity: grant.quantity,
        acceptedQuantity: total,
        acceptedSequence: close.sequence,
        lastAcceptedId: close.lastAcceptedId,
        importedQuantity: reconciled ? total : (prior?.importedQuantity ?? 0),
        importedSequence: reconciled
          ? close.sequence
          : (prior?.importedSequence ?? 0),
        lastImportedId: reconciled
          ? close.lastAcceptedId
          : (prior?.lastImportedId ?? grantPacket.rumor.id),
        state: reconciled || prior?.state === "closed" ? "closed" : "closing",
        closingRumor: closing.rumor,
        receivedClosingEnvelope: input.closingEnvelope,
        readOnlyRecovery: true,
      }
      for (const entry of entries) {
        const saved = existing.find((candidate) => candidate.id === entry.id)
        if (!saved)
          await input.db.eventMarketOrganizerStockEntries.add({
            ...entry,
            imported: pool.state === "closed",
          })
        else if (
          (pool.state === "closed" && !saved.imported) ||
          (entry.handout && !saved.handout)
        )
          await input.db.eventMarketOrganizerStockEntries.put({
            ...saved,
            imported: pool.state === "closed" || saved.imported,
            ...(entry.handout
              ? {
                  handout: clone(entry.handout),
                  orderPoolBinding: entry.orderPoolBinding,
                }
              : {}),
          })
      }
      await input.db.eventMarketOrganizerStockPools.put(pool)
      authority.check()
      return pool
    }
  )
}
