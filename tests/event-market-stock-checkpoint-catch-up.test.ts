import { afterEach, expect, it, spyOn } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { matchFilter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import { ConduitDB } from "@conduit/core/db"
import { orderSchema, type OrderSchema } from "@conduit/core/schemas"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { buildEventMarketAuthorizationDraft } from "@conduit/core/protocol/event-market-authorization"
import { computeEventMarketAssignmentDTag } from "@conduit/core/protocol/event-market-assignment"
import { createEventMarketStockAuthorityRumor } from "@conduit/core/protocol/event-market-stock-authority"
import {
  commitOrganizerStockAcceptance,
  installOrganizerStockHandover,
  prepareMerchantOrganizerStockPool,
  prepareOrganizerStockEnvelopes,
} from "@conduit/core/protocol/event-market-stock-journal"
import {
  getOrganizerStockOrderBindings,
  importMerchantOrganizerStockOrder,
} from "@conduit/core/protocol/event-market-stock-import"
import {
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
  outstandingOrganizerStockHold,
  resumeMerchantInventoryPublication,
} from "@conduit/core/protocol/merchant-inventory"
import {
  openMerchantOrganizerStockCheckpoint,
  observeMerchantOrganizerStockCheckpoint,
  parseEventMarketStockCheckpointRumor,
  restoreMerchantOrganizerStockCheckpoint,
} from "@conduit/core/protocol/event-market-stock-checkpoint"
import { createEventMarketStockDiscovery } from "@conduit/core/protocol/event-market-stock-workflow"
import { createEventMarketEvidenceStore } from "@conduit/core/protocol/event-market-evidence-store"
import { snapshotSignedPublicEvent } from "@conduit/core/protocol/verified-public-event"
import { recoverMerchantOrganizerStockFromInbox } from "@conduit/core/protocol/merchant-inventory-recovery"
import { getFutureMarketClaimRef } from "@conduit/core/protocol/future-market-handoff"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import type { NostrKeySigner } from "@conduit/core/protocol/nostr-event-signer"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import type { ProtectedInboxReadResult } from "@conduit/core/protocol/protected-inbox-read"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import {
  buildEventMarketOrderRumorTags,
  serializeOrderRumorContent,
} from "@conduit/core/protocol/orders"
import {
  createPrivateMessageRumor,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"

const databases: ConduitDB[] = []
afterEach(async () => {
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

function database() {
  const selected = new ConduitDB(`stock-catch-up-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(selected)
  return selected
}

function signer(secret: Uint8Array) {
  const pubkey = getPublicKey(secret)
  const provider: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (peer, plaintext) =>
      nip44.encrypt(plaintext, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      nip44.decrypt(ciphertext, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy decryption is not used")
    },
  }
  return new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: "checkpoint-catch-up-test",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => true,
  })
}

const relay = "wss://relay.conduit.market"
function inboxResult(
  events: SignedPublicNostrEvent[]
): ProtectedInboxReadResult {
  return {
    events,
    coverage: "complete",
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: "success",
      observations: [{ type: "eose", relayIndex: 0 }],
      relays: [
        {
          relayIndex: 0,
          status: "success",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      authoritativeEmpty: events.length === 0,
    },
  }
}

async function fixture() {
  const original = database(),
    cold = database()
  const merchantSecret = generateSecretKey(),
    organizerSecret = generateSecretKey(),
    buyerSecret = generateSecretKey()
  const merchantSigner = signer(merchantSecret),
    organizerSigner = signer(organizerSecret),
    buyerSigner = signer(buyerSecret)
  const merchant = merchantSigner.pubkey,
    organizer = organizerSigner.pubkey
  installProtectedReadSigner(merchantSigner, merchant, () => true)
  const authorization = getProtectedReadAuthorization(merchant)!
  const originalStore = new CommerceInboxStore(authorization, original)
  const coldStore = new CommerceInboxStore(authorization, cold)
  const marketCoordinate = `30409:${organizer}:catch-up`,
    occurrenceCoordinate = `31923:${organizer}:catch-up`
  const productCoordinate = `30402:${merchant}:catch-up`
  const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ productCoordinate, marketCoordinate, occurrenceCoordinate })}`
  const market = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "catch-up",
        organizerPubkey: organizer,
        calendarCoordinate: occurrenceCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: merchant,
            mode: "organizer_handoff",
            assignment: "Organizer table",
          },
        ],
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const occurrence = finalizeEvent(
    {
      kind: 31923,
      created_at: 100,
      content: "",
      tags: [
        ["d", "catch-up"],
        ["title", "Market day"],
        ["start", "150"],
        ["end", "250"],
        ["location", "Square"],
        ["D", "0"],
      ],
    },
    organizerSecret
  )
  const admission = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: merchant,
        state: "active",
        sequence: 0,
        parentIds: [],
      }),
      created_at: 99,
    },
    organizerSecret
  )
  const sourceProduct = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", "catch-up"],
        ["title", "Stock item"],
        ["type", "simple", "physical"],
        ["price", "1", "SATS"],
        ["stock", "20"],
      ],
    },
    merchantSecret
  )
  const publish = () =>
    resumeMerchantInventoryPublication({
      db: original,
      merchantPubkey: merchant,
      stockCheckpoint: {
        signer: merchantSigner,
        shouldContinue: () => true,
        delivery: {
          deliveryStore: originalStore,
          resolveInboxRelays: async () => [relay],
          publishFn: async () => ({
            successfulRelayUrls: [relay],
            failedRelayUrls: [],
            attemptedRelayUrls: [relay],
            relayFailureMessages: {},
            plan: {} as never,
          }),
        },
      },
      sign: async (draft) => finalizeEvent(draft, merchantSecret),
      publish: async () => true,
    })
  await initializeMerchantInventoryProduct({
    db: original,
    productCoordinate,
    merchantPubkey: merchant,
    stock: 20,
    signedProductEvent: sourceProduct,
  })
  await commitMerchantInventoryAssignment({
    db: original,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: crypto.randomUUID(),
    nowMs: 100_000,
    context: {
      kind: "validated-event-market-assignment",
      productEventId: sourceProduct.id,
      marketEventId: market.id,
      occurrenceEventId: occurrence.id,
      grantEventId: admission.id,
      occurrenceEndMs: 250_000,
      terminal: false,
    },
  })
  expect((await publish()).pending).toBe(0)
  const initialAssignment =
    (await original.merchantInventoryAssignments.get(assignmentCoordinate))!
  const writerId = crypto.randomUUID()
  const grant = createEventMarketStockAuthorityRumor({
    createdAt: 101,
    payload: {
      type: "grant",
      version: 1,
      nonce: crypto.randomUUID(),
      merchantPubkey: merchant,
      organizerPubkey: organizer,
      writerId,
      productCoordinate,
      assignmentCoordinate,
      marketCoordinate,
      occurrenceCoordinate,
      productEventId: sourceProduct.id,
      assignmentEventId: initialAssignment.signedAssignmentEvent!.id,
      marketEventId: market.id,
      occurrenceEventId: occurrence.id,
      grantEventId: admission.id,
      quantity: 4,
      expiresAtMs: 240_000,
    },
  })
  await prepareMerchantOrganizerStockPool({
    db: original,
    authenticatedPubkey: merchant,
    grantRumor: grant,
    expectedAssignmentRevision: initialAssignment.revision,
    nowMs: 101_000,
  })
  await prepareOrganizerStockEnvelopes({
    db: original,
    signer: merchantSigner,
    authenticatedPubkey: merchant,
    shouldContinue: () => true,
    poolId: grant.id,
    work: "grant",
  })
  expect((await publish()).pending).toBe(0)
  const commitment = (await original.merchantInventoryAssignments.get(
    assignmentCoordinate
  ))!.signedAssignmentEvent!
  await installOrganizerStockHandover({
    db: original,
    authenticatedPubkey: organizer,
    writerId,
    grantRumor: grant,
    committedAssignmentEvent: commitment,
    nowMs: 102_000,
  })
  const checkpoint = async () =>
    openMerchantOrganizerStockCheckpoint({
      db: original,
      authenticatedPubkey: merchant,
      productCoordinate,
      checkpoint: (await original.merchantInventoryProducts.get(
        productCoordinate
      ))!.organizerStockCheckpoint!,
    })
  const first = await checkpoint()
  const firstPayload = parseEventMarketStockCheckpointRumor(first.rumor)
  const state = { current: true }
  const coldSession = {
    db: cold,
    signer: merchantSigner,
    authenticatedPubkey: merchant,
    authorization,
    store: coldStore,
    shouldContinue: () => state.current,
  }
  await coldStore.receive(first.selfEnvelope!, [relay])
  await restoreMerchantOrganizerStockCheckpoint({
    ...coldSession,
    envelope: first.selfEnvelope!,
    signedProductEvent: firstPayload.snapshot.product.signedProductEvent,
    signedAssignmentEvents: firstPayload.snapshot.assignments.map(
      (row) => row.signedAssignmentEvent!
    ),
  })
  expect(
    (await cold.eventMarketOrganizerStockPools.get(`${merchant}:${grant.id}`))!
      .importedQuantity
  ).toBe(0)
  const importQuantity = async (quantity: number, acceptedAtMs: number) => {
    const order: OrderSchema = orderSchema.parse({
      id: crypto.randomUUID(),
      merchantPubkey: merchant,
      buyerPubkey: buyerSigner.pubkey,
      items: [
        {
          productId: productCoordinate,
          title: "Stock item",
          format: "physical",
          quantity,
          priceAtPurchase: 1,
          currency: "SATS",
          sourcePrice: {
            amount: 1,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
          shippingCostSats: 0,
          fulfillment: {
            type: "event_market_pickup",
            organizerPubkey: organizer,
            merchantPubkey: merchant,
            payeePubkey: merchant,
            market: {
              coordinate: marketCoordinate,
              eventId: market.id,
              createdAt: 100_000,
              signedEvent: market,
            },
            calendar: {
              coordinate: occurrenceCoordinate,
              eventId: occurrence.id,
              createdAt: 100_000,
              start: 150_000,
              end: 250_000,
              signedEvent: occurrence,
            },
            grant: {
              kind: 3841,
              pubkey: organizer,
              eventId: admission.id,
              createdAt: 99_000,
              ancestryEventIds: [admission.id],
              observedDeletionEventIds: [],
              signedEvidence: {
                tip: admission,
                ancestry: [admission],
                deletions: [],
              },
            },
            product: {
              coordinate: productCoordinate,
              eventId: sourceProduct.id,
              createdAt: 100_000,
              signedEvent: sourceProduct,
            },
            occurrenceAssignment: {
              coordinate: assignmentCoordinate,
              eventId: commitment.id,
              createdAt: commitment.created_at * 1000,
              signedEvent: commitment,
            },
            mode: "organizer_handoff",
            assignment: "Organizer table",
          },
        },
      ],
      subtotal: quantity,
      currency: "SATS",
      shippingCostSats: 0,
      createdAt: 103_000,
    })
    const bindings = getOrganizerStockOrderBindings(order)
    const accepted = await commitOrganizerStockAcceptance({
      db: original,
      authenticatedPubkey: organizer,
      writerId,
      poolId: grant.id,
      orderId: order.id,
      identityBinding: bindings.identityHash,
      termsBinding: bindings.termsHash,
      claimRef: getFutureMarketClaimRef({
        orderId: order.id,
        merchantPubkey: merchant,
        organizerPubkey: organizer,
        marketCoordinate,
      }),
      quantity,
      evidence: bindings.termsBinding,
      nowMs: acceptedAtMs,
    })
    const wraps = await prepareOrganizerStockEnvelopes({
      db: original,
      signer: organizerSigner,
      authenticatedPubkey: organizer,
      poolId: grant.id,
      work: { entryId: accepted.entry.rumor.id },
      shouldContinue: () => true,
    })
    const buyerOrder = await wrapPrivateMessage(
      createPrivateMessageRumor({
        kind: 16,
        pubkey: buyerSigner.pubkey,
        created_at: 103,
        content: serializeOrderRumorContent(order),
        tags: [
          ["p", merchant],
          ["type", "order"],
          ["order", order.id],
          ...buildEventMarketOrderRumorTags(order),
        ],
      }),
      { pubkey: merchant },
      buyerSigner
    )
    await importMerchantOrganizerStockOrder({
      db: original,
      signer: merchantSigner,
      authenticatedPubkey: merchant,
      originalOrderEnvelope: buyerOrder,
      acceptedEnvelopes: [wraps.recipient],
      shouldContinue: () => true,
      nowMs: acceptedAtMs + 1000,
    })
    expect((await publish()).pending).toBe(0)
    return checkpoint()
  }
  const middle = await importQuantity(1, 104_000)
  const latest = await importQuantity(2, 106_000)
  const latestPayload = parseEventMarketStockCheckpointRumor(latest.rumor)
  expect(latestPayload.sequence).toBe(firstPayload.sequence + 2)
  expect(latestPayload.previousId).toBe(middle.rumor.id)
  const publicEvents = [
    market,
    occurrence,
    admission,
    latestPayload.snapshot.product.signedProductEvent,
    ...latestPayload.snapshot.assignments.map(
      (row) => row.signedAssignmentEvent!
    ),
    ...latestPayload.snapshot.pools.map((row) => row.initialCommitment),
  ]
  const dependencies: NonNullable<
    Parameters<typeof recoverMerchantOrganizerStockFromInbox>[1]
  > = {
    products: async () =>
      ({
        data: [
          {
            addressId: productCoordinate,
            product: {
              signedProductEvent:
                latestPayload.snapshot.product.signedProductEvent,
            },
          },
        ],
        meta: {},
      }) as never,
    read: {
      plan: async () =>
        ({ candidateRelayUrls: [relay], maxRelayAttempts: 1 }) as never,
      fetch: async (filter) => ({
        events: publicEvents.filter((event) => matchFilter(filter, event)),
        relays: [{ relayUrl: relay, status: "success" }],
      }),
    },
  }
  return {
    cold,
    merchant,
    merchantSigner,
    coldStore,
    coldSession,
    state,
    first,
    middle,
    latest,
    latestPayload,
    productCoordinate,
    assignmentCoordinate,
    poolId: grant.id,
    dependencies,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
async function discover(
  f: Fixture,
  envelopes = [f.middle.selfEnvelope!, f.latest.selfEnvelope!]
) {
  const scan = await createEventMarketStockDiscovery({
    ...f.coldSession,
    resolveDeclaration: async () => ({
      pubkey: f.merchant,
      state: "declared",
      relayUrls: [relay],
      stale: false,
      fetchedAt: Date.now(),
    }),
    read: async () => inboxResult(envelopes),
  })
  try {
    let page = await scan.nextPage()
    for (let count = 0; page.hasMore && count < 3; count++)
      page = await scan.nextPage()
    const candidates = page.packets.filter(
      (packet) => packet.payload.type === "merchant_checkpoint"
    )
    expect(candidates).toHaveLength(1)
    return candidates[0]!
  } finally {
    scan.dispose()
  }
}

async function pool(f: Fixture) {
  return (await f.cold.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.poolId}`
  ))!
}

async function fails(operation: Promise<unknown>) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure instanceof Error).toBe(true)
  return failure as Error
}

it("catches up an already recovered Merchant through available checkpoint predecessors discovered together", async () => {
  const f = await fixture(),
    selected = await discover(f)
  expect(selected.rumor.id === f.latest.rumor.id).toBe(true)
  // Both exact predecessor envelopes are available in the authenticated inbox;
  // the user should not need another device, data reset or stock write.
  const retained = new Set(
    (await f.coldStore.wrappers()).map((row) => row.event.id)
  )
  expect(
    [f.first, f.middle, f.latest].every((value) =>
      retained.has(value.selfEnvelope!.id)
    )
  ).toBe(true)
  const installedStocks: number[] = []
  const put = f.cold.merchantInventoryProducts.put.bind(
    f.cold.merchantInventoryProducts
  )
  const writes = spyOn(
    f.cold.merchantInventoryProducts,
    "put"
  ).mockImplementation(async (record, key) => {
    installedStocks.push(record.stock!)
    return put(record, key)
  })
  try {
    const restored = await recoverMerchantOrganizerStockFromInbox(
      { ...f.coldSession, envelope: selected.envelope },
      f.dependencies
    )
    expect(restored.state).toBe("ready")
    expect((await pool(f)).importedQuantity).toBe(3)
    expect(
      outstandingOrganizerStockHold(
        (await f.cold.merchantInventoryAssignments.get(f.assignmentCoordinate))!
      )
    ).toBe(1)
    expect(
      (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
    ).toBe(17)
    const replay = await recoverMerchantOrganizerStockFromInbox(
      { ...f.coldSession, envelope: selected.envelope },
      f.dependencies
    )
    expect(replay.state === "ready" && replay.alreadyCommitted).toBe(true)
    expect((await pool(f)).importedQuantity).toBe(3)
    expect(
      (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
    ).toBe(17)
    expect(installedStocks).toEqual([17])
  } finally {
    writes.mockRestore()
  }
})

it("keeps recovered stock unchanged when the retained checkpoint chain is missing its middle", async () => {
  const f = await fixture(),
    selected = await discover(f, [f.latest.selfEnvelope!])
  const before = await observeMerchantOrganizerStockCheckpoint({
    ...f.coldSession,
    envelope: f.latest.selfEnvelope!,
  })
  await fails(
    recoverMerchantOrganizerStockFromInbox(
      { ...f.coldSession, envelope: selected.envelope },
      f.dependencies
    )
  )
  expect((await pool(f)).importedQuantity).toBe(0)
  expect(
    (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
  ).toBe(20)
  const after = await observeMerchantOrganizerStockCheckpoint({
    ...f.coldSession,
    envelope: f.first.selfEnvelope!,
  })
  expect(after.observation.rumorId === f.latest.rumor.id).toBe(true)
  expect(after.observation.sequence).toBe(before.observation.sequence)
  expect(
    JSON.stringify(Array.from(after.row!.value.nonce)) ===
      JSON.stringify(Array.from(before.row!.value.nonce))
  ).toBe(true)
})

it("preserves the exact retained grant commitment representation when identical signed evidence is retained again", async () => {
  const f = await fixture()
  const initial = parseEventMarketStockCheckpointRumor(f.first.rumor).snapshot
    .pools[0]!.initialCommitment
  const assignment = parseEventMarketStockCheckpointRumor(f.first.rumor)
    .snapshot.assignments[0]!
  const key = `${assignment.marketCoordinate}:${initial.id}`
  const before = (await f.cold.eventMarketRosterEvidence.get(key))!
  const originalBytes = JSON.stringify(before.signedEvent)
  const store = createEventMarketEvidenceStore(f.cold)
  await store.retain(assignment.marketCoordinate, [
    snapshotSignedPublicEvent(initial),
  ])
  await store.retain(assignment.marketCoordinate, [
    snapshotSignedPublicEvent(initial),
  ])
  const after = (await f.cold.eventMarketRosterEvidence.get(key))!
  expect(JSON.stringify(after.signedEvent) === originalBytes).toBe(true)
  expect(after.discoveryBytes).toBeUndefined()
  await f.cold.eventMarketRosterEvidence.put({
    ...after,
    signedEvent: { ...after.signedEvent, tags: undefined } as never,
  })
  const incoming = snapshotSignedPublicEvent(initial)
  await store.retain(assignment.marketCoordinate, [incoming])
  const repaired = (await f.cold.eventMarketRosterEvidence.get(key))!
  expect(
    JSON.stringify(repaired.signedEvent) === JSON.stringify(incoming)
  ).toBe(true)
  expect(repaired.discoveryBytes).toBeUndefined()
})

it("does not let direct restore skip its exact predecessor without chain evidence", async () => {
  const f = await fixture()
  await discover(f)
  await fails(
    restoreMerchantOrganizerStockCheckpoint({
      ...f.coldSession,
      envelope: f.latest.selfEnvelope!,
      signedProductEvent: f.latestPayload.snapshot.product.signedProductEvent,
      signedAssignmentEvents: f.latestPayload.snapshot.assignments.map(
        (row) => row.signedAssignmentEvent!
      ),
    })
  )
  expect((await pool(f)).importedQuantity).toBe(0)
})

it("rejects a validly sealed predecessor that is not on the selected checkpoint ancestry", async () => {
  const f = await fixture()
  await discover(f)
  const alternate = createPrivateMessageRumor({
    ...f.middle.rumor,
    content: JSON.stringify({
      ...parseEventMarketStockCheckpointRumor(f.middle.rumor),
      previousId: f.latest.rumor.id,
    }),
  })
  const envelope = await wrapPrivateMessage(
    alternate,
    { pubkey: f.merchant },
    f.merchantSigner
  )
  await f.coldStore.receive(envelope, [relay])
  const input = {
    ...f.coldSession,
    envelope: f.latest.selfEnvelope!,
    predecessorEnvelopes: [envelope],
    signedProductEvent: f.latestPayload.snapshot.product.signedProductEvent,
    signedAssignmentEvents: f.latestPayload.snapshot.assignments.map(
      (row) => row.signedAssignmentEvent!
    ),
  }
  await fails(restoreMerchantOrganizerStockCheckpoint(input))
  expect((await pool(f)).importedQuantity).toBe(0)
  expect(
    (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
  ).toBe(20)
})

it("rejects an authenticated linked catch-up chain whose latest snapshot drops an imported frontier", async () => {
  const f = await fixture()
  const middlePayload = parseEventMarketStockCheckpointRumor(f.middle.rumor)
  const advancedMiddle = createPrivateMessageRumor({
    ...f.middle.rumor,
    content: JSON.stringify({
      ...middlePayload,
      snapshot: f.latestPayload.snapshot,
      snapshotKey: f.latestPayload.snapshotKey,
    }),
  })
  const regressingTip = createPrivateMessageRumor({
    ...f.latest.rumor,
    content: JSON.stringify({
      ...f.latestPayload,
      previousId: advancedMiddle.id,
      snapshot: middlePayload.snapshot,
      snapshotKey: middlePayload.snapshotKey,
    }),
  })
  // Each snapshot and each author seal is independently valid; their linked
  // progression is not. No intermediate availability may escape validation.
  parseEventMarketStockCheckpointRumor(advancedMiddle)
  parseEventMarketStockCheckpointRumor(regressingTip)
  const predecessor = await wrapPrivateMessage(
    advancedMiddle,
    { pubkey: f.merchant },
    f.merchantSigner
  )
  const tip = await wrapPrivateMessage(
    regressingTip,
    { pubkey: f.merchant },
    f.merchantSigner
  )
  await f.coldStore.receive(predecessor, [relay])
  await f.coldStore.receive(tip, [relay])
  const input = {
    ...f.coldSession,
    envelope: tip,
    predecessorEnvelopes: [predecessor],
    signedProductEvent: middlePayload.snapshot.product.signedProductEvent,
    signedAssignmentEvents: middlePayload.snapshot.assignments.map(
      (row) => row.signedAssignmentEvent!
    ),
  }
  await fails(restoreMerchantOrganizerStockCheckpoint(input))
  expect((await pool(f)).importedQuantity).toBe(0)
  expect(
    (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
  ).toBe(20)
})

it.each([
  { kind: "product", relation: "older" },
  { kind: "assignment", relation: "older" },
  { kind: "product", relation: "same-time-conflict" },
  { kind: "assignment", relation: "same-time-conflict" },
] as const)(
  "preserves an intermediate signed $kind frontier against a $relation final revision",
  async ({ kind, relation }) => {
    const f = await fixture()
    const middle = parseEventMarketStockCheckpointRumor(f.middle.rumor)
    const before =
      kind === "product"
        ? middle.snapshot.product.signedProductEvent
        : middle.snapshot.assignments[0]!.signedAssignmentEvent!
    const final =
      kind === "product"
        ? f.latestPayload.snapshot.product.signedProductEvent
        : f.latestPayload.snapshot.assignments[0]!.signedAssignmentEvent!
    const stronger = await f.merchantSigner.signEvent({
      ...before,
      created_at: final.created_at + (relation === "older" ? 1 : 0),
    })
    if (kind === "product")
      middle.snapshot.product.signedProductEvent = stronger
    else middle.snapshot.assignments[0]!.signedAssignmentEvent = stronger
    const snapshotKey = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(middle.snapshot))
        )
      )
    )
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
    const intermediate = createPrivateMessageRumor({
      ...f.middle.rumor,
      content: JSON.stringify({ ...middle, snapshotKey }),
    })
    const tip = createPrivateMessageRumor({
      ...f.latest.rumor,
      content: JSON.stringify({
        ...f.latestPayload,
        previousId: intermediate.id,
      }),
    })
    parseEventMarketStockCheckpointRumor(intermediate)
    parseEventMarketStockCheckpointRumor(tip)
    expect(stronger.id !== final.id).toBe(true)
    const predecessor = await wrapPrivateMessage(
      intermediate,
      { pubkey: f.merchant },
      f.merchantSigner
    )
    const selected = await wrapPrivateMessage(
      tip,
      { pubkey: f.merchant },
      f.merchantSigner
    )
    await f.coldStore.receive(predecessor, [relay])
    await f.coldStore.receive(selected, [relay])
    const input = {
      ...f.coldSession,
      envelope: selected,
      predecessorEnvelopes: [predecessor],
      signedProductEvent: f.latestPayload.snapshot.product.signedProductEvent,
      signedAssignmentEvents: f.latestPayload.snapshot.assignments.map(
        (row) => row.signedAssignmentEvent!
      ),
    }
    await fails(restoreMerchantOrganizerStockCheckpoint(input))
    expect((await pool(f)).importedQuantity).toBe(0)
    expect(
      (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
    ).toBe(20)
  }
)

it("does not install any intermediate stock when the session changes during predecessor decryption", async () => {
  const f = await fixture(),
    selected = await discover(f)
  const decrypt = f.merchantSigner.decryptNip44.bind(f.merchantSigner)
  const observationState = { predecessorOpened: false }
  const observation = spyOn(
    f.merchantSigner,
    "decryptNip44"
  ).mockImplementation(async (peer, ciphertext) => {
    const result = await decrypt(peer, ciphertext)
    if (ciphertext === f.middle.selfEnvelope!.content) {
      observationState.predecessorOpened = true
      f.state.current = false
    }
    return result
  })
  try {
    await fails(
      recoverMerchantOrganizerStockFromInbox(
        { ...f.coldSession, envelope: selected.envelope },
        f.dependencies
      )
    )
    expect(observationState.predecessorOpened).toBe(true)
    expect((await pool(f)).importedQuantity).toBe(0)
    expect(
      (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
    ).toBe(20)
  } finally {
    observation.mockRestore()
  }
})

it("does not overwrite a concurrent local stock change while installing the strongest recovered checkpoint", async () => {
  const f = await fixture(),
    selected = await discover(f)
  const originalTransaction = f.cold.transaction.bind(f.cold)
  const concurrency = { changed: false }
  const concurrent = spyOn(f.cold, "transaction").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const tables = args.slice(1, -1).flat()
    if (
      !concurrency.changed &&
      args[0] === "rw" &&
      tables.includes(f.cold.commerceInboxWrappers) &&
      tables.includes(f.cold.merchantInventoryAssignments) &&
      tables.includes(f.cold.eventMarketRosterEvidence)
    ) {
      concurrency.changed = true
      const product = (await f.cold.merchantInventoryProducts.get(
        f.productCoordinate
      ))!
      await f.cold.merchantInventoryProducts.put({ ...product, stock: 19 })
    }
    return (originalTransaction as (...input: unknown[]) => Promise<unknown>)(
      ...args
    )
  }) as never)
  try {
    await fails(
      recoverMerchantOrganizerStockFromInbox(
        { ...f.coldSession, envelope: selected.envelope },
        f.dependencies
      )
    )
    expect(concurrency.changed).toBe(true)
    expect((await pool(f)).importedQuantity).toBe(0)
    expect(
      (await f.cold.merchantInventoryProducts.get(f.productCoordinate))!.stock
    ).toBe(19)
  } finally {
    concurrent.mockRestore()
  }
})
