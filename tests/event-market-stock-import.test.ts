import { merchantOccurrenceAcceptanceBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import { afterEach, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import { matchFilter } from "nostr-tools"
import { ConduitDB } from "@conduit/core/db"
import { config } from "@conduit/core/config"
import {
  orderSchema,
  type OrderSchema,
  type OrderEventMarketPickupFulfillmentSchema,
} from "@conduit/core/schemas"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { buildEventMarketAuthorizationDraft } from "@conduit/core/protocol/event-market-authorization"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
} from "@conduit/core/protocol/event-market-stock-authority"
import {
  beginOrganizerStockClose,
  commitOrganizerStockAcceptance,
  commitOrganizerStockOrder,
  installOrganizerStockHandover,
  prepareMerchantOrganizerStockPool,
  prepareOrganizerStockEnvelopes,
} from "@conduit/core/protocol/event-market-stock-journal"
import {
  getOrganizerStockOrderBindings,
  importMerchantOrganizerStockOrder,
  reconcileMerchantOrganizerStockClose,
} from "@conduit/core/protocol/event-market-stock-import"
import {
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
  outstandingOrganizerStockHold,
  resumeMerchantInventoryPublication,
} from "@conduit/core/protocol/merchant-inventory"
import {
  computeEventMarketAssignmentDTag,
  parseEventMarketAssignmentEvent,
} from "@conduit/core/protocol/event-market-assignment"
import { getFutureMarketClaimRef } from "@conduit/core/protocol/future-market-handoff"
import {
  SessionSigner,
  SessionSignerError,
} from "@conduit/core/protocol/session-signer"
import {
  NostrSignerError,
  type NostrKeySigner,
} from "@conduit/core/protocol/nostr-event-signer"
import {
  buildEventMarketOrderRumorTags,
  serializeOrderRumorContent,
} from "@conduit/core/protocol/orders"
import {
  createPrivateMessageRumor,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  createEventMarketStockDiscovery,
  inspectEventMarketStockPacket,
  publishEventMarketStockWork,
  receiveOrganizerStockGrant,
  restoreClosedOrganizerStockJournal,
  restoreClosedOrganizerStockFromInbox,
  startMerchantOrganizerStockGrant,
} from "@conduit/core/protocol/event-market-stock-workflow"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import type { ProtectedInboxReadResult } from "@conduit/core/protocol/protected-inbox-read"
import type { PublishWithPlannerResult } from "@conduit/core/protocol/relay-publish"
import { db as sharedDb } from "@conduit/core/db"
import * as rosterReads from "@conduit/core/protocol/event-market-roster-read"
import * as authorizationReads from "@conduit/core/protocol/event-market-authorization-read"
import * as commerce from "@conduit/core/protocol/commerce"
import { resolveEventMarketRoster } from "@conduit/core/protocol/event-market-roster"
import { resolveEventMarketAuthorization } from "@conduit/core/protocol/event-market-authorization"
import { parseEventMarketCalendarEvent } from "@conduit/core/protocol/event-market"
import { parseProductEvent } from "@conduit/core/protocol/products"
import { saveMerchantOccurrenceAssignment } from "@conduit/core/protocol/merchant-occurrence-workflow"
import { admitFixtureEvent } from "./helpers/admit-event"
import {
  parseEventMarketStockCheckpointRumor,
  openMerchantOrganizerStockCheckpoint,
  observeMerchantOrganizerStockCheckpoint,
  publishMerchantOrganizerStockCheckpoint,
  restoreMerchantOrganizerStockCheckpoint,
} from "@conduit/core/protocol/event-market-stock-checkpoint"
import { recoverMerchantOrganizerStockFromInbox } from "@conduit/core/protocol/merchant-inventory-recovery"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import {
  deliverProductListingJob,
  prepareProductListingDeliveryJob,
  type ProductListingOutboxRepository,
} from "@conduit/core/protocol/product-listing-delivery"
import { deliverQueuedProductListings } from "../apps/merchant/src/lib/product-listing-delivery"
import { createEventMarketEvidenceStore } from "@conduit/core/protocol/event-market-evidence-store"
import { reserveMerchantOrganizerStockForAssignment } from "../apps/merchant/src/lib/event-market-stock-handover"
import { merchantOccurrenceAcceptanceBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import {
  openMerchantAcceptanceEvidence,
  merchantAcceptanceStore,
} from "@conduit/core/protocol/merchant-acceptance-privacy"

const databases: ConduitDB[] = []
const originalCommerceRelayUrls = [...config.commerceRelayUrls]
afterEach(async () => {
  config.commerceRelayUrls = [...originalCommerceRelayUrls]
  __resetProtectedReadSigner()
  for (const db of databases.splice(0)) await db.delete()
})

function signer(secret: Uint8Array, hasAuthority = () => true) {
  const pubkey = getPublicKey(secret)
  const provider: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => finalizeEvent(draft, secret),
    encryptNip44: async (peer, text) =>
      nip44.encrypt(text, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, text) =>
      nip44.decrypt(text, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Not used")
    },
  }
  return new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: "stock-import-test",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority,
  })
}

async function fails(operation: Promise<unknown>, message?: string) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (message) expect((failure as Error).message).toContain(message)
}

async function fixture(count = 1) {
  const db = new ConduitDB(`stock-import-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  const merchantSecret = generateSecretKey(),
    organizerSecret = generateSecretKey(),
    buyerSecret = generateSecretKey()
  const merchant = getPublicKey(merchantSecret),
    organizer = getPublicKey(organizerSecret),
    buyer = getPublicKey(buyerSecret)
  const merchantSigner = signer(merchantSecret),
    organizerSigner = signer(organizerSecret),
    buyerSigner = signer(buyerSecret)
  installProtectedReadSigner(merchantSigner, merchant, () => true)
  const writerId = crypto.randomUUID()
  const marketCoordinate = `30409:${organizer}:market`,
    occurrenceCoordinate = `31923:${organizer}:day`
  const market = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "market",
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
  const calendar = finalizeEvent(
    {
      kind: 31923,
      created_at: 100,
      content: "",
      tags: [
        ["d", "day"],
        ["title", "Day"],
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
  const publish = () =>
    resumeMerchantInventoryPublication({
      db,
      merchantPubkey: merchant,
      stockCheckpoint: {
        signer: merchantSigner,
        shouldContinue: () => true,
        delivery: {
          deliveryStore: getProtectedReadAuthorization(merchant)
            ? new CommerceInboxStore(
                getProtectedReadAuthorization(merchant)!,
                db
              )
            : undefined,
          resolveInboxRelays: async () => ["wss://relay.conduit.market"],
          publishFn: async () => ack("wss://relay.conduit.market"),
        },
      },
      sign: async (draft) => finalizeEvent(draft, merchantSecret),
      publish: async () => true,
    })
  const products = [] as Array<{
    coordinate: string
    assignmentCoordinate: string
    product: SignedPublicNostrEvent
    commitment: SignedPublicNostrEvent
    poolId: string
    fulfillment: OrderEventMarketPickupFulfillmentSchema
  }>
  for (let index = 0; index < count; index++) {
    const coordinate = `30402:${merchant}:item-${index}`
    const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ productCoordinate: coordinate, marketCoordinate, occurrenceCoordinate })}`
    const product = finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        content: "",
        tags: [
          ["d", `item-${index}`],
          ["title", "Stock item"],
          ["type", "simple", "physical"],
          ["price", "1", "SATS"],
          ["stock", "20"],
        ],
      },
      merchantSecret
    )
    await initializeMerchantInventoryProduct({
      db,
      productCoordinate: coordinate,
      merchantPubkey: merchant,
      stock: 20,
      signedProductEvent: product,
    })
    await commitMerchantInventoryAssignment({
      db,
      productCoordinate: coordinate,
      assignmentCoordinate,
      marketCoordinate,
      occurrenceCoordinate,
      inventory: { mode: "tracked", quantity: 6 },
      state: "active",
      fulfillmentMethods: ["pickup"],
      expectedRevision: null,
      mutationId: `initial-${index}`,
      context: {
        kind: "validated-event-market-assignment",
        productEventId: product.id,
        marketEventId: market.id,
        occurrenceEventId: calendar.id,
        grantEventId: admission.id,
        occurrenceEndMs: 250_000,
        terminal: false,
      },
      nowMs: 100_000,
    })
    await publish()
    const assignment =
      (await db.merchantInventoryAssignments.get(assignmentCoordinate))!
    const grantRumor = createEventMarketStockAuthorityRumor({
      createdAt: 101,
      payload: {
        type: "grant",
        version: 1,
        nonce: crypto.randomUUID(),
        merchantPubkey: merchant,
        organizerPubkey: organizer,
        writerId,
        productCoordinate: coordinate,
        assignmentCoordinate,
        marketCoordinate,
        occurrenceCoordinate,
        productEventId: product.id,
        assignmentEventId: assignment.signedAssignmentEvent!.id,
        marketEventId: market.id,
        occurrenceEventId: calendar.id,
        grantEventId: admission.id,
        quantity: 4,
        expiresAtMs: 240_000,
      },
    })
    await prepareMerchantOrganizerStockPool({
      db,
      authenticatedPubkey: merchant,
      grantRumor,
      expectedAssignmentRevision: assignment.revision,
      nowMs: 101_000,
    })
    await prepareOrganizerStockEnvelopes({
      db,
      signer: merchantSigner,
      authenticatedPubkey: merchant,
      shouldContinue: () => true,
      poolId: grantRumor.id,
      work: "grant",
    })
    await publish()
    const commitment = (await db.merchantInventoryAssignments.get(
      assignmentCoordinate
    ))!.signedAssignmentEvent!
    await installOrganizerStockHandover({
      db,
      authenticatedPubkey: organizer,
      writerId,
      grantRumor,
      committedAssignmentEvent: commitment,
      nowMs: 102_000,
    })
    const fulfillment: OrderEventMarketPickupFulfillmentSchema = {
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
        eventId: calendar.id,
        createdAt: 100_000,
        start: 150_000,
        end: 250_000,
        signedEvent: calendar,
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
        coordinate,
        eventId: product.id,
        createdAt: 100_000,
        signedEvent: product,
      },
      occurrenceAssignment: {
        coordinate: assignmentCoordinate,
        eventId: commitment.id,
        createdAt: commitment.created_at * 1000,
        signedEvent: commitment,
      },
      mode: "organizer_handoff",
      assignment: "Organizer table",
    }
    products.push({
      coordinate,
      assignmentCoordinate,
      product,
      commitment,
      poolId: grantRumor.id,
      fulfillment,
    })
  }
  const order = (quantity = 2, id = crypto.randomUUID()) =>
    orderSchema.parse({
      id,
      merchantPubkey: merchant,
      buyerPubkey: buyer,
      items: products.map((product) => ({
        productId: product.coordinate,
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
        fulfillment: product.fulfillment,
      })),
      subtotal: quantity * products.length,
      currency: "SATS",
      shippingCostSats: 0,
      createdAt: 103_000,
    })
  const original = async (value: OrderSchema, source = buyerSigner) => {
    const rumor = createPrivateMessageRumor({
      kind: 16,
      pubkey: source.pubkey,
      created_at: 103,
      content: serializeOrderRumorContent(value),
      tags: [
        ["p", merchant],
        ["type", "order"],
        ["order", value.id],
        ...buildEventMarketOrderRumorTags(value),
      ],
    })
    return wrapPrivateMessage(rumor, { pubkey: merchant }, source)
  }
  const accept = async (value: OrderSchema, nowMs = 104_000) => {
    const bindings = getOrganizerStockOrderBindings(value)
    const envelopes: SignedPublicNostrEvent[] = []
    for (const product of products) {
      const quantity = value.items
        .filter((item) => item.productId === product.coordinate)
        .reduce((sum, item) => sum + item.quantity, 0)
      const result = await commitOrganizerStockAcceptance({
        db,
        authenticatedPubkey: organizer,
        writerId,
        poolId: product.poolId,
        orderId: value.id,
        identityBinding: bindings.identityHash,
        termsBinding: bindings.termsHash,
        claimRef: getFutureMarketClaimRef({
          orderId: value.id,
          merchantPubkey: merchant,
          organizerPubkey: organizer,
          marketCoordinate,
        }),
        quantity,
        evidence: bindings.termsBinding,
        nowMs,
      })
      const wraps = await prepareOrganizerStockEnvelopes({
        db,
        signer: organizerSigner,
        authenticatedPubkey: organizer,
        poolId: product.poolId,
        work: { entryId: result.entry.rumor.id },
        shouldContinue: () => true,
      })
      envelopes.push(wraps.recipient)
    }
    return envelopes
  }
  const importOrder = async (
    value: OrderSchema,
    envelopes: readonly SignedPublicNostrEvent[],
    nowMs = 105_000
  ) => {
    return importMerchantOrganizerStockOrder({
      db,
      signer: merchantSigner,
      authenticatedPubkey: merchant,
      originalOrderEnvelope: await original(value),
      acceptedEnvelopes: envelopes,
      shouldContinue: () => true,
      nowMs,
    })
  }
  const close = async (index = 0) => {
    const product = products[index]!
    await beginOrganizerStockClose({
      db,
      authenticatedPubkey: organizer,
      writerId,
      poolId: product.poolId,
      nowMs: 106_000,
    })
    return (
      await prepareOrganizerStockEnvelopes({
        db,
        signer: organizerSigner,
        authenticatedPubkey: organizer,
        poolId: product.poolId,
        work: "close",
        shouldContinue: () => true,
      })
    ).recipient
  }
  return {
    db,
    merchant,
    organizer,
    buyer,
    merchantSecret,
    organizerSecret,
    merchantSigner,
    organizerSigner,
    buyerSigner,
    writerId,
    marketCoordinate,
    occurrenceCoordinate,
    products,
    order,
    original,
    accept,
    importOrder,
    close,
    publish,
  }
}

it("imports the authenticated original order once using the shared stock owner", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const result = await f.importOrder(order, envelopes)
  expect(result.replayed).toBe(false)
  expect(result.order.organizerImport?.entries).toHaveLength(1)
  expect(result.order.identityBinding).toBe(
    merchantOccurrenceAcceptanceBindings(order).identityBinding
  )
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
  const assignment = (await f.db.merchantInventoryAssignments.get(
    f.products[0]!.assignmentCoordinate
  ))!
  expect(assignment.inventory).toEqual({ mode: "tracked", quantity: 4 })
  expect(outstandingOrganizerStockHold(assignment)).toBe(2)
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
  expect(
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.merchant)
      .count()
  ).toBe(1)
})

it("protects imported private order evidence while preserving exact replay and closing", async () => {
  const f = await fixture()
  const order = orderSchema.parse({
    ...f.order(),
    note: "SYNTHETIC_IMPORT_PRIVATE_NOTE",
    buyerIdentityKind: "guest_ephemeral",
    guestContact: { email: "synthetic-import@example.test" },
  })
  const envelopes = await f.accept(order)
  const accepted = await f.importOrder(order, envelopes)
  const entries = await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .toArray()
  for (const value of [
    order.note!,
    order.guestContact!.email!,
    order.buyerPubkey,
  ])
    expect(JSON.stringify([accepted.order, entries]).includes(value)).toBe(
      false
    )
  expect(accepted.order.evidenceFormat).toBe("device-encrypted-v1")
  expect(accepted.order.termsBinding).toMatch(/^sha256:[a-f0-9]{64}$/)
  f.db.close({ disableAutoOpen: false })
  await f.db.open()
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: await f.close(),
    nowMs: 500_000,
  })
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
})

for (const acceptedAlreadyEncrypted of [false, true]) {
  it(`repairs legacy imported entries atomically without changing stock (accepted encrypted=${acceptedAlreadyEncrypted})`, async () => {
    const f = await fixture()
    const order = orderSchema.parse({
      ...f.order(),
      note: "SYNTHETIC_LEGACY_IMPORT_NOTE",
    })
    const envelopes = await f.accept(order)
    const encrypted = (await f.importOrder(order, envelopes)).order
    const bindings = getOrganizerStockOrderBindings(order)
    const {
      evidenceFormat: _format,
      evidenceBinding: _binding,
      ...decision
    } = encrypted
    void _format
    void _binding
    const legacy = {
      ...decision,
      identityBinding: bindings.identityBinding,
      termsBinding: bindings.termsBinding,
      evidence: bindings.termsBinding,
    }
    if (!acceptedAlreadyEncrypted)
      await f.db.merchantInventoryAcceptedOrders.put(legacy)
    const entry = (await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.merchant)
      .first())!
    await f.db.eventMarketOrganizerStockEntries.update(entry.id, {
      evidence: bindings.termsBinding,
    })
    const before = await f.db.merchantInventoryAcceptedOrders.get(order.id)
    const failWrite = spyOn(
      f.db.eventMarketOrganizerStockEntries,
      "put"
    ).mockRejectedValue(new Error("Synthetic entry repair persistence failure"))
    try {
      await fails(
        f.importOrder(order, envelopes),
        "Synthetic entry repair persistence failure"
      )
      expect(
        JSON.stringify(
          await f.db.merchantInventoryAcceptedOrders.get(order.id)
        ) === JSON.stringify(before)
      ).toBe(true)
      expect(
        (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!
          .evidence === bindings.termsBinding
      ).toBe(true)
    } finally {
      failWrite.mockRestore()
    }
    const replay = await f.importOrder(order, envelopes)
    expect(replay.replayed).toBe(true)
    expect(replay.order.acceptedAt).toBe(encrypted.acceptedAt)
    expect(
      (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!.evidence
    ).toBe(replay.order.evidenceBinding!)
    expect(JSON.stringify(replay.order).includes(order.note!)).toBe(false)
    expect(
      (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!
        .stock
    ).toBe(18)
  })
}

it("does not report a concurrent partial privacy repair complete while imported evidence remains plaintext", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const encrypted = (await f.importOrder(order, envelopes)).order
  const wire = getOrganizerStockOrderBindings(order)
  const {
    evidenceFormat: _format,
    evidenceBinding: _binding,
    ...decision
  } = encrypted
  void _format
  void _binding
  await f.db.merchantInventoryAcceptedOrders.put({
    ...decision,
    identityBinding: wire.identityBinding,
    termsBinding: wire.termsBinding,
    evidence: wire.termsBinding,
  })
  const entry = (await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .first())!
  await f.db.eventMarketOrganizerStockEntries.update(entry.id, {
    evidence: wire.termsBinding,
  })
  const originalSeal = CommerceInboxStore.prototype.seal
  const concurrent = spyOn(
    CommerceInboxStore.prototype,
    "seal"
  ).mockImplementation(async function (
    this: CommerceInboxStore,
    ...args: Parameters<typeof originalSeal>
  ) {
    const cipher = await originalSeal.apply(this, args)
    await f.db.merchantInventoryAcceptedOrders.put(encrypted)
    return cipher
  })
  try {
    await fails(
      f.importOrder(order, envelopes),
      "changed during privacy migration"
    )
  } finally {
    concurrent.mockRestore()
  }
  expect(
    (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!.evidence ===
      wire.termsBinding
  ).toBe(true)
  const replay = await f.importOrder(order, envelopes)
  expect(replay.replayed).toBe(true)
  expect(
    (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!.evidence
  ).toBe(replay.order.evidenceBinding!)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
})

it("requires the exact connected Merchant signer and DB key before importing private evidence", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const replacement = signer(f.merchantSecret)
  installProtectedReadSigner(replacement, f.merchant, () => true)
  await fails(f.importOrder(order, envelopes), "session changed")
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  installProtectedReadSigner(f.merchantSigner, f.merchant, () => true)
  const accepted = (await f.importOrder(order, envelopes)).order
  const otherDb = new ConduitDB(
    `private-evidence-other-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  databases.push(otherDb)
  await expect(
    openMerchantAcceptanceEvidence(
      accepted,
      merchantAcceptanceStore(f.merchant, otherDb)
    )
  ).rejects.toThrow()
  expect(
    await openMerchantAcceptanceEvidence(
      accepted,
      merchantAcceptanceStore(f.merchant, f.db)
    )
  ).toBe(JSON.stringify(order))
})

it("does not debit stock when the protected Merchant lease is revoked during privacy preparation", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const originalSeal = CommerceInboxStore.prototype.seal
  const revoke = spyOn(CommerceInboxStore.prototype, "seal").mockImplementation(
    async function (
      this: CommerceInboxStore,
      ...args: Parameters<typeof originalSeal>
    ) {
      const cipher = await originalSeal.apply(this, args)
      __resetProtectedReadSigner()
      return cipher
    }
  )
  try {
    await fails(f.importOrder(order, envelopes), "authority is unavailable")
  } finally {
    revoke.mockRestore()
  }
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(20)
  expect(
    (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.importedQuantity
  ).toBe(0)
})

it("imports every product pool in one order atomically and replays independently of envelope order", async () => {
  const f = await fixture(2),
    order = f.order(),
    envelopes = await f.accept(order)
  await fails(f.importOrder(order, envelopes.slice(0, 1)), "Every delegated")
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map(
      (product) => product.stock
    )
  ).toEqual([20, 20])
  await f.importOrder(order, envelopes)
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map(
      (product) => product.stock
    )
  ).toEqual([18, 18])
  expect((await f.importOrder(order, [...envelopes].reverse())).replayed).toBe(
    true
  )
})

it("retains the complete canonical pool manifest on every imported order entry", async () => {
  const f = await fixture(2),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const entries = await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .toArray()
  const binding = JSON.stringify(
    entries
      .map((entry) => ({
        poolId: entry.poolId,
        writerId: f.writerId,
        quantity: entry.quantity,
      }))
      .sort((left, right) => left.poolId.localeCompare(right.poolId))
  )
  expect(entries).toHaveLength(2)
  expect(entries.every((entry) => entry.orderPoolBinding === binding)).toBe(
    true
  )
  await f.importOrder(order, [...envelopes].reverse())
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map((row) => row.stock)
  ).toEqual([18, 18])
})

it("repairs an exact historical import's missing manifest without a second stock debit", async () => {
  const f = await fixture(2),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const entries = await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .toArray()
  const binding = entries[0]!.orderPoolBinding
  expect(binding).toBeDefined()
  for (const entry of entries)
    await f.db.eventMarketOrganizerStockEntries.update(entry.id, {
      orderPoolBinding: undefined,
    })
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
  for (const entry of entries)
    expect(
      (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!
        .orderPoolBinding
    ).toBe(binding)
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map((row) => row.stock)
  ).toEqual([18, 18])
})

it("rejects conflicting imported and staged manifests without partial repair or debit", async () => {
  const f = await fixture(2),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const entries = (
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.merchant)
      .toArray()
  ).sort((left, right) => left.poolId.localeCompare(right.poolId))
  const first = entries[0]!,
    second = entries[1]!
  await f.db.eventMarketOrganizerStockEntries.update(first.id, {
    orderPoolBinding: undefined,
  })
  await f.db.eventMarketOrganizerStockEntries.update(second.id, {
    orderPoolBinding: "[]",
  })
  await fails(f.importOrder(order, envelopes), "requires reconciliation")
  expect(
    (await f.db.eventMarketOrganizerStockEntries.get(first.id))!
      .orderPoolBinding
  ).toBeUndefined()
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map((row) => row.stock)
  ).toEqual([18, 18])

  const fresh = await fixture(),
    freshOrder = fresh.order(),
    freshEnvelopes = await fresh.accept(freshOrder),
    organizerEntry = (await fresh.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(fresh.organizer)
      .first())!
  await fresh.db.eventMarketOrganizerStockEntries.add({
    ...organizerEntry,
    id: `${fresh.merchant}:${organizerEntry.rumor.id}`,
    accountPubkey: fresh.merchant,
    evidence: getOrganizerStockOrderBindings(freshOrder).termsBinding,
    orderPoolBinding: "[]",
    imported: false,
  })
  await fails(
    fresh.importOrder(freshOrder, freshEnvelopes),
    "conflicts with its accepted order"
  )
  expect(
    (await fresh.db.merchantInventoryProducts.get(
      fresh.products[0]!.coordinate
    ))!.stock
  ).toBe(20)
})

it("rolls back all product and pool decisions when an entry cannot be retained", async () => {
  const f = await fixture(2),
    order = f.order(),
    envelopes = await f.accept(order)
  const fault = spyOn(
    f.db.eventMarketOrganizerStockEntries,
    "put"
  ).mockRejectedValueOnce(new Error("disk failure"))
  await fails(f.importOrder(order, envelopes), "disk failure")
  fault.mockRestore()
  expect(
    (await f.db.merchantInventoryProducts.toArray()).map(
      (product) => product.stock
    )
  ).toEqual([20, 20])
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  expect(
    (
      await f.db.eventMarketOrganizerStockPools
        .where("accountPubkey")
        .equals(f.merchant)
        .toArray()
    ).every((pool) => pool.importedQuantity === 0)
  ).toBe(true)
  await f.importOrder(order, envelopes)
})

it("honors historical delegated sales after removal and expiry without negative allocation", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    product = f.products[0]!
  await f.db.merchantInventoryAssignments.update(product.assignmentCoordinate, {
    state: "removed",
    inventory: { mode: "tracked", quantity: 0 },
    terminal: true,
  })
  await f.importOrder(order, envelopes, 300_000)
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(18)
  const assignment = (await f.db.merchantInventoryAssignments.get(
    product.assignmentCoordinate
  ))!
  expect(assignment.inventory).toEqual({ mode: "tracked", quantity: 0 })
  expect(outstandingOrganizerStockHold(assignment)).toBe(2)
})

it("rejects a reused order ID with changed original terms", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  await fails(f.importOrder(f.order(1, order.id), envelopes), "original order")
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
})

it("rejects an ordinary accepted ID without positive durable legacy debit provenance", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    bindings = getOrganizerStockOrderBindings(order)
  await f.db.merchantInventoryAcceptedOrders.add({
    orderId: order.id,
    merchantPubkey: f.merchant,
    identityBinding: bindings.identityBinding,
    termsBinding: bindings.termsBinding,
    evidence: bindings.termsBinding,
    items: [],
    acceptedAt: 104_000,
  })
  await fails(f.importOrder(order, envelopes), "lacks verified")
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(20)
})

it("releases unused stock only after importing the complete authenticated closing prefix", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    closingEnvelope = await f.close()
  const close = () =>
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
      nowMs: 300_000,
    })
  await fails(close(), "Import every")
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(4)
  await f.importOrder(order, envelopes)
  const result = await close()
  expect(result.pool.state).toBe("closed")
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(0)
  expect((await close()).replayed).toBe(true)
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
})

it("does not close a partial prefix or trust a modified retained organizer entry", async () => {
  const f = await fixture(),
    first = f.order(1),
    second = f.order(1),
    one = await f.accept(first),
    two = await f.accept(second, 105_000)
  await f.importOrder(first, one)
  const closingEnvelope = await f.close()
  const close = () =>
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
    })
  await fails(close(), "Import every")
  await f.importOrder(second, two, 106_000)
  const entry = (await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .first())!
  await f.db.eventMarketOrganizerStockEntries.update(entry.id, { quantity: 3 })
  await fails(close(), "incomplete or conflicting")
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(2)
})

it("serializes concurrent exact imports without a second debit", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const results = await Promise.all([
    f.importOrder(order, envelopes),
    f.importOrder(order, envelopes),
  ])
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true])
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
})

it("rejects altered authenticated organizer identity and grant writer", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  const row = (await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizer)
    .first())!
  const payload = parseEventMarketStockAuthorityRumor(row.rumor)
  if (payload.type !== "accepted") throw new Error("Acceptance required")
  const rumor = createEventMarketStockAuthorityRumor({
    payload: { ...payload, writerId: crypto.randomUUID() },
    createdAt: row.rumor.created_at,
  })
  const altered = await wrapPrivateMessage(
    rumor,
    { pubkey: f.merchant },
    f.organizerSigner
  )
  await fails(f.importOrder(order, [altered]), "exceeds its grant")
  await fails(
    importMerchantOrganizerStockOrder({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      originalOrderEnvelope: await f.original(order, f.organizerSigner),
      acceptedEnvelopes: envelopes,
      shouldContinue: () => true,
      nowMs: 105_000,
    }),
    "Buyer order"
  )
})

it("adopts a positively applied legacy same-order debit without consuming it twice", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    product = f.products[0]!,
    bindings = getOrganizerStockOrderBindings(order)
  const projected = finalizeEvent(
    {
      kind: 30402,
      created_at: 104,
      content: product.product.content,
      tags: product.product.tags.map((tag) =>
        tag[0] === "stock" ? ["stock", "18"] : [...tag]
      ),
    },
    f.merchantSecret
  )
  await f.db.merchantInventoryProducts.update(product.coordinate, {
    stock: 18,
    signedProductEvent: projected,
  })
  await f.db.localProductStockCheckpoints.add({
    id: crypto.randomUUID(),
    merchantPubkey: f.merchant,
    orderId: order.id,
    productAddressId: product.coordinate,
    sourceEventId: product.product.id,
    signedEventId: projected.id,
    state: "applied",
    committedAt: 104_000,
    adjustment: {
      key: crypto.randomUUID(),
      addressId: product.coordinate,
      sourceEventId: product.product.id,
      title: "Stock item",
      quantity: 2,
      currentStock: 20,
      nextStock: 18,
      shortfall: 0,
    },
  })
  await f.db.merchantInventoryAcceptedOrders.add({
    orderId: order.id,
    merchantPubkey: f.merchant,
    identityBinding: bindings.identityBinding,
    termsBinding: bindings.termsBinding,
    evidence: bindings.termsBinding,
    items: [],
    acceptedAt: 104_000,
  })
  const result = await f.importOrder(order, envelopes)
  expect(result.replayed).toBe(true)
  expect(result.order.organizerImport?.entries).toHaveLength(1)
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(18)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        product.assignmentCoordinate
      ))!
    )
  ).toBe(2)
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
  expect(await f.db.localProductStockCheckpoints.count()).toBe(1)
})

it("does not credit a merely pending prior stock checkpoint", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    product = f.products[0]!
  await f.db.localProductStockCheckpoints.add({
    id: crypto.randomUUID(),
    merchantPubkey: f.merchant,
    orderId: order.id,
    productAddressId: product.coordinate,
    sourceEventId: product.product.id,
    signedEventId: product.product.id,
    state: "pending",
    committedAt: 104_000,
    adjustment: {
      key: crypto.randomUUID(),
      addressId: product.coordinate,
      sourceEventId: product.product.id,
      title: "Stock item",
      quantity: 2,
      currentStock: 20,
      nextStock: 18,
      shortfall: 0,
    },
  })
  await fails(f.importOrder(order, envelopes), "not durably confirmed")
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(20)
})

it("preserves a stronger observed journal frontier when importing its next exact staged entry", async () => {
  const f = await fixture(),
    first = f.order(1),
    second = f.order(1),
    one = await f.accept(first),
    two = await f.accept(second, 105_000),
    product = f.products[0]!
  const organizerPool = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${product.poolId}`
  ))!
  await f.db.eventMarketOrganizerStockPools.update(
    `${f.merchant}:${product.poolId}`,
    {
      acceptedSequence: organizerPool.acceptedSequence,
      acceptedQuantity: organizerPool.acceptedQuantity,
      lastAcceptedId: organizerPool.lastAcceptedId,
    }
  )
  const original = (await f.db.eventMarketOrganizerStockEntries
    .where("[accountPubkey+poolId+orderId]")
    .equals([f.organizer, product.poolId, first.id])
    .first())!
  await f.db.eventMarketOrganizerStockEntries.add({
    ...original,
    id: `${f.merchant}:${original.rumor.id}`,
    accountPubkey: f.merchant,
    receivedEnvelope: one[0]!,
    wraps: undefined,
  })
  await f.importOrder(first, one)
  const pool = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${product.poolId}`
  ))!
  expect(pool.importedSequence).toBe(1)
  expect(pool.acceptedSequence).toBe(2)
  expect(pool.lastAcceptedId).toBe(organizerPool.lastAcceptedId)
  await f.importOrder(second, two, 106_000)
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(18)
})

it("requires the preceding organizer journal entry instead of importing a gap", async () => {
  const f = await fixture(),
    first = f.order(1),
    second = f.order(1),
    one = await f.accept(first),
    two = await f.accept(second, 105_000)
  await fails(f.importOrder(second, two, 106_000), "next held journal entry")
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  await f.importOrder(first, one)
  await f.importOrder(second, two, 106_000)
})

it("does not overwrite conflicting pre-staged acceptance metadata", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    product = f.products[0]!
  const row = (await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizer)
    .first())!
  await f.db.eventMarketOrganizerStockEntries.add({
    ...row,
    id: `${f.merchant}:${row.rumor.id}`,
    accountPubkey: f.merchant,
    quantity: 1,
  })
  await fails(f.importOrder(order, envelopes), "conflicts")
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(20)
})

it("rolls back stock and imported provenance when the authenticated session changes during commit", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    originalOrderEnvelope = await f.original(order)
  let active = true
  const put = f.db.eventMarketOrganizerStockPools.put.bind(
    f.db.eventMarketOrganizerStockPools
  )
  const change = spyOn(
    f.db.eventMarketOrganizerStockPools,
    "put"
  ).mockImplementation(async (...args) => {
    const result = await put(...args)
    active = false
    return result
  })
  await fails(
    importMerchantOrganizerStockOrder({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      originalOrderEnvelope,
      acceptedEnvelopes: envelopes,
      shouldContinue: () => active,
      nowMs: 105_000,
    }),
    "session changed"
  )
  change.mockRestore()
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(20)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(4)
})

it("keeps the upstream product-terms compare-and-swap guard during delegated import", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    product = f.products[0]!
  const get = f.db.merchantInventoryProducts.get.bind(
    f.db.merchantInventoryProducts
  )
  const replacement = finalizeEvent(
    {
      kind: 30402,
      created_at: 105,
      content: "An ordinary listing edit",
      tags: product.product.tags.map((tag) => [...tag]),
    },
    f.merchantSecret
  )
  let reads = 0
  const change = spyOn(
    f.db.merchantInventoryProducts,
    "get"
  ).mockImplementation(async (key) => {
    const row = await get(key)
    if (++reads === 1)
      await f.db.merchantInventoryProducts.update(product.coordinate, {
        sourceProductEvent: replacement,
      })
    return row
  })
  await fails(f.importOrder(order, envelopes), "product changed")
  change.mockRestore()
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(20)
  expect(await f.db.merchantInventoryAcceptedOrders.count()).toBe(0)
})

it("copies all incoming wrappers before asynchronous signer work", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    originalOrderEnvelope = await f.original(order)
  const operation = importMerchantOrganizerStockOrder({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    originalOrderEnvelope,
    acceptedEnvelopes: envelopes,
    shouldContinue: () => true,
    nowMs: 105_000,
  })
  Object.assign(originalOrderEnvelope, { content: "changed" })
  envelopes.splice(0)
  expect((await operation).order.orderId).toBe(order.id)
})

it("closes an unused pool without waiting for expiry, retaining a replay marker and projection", async () => {
  const f = await fixture(),
    closingEnvelope = await f.close(),
    product = f.products[0]!
  const result = await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    closingEnvelope,
    shouldContinue: () => true,
    nowMs: 107_000,
  })
  expect(result.pool.importedQuantity).toBe(0)
  expect(result.pool.closingRumor).toBeDefined()
  const assignment = (await f.db.merchantInventoryAssignments.get(
    product.assignmentCoordinate
  ))!
  expect(assignment.organizerStockHold?.closed).toBe(true)
  expect(
    assignment.publicationJobs.at(-1)?.assignmentSnapshot?.organizerStockHold
      ?.closed
  ).toBe(true)
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(20)
})

it("rolls back a closing failure without releasing the hold or losing the close", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const closingEnvelope = await f.close()
  const close = () =>
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
    })
  const fault = spyOn(
    f.db.merchantInventoryAssignments,
    "put"
  ).mockRejectedValueOnce(new Error("close disk failure"))
  await fails(close(), "close disk failure")
  fault.mockRestore()
  expect(
    (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.state
  ).not.toBe("closed")
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(2)
  expect((await close()).pool.state).toBe("closed")
})

it("requires matching accepted-order provenance again when closing", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const closingEnvelope = await f.close()
  await f.db.merchantInventoryAcceptedOrders.update(order.id, {
    termsBinding: "different terms",
  })
  await fails(
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
    }),
    "attribution"
  )
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(2)
})

it("imports repeated lines of one product as one pool entry and one combined stock debit", async () => {
  const f = await fixture(),
    initial = f.order(1)
  const order = orderSchema.parse({
    ...initial,
    items: [initial.items[0], initial.items[0]],
    subtotal: 2,
  })
  const envelopes = await f.accept(order)
  const result = await f.importOrder(order, envelopes)
  expect(result.order.items).toHaveLength(2)
  expect(result.order.organizerImport?.entries[0]?.quantity).toBe(2)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(2)
})

it("retains once-only stock provenance and authenticated closing evidence after reload", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  f.db.close()
  await f.db.open()
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
  const closingEnvelope = await f.close()
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    closingEnvelope,
    shouldContinue: () => true,
  })
  f.db.close()
  await f.db.open()
  expect(
    (
      await reconcileMerchantOrganizerStockClose({
        db: f.db,
        signer: f.merchantSigner,
        authenticatedPubkey: f.merchant,
        closingEnvelope,
        shouldContinue: () => true,
      })
    ).replayed
  ).toBe(true)
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
})

it("never releases a concurrently imported closing prefix prematurely", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    closingEnvelope = await f.close()
  const close = () =>
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
    })
  const [imported, closed] = await Promise.allSettled([
    f.importOrder(order, envelopes),
    close(),
  ])
  expect(imported.status).toBe("fulfilled")
  if (closed.status === "rejected")
    expect((await close()).pool.state).toBe("closed")
  else expect(closed.value.pool.state).toBe("closed")
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(18)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(0)
})

it("rejects an authenticated journal record that predates its imported predecessor", async () => {
  const f = await fixture(),
    first = f.order(1),
    second = f.order(1),
    one = await f.accept(first),
    two = await f.accept(second, 105_000)
  await f.importOrder(first, one)
  const entry = (await f.db.eventMarketOrganizerStockEntries
    .where("[accountPubkey+poolId+orderId]")
    .equals([f.organizer, f.products[0]!.poolId, second.id])
    .first())!
  const payload = parseEventMarketStockAuthorityRumor(entry.rumor)
  if (payload.type !== "accepted") throw new Error("Acceptance required")
  const earlier = createEventMarketStockAuthorityRumor({
    payload: { ...payload, acceptedAtMs: 103_000 },
    createdAt: 103,
  })
  const envelope = await wrapPrivateMessage(
    earlier,
    { pubkey: f.merchant },
    f.organizerSigner
  )
  await fails(f.importOrder(second, [envelope]), "predecessor")
  expect(
    (await f.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!.stock
  ).toBe(19)
  await f.importOrder(second, two, 106_000)
})

it("rejects a conflicting signed close after the original close was reconciled", async () => {
  const f = await fixture(),
    closingEnvelope = await f.close(),
    product = f.products[0]!
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    closingEnvelope,
    shouldContinue: () => true,
  })
  const pool = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${product.poolId}`
  ))!
  const payload = parseEventMarketStockAuthorityRumor(pool.closingRumor!)
  const altered = createEventMarketStockAuthorityRumor({
    payload,
    createdAt: 107,
  })
  const envelope = await wrapPrivateMessage(
    altered,
    { pubkey: f.merchant },
    f.organizerSigner
  )
  await fails(
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope: envelope,
      shouldContinue: () => true,
    }),
    "identity conflict"
  )
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))!.stock
  ).toBe(20)
})

it("does not release a pool when a stronger observed frontier still lacks its entry", async () => {
  const f = await fixture(),
    order = f.order(1),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  const closingEnvelope = await f.close(),
    product = f.products[0]!
  await f.db.eventMarketOrganizerStockPools.update(
    `${f.merchant}:${product.poolId}`,
    {
      acceptedSequence: 2,
      acceptedQuantity: 2,
      lastAcceptedId: getPublicKey(generateSecretKey()),
    }
  )
  await fails(
    reconcileMerchantOrganizerStockClose({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      closingEnvelope,
      shouldContinue: () => true,
    }),
    "imported frontier"
  )
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        product.assignmentCoordinate
      ))!
    )
  ).toBe(3)
})

type Fixture = Awaited<ReturnType<typeof fixture>>
function protectedStore(f: Fixture, owner: "merchant" | "organizer") {
  const account = f[owner],
    accountSigner = owner === "merchant" ? f.merchantSigner : f.organizerSigner
  installProtectedReadSigner(accountSigner, account, () => true)
  const authorization = getProtectedReadAuthorization(account)!
  return {
    authorization,
    store: new CommerceInboxStore(authorization, f.db),
    signer: accountSigner,
    authenticatedPubkey: account,
  }
}
function ack(relay: string): PublishWithPlannerResult {
  return {
    successfulRelayUrls: [relay],
    failedRelayUrls: [],
    attemptedRelayUrls: [relay],
    relayFailureMessages: {},
    plan: {} as never,
  }
}
function inboxResult(
  events: SignedPublicNostrEvent[],
  coverage: "complete" | "partial" | "unavailable" = "complete"
): ProtectedInboxReadResult {
  return {
    events,
    coverage,
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: coverage === "complete" ? "success" : coverage,
      observations:
        coverage === "complete" ? [{ type: "eose", relayIndex: 0 }] : [],
      relays: [
        {
          relayIndex: 0,
          status: coverage === "complete" ? "success" : "failed",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: coverage === "complete" ? 1 : 0,
      failedCount: coverage === "complete" ? 0 : 1,
      authoritativeEmpty: coverage === "complete" && events.length === 0,
    },
  }
}
async function history(f: Fixture) {
  const product = f.products[0]!
  const grant = await prepareOrganizerStockEnvelopes({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    poolId: product.poolId,
    work: "grant",
    shouldContinue: () => true,
  })
  await f.close()
  const pool = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${product.poolId}`
  ))!
  const entries = await f.db.eventMarketOrganizerStockEntries
    .where("[accountPubkey+poolId]")
    .equals([f.organizer, product.poolId])
    .toArray()
  return {
    grantEnvelope: grant.recipient,
    committedAssignmentEvent: product.commitment,
    acceptedEnvelopes: entries.map((entry) => entry.wraps!.self),
    closingEnvelope: pool.closingWraps!.self,
  }
}
async function forgetOrganizer(f: Fixture) {
  await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizer)
    .delete()
  await f.db.eventMarketOrganizerStockPools
    .where("accountPubkey")
    .equals(f.organizer)
    .delete()
}

it("retries declared-inbox stock delivery with the saved exact recipient and self wrappers", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "merchant"),
    sent: SignedPublicNostrEvent[] = []
  let failing = true
  const publish = () =>
    publishEventMarketStockWork({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      poolId: f.products[0]!.poolId,
      work: "grant",
      delivery: {
        deliveryStore: auth.store,
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async (event, options) => {
          sent.push(event)
          if (failing) throw new Error("Relay unavailable")
          return ack(options.exclusiveRelayUrls![0]!)
        },
      },
    })
  await fails(publish())
  const saved = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.products[0]!.poolId}`
  ))!.grantWraps!
  f.db.close()
  await f.db.open()
  failing = false
  const result = await publish()
  expect(result.recipientDelivery?.successfulRelayUrls).toEqual([
    "wss://relay.conduit.market",
  ])
  expect(
    sent
      .filter((event) =>
        event.tags.some((tag) => tag[0] === "p" && tag[1] === f.organizer)
      )
      .every((event) => event.id === saved.recipient.id)
  ).toBe(true)
  expect(result.selfDelivery?.successfulRelayUrls).toEqual([
    "wss://relay.conduit.market",
  ])
  expect(
    (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.grantWraps
  ).toEqual(saved)
})

it("never delivers a grant before its public reservation commitment is acknowledged", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "merchant"),
    product = f.products[0]!,
    pool = (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${product.poolId}`
    ))!
  const assignment = (await f.db.merchantInventoryAssignments.get(
    product.assignmentCoordinate
  ))!
  assignment.publicationJobs.find(
    (work) => work.id === `${pool.poolId}:reserve`
  )!.state = "signed"
  await f.db.merchantInventoryAssignments.put(assignment)
  const deliveries: string[] = []
  await fails(
    startMerchantOrganizerStockGrant({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      grantRumor: pool.grantRumor,
      admissionEvidence: [
        product.fulfillment.market.signedEvent,
        product.fulfillment.calendar.signedEvent,
        product.fulfillment.product.signedEvent,
        ...product.fulfillment.grant.signedEvidence.ancestry,
      ],
      expectedAssignmentRevision: 1,
      nowMs: 102_000,
      publishPublic: async () => false,
      delivery: {
        deliveryStore: auth.store,
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async (event, options) => {
          deliveries.push(event.id)
          return ack(options.exclusiveRelayUrls![0]!)
        },
      },
    }),
    "Publish the exact"
  )
  expect(deliveries).not.toContain(pool.grantWraps!.recipient.id)
  expect(deliveries).not.toContain(pool.grantWraps!.self.id)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        product.assignmentCoordinate
      ))!
    )
  ).toBe(4)
})

it("requires the preselected local device writer instead of copying one from a received grant", async () => {
  const f = await fixture(),
    product = f.products[0]!,
    wraps = await prepareOrganizerStockEnvelopes({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      poolId: product.poolId,
      work: "grant",
      shouldContinue: () => true,
    })
  await forgetOrganizer(f)
  await fails(
    receiveOrganizerStockGrant({
      db: f.db,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => true,
      expectedWriterId: crypto.randomUUID(),
      grantEnvelope: wraps.recipient,
      committedAssignmentEvent: product.commitment,
      nowMs: 103_000,
    }),
    "not selected"
  )
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
  expect(
    (
      await receiveOrganizerStockGrant({
        db: f.db,
        signer: f.organizerSigner,
        authenticatedPubkey: f.organizer,
        shouldContinue: () => true,
        expectedWriterId: f.writerId,
        grantEnvelope: wraps.recipient,
        committedAssignmentEvent: product.commitment,
        nowMs: 103_000,
      })
    ).acceptedQuantity
  ).toBe(0)
})

it("recovers only a positively complete closed prefix and never reactivates its old writer", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    recovered = await history(f)
  await forgetOrganizer(f)
  const restore = (acceptedEnvelopes = recovered.acceptedEnvelopes) =>
    restoreClosedOrganizerStockJournal({
      db: f.db,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => true,
      ...recovered,
      acceptedEnvelopes,
    })
  await fails(restore([]), "Complete closed")
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
  const pool = await restore()
  expect(pool.state).toBe("closing")
  expect(pool.acceptedQuantity).toBe(2)
  expect(pool.readOnlyRecovery).toBe(true)
  await fails(
    commitOrganizerStockAcceptance({
      db: f.db,
      authenticatedPubkey: f.organizer,
      writerId: f.writerId,
      poolId: pool.poolId,
      orderId: crypto.randomUUID(),
      identityBinding: getPublicKey(generateSecretKey()),
      termsBinding: getPublicKey(generateSecretKey()),
      claimRef: getPublicKey(generateSecretKey()),
      quantity: 1,
      evidence: "private approved terms",
      nowMs: 107_000,
    }),
    "ended"
  )
  const entry = (await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizer)
    .first())!
  await fails(
    prepareOrganizerStockEnvelopes({
      db: f.db,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      poolId: pool.poolId,
      work: { entryId: entry.rumor.id },
      shouldContinue: () => true,
    }),
    "cannot recreate"
  )
  await f.importOrder(order, envelopes)
})

it("marks restored history closed only with the exact Merchant reconciled projection", async () => {
  const f = await fixture(),
    order = f.order(),
    envelopes = await f.accept(order),
    recovered = await history(f)
  await f.importOrder(order, envelopes)
  const merchantPool = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.products[0]!.poolId}`
  ))!
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: merchantPool.closingWraps!.recipient,
  })
  await f.publish()
  const closedAssignmentEvent = (await f.db.merchantInventoryAssignments.get(
    f.products[0]!.assignmentCoordinate
  ))!.signedAssignmentEvent!
  await forgetOrganizer(f)
  const pool = await restoreClosedOrganizerStockJournal({
    db: f.db,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizer,
    shouldContinue: () => true,
    ...recovered,
    closedAssignmentEvent,
  })
  expect(pool.state).toBe("closed")
  expect(pool.importedQuantity).toBe(2)
  expect(pool.readOnlyRecovery).toBe(true)
})

it("rolls back a cold restore persistence failure without installing an empty stock writer", async () => {
  const f = await fixture(),
    order = f.order()
  await f.accept(order)
  const recovered = await history(f)
  await forgetOrganizer(f)
  const fault = spyOn(
    f.db.eventMarketOrganizerStockEntries,
    "add"
  ).mockRejectedValueOnce(new Error("restore disk failure"))
  await fails(
    restoreClosedOrganizerStockJournal({
      db: f.db,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => true,
      ...recovered,
    }),
    "restore disk failure"
  )
  fault.mockRestore()
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
  expect(
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
})

it("keeps authenticated positive stock packets on a partial protected inbox read", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "organizer"),
    product = f.products[0]!,
    wraps = await prepareOrganizerStockEnvelopes({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      poolId: product.poolId,
      work: "grant",
      shouldContinue: () => true,
    })
  const scan = await createEventMarketStockDiscovery({
    db: f.db,
    ...auth,
    shouldContinue: () => true,
    resolveDeclaration: async () => ({
      pubkey: f.organizer,
      state: "declared",
      relayUrls: ["wss://relay.conduit.market"],
      stale: false,
      fetchedAt: Date.now(),
    }),
    read: async () => inboxResult([wraps.recipient], "partial"),
  })
  const page = await scan.nextPage()
  expect(page.pageStatus).toBe("partial")
  expect(page.packets).toHaveLength(1)
  expect(page.packets[0]?.rumor.id).toBe(product.poolId)
  expect((await auth.store.wrappers()).map((row) => row.event.id)).toContain(
    wraps.recipient.id
  )
  scan.dispose()
  const restored = await createEventMarketStockDiscovery({
    db: f.db,
    ...auth,
    shouldContinue: () => true,
    resolveDeclaration: async () => ({
      pubkey: f.organizer,
      state: "lookup_unavailable",
      relayUrls: [],
      stale: true,
      fetchedAt: Date.now(),
    }),
  })
  expect((await restored.nextPage()).packets).toHaveLength(1)
  expect((await restored.nextPage()).pageStatus).toBe("unavailable")
  restored.dispose()
})

it("does not turn empty or unavailable discovery into a fresh active organizer writer", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "organizer")
  await forgetOrganizer(f)
  const scan = await createEventMarketStockDiscovery({
    db: f.db,
    ...auth,
    shouldContinue: () => true,
    resolveDeclaration: async () => ({
      pubkey: f.organizer,
      state: "declared",
      relayUrls: ["wss://relay.conduit.market"],
      stale: false,
      fetchedAt: Date.now(),
    }),
    read: async () => inboxResult([]),
  })
  const page = await scan.nextPage()
  expect(page.pageStatus).toBe("source_eose")
  expect(page.packets).toHaveLength(0)
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
  scan.dispose()
})

it("keeps authenticated unknown-version stock packets quarantined and out of active discovery", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "organizer"),
    product = f.products[0]!
  const grant = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${product.poolId}`
  ))!.grantRumor
  const rumor = createPrivateMessageRumor({
    ...grant,
    content: JSON.stringify({ ...JSON.parse(grant.content), version: 2 }),
  })
  const envelope = await wrapPrivateMessage(
    rumor,
    { pubkey: f.organizer },
    f.merchantSigner
  )
  await fails(
    inspectEventMarketStockPacket({
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => true,
      envelope,
    }),
    "malformed"
  )
  const scan = await createEventMarketStockDiscovery({
    db: f.db,
    ...auth,
    shouldContinue: () => true,
    resolveDeclaration: async () => ({
      pubkey: f.organizer,
      state: "declared",
      relayUrls: ["wss://relay.conduit.market"],
      stale: false,
      fetchedAt: Date.now(),
    }),
    read: async () => inboxResult([envelope]),
  })
  const page = await scan.nextPage()
  expect(page.packets).toHaveLength(0)
  expect(page.malformedCount).toBe(1)
  expect(page.decryptFailureCount).toBe(0)
  expect((await auth.store.wrappers())[0]?.event.id).toBe(envelope.id)
  scan.dispose()
})

it("refuses active installation if the account session ends during persistence", async () => {
  const f = await fixture(),
    product = f.products[0]!
  const wraps = await prepareOrganizerStockEnvelopes({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    poolId: product.poolId,
    work: "grant",
    shouldContinue: () => true,
  })
  await forgetOrganizer(f)
  let current = true
  const add = f.db.eventMarketOrganizerStockPools.add.bind(
    f.db.eventMarketOrganizerStockPools
  )
  const fault = spyOn(
    f.db.eventMarketOrganizerStockPools,
    "add"
  ).mockImplementation(async (...args) => {
    const result = await add(...args)
    current = false
    return result
  })
  await fails(
    receiveOrganizerStockGrant({
      db: f.db,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => current,
      expectedWriterId: f.writerId,
      grantEnvelope: wraps.recipient,
      committedAssignmentEvent: product.commitment,
      nowMs: 103_000,
    }),
    "session changed"
  )
  fault.mockRestore()
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
})

it("preserves the closed-prefix read-only marker after reload and rejects a fresh writer reset", async () => {
  const f = await fixture(),
    order = f.order()
  await f.accept(order)
  const recovered = await history(f)
  await forgetOrganizer(f)
  await restoreClosedOrganizerStockJournal({
    db: f.db,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizer,
    shouldContinue: () => true,
    ...recovered,
  })
  f.db.close()
  await f.db.open()
  const row = await receiveOrganizerStockGrant({
    db: f.db,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizer,
    shouldContinue: () => true,
    expectedWriterId: f.writerId,
    grantEnvelope: recovered.grantEnvelope,
    committedAssignmentEvent: recovered.committedAssignmentEvent,
    nowMs: 107_000,
  })
  expect(row.readOnlyRecovery).toBe(true)
  expect(row.acceptedQuantity).toBe(2)
  expect(row.state).toBe("closing")
})

it("allows finite organizer assignment setup without granting stock or requiring the later device handover", async () => {
  const f = await fixture(),
    product = f.products[0]!,
    fulfillment = product.fulfillment
  const deps = (sharedDb as unknown as { _deps: Record<string, unknown> })
      ._deps,
    prior = { ...deps }
  sharedDb.close({ disableAutoOpen: false })
  Object.assign(deps, { indexedDB: new IDBFactory(), IDBKeyRange })
  await sharedDb.open()
  const source = await admitFixtureEvent(product.product)
  const productSchema = parseProductEvent(source)
  const market = await admitFixtureEvent(fulfillment.market.signedEvent),
    calendar = await admitFixtureEvent(fulfillment.calendar.signedEvent),
    admission = await admitFixtureEvent(fulfillment.grant.signedEvidence.tip)
  const roster = spyOn(rosterReads, "readEventMarketRoster").mockResolvedValue({
    coordinate: f.marketCoordinate,
    resolution: resolveEventMarketRoster({
      coordinate: f.marketCoordinate,
      revisions: [market],
      deletions: [],
    }),
    coverage: "complete",
    retained: true,
    observedRelayUrls: [],
    calendar: parseEventMarketCalendarEvent(calendar),
    calendarSignedEvent: calendar,
  })
  const approval = spyOn(
    authorizationReads,
    "readEventMarketAuthorization"
  ).mockResolvedValue({
    marketCoordinate: f.marketCoordinate,
    merchantPubkey: f.merchant,
    resolution: resolveEventMarketAuthorization({
      marketCoordinate: f.marketCoordinate,
      merchantPubkey: f.merchant,
      transitions: [admission],
      deletions: [],
    }),
    coverage: "complete",
    retained: true,
    actionable: true,
    observedEvidence: [admission],
  })
  const listings = spyOn(commerce, "getProductsByIds").mockResolvedValue({
    data: [{ addressId: product.coordinate, product: productSchema }],
    meta: {},
  } as never)
  const clock = spyOn(Date, "now").mockReturnValue(103_000)
  try {
    await initializeMerchantInventoryProduct({
      db: sharedDb,
      merchantPubkey: f.merchant,
      productCoordinate: product.coordinate,
      stock: 20,
      signedProductEvent: source,
    })
    const input = {
      merchantPubkey: f.merchant,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      marketReference: f.marketCoordinate,
      product: productSchema,
      occurrenceCoordinate: f.occurrenceCoordinate,
      quantity: 2,
      remove: false,
    }
    const baseline = await saveMerchantOccurrenceAssignment(input)
    expect(baseline.inventory).toEqual({ mode: "tracked", quantity: 2 })
    expect(baseline.organizerStockHold).toBeUndefined()
    expect(await sharedDb.eventMarketOrganizerStockPools.count()).toBe(0)
    await fails(
      saveMerchantOccurrenceAssignment({
        ...input,
        organizerHandoverSetup: {
          organizerPubkey: f.merchant,
          writerId: f.writerId,
        },
      }),
      "event organizer"
    )
    await fails(
      saveMerchantOccurrenceAssignment({
        ...input,
        quantity: 0,
        organizerHandoverSetup: {
          organizerPubkey: f.organizer,
          writerId: f.writerId,
        },
      }),
      "finite stock"
    )
    await fails(
      saveMerchantOccurrenceAssignment({
        ...input,
        organizerHandoverSetup: {
          organizerPubkey: f.organizer,
          writerId: "not-a-device-writer",
        },
      }),
      "event organizer"
    )
    const untracked = await admitFixtureEvent(
      finalizeEvent(
        {
          kind: 30402,
          created_at: 102,
          content: product.product.content,
          tags: product.product.tags
            .filter((tag) => tag[0] !== "stock")
            .map((tag) => [...tag]),
        },
        f.merchantSecret
      )
    )
    listings.mockResolvedValueOnce({
      data: [
        {
          addressId: product.coordinate,
          product: parseProductEvent(untracked),
        },
      ],
      meta: {},
    } as never)
    await fails(
      saveMerchantOccurrenceAssignment({
        ...input,
        organizerHandoverSetup: {
          organizerPubkey: f.organizer,
          writerId: f.writerId,
        },
      }),
      "finite stock"
    )
    const organizerHandoverSetup = {
      organizerPubkey: f.organizer,
      writerId: f.writerId,
    }
    const operation = saveMerchantOccurrenceAssignment({
      ...input,
      organizerHandoverSetup,
    })
    organizerHandoverSetup.organizerPubkey = f.merchant
    const assignment = await operation
    expect(assignment.inventory).toEqual({ mode: "tracked", quantity: 2 })
    expect(assignment.organizerStockHold).toBeUndefined()
    expect(assignment.publicationJobs.at(-1)?.state).toBe("awaiting_signature")
    expect(await sharedDb.eventMarketOrganizerStockPools.count()).toBe(0)
  } finally {
    roster.mockRestore()
    approval.mockRestore()
    listings.mockRestore()
    clock.mockRestore()
    sharedDb.close({ disableAutoOpen: false })
    Object.assign(deps, prior)
  }
})

function proofGraph(f: Fixture) {
  const fulfillment = f.products[0]!.fulfillment
  return [
    fulfillment.market.signedEvent,
    fulfillment.calendar.signedEvent,
    fulfillment.product.signedEvent,
    ...fulfillment.grant.signedEvidence.ancestry,
  ]
}
async function resetToPublishedPreGrant(f: Fixture) {
  const product = f.products[0]!,
    pool = (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${product.poolId}`
    ))!
  const assignment = (await f.db.merchantInventoryAssignments.get(
    product.assignmentCoordinate
  ))!
  const baseline = assignment.publicationJobs.find(
    (work) =>
      work.signedEvent?.id ===
      JSON.parse(pool.grantRumor.content).assignmentEventId
  )!
  delete assignment.organizerStockHold
  assignment.revision = baseline.revision
  assignment.signedAssignmentEvent = baseline.signedEvent
  assignment.publicationJobs = [baseline]
  await f.db.merchantInventoryAssignments.put(assignment)
  await f.db.eventMarketOrganizerStockPools.delete(
    `${f.merchant}:${product.poolId}`
  )
  await forgetOrganizer(f)
  return {
    product,
    grantRumor: pool.grantRumor,
    expectedAssignmentRevision: assignment.revision,
  }
}

async function variationGrantCallerFixture() {
  const f = await fixture()
  const prepared = await resetToPublishedPreGrant(f)
  const parentCoordinate = `30402:${f.merchant}:variable-parent`
  const parent = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", "variable-parent"],
        ["title", "Variable stock item"],
        ["type", "variable", "physical"],
        ["price", "1", "SATS"],
      ],
    },
    f.merchantSecret
  )
  const child = finalizeEvent(
    {
      ...prepared.product.product,
      created_at: 101,
      tags: [
        ...prepared.product.product.tags.map((tag) =>
          tag[0] === "type" ? ["type", "variation", "physical"] : tag
        ),
        ["a", parentCoordinate],
        ["spec", "Size", "Small"],
      ],
    },
    f.merchantSecret
  )
  const product = (await f.db.merchantInventoryProducts.get(
    prepared.product.coordinate
  ))!
  product.signedProductEvent = child
  product.sourceProductEvent = child
  await f.db.merchantInventoryProducts.put(product)
  const assignment = (await f.db.merchantInventoryAssignments.get(
    prepared.product.assignmentCoordinate
  ))!
  const fulfillment = prepared.product.fulfillment
  const live = [
    fulfillment.market.signedEvent,
    fulfillment.calendar.signedEvent,
    ...fulfillment.grant.signedEvidence.ancestry,
    child,
    assignment.signedAssignmentEvent!,
    parent,
  ]
  const evidence = createEventMarketEvidenceStore(f.db)
  await evidence.retain(
    f.marketCoordinate,
    live.filter((event) => event.id !== parent.id)
  )
  const relay = "wss://relay.conduit.market"
  const reads: NonNullable<
    Parameters<typeof rosterReads.readEventMarketProduct>[1]
  > = {
    plan: async () => ({
      relayUrls: [relay],
      candidateRelayUrls: [relay],
      relayTargets: [],
      ownerSelectedRelayUrls: [],
      appRelayUrls: [relay],
      personalRelayUrls: [],
      independentRelayUrls: [],
      relayListState: "missing",
      relayHintTruncated: false,
    }),
    fetch: async (filter) => ({
      events: live.filter((event) => matchFilter(filter, event)),
      relays: [{ relayUrl: relay, status: "success" }],
    }),
    load: evidence.load,
    retain: evidence.retain,
  }
  const marketRead = await rosterReads.readEventMarketRoster(
    { reference: f.marketCoordinate, authenticatedPubkey: f.merchant },
    reads
  )
  if (marketRead.resolution.state !== "current" || !marketRead.calendar)
    throw new Error("Expected current caller fixture")
  const auth = protectedStore(f, "merchant")
  const effects = { public: 0, private: 0 }
  const input: Parameters<
    typeof reserveMerchantOrganizerStockForAssignment
  >[0] = {
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    market: marketRead.resolution.market,
    occurrence: marketRead.calendar,
    marketRead,
    assignment,
    writerId: f.writerId,
    quantityText: "4",
    nowMs: 102_000,
    publishPublic: async () => {
      effects.public++
      return true
    },
    delivery: {
      deliveryStore: auth.store,
      resolveInboxRelays: async () => [relay],
      publishFn: async () => {
        effects.private++
        return ack(relay)
      },
    },
  }
  const dependencies = {
    readAuthorization: (
      query: Parameters<
        typeof authorizationReads.readEventMarketAuthorization
      >[0]
    ) => authorizationReads.readEventMarketAuthorization(query, reads),
    readProduct: async (
      query: Parameters<typeof rosterReads.readEventMarketProduct>[0]
    ) => {
      const clock = spyOn(Date, "now").mockReturnValue(102_000)
      try {
        return await rosterReads.readEventMarketProduct(query, reads)
      } finally {
        clock.mockRestore()
      }
    },
    loadEvidence: evidence.load,
    start: startMerchantOrganizerStockGrant,
  }
  return { f, parent, child, live, input, dependencies, effects, evidence }
}

it("the stock-panel grant workflow reads the live variation parent before reserving and publishing", async () => {
  const state = await variationGrantCallerFixture()
  expect(
    (await state.evidence.load(state.f.marketCoordinate)).some(
      (event) => event.id === state.parent.id
    )
  ).toBe(false)
  const result = await reserveMerchantOrganizerStockForAssignment(
    state.input,
    state.dependencies
  )
  expect(result.pool.quantity).toBe(4)
  expect(state.effects.public).toBeGreaterThan(0)
  expect(state.effects.private).toBeGreaterThan(0)
  expect(
    outstandingOrganizerStockHold(
      (await state.f.db.merchantInventoryAssignments.get(
        state.input.assignment.coordinate
      ))!
    )
  ).toBe(4)
  expect(
    (await state.evidence.load(state.f.marketCoordinate)).some(
      (event) => event.id === state.parent.id
    )
  ).toBe(true)
})

it.each([
  "missing parent",
  "wrong-author parent",
  "wrong-type parent",
  "hidden parent",
  "deleted parent",
  "retained parent deletion",
  "stale parent",
  "deleted child",
  "changed child",
  "changed assignment",
] as const)(
  "the stock-panel variation grant rejects %s before any reservation or publication",
  async (defect) => {
    const state = await variationGrantCallerFixture()
    const { f, parent, child, live, input } = state
    const parentCoordinate = `30402:${f.merchant}:variable-parent`
    if (defect === "missing parent") live.splice(live.indexOf(parent), 1)
    if (defect === "wrong-author parent") {
      live.splice(
        live.indexOf(parent),
        1,
        finalizeEvent(parent, generateSecretKey())
      )
    }
    if (defect === "wrong-type parent" || defect === "hidden parent") {
      live.push(
        finalizeEvent(
          {
            ...parent,
            created_at: 102,
            tags:
              defect === "wrong-type parent"
                ? parent.tags.map((tag) =>
                    tag[0] === "type" ? ["type", "simple", "physical"] : tag
                  )
                : [...parent.tags, ["visibility", "hidden"]],
          },
          f.merchantSecret
        )
      )
    }
    if (
      defect === "deleted parent" ||
      defect === "retained parent deletion" ||
      defect === "deleted child"
    ) {
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 102,
          content: "",
          tags: [
            [
              "a",
              defect === "deleted child"
                ? input.assignment.productCoordinate
                : parentCoordinate,
            ],
          ],
        },
        f.merchantSecret
      )
      if (defect === "retained parent deletion")
        await state.evidence.retain(f.marketCoordinate, [deletion])
      else live.push(deletion)
    }
    if (defect === "stale parent") {
      await state.evidence.retain(f.marketCoordinate, [parent])
      live.splice(live.indexOf(parent), 1)
    }
    if (defect === "changed child")
      live.push(finalizeEvent({ ...child, created_at: 102 }, f.merchantSecret))
    if (defect === "changed assignment") {
      const previous = input.assignment.signedAssignmentEvent!
      live.push(
        finalizeEvent(
          {
            ...previous,
            created_at: 102,
            tags: [
              ...previous.tags
                .filter((tag) => tag[0] !== "prev")
                .map((tag) =>
                  tag[0] === "inventory" ? ["inventory", "tracked", "5"] : tag
                ),
              ["prev", previous.id],
            ],
          },
          f.merchantSecret
        )
      )
    }
    await fails(
      reserveMerchantOrganizerStockForAssignment(input, state.dependencies)
    )
    expect(
      (await f.db.merchantInventoryAssignments.get(
        input.assignment.coordinate
      ))!.organizerStockHold
    ).toBeUndefined()
    expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
    expect(state.effects).toEqual({ public: 0, private: 0 })
  }
)

it("retains a prepared handover when signing is interrupted and resumes the same grant before delivery", async () => {
  const f = await fixture(),
    prepared = await resetToPublishedPreGrant(f),
    auth = protectedStore(f, "merchant")
  let sent = 0
  const run = () =>
    startMerchantOrganizerStockGrant({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      ...prepared,
      admissionEvidence: proofGraph(f),
      nowMs: 102_000,
      publishPublic: async () => true,
      delivery: {
        deliveryStore: auth.store,
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async (_, options) => {
          sent++
          return ack(options.exclusiveRelayUrls![0]!)
        },
      },
    })
  const deny = spyOn(f.merchantSigner, "signEvent").mockRejectedValueOnce(
    new Error("Signer interrupted")
  )
  await fails(run(), "Signer interrupted")
  deny.mockRestore()
  expect(sent).toBe(0)
  expect(
    outstandingOrganizerStockHold(
      (await f.db.merchantInventoryAssignments.get(
        prepared.product.assignmentCoordinate
      ))!
    )
  ).toBe(4)
  const saved = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${prepared.product.poolId}`
  ))!
  expect(saved.grantRumor.id).toBe(prepared.grantRumor.id)
  const result = await run()
  expect(result.pool.poolId).toBe(prepared.grantRumor.id)
  expect(result.delivery.recipientDelivery?.successfulRelayUrls).toHaveLength(1)
  expect(sent).toBe(3)
})

it("rejects a changed signed admission graph before creating any Merchant hold", async () => {
  const f = await fixture(),
    prepared = await resetToPublishedPreGrant(f)
  const prior = f.products[0]!.fulfillment.market.signedEvent
  const changed = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "market",
        organizerPubkey: f.organizer,
        calendarCoordinate: f.occurrenceCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: f.merchant,
            mode: "merchant_present",
            assignment: "Organizer table",
          },
        ],
        previousEventId: prior.id,
      }),
      created_at: 102,
    },
    f.organizerSecret
  )
  await fails(
    startMerchantOrganizerStockGrant({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      ...prepared,
      admissionEvidence: [...proofGraph(f), changed],
      nowMs: 103_000,
      publishPublic: async () => {
        throw new Error("No publication expected")
      },
    }),
    "admission"
  )
  expect(
    (await f.db.merchantInventoryAssignments.get(
      prepared.product.assignmentCoordinate
    ))!.organizerStockHold
  ).toBeUndefined()
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.merchant)
      .count()
  ).toBe(0)
})

it("does not publish any private grant when exact envelope persistence fails", async () => {
  const f = await fixture(),
    auth = protectedStore(f, "merchant")
  const before = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.products[0]!.poolId}`
  ))!
  delete before.grantWraps
  await f.db.eventMarketOrganizerStockPools.put(before)
  let sent = 0
  const fault = spyOn(
    f.db.eventMarketOrganizerStockPools,
    "put"
  ).mockRejectedValueOnce(new Error("Envelope disk failure"))
  await fails(
    publishEventMarketStockWork({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      poolId: f.products[0]!.poolId,
      work: "grant",
      delivery: {
        deliveryStore: auth.store,
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async (_, options) => {
          sent++
          return ack(options.exclusiveRelayUrls![0]!)
        },
      },
    }),
    "Envelope disk failure"
  )
  fault.mockRestore()
  expect(sent).toBe(0)
  expect(
    (await f.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.grantWraps
  ).toBeUndefined()
})

function batchInput(f: Fixture, order: OrderSchema, quantity = 2) {
  const bindings = getOrganizerStockOrderBindings(order)
  return {
    db: f.db,
    authenticatedPubkey: f.organizer,
    orderId: order.id,
    identityBinding: bindings.identityHash,
    termsBinding: bindings.termsHash,
    claimRef: getFutureMarketClaimRef({
      orderId: order.id,
      merchantPubkey: f.merchant,
      organizerPubkey: f.organizer,
      marketCoordinate: f.marketCoordinate,
    }),
    evidence: bindings.termsBinding,
    entries: f.products.map((product) => ({
      poolId: product.poolId,
      writerId: f.writerId,
      quantity,
    })),
    nowMs: 104_000,
  }
}

it("commits and replays all product pools as one exact organizer order", async () => {
  const f = await fixture(2),
    order = f.order(),
    input = batchInput(f, order)
  const result = await commitOrganizerStockOrder(input)
  expect(result.replayed).toBe(false)
  expect(result.entries).toHaveLength(2)
  expect(
    new Set(result.entries.map((entry) => entry.orderPoolBinding)).size
  ).toBe(1)
  expect(
    result.entries
      .map((entry) => parseEventMarketStockAuthorityRumor(entry.rumor))
      .every(
        (payload) =>
          payload.type === "accepted" && payload.acceptedAtMs === 104_000
      )
  ).toBe(true)
  const replay = await commitOrganizerStockOrder({
    ...input,
    entries: [...input.entries].reverse(),
    nowMs: 105_000,
  })
  expect(replay.replayed).toBe(true)
  expect(new Set(replay.entries.map((entry) => entry.rumor.id))).toEqual(
    new Set(result.entries.map((entry) => entry.rumor.id))
  )
  await fails(
    commitOrganizerStockOrder({ ...input, entries: input.entries.slice(0, 1) }),
    "complete pool manifest"
  )
  await fails(
    commitOrganizerStockOrder({
      ...input,
      entries: input.entries.map((entry) => ({ ...entry, quantity: 1 })),
    }),
    "complete pool manifest"
  )
})

it("rolls back every other pool when one product's organizer stock is exhausted", async () => {
  const f = await fixture(2),
    input = batchInput(f, f.order())
  await commitOrganizerStockAcceptance({
    ...input,
    ...input.entries[1]!,
    orderId: crypto.randomUUID(),
    quantity: 4,
  })
  await fails(commitOrganizerStockOrder(input), "Insufficient entrusted")
  const first = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.products[0]!.poolId}`
  ))!
  expect(first.acceptedQuantity).toBe(0)
  expect(first.acceptedSequence).toBe(0)
  expect(
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.organizer)
      .filter((entry) => entry.orderId === input.orderId)
      .count()
  ).toBe(0)
})

it("serializes competing whole orders without splitting successful products between them", async () => {
  const f = await fixture(2),
    first = batchInput(f, f.order(3), 3),
    second = batchInput(f, f.order(3), 3)
  const results = await Promise.allSettled([
    commitOrganizerStockOrder(first),
    commitOrganizerStockOrder(second),
  ])
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1)
  expect(
    (
      await f.db.eventMarketOrganizerStockPools
        .where("accountPubkey")
        .equals(f.organizer)
        .toArray()
    ).map((pool) => pool.acceptedQuantity)
  ).toEqual([3, 3])
  const saved = await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizer)
    .toArray()
  expect(new Set(saved.map((entry) => entry.orderId)).size).toBe(1)
  expect(saved).toHaveLength(2)
})

it("rolls back a multi-pool acceptance when its second durable entry cannot be saved", async () => {
  const f = await fixture(2),
    input = batchInput(f, f.order()),
    add = f.db.eventMarketOrganizerStockEntries.add.bind(
      f.db.eventMarketOrganizerStockEntries
    )
  let calls = 0
  const fault = spyOn(
    f.db.eventMarketOrganizerStockEntries,
    "add"
  ).mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error("second entry disk failure")
    return add(...args)
  })
  await fails(commitOrganizerStockOrder(input), "second entry disk failure")
  fault.mockRestore()
  expect(
    (
      await f.db.eventMarketOrganizerStockPools
        .where("accountPubkey")
        .equals(f.organizer)
        .toArray()
    ).every((pool) => pool.acceptedQuantity === 0)
  ).toBe(true)
  expect(
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
})

it("rejects partial or differently timed legacy pool decisions instead of pretending they were atomic", async () => {
  const f = await fixture(2),
    input = batchInput(f, f.order())
  await commitOrganizerStockAcceptance({ ...input, ...input.entries[0]! })
  await fails(commitOrganizerStockOrder(input), "Partial legacy")
  await commitOrganizerStockAcceptance({
    ...input,
    ...input.entries[1]!,
    nowMs: 105_000,
  })
  await fails(commitOrganizerStockOrder(input), "acceptance times")
})

async function merchantCheckpoint(f: Fixture) {
  const product = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!
  return openMerchantOrganizerStockCheckpoint({
    db: f.db,
    authenticatedPubkey: f.merchant,
    productCoordinate: product.coordinate,
    checkpoint: product.organizerStockCheckpoint!,
  })
}

async function coldMerchantCheckpoint(f: Fixture) {
  const db = new ConduitDB(`stock-cold-merchant-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  const auth = protectedStore({ ...f, db }, "merchant")
  const checkpoint = await merchantCheckpoint(f)
  const payload = parseEventMarketStockCheckpointRumor(checkpoint.rumor)
  return {
    db,
    checkpoint,
    payload,
    auth,
    input: {
      db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      authorization: auth.authorization,
      store: auth.store,
      envelope: checkpoint.selfEnvelope!,
      signedProductEvent: payload.snapshot.product.signedProductEvent,
      signedAssignmentEvents: payload.snapshot.assignments.map(
        (row) => row.signedAssignmentEvent!
      ),
    },
  }
}

it("restores fresh Merchant stock and imported replay evidence before importing or closing again", async () => {
  const f = await fixture(),
    order = f.order(),
    original = await f.original(order),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  expect((await f.publish()).pending).toBe(0)
  const cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  const restored = await restoreMerchantOrganizerStockCheckpoint(cold.input)
  expect(restored.replayed).toBe(false)
  expect(restored.product.stock).toBe(18)
  const held = (await cold.db.merchantInventoryAssignments.get(
    f.products[0]!.assignmentCoordinate
  ))!
  expect(outstandingOrganizerStockHold(held)).toBe(2)
  const imported = await importMerchantOrganizerStockOrder({
    db: cold.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    originalOrderEnvelope: original,
    acceptedEnvelopes: entries,
    nowMs: 500_000,
  })
  expect(imported.replayed).toBe(true)
  expect(
    (await cold.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!
      .stock
  ).toBe(18)
  const close = await f.close()
  await reconcileMerchantOrganizerStockClose({
    db: cold.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: close,
    nowMs: 500_000,
  })
  expect(
    outstandingOrganizerStockHold(
      (await cold.db.merchantInventoryAssignments.get(held.coordinate))!
    )
  ).toBe(0)
  expect(
    (await cold.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.state
  ).toBe("closed")
  expect(
    (await cold.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!
      .stock
  ).toBe(18)
})

it("keeps private imported orders encrypted through checkpoint publication and fresh-device recovery", async () => {
  const f = await fixture()
  const order = orderSchema.parse({
    ...f.order(),
    note: "SYNTHETIC_CHECKPOINT_PRIVATE_NOTE",
  })
  const entries = await f.accept(order)
  await f.importOrder(order, entries)
  expect((await f.publish()).pending).toBe(0)
  const product = await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  )
  expect(JSON.stringify(product).includes(order.note!)).toBe(false)
  const cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await restoreMerchantOrganizerStockCheckpoint(cold.input)
  const accepted = (await cold.db.merchantInventoryAcceptedOrders.get(
    order.id
  ))!
  expect(accepted.evidenceFormat).toBe("device-encrypted-v1")
  const source = (await f.db.merchantInventoryAcceptedOrders.get(order.id))!
  expect(accepted.evidence === source.evidence).toBe(false)
  expect(await openMerchantAcceptanceEvidence(accepted, cold.auth.store)).toBe(
    JSON.stringify(order)
  )
  await expect(
    openMerchantAcceptanceEvidence(source, cold.auth.store)
  ).rejects.toThrow()
  const rows = await cold.db.eventMarketOrganizerStockEntries.toArray()
  for (const value of [order.note!, order.buyerPubkey])
    expect(
      JSON.stringify([
        accepted,
        rows,
        await cold.db.merchantInventoryProducts.toArray(),
      ]).includes(value)
    ).toBe(false)
  expect(
    (
      await importMerchantOrganizerStockOrder({
        ...cold.input,
        originalOrderEnvelope: await f.original(order),
        acceptedEnvelopes: entries,
        nowMs: 500_000,
      })
    ).replayed
  ).toBe(true)
  expect(
    (await cold.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!
      .stock
  ).toBe(18)
})

it("repairs a legacy plaintext checkpoint without changing its portable bytes or exact acknowledged envelope", async () => {
  const f = await fixture(),
    order = orderSchema.parse({
      ...f.order(),
      note: "SYNTHETIC_OLD_CHECKPOINT_NOTE",
    }),
    envelopes = await f.accept(order)
  await f.importOrder(order, envelopes)
  expect((await f.publish()).pending).toBe(0)
  const opened = await merchantCheckpoint(f)
  const { sealedRumor: _private, rumorId: _id, ...legacy } = opened
  void _private
  void _id
  await f.db.merchantInventoryProducts.update(f.products[0]!.coordinate, {
    organizerStockCheckpoint: legacy,
  })
  expect((await f.publish()).pending).toBe(0)
  const repaired = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!.organizerStockCheckpoint!
  expect(repaired.rumor).toBeUndefined()
  expect(repaired.rumorId).toBe(opened.rumor.id)
  expect(repaired.sealedRumor).toBeDefined()
  const deployedRumor = await merchantAcceptanceStore(f.merchant, f.db).open<{
    id: string
    content: string
  }>(repaired.sealedRumor!, `merchant-stock-checkpoint:${repaired.rumorId}`)
  expect(deployedRumor.content).toBe(opened.rumor.content)
  expect(repaired.snapshotKey).toBe(opened.snapshotKey)
  expect(
    JSON.stringify(repaired.selfEnvelope) ===
      JSON.stringify(opened.selfEnvelope)
  ).toBe(true)
  expect(JSON.stringify(repaired).includes(order.note!)).toBe(false)
  expect((await merchantCheckpoint(f)).rumor.content).toBe(opened.rumor.content)
  expect((await f.importOrder(order, envelopes)).replayed).toBe(true)
})

it("requires a positively observed checkpoint and exact public projections, not an empty inbox", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!)
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await fails(
    restoreMerchantOrganizerStockCheckpoint({
      ...cold.input,
      signedAssignmentEvents: [],
    })
  )
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  expect(await cold.db.eventMarketOrganizerStockPools.count()).toBe(0)
  const result = await restoreMerchantOrganizerStockCheckpoint(cold.input)
  expect(result.product.stock).toBe(20)
  expect(
    (await restoreMerchantOrganizerStockCheckpoint(cold.input)).replayed
  ).toBe(true)
})

it("keeps older or incomplete checkpoints read-only after stronger public or local observations", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  const order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  await f.publish()
  const newer = (await f.db.merchantInventoryAssignments.get(
    f.products[0]!.assignmentCoordinate
  ))!.signedAssignmentEvent!
  await cold.db.eventMarketRosterEvidence.put({
    id: `${f.marketCoordinate}:${newer.id}`,
    marketCoordinate: f.marketCoordinate,
    signedEvent: newer,
    cachedAt: Date.now(),
  })
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  await cold.db.eventMarketRosterEvidence.clear()
  await restoreMerchantOrganizerStockCheckpoint(cold.input)
  const local = (await cold.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!
  local.stock = 19
  local.revision++
  await cold.db.merchantInventoryProducts.put(local)
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  expect(
    (await cold.db.merchantInventoryProducts.get(local.coordinate))!.stock
  ).toBe(19)
})

it("reports the blocked checkpoint stage without publishing unacknowledged stock", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const observed: {
    productCoordinate: string
    status: "pending" | "acknowledged"
    phase: string
  }[] = []
  const calls = { public: 0, private: 0 }
  const result = await resumeMerchantInventoryPublication({
    db: f.db,
    merchantPubkey: f.merchant,
    stockCheckpoint: {
      signer: f.merchantSigner,
      shouldContinue: () => true,
      delivery: {
        deliveryStore: new CommerceInboxStore(
          getProtectedReadAuthorization(f.merchant)!,
          f.db
        ),
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async () => {
          calls.private++
          throw new Error("controlled relay failure")
        },
      },
    },
    sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
    publish: async () => {
      calls.public++
      return true
    },
    onStockCheckpoint: (outcome: (typeof observed)[number]) => {
      observed.push(outcome)
    },
  })
  expect(calls).toEqual({ public: 0, private: 1 })
  expect(result.delivered).toBe(0)
  expect(result.pending).toBeGreaterThan(0)
  expect(Object.keys(result).sort()).toEqual(["delivered", "pending", "signed"])
  expect(observed).toHaveLength(1)
  expect(observed[0]!.productCoordinate === f.products[0]!.coordinate).toBe(
    true
  )
  expect({ status: observed[0]!.status, phase: observed[0]!.phase }).toEqual({
    status: "pending",
    phase: "delivery_ack",
  })
  const retained = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!.organizerStockCheckpoint!
  expect(retained.acknowledgedRelayUrls).toHaveLength(0)
  expect(retained.selfEnvelope).toBeDefined()
})

it("keeps checkpoint observers separate from failed ACKs and successful retries", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const calls = { public: 0, private: 0, observer: 0 }
  const state = { acknowledge: false }
  const input = {
    db: f.db,
    merchantPubkey: f.merchant,
    stockCheckpoint: {
      signer: f.merchantSigner,
      shouldContinue: () => true,
      delivery: {
        deliveryStore: new CommerceInboxStore(
          getProtectedReadAuthorization(f.merchant)!,
          f.db
        ),
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async () => {
          calls.private++
          if (!state.acknowledge) throw new Error("controlled relay failure")
          return ack("wss://relay.conduit.market")
        },
      },
    },
    sign: async (draft: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent(draft, f.merchantSecret),
    publish: async () => {
      calls.public++
      return true
    },
    onStockCheckpoint: () => {
      calls.observer++
      throw new Error("controlled observer failure")
    },
  }
  const held = await resumeMerchantInventoryPublication(input)
  expect(held.delivered).toBe(0)
  expect(held.pending).toBeGreaterThan(0)
  expect(calls).toEqual({ public: 0, private: 1, observer: 1 })
  const retained = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!.organizerStockCheckpoint!
  expect(retained.acknowledgedRelayUrls).toHaveLength(0)
  expect(retained.selfEnvelope).toBeDefined()
  state.acknowledge = true
  const resumed = await resumeMerchantInventoryPublication({
    ...input,
    onStockCheckpoint: async () => {
      calls.observer++
      throw new Error("controlled async observer failure")
    },
  })
  expect(resumed.pending).toBe(0)
  expect(resumed.delivered).toBeGreaterThan(0)
  expect(calls.public).toBe(resumed.delivered)
  expect(calls.private).toBe(2)
  expect(calls.observer).toBe(2)
  const delivered = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!.organizerStockCheckpoint!
  expect(
    JSON.stringify(delivered.selfEnvelope) ===
      JSON.stringify(retained.selfEnvelope)
  ).toBe(true)
  expect(delivered.acknowledgedRelayUrls).toHaveLength(1)
  const phases: string[] = []
  const unchanged = await publishMerchantOrganizerStockCheckpoint({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    productCoordinate: f.products[0]!.coordinate,
    shouldContinue: () => true,
    onPhase: async (phase) => {
      phases.push(phase)
      throw new Error("controlled async phase observer failure")
    },
  })
  expect(unchanged.acknowledgedRelayUrls).toHaveLength(1)
  expect(phases).toEqual(["snapshot"])
  expect(calls.private).toBe(2)
})

it("reports only the typed signer failure code from the actual checkpoint wrapping failure", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const observed: {
    status: string
    phase: string
    wrappingOperation?: string
    failure?: unknown
  }[] = []
  const encryption = spyOn(
    f.merchantSigner,
    "encryptNip44"
  ).mockRejectedValueOnce(new NostrSignerError("unavailable"))
  try {
    const result = await resumeMerchantInventoryPublication({
      db: f.db,
      merchantPubkey: f.merchant,
      stockCheckpoint: { signer: f.merchantSigner, shouldContinue: () => true },
      sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
      publish: async () => {
        throw new Error("No public write before checkpoint")
      },
      onStockCheckpoint: (outcome: (typeof observed)[number]) => {
        observed.push({
          status: outcome.status,
          phase: outcome.phase,
          wrappingOperation: outcome.wrappingOperation,
          failure: outcome.failure,
        })
      },
    })
    expect(result.delivered).toBe(0)
    expect(result.pending).toBeGreaterThan(0)
    expect(encryption).toHaveBeenCalledTimes(1)
    expect(observed).toEqual([
      {
        status: "pending",
        phase: "wrapping",
        wrappingOperation: "encryption",
        failure: { source: "signer", code: "unavailable" },
      },
    ])
  } finally {
    encryption.mockRestore()
  }
})

it("observes checkpoint retention before the unchanged session guard and any delivery", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  await resumeMerchantInventoryPublication({
    db: f.db,
    merchantPubkey: f.merchant,
    sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
    publish: async () => {
      throw new Error("No write before checkpoint")
    },
  })
  const state: { operation?: string; deliveries: number } = { deliveries: 0 }
  const table = f.db.merchantInventoryProducts
  await fails(
    publishMerchantOrganizerStockCheckpoint({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      productCoordinate: f.products[0]!.coordinate,
      shouldContinue: () => state.operation !== "checkpoint_retention",
      onWrappingOperation: (operation) => {
        state.operation = operation
      },
      delivery: {
        resolveInboxRelays: async () => {
          state.deliveries++
          throw new Error("No delivery before saved envelope")
        },
      },
    }),
    "Merchant stock checkpoint session changed"
  )
  expect(state.operation).toBe("checkpoint_retention")
  expect(state.deliveries).toBe(0)
  const saved = (await table.get(f.products[0]!.coordinate))!
    .organizerStockCheckpoint!
  expect(saved.selfEnvelope).toBeUndefined()
  expect(saved.acknowledgedRelayUrls).toHaveLength(0)
})

for (const observer of ["throw", "reject"] as const) {
  it(`does not let a ${observer} wrapping observer change checkpoint ACK or retained bytes`, async () => {
    const f = await fixture(),
      order = f.order(),
      entries = await f.accept(order)
    await f.importOrder(order, entries)
    await resumeMerchantInventoryPublication({
      db: f.db,
      merchantPubkey: f.merchant,
      sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
      publish: async () => {
        throw new Error("No write before checkpoint")
      },
    })
    const state = { deliveries: 0 }
    const operations: string[] = []
    const checkpoint = await publishMerchantOrganizerStockCheckpoint({
      db: f.db,
      signer: f.merchantSigner,
      authenticatedPubkey: f.merchant,
      productCoordinate: f.products[0]!.coordinate,
      shouldContinue: () => true,
      onWrappingOperation: (operation) => {
        operations.push(operation)
        if (observer === "reject")
          return Promise.reject(new Error("controlled observer rejection"))
        throw new Error("controlled observer failure")
      },
      delivery: {
        deliveryStore: new CommerceInboxStore(
          getProtectedReadAuthorization(f.merchant)!,
          f.db
        ),
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async () => {
          state.deliveries++
          return ack("wss://relay.conduit.market")
        },
      },
    })
    expect(operations).toEqual([
      "identity",
      "preparation",
      "encryption",
      "seal_signing",
      "seal_validation",
      "local_wrap",
      "checkpoint_retention",
    ])
    expect(state.deliveries).toBe(1)
    expect(checkpoint.acknowledgedRelayUrls).toHaveLength(1)
    const saved = (await f.db.merchantInventoryProducts.get(
      f.products[0]!.coordinate
    ))!.organizerStockCheckpoint!
    expect(
      JSON.stringify(saved.selfEnvelope) ===
        JSON.stringify(checkpoint.selfEnvelope)
    ).toBe(true)
  })
}

for (const scenario of [
  "session",
  "plain-code",
  "unknown-typed-code",
  "throwing-code",
  "proxied-error",
  "private-getters",
] as const) {
  it(`keeps ${scenario} checkpoint failure diagnostics typed, content-free and observational`, async () => {
    const f = await fixture(),
      order = f.order(),
      entries = await f.accept(order)
    await f.importOrder(order, entries)
    const access = { privateFields: 0, code: 0, public: 0 }
    const failure =
      scenario === "session" || scenario === "throwing-code"
        ? new SessionSignerError("queue_full", "controlled session failure")
        : scenario === "plain-code"
          ? Object.assign(new Error("controlled failure"), {
              code: "unavailable",
            })
          : scenario === "proxied-error"
            ? new Proxy(
                {},
                {
                  getPrototypeOf() {
                    throw new Error("controlled inspection failure")
                  },
                }
              )
            : new NostrSignerError("unavailable")
    if (scenario === "unknown-typed-code")
      Object.defineProperty(failure, "code", { value: "untrusted-code" })
    if (scenario === "throwing-code")
      Object.defineProperty(failure, "code", {
        get() {
          access.code++
          throw new Error("controlled code getter")
        },
      })
    for (const key of ["message", "cause"])
      Object.defineProperty(failure, key, {
        get() {
          access.privateFields++
          throw new Error("private failure detail must not be read")
        },
      })
    const observed: unknown[] = []
    const encryption = spyOn(
      f.merchantSigner,
      "encryptNip44"
    ).mockRejectedValueOnce(failure)
    try {
      const result = await resumeMerchantInventoryPublication({
        db: f.db,
        merchantPubkey: f.merchant,
        stockCheckpoint: {
          signer: f.merchantSigner,
          shouldContinue: () => true,
        },
        sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
        publish: async () => {
          access.public++
          return true
        },
        onStockCheckpoint: (outcome) => {
          observed.push(outcome.failure)
          throw new Error("controlled observer failure")
        },
      })
      expect(observed).toEqual([
        scenario === "session"
          ? { source: "session", code: "queue_full" }
          : scenario === "private-getters"
            ? { source: "signer", code: "unavailable" }
            : { source: "unclassified" },
      ])
      expect(result.delivered).toBe(0)
      expect(result.pending).toBeGreaterThan(0)
      expect(Object.keys(result).sort()).toEqual([
        "delivered",
        "pending",
        "signed",
      ])
      expect(encryption).toHaveBeenCalledTimes(1)
      expect(access.public).toBe(0)
      expect(access.privateFields).toBe(0)
      expect(access.code).toBe(scenario === "throwing-code" ? 1 : 0)
      const retained = (await f.db.merchantInventoryProducts.get(
        f.products[0]!.coordinate
      ))!.organizerStockCheckpoint!
      expect(retained.selfEnvelope).toBeUndefined()
      expect(retained.acknowledgedRelayUrls).toHaveLength(0)
    } finally {
      encryption.mockRestore()
    }
  })
}

it("does not inspect checkpoint failure details when no observer is installed", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const access = { code: 0, public: 0 }
  const failure = new NostrSignerError("unavailable")
  Object.defineProperty(failure, "code", {
    get() {
      access.code++
      throw new Error("controlled code getter")
    },
  })
  const encryption = spyOn(
    f.merchantSigner,
    "encryptNip44"
  ).mockRejectedValueOnce(failure)
  try {
    const result = await resumeMerchantInventoryPublication({
      db: f.db,
      merchantPubkey: f.merchant,
      stockCheckpoint: { signer: f.merchantSigner, shouldContinue: () => true },
      sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
      publish: async () => {
        access.public++
        return true
      },
    })
    expect(result.delivered).toBe(0)
    expect(result.pending).toBeGreaterThan(0)
    expect(Object.keys(result).sort()).toEqual([
      "delivered",
      "pending",
      "signed",
    ])
    expect(encryption).toHaveBeenCalledTimes(1)
    expect(access).toEqual({ code: 0, public: 0 })
  } finally {
    encryption.mockRestore()
  }
})

it("reports snapshot and wrapping phases without replacing the checkpoint failure", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const phases: string[] = []
  const input = {
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    productCoordinate: f.products[0]!.coordinate,
    shouldContinue: () => true,
    onPhase: (phase: string) => {
      phases.push(phase)
      throw new Error("controlled phase observer failure")
    },
  }
  await fails(
    publishMerchantOrganizerStockCheckpoint(input),
    "Sign every stock projection before checkpointing"
  )
  expect(phases).toEqual(["snapshot"])
  await resumeMerchantInventoryPublication({
    db: f.db,
    merchantPubkey: f.merchant,
    sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
    publish: async () => false,
  })
  phases.length = 0
  const encryption = spyOn(
    f.merchantSigner,
    "encryptNip44"
  ).mockRejectedValueOnce(new Error("controlled wrapping failure"))
  try {
    await fails(
      publishMerchantOrganizerStockCheckpoint({
        ...input,
        onPhase: async (phase) => {
          phases.push(phase)
          throw new Error("controlled async phase observer failure")
        },
      }),
      "controlled wrapping failure"
    )
    expect(phases).toEqual(["snapshot", "wrapping"])
    expect(encryption).toHaveBeenCalledTimes(1)
    const retained = (await f.db.merchantInventoryProducts.get(
      f.products[0]!.coordinate
    ))!.organizerStockCheckpoint!
    expect(retained.acknowledgedRelayUrls).toHaveLength(0)
    expect(retained.selfEnvelope).toBeUndefined()
  } finally {
    encryption.mockRestore()
  }
})

it("reports a failed stock freshness recheck without losing its retained ACK", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const state = { failRead: false, private: 0, public: 0 }
  const observed: { status: string; phase: string }[] = []
  const table = f.db.eventMarketOrganizerStockEntries
  const originalWhere = table.where.bind(table)
  const read = spyOn(table, "where").mockImplementation((...args) => {
    if (state.failRead) throw new Error("controlled freshness read failure")
    return originalWhere(...args)
  })
  try {
    const result = await resumeMerchantInventoryPublication({
      db: f.db,
      merchantPubkey: f.merchant,
      stockCheckpoint: {
        signer: f.merchantSigner,
        shouldContinue: () => true,
        delivery: {
          deliveryStore: new CommerceInboxStore(
            getProtectedReadAuthorization(f.merchant)!,
            f.db
          ),
          resolveInboxRelays: async () => ["wss://relay.conduit.market"],
          publishFn: async () => {
            state.private++
            state.failRead = true
            return ack("wss://relay.conduit.market")
          },
        },
      },
      sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
      publish: async () => {
        state.public++
        return true
      },
      onStockCheckpoint: (outcome) => {
        observed.push({ status: outcome.status, phase: outcome.phase })
      },
    })
    expect(observed).toEqual([{ status: "pending", phase: "freshness" }])
    expect(state.private).toBe(1)
    expect(state.public).toBe(0)
    expect(result.delivered).toBe(0)
    expect(result.pending).toBeGreaterThan(0)
    const retained = (await f.db.merchantInventoryProducts.get(
      f.products[0]!.coordinate
    ))!.organizerStockCheckpoint!
    expect(retained.acknowledgedRelayUrls).toHaveLength(1)
  } finally {
    read.mockRestore()
  }
})

it("retries the identical durable Merchant checkpoint ciphertext after relay failure", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  // Sign the projections while withholding the required private checkpoint.
  const held = await resumeMerchantInventoryPublication({
    db: f.db,
    merchantPubkey: f.merchant,
    sign: async (draft) => finalizeEvent(draft, f.merchantSecret),
    publish: async () => {
      throw new Error("No public write before checkpoint")
    },
  })
  expect(held.delivered).toBe(0)
  expect(held.pending).toBeGreaterThan(0)
  const seen: string[] = []
  const input = {
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    productCoordinate: f.products[0]!.coordinate,
    shouldContinue: () => true,
    delivery: {
      deliveryStore: new CommerceInboxStore(
        getProtectedReadAuthorization(f.merchant)!,
        f.db
      ),
      resolveInboxRelays: async () => ["wss://relay.conduit.market"],
      publishFn: async (event: SignedPublicNostrEvent) => {
        seen.push(JSON.stringify(event))
        throw new Error("relay unavailable")
      },
    },
  }
  await fails(publishMerchantOrganizerStockCheckpoint(input))
  const retained = (await f.db.merchantInventoryProducts.get(
    input.productCoordinate
  ))!.organizerStockCheckpoint!
  expect(retained.acknowledgedRelayUrls).toHaveLength(0)
  expect(retained.selfEnvelope).toBeDefined()
  const signed = spyOn(f.merchantSigner, "signEvent")
  const delivered = await publishMerchantOrganizerStockCheckpoint({
    ...input,
    delivery: {
      ...input.delivery,
      publishFn: async (event) => {
        seen.push(JSON.stringify(event))
        return ack("wss://relay.conduit.market")
      },
    },
  })
  expect(signed).not.toHaveBeenCalled()
  signed.mockRestore()
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
  expect(delivered.acknowledgedRelayUrls).toEqual([
    "wss://relay.conduit.market",
  ])
})

it("rolls back fresh Merchant reconstruction when persistence or account authority fails", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  const fault = spyOn(
    cold.db.eventMarketOrganizerStockPools,
    "bulkPut"
  ).mockRejectedValueOnce(new Error("cold disk failure"))
  await fails(
    restoreMerchantOrganizerStockCheckpoint(cold.input),
    "cold disk failure"
  )
  fault.mockRestore()
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  expect(await cold.db.merchantInventoryAssignments.count()).toBe(0)
  expect(await cold.db.eventMarketOrganizerStockPools.count()).toBe(0)
  await fails(
    restoreMerchantOrganizerStockCheckpoint({
      ...cold.input,
      shouldContinue: () => false,
    }),
    "session changed"
  )
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
})

it("retains a newer authenticated Merchant checkpoint before any stock reconstruction", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  const value = f.order(),
    entries = await f.accept(value)
  await f.importOrder(value, entries)
  expect((await f.publish()).pending).toBe(0)
  const newer = await merchantCheckpoint(f)
  await cold.auth.store.receive(newer.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await observeMerchantOrganizerStockCheckpoint({
    ...cold.input,
    envelope: newer.selfEnvelope!,
  })
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  const payload = parseEventMarketStockCheckpointRumor(
    (
      await openMerchantOrganizerStockCheckpoint({
        checkpoint: newer,
        authenticatedPubkey: f.merchant,
        db: f.db,
        productCoordinate: f.products[0]!.coordinate,
      })
    ).rumor
  )
  const restored = await restoreMerchantOrganizerStockCheckpoint({
    ...cold.input,
    envelope: newer.selfEnvelope!,
    signedProductEvent: payload.snapshot.product.signedProductEvent,
    signedAssignmentEvents: payload.snapshot.assignments.map(
      (row) => row.signedAssignmentEvent!
    ),
  })
  expect(restored.product.stock).toBe(18)
  const markers = await cold.db.commerceInboxDeliveries.toArray()
  expect(
    markers.filter((row) => row.kind === "merchant_stock_recovery")
  ).toHaveLength(1)
  expect(markers.every((row) => row.state === undefined)).toBe(true)
})

it("restores closed Merchant history without releasing or importing it a second time", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const close = await f.close()
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: close,
    nowMs: 107_000,
  })
  expect((await f.publish()).pending).toBe(0)
  const cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await restoreMerchantOrganizerStockCheckpoint(cold.input)
  const replay = await reconcileMerchantOrganizerStockClose({
    db: cold.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: close,
    nowMs: 500_000,
  })
  expect(replay.replayed).toBe(true)
  expect(replay.pool.state).toBe("closed")
  expect(
    (await cold.db.merchantInventoryProducts.get(f.products[0]!.coordinate))!
      .stock
  ).toBe(18)
  expect(
    outstandingOrganizerStockHold(
      (await cold.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(0)
})

it("composes historical Merchant reconstruction through the shared public readers and recovery owner", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  let productReads = 0,
    assignmentReads = 0
  const result = await recoverMerchantOrganizerStockFromInbox(cold.input, {
    products: async () => {
      productReads++
      return { data: [], meta: {} } as never
    },
    read: {
      plan: async () =>
        ({
          candidateRelayUrls: ["wss://relay.conduit.market"],
          maxRelayAttempts: 1,
        }) as never,
      fetch: async () => {
        assignmentReads++
        return {
          events: [],
          relays: [
            { relayUrl: "wss://relay.conduit.market", status: "failed" },
          ],
        }
      },
    },
  })
  expect(productReads).toBe(1)
  expect(assignmentReads).toBeGreaterThan(0)
  expect(result.state).toBe("ready")
  expect(result.coverage).not.toBe("complete")
  expect(
    (await cold.db.eventMarketOrganizerStockPools.get(
      `${f.merchant}:${f.products[0]!.poolId}`
    ))!.quantity
  ).toBe(4)
})

it("quarantines Merchant stock checkpoints and unknown versions from generic conversations", async () => {
  const f = await fixture(),
    product = (await f.db.merchantInventoryProducts.get(
      f.products[0]!.coordinate
    ))!
  const rumor = (await merchantCheckpoint(f)).rumor
  expect(product.organizerStockCheckpoint!.rumor).toBeUndefined()
  expect(decodeCommerceMessageRumor(rumor).category).toBe("machine")
  const unknown = createPrivateMessageRumor({
    ...rumor,
    tags: rumor.tags.map((tag) =>
      tag[0] === "conduit" ? [tag[0], tag[1]!, "999"] : [...tag]
    ),
  })
  expect(decodeCommerceMessageRumor(unknown).category).toBe("machine")
  expect(() => parseEventMarketStockCheckpointRumor(unknown)).toThrow()
})

it("refuses a higher checkpoint that drops a positively retained imported frontier", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  const oldPayload = structuredClone(cold.payload)
  const order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  expect((await f.publish()).pending).toBe(0)
  const current = await merchantCheckpoint(f)
  await cold.auth.store.receive(current.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await observeMerchantOrganizerStockCheckpoint({
    ...cold.input,
    envelope: current.selfEnvelope!,
  })
  oldPayload.sequence = current.sequence + 1
  oldPayload.previousId = current.rumorId!
  const rollback = createPrivateMessageRumor({
    ...(
      await openMerchantOrganizerStockCheckpoint({
        checkpoint: current,
        authenticatedPubkey: f.merchant,
        db: f.db,
        productCoordinate: f.products[0]!.coordinate,
      })
    ).rumor,
    content: JSON.stringify(oldPayload),
  })
  const wrapped = await wrapPrivateMessage(
    rollback,
    { pubkey: f.merchant },
    f.merchantSigner
  )
  await cold.auth.store.receive(wrapped, ["wss://relay.conduit.market"])
  await fails(
    observeMerchantOrganizerStockCheckpoint({
      ...cold.input,
      envelope: wrapped,
    })
  )
  await fails(restoreMerchantOrganizerStockCheckpoint(cold.input))
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
})

it("rejects incomplete authenticated checkpoint history instead of restoring an empty pool", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  expect((await f.publish()).pending).toBe(0)
  const cold = await coldMerchantCheckpoint(f)
  const incomplete = structuredClone(cold.payload)
  incomplete.snapshot.entries = []
  incomplete.snapshotKey = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(incomplete.snapshot))
      )
    )
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  const rumor = createPrivateMessageRumor({
    ...cold.checkpoint.rumor,
    content: JSON.stringify(incomplete),
  })
  const envelope = await wrapPrivateMessage(
    rumor,
    { pubkey: f.merchant },
    f.merchantSigner
  )
  await cold.auth.store.receive(envelope, ["wss://relay.conduit.market"])
  await fails(
    restoreMerchantOrganizerStockCheckpoint({ ...cold.input, envelope })
  )
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  expect(await cold.db.eventMarketOrganizerStockPools.count()).toBe(0)
  expect(await cold.db.commerceInboxDeliveries.count()).toBe(0)
})

it("retains the complete finite pool after several separate imported orders", async () => {
  const f = await fixture()
  for (let index = 0; index < 4; index++) {
    const order = f.order(1),
      entries = await f.accept(order, 104_000 + index * 1000)
    await f.importOrder(order, entries, 105_000 + index * 1000)
    expect((await f.publish()).pending).toBe(0)
  }
  const cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  const restored = await restoreMerchantOrganizerStockCheckpoint(cold.input)
  expect(restored.product.stock).toBe(16)
  expect(await cold.db.merchantInventoryAcceptedOrders.count()).toBe(4)
  expect(await cold.db.eventMarketOrganizerStockEntries.count()).toBe(4)
  expect(
    outstandingOrganizerStockHold(
      (await cold.db.merchantInventoryAssignments.get(
        f.products[0]!.assignmentCoordinate
      ))!
    )
  ).toBe(0)
})

it("requeues exact public projections after cold recovery without signing another stock decision", async () => {
  const f = await fixture(),
    cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await restoreMerchantOrganizerStockCheckpoint(cold.input)
  const sent: string[] = [],
    sign = spyOn(f.merchantSigner, "signEvent")
  const result = await resumeMerchantInventoryPublication({
    db: cold.db,
    merchantPubkey: f.merchant,
    sign: async (draft) => f.merchantSigner.signEvent(draft),
    stockCheckpoint: {
      signer: f.merchantSigner,
      shouldContinue: () => true,
      delivery: {
        deliveryStore: cold.auth.store,
        resolveInboxRelays: async () => ["wss://relay.conduit.market"],
        publishFn: async () => ack("wss://relay.conduit.market"),
      },
    },
    publish: async (event) => {
      sent.push(event.id)
      return true
    },
  })
  expect(result.pending).toBe(0)
  expect(result.signed).toBe(0)
  expect(sign).not.toHaveBeenCalled()
  sign.mockRestore()
  expect(sent).toContain(cold.payload.snapshot.product.signedProductEvent.id)
  expect(sent).toContain(
    cold.payload.snapshot.assignments[0]!.signedAssignmentEvent!.id
  )
})

it("keeps only the strongest authenticated checkpoint per product during bounded discovery", async () => {
  const f = await fixture(),
    old = await merchantCheckpoint(f)
  const order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  await f.publish()
  const current = await merchantCheckpoint(f)
  const cold = await coldMerchantCheckpoint(f)
  const scan = await createEventMarketStockDiscovery({
    db: cold.db,
    ...cold.auth,
    shouldContinue: () => true,
    resolveDeclaration: async () => ({
      pubkey: f.merchant,
      state: "declared",
      relayUrls: ["wss://relay.conduit.market"],
      stale: false,
      fetchedAt: Date.now(),
    }),
    read: async () =>
      inboxResult([current.selfEnvelope!, old.selfEnvelope!], "partial"),
  })
  const page = await scan.nextPage()
  expect(page.packets).toHaveLength(1)
  expect(page.packets[0]!.rumor.id).toBe(current.rumorId)
  expect(page.packets[0]!.payload.type).toBe("merchant_checkpoint")
  expect(await cold.db.merchantInventoryProducts.count()).toBe(0)
  expect(
    (await cold.db.commerceInboxDeliveries.toArray()).some(
      (row) => row.kind === "merchant_stock_recovery"
    )
  ).toBe(true)
  scan.dispose()
})

function listingRepository(event: SignedPublicNostrEvent) {
  let job = prepareProductListingDeliveryJob({
    merchantPubkey: event.pubkey,
    signedEvents: [event],
    relayTargets: [
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelected: false,
        appRelay: true,
      },
    ],
  })
  const repository: ProductListingOutboxRepository = {
    add: async (next) => {
      job = structuredClone(next)
    },
    get: async () => structuredClone(job),
    listUndelivered: async () => [structuredClone(job)],
    update: async (_, updater) => {
      job = structuredClone(updater(structuredClone(job)))
      return structuredClone(job)
    },
  }
  return { repository, id: job.id }
}
async function ordinaryEdit(f: Fixture) {
  const row = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!
  const event = finalizeEvent(
    {
      ...row.signedProductEvent,
      created_at: row.signedProductEvent.created_at + 1,
      tags: row.signedProductEvent.tags.map((tag) =>
        tag[0] === "stock" ? ["stock", "19"] : [...tag]
      ),
    },
    f.merchantSecret
  )
  row.stock = 19
  row.revision++
  row.signedProductEvent = event
  row.sourceProductEvent = event
  await f.db.merchantInventoryProducts.put(row)
  return event
}
function listingOptions(
  f: Fixture,
  repository: ProductListingOutboxRepository
) {
  config.commerceRelayUrls = [
    ...new Set([...config.commerceRelayUrls, "wss://relay.conduit.market"]),
  ]
  return {
    repository,
    inventoryDatabase: f.db,
    authenticatedPubkey: f.merchant,
    accountNetworkLocalStateRepository: { get: async () => undefined },
  }
}

it("holds ordinary product-edit publication until its exact entrusted-stock checkpoint is acknowledged", async () => {
  const f = await fixture(),
    event = await ordinaryEdit(f),
    listing = listingRepository(event)
  let writes = 0,
    preparations = 0
  await fails(
    deliverProductListingJob(
      listing.id,
      async () => {
        writes++
        return { status: "acked" }
      },
      {
        ...listingOptions(f, listing.repository),
        prepareStockCheckpoint: async () => {
          preparations++
        },
      }
    ),
    "checkpoint"
  )
  expect(writes).toBe(0)
  expect(preparations).toBe(1)
  expect(
    (await listing.repository.get(listing.id))!.relayDelivery[0]!.attemptCount
  ).toBe(0)
  expect((await listing.repository.get(listing.id))!.signedEvents[0]).toEqual(
    JSON.parse(JSON.stringify(event))
  )
})

it("refreshes the checkpoint in the Merchant adapter and retries only exact signed listing bytes", async () => {
  const f = await fixture(),
    event = await ordinaryEdit(f),
    listing = listingRepository(event)
  const sent: string[] = []
  let prepares = 0
  const options = {
    ...listingOptions(f, listing.repository),
    restoreLocalEvidence: async () => {},
    prepareStockCheckpoint: async () => {
      prepares++
      await publishMerchantOrganizerStockCheckpoint({
        db: f.db,
        signer: f.merchantSigner,
        authenticatedPubkey: f.merchant,
        productCoordinate: f.products[0]!.coordinate,
        shouldContinue: () => true,
        delivery: {
          deliveryStore: new CommerceInboxStore(
            getProtectedReadAuthorization(f.merchant)!,
            f.db
          ),
          resolveInboxRelays: async () => ["wss://relay.conduit.market"],
          publishFn: async () => ack("wss://relay.conduit.market"),
        },
      })
    },
    publisher: async ({
      signedEvent,
    }: {
      signedEvent: SignedPublicNostrEvent
    }) => {
      sent.push(JSON.stringify(signedEvent))
      return { status: "timed_out" as const }
    },
  }
  await deliverQueuedProductListings(listing.id, options)
  await deliverQueuedProductListings(listing.id, options)
  expect(prepares).toBe(1)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
  expect((await listing.repository.get(listing.id))!.signedEvents[0]).toEqual(
    JSON.parse(JSON.stringify(event))
  )
})

it("does not require a stock checkpoint for ordinary products without a retained organizer pool", async () => {
  const f = await fixture(),
    event = f.products[0]!.product,
    listing = listingRepository(event)
  await f.db.eventMarketOrganizerStockPools.clear()
  let writes = 0
  await deliverProductListingJob(
    listing.id,
    async () => {
      writes++
      return { status: "acked" }
    },
    {
      ...listingOptions(f, listing.repository),
      prepareStockCheckpoint: async () => {
        throw new Error("No checkpoint for ordinary product")
      },
    }
  )
  expect(writes).toBe(1)
})

it("keeps product listing queued if the Merchant identity changes during checkpoint preparation", async () => {
  const f = await fixture(),
    event = await ordinaryEdit(f),
    listing = listingRepository(event)
  let current = true,
    writes = 0
  await fails(
    deliverProductListingJob(
      listing.id,
      async () => {
        writes++
        return { status: "acked" }
      },
      {
        ...listingOptions(f, listing.repository),
        isAuthenticatedPubkeyCurrent: () => current,
        prepareStockCheckpoint: async () => {
          current = false
        },
      }
    ),
    "session changed"
  )
  expect(writes).toBe(0)
  expect(
    (await listing.repository.get(listing.id))!.relayDelivery[0]!.attemptCount
  ).toBe(0)
})

async function organizerHistoryPackets(
  f: Fixture,
  record: Awaited<ReturnType<typeof history>>,
  extra: SignedPublicNostrEvent[] = []
) {
  const packets = []
  for (const envelope of [
    record.grantEnvelope,
    ...record.acceptedEnvelopes,
    record.closingEnvelope,
    ...extra,
  ]) {
    const packet = await inspectEventMarketStockPacket({
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizer,
      shouldContinue: () => true,
      envelope,
    })
    if (!packet) throw new Error("Expected authenticated stock history")
    packets.push(packet)
  }
  return packets
}
function organizerHistoryInput(
  f: Fixture,
  packets: Awaited<ReturnType<typeof organizerHistoryPackets>>
) {
  return {
    db: f.db,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizer,
    shouldContinue: () => true,
    poolId: f.products[0]!.poolId,
    packets,
    nowMs: 500_000,
  }
}
function assignmentRead(event: SignedPublicNostrEvent) {
  const assignment = parseEventMarketAssignmentEvent(event)!
  return async () => ({
    assignment,
    state: assignment.state,
    coverage: "complete" as const,
    retained: true,
  })
}

it("composes fresh Organizer closed-prefix history and positive handout markers without activating a writer", async () => {
  const f = await fixture(),
    order = f.order()
  await f.accept(order)
  const saved = (
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.organizer)
      .toArray()
  )[0]!
  const accepted = parseEventMarketStockAuthorityRumor(saved.rumor)
  if (accepted.type !== "accepted") throw new Error("Acceptance expected")
  const handout = createEventMarketStockAuthorityRumor({
    createdAt: 107,
    payload: {
      version: 1,
      type: "handed_out",
      merchantPubkey: f.merchant,
      organizerPubkey: f.organizer,
      writerId: f.writerId,
      orderId: order.id,
      identityBinding: accepted.identityBinding,
      termsBinding: accepted.termsBinding,
      claimRef: accepted.claimRef,
      handedOutAtMs: 107_000,
      entries: [
        {
          poolId: saved.poolId,
          acceptedId: saved.rumor.id,
          quantity: saved.quantity,
        },
      ],
    },
  })
  const wrapped = await wrapPrivateMessage(
    handout,
    { pubkey: f.organizer },
    f.organizerSigner
  )
  const restoredHistory = await history(f),
    packets = await organizerHistoryPackets(f, restoredHistory, [wrapped])
  await forgetOrganizer(f)
  const sign = spyOn(f.organizerSigner, "signEvent")
  const pool = await restoreClosedOrganizerStockFromInbox(
    organizerHistoryInput(f, packets),
    {
      readAssignment: assignmentRead(f.products[0]!.commitment),
    }
  )
  expect(pool.readOnlyRecovery).toBe(true)
  expect(pool.state).toBe("closing")
  expect(pool.acceptedQuantity).toBe(2)
  const entry = (await f.db.eventMarketOrganizerStockEntries.get(
    `${f.organizer}:${saved.rumor.id}`
  ))!
  expect(entry.handout!.rumor.id).toBe(handout.id)
  expect(entry.handout!.receivedEnvelope!.id).toBe(wrapped.id)
  expect(entry.orderPoolBinding).toBeDefined()
  await restoreClosedOrganizerStockFromInbox(
    organizerHistoryInput(f, packets),
    {
      readAssignment: assignmentRead(f.products[0]!.commitment),
    }
  )
  expect(sign).not.toHaveBeenCalled()
  sign.mockRestore()
  expect(
    await f.db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(f.organizer)
      .toArray()
  ).toHaveLength(1)
  await fails(
    commitOrganizerStockAcceptance({
      ...organizerHistoryInput(f, packets),
      writerId: f.writerId,
      orderId: crypto.randomUUID(),
      identityBinding: accepted.identityBinding,
      termsBinding: accepted.termsBinding,
      claimRef: getPublicKey(generateSecretKey()),
      quantity: 1,
      evidence: "private approved terms",
    }),
    "ended"
  )
  const originalHandout = parseEventMarketStockAuthorityRumor(handout)
  if (originalHandout.type !== "handed_out") throw new Error("Handout expected")
  const conflict = createEventMarketStockAuthorityRumor({
    createdAt: 108,
    payload: {
      ...originalHandout,
      handedOutAtMs: 108_000,
    },
  })
  const conflictWrap = await wrapPrivateMessage(
    conflict,
    { pubkey: f.organizer },
    f.organizerSigner
  )
  const conflicting = await organizerHistoryPackets(f, restoredHistory, [
    wrapped,
    conflictWrap,
  ])
  await fails(
    restoreClosedOrganizerStockFromInbox(
      organizerHistoryInput(f, conflicting),
      {
        readAssignment: assignmentRead(f.products[0]!.commitment),
      }
    ),
    "conflicts"
  )
  expect(
    (await f.db.eventMarketOrganizerStockEntries.get(entry.id))!.handout!.rumor
      .id
  ).toBe(handout.id)
})

it("stops incomplete or divergent closed Organizer recovery without an empty-history reset", async () => {
  const f = await fixture()
  await f.accept(f.order())
  const restoredHistory = await history(f),
    packets = await organizerHistoryPackets(f, restoredHistory)
  await forgetOrganizer(f)
  await fails(
    restoreClosedOrganizerStockFromInbox(
      organizerHistoryInput(
        f,
        packets.filter((packet) => packet.payload.type !== "accepted")
      ),
      {
        readAssignment: assignmentRead(f.products[0]!.commitment),
      }
    ),
    "Complete closed"
  )
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
  await fails(
    restoreClosedOrganizerStockFromInbox(organizerHistoryInput(f, packets), {
      readAssignment: async () => ({
        state: "conflicting",
        coverage: "partial",
        retained: true,
      }),
    }),
    "needs reconciliation"
  )
  expect(
    await f.db.eventMarketOrganizerStockPools
      .where("accountPubkey")
      .equals(f.organizer)
      .count()
  ).toBe(0)
})

it("uses a positive latest Merchant closed projection without needing an archived active assignment", async () => {
  const f = await fixture(),
    order = f.order(),
    entries = await f.accept(order)
  await f.importOrder(order, entries)
  const restoredHistory = await history(f)
  const close = (await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.products[0]!.poolId}`
  ))!.closingWraps!.recipient
  await reconcileMerchantOrganizerStockClose({
    db: f.db,
    signer: f.merchantSigner,
    authenticatedPubkey: f.merchant,
    shouldContinue: () => true,
    closingEnvelope: close,
    nowMs: 107_000,
  })
  await f.publish()
  const closed = (await f.db.merchantInventoryAssignments.get(
    f.products[0]!.assignmentCoordinate
  ))!.signedAssignmentEvent!
  const packets = await organizerHistoryPackets(f, restoredHistory)
  await forgetOrganizer(f)
  const pool = await restoreClosedOrganizerStockFromInbox(
    organizerHistoryInput(f, packets),
    {
      readAssignment: assignmentRead(closed),
    }
  )
  expect(pool.state).toBe("closed")
  expect(pool.readOnlyRecovery).toBe(true)
  expect(pool.importedQuantity).toBe(2)
  expect(pool.receivedEnvelope!.id).toBe(restoredHistory.grantEnvelope.id)
  await forgetOrganizer(f)
  const staleRead = await restoreClosedOrganizerStockFromInbox(
    organizerHistoryInput(f, packets),
    {
      readAssignment: assignmentRead(f.products[0]!.commitment),
    }
  )
  expect(staleRead.state).toBe("closed")
  expect(staleRead.readOnlyRecovery).toBe(true)
})

it("keeps full Merchant acceptance terms encrypted in inventory, import entries and recovery checkpoints", async () => {
  const f = await fixture()
  const order = orderSchema.parse({
    ...f.order(),
    note: "SYNTHETIC_CHECKPOINT_PRIVATE_NOTE",
  })
  await f.importOrder(order, await f.accept(order))
  expect((await f.publish()).pending).toBe(0)
  const saved = await f.db.merchantInventoryAcceptedOrders.get(order.id)
  expect(JSON.stringify(saved)).not.toContain(order.note!)
  const entries = await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .toArray()
  expect(JSON.stringify(entries)).not.toContain(order.note!)
  const products = await f.db.merchantInventoryProducts
    .where("merchantPubkey")
    .equals(f.merchant)
    .toArray()
  expect(JSON.stringify(products)).not.toContain(order.note!)
  const cold = await coldMerchantCheckpoint(f)
  await cold.auth.store.receive(cold.checkpoint.selfEnvelope!, [
    "wss://relay.conduit.market",
  ])
  await restoreMerchantOrganizerStockCheckpoint(cold.input)
  const restored = (await cold.db.merchantInventoryAcceptedOrders.get(
    order.id
  ))!
  expect(JSON.stringify(restored)).not.toContain(order.note!)
  expect(
    JSON.stringify(await cold.db.merchantInventoryProducts.toArray())
  ).not.toContain(order.note!)
  expect(
    JSON.stringify(await cold.db.eventMarketOrganizerStockEntries.toArray())
  ).not.toContain(order.note!)
  const { openMerchantAcceptanceEvidence } =
    await import("@conduit/core/protocol/merchant-acceptance-privacy")
  expect(await openMerchantAcceptanceEvidence(restored, cold.auth.store)).toBe(
    JSON.stringify(order)
  )
  expect(restored.evidence).not.toBe(saved!.evidence)
})

it("repairs legacy Merchant acceptance and checkpoint copies without changing signed retry identity", async () => {
  const f = await fixture()
  const order = orderSchema.parse({
    ...f.order(),
    note: "LEGACY_PRIVATE_CHECKPOINT_NOTE",
  })
  await f.importOrder(order, await f.accept(order))
  await f.publish()
  const product = (await f.db.merchantInventoryProducts.get(
    f.products[0]!.coordinate
  ))!
  const checkpoint = await openMerchantOrganizerStockCheckpoint({
    checkpoint: product.organizerStockCheckpoint!,
    authenticatedPubkey: f.merchant,
    db: f.db,
    productCoordinate: product.coordinate,
  })
  const {
    merchantAcceptanceForPrivateTransport,
    protectMerchantAcceptanceHistory,
  } = await import("@conduit/core/protocol/merchant-acceptance-privacy")
  const saved = (await f.db.merchantInventoryAcceptedOrders.get(order.id))!
  await f.db.merchantInventoryAcceptedOrders.put(
    await merchantAcceptanceForPrivateTransport(
      saved,
      merchantAcceptanceStore(f.merchant, f.db)
    )
  )
  const legacy = { ...checkpoint }
  delete legacy.sealedRumor
  delete legacy.rumorId
  await f.db.merchantInventoryProducts.update(product.coordinate, {
    organizerStockCheckpoint: legacy,
  })
  await f.db.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.merchant)
    .modify({ evidence: JSON.stringify(order) })
  const store = new CommerceInboxStore(
    getProtectedReadAuthorization(f.merchant)!,
    f.db
  )
  await protectMerchantAcceptanceHistory(store)
  const repaired = (await f.db.merchantInventoryProducts.get(
    product.coordinate
  ))!
  expect(JSON.stringify(repaired)).not.toContain(order.note!)
  expect(
    JSON.stringify(await f.db.merchantInventoryAcceptedOrders.get(order.id))
  ).not.toContain(order.note!)
  expect(
    JSON.stringify(
      await f.db.eventMarketOrganizerStockEntries
        .where("accountPubkey")
        .equals(f.merchant)
        .toArray()
    )
  ).not.toContain(order.note!)
  expect(repaired.stock).toBe(product.stock)
  expect(repaired.publicationJobs).toEqual(product.publicationJobs)
  expect(
    (
      await openMerchantOrganizerStockCheckpoint({
        checkpoint: repaired.organizerStockCheckpoint!,
        authenticatedPubkey: f.merchant,
        db: f.db,
        productCoordinate: product.coordinate,
      })
    ).rumor
  ).toEqual(checkpoint.rumor)
  expect(repaired.organizerStockCheckpoint!.selfEnvelope).toEqual(
    checkpoint.selfEnvelope
  )
  expect((await f.importOrder(order, await f.accept(order))).replayed).toBe(
    true
  )
  expect(
    (await f.db.merchantInventoryProducts.get(product.coordinate))?.stock
  ).toBe(product.stock)
})

it("rejects device-storage markers in a portable checkpoint before restoring plaintext", async () => {
  const f = await fixture(),
    order = f.order()
  await f.importOrder(order, await f.accept(order))
  await f.publish()
  const cold = await coldMerchantCheckpoint(f)
  const payload = structuredClone(cold.payload)
  payload.snapshot.orders[0]!.evidenceFormat = "device-encrypted-v1"
  payload.snapshot.orders[0]!.evidenceBinding = "sha256:" + "a".repeat(64)
  payload.snapshotKey = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(payload.snapshot))
      )
    )
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  const rumor = createPrivateMessageRumor({
    ...cold.checkpoint.rumor,
    content: JSON.stringify(payload),
  })
  expect(() => parseEventMarketStockCheckpointRumor(rumor)).toThrow(
    "requires reconciliation"
  )
  expect(await cold.db.merchantInventoryAcceptedOrders.count()).toBe(0)
})
