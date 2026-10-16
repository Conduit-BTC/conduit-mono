import { afterEach, expect, it, spyOn } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 as nip44 } from "nostr-tools/nip44"
import { ConduitDB } from "@conduit/core/db"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
  parseEventMarketAssignmentEvent,
} from "@conduit/core/protocol/event-market-assignment"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockGrant,
} from "@conduit/core/protocol/event-market-stock-authority"
import {
  beginOrganizerStockClose,
  commitOrganizerStockAcceptance,
  installOrganizerStockHandover,
  prepareMerchantOrganizerStockPool,
  prepareOrganizerStockEnvelopes,
} from "@conduit/core/protocol/event-market-stock-journal"
import {
  commitMerchantInventoryAssignment,
  initializeMerchantInventoryProduct,
  readMerchantInventoryAvailability,
  resumeMerchantInventoryPublication,
} from "@conduit/core/protocol/merchant-inventory"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import type { NostrKeySigner } from "@conduit/core/protocol/nostr-event-signer"
import {
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})

function runtimeAccountSigner(
  secret: Uint8Array,
  controls: {
    hasAuthority?: () => boolean
    sign?: NostrKeySigner["signEvent"]
  } = {}
) {
  const pubkey = getPublicKey(secret)
  const provider: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: controls.sign ?? (async (draft) => finalizeEvent(draft, secret)),
    encryptNip44: async (peer, plaintext) =>
      nip44.encrypt(plaintext, nip44.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      nip44.decrypt(ciphertext, nip44.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy encryption is not used")
    },
  }
  return new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: "runtime-test",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: controls.hasAuthority ?? (() => true),
  })
}

async function expectFailure(operation: Promise<unknown>, message?: string) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (message) expect((failure as Error).message).toContain(message)
}

async function fixture() {
  const merchantSecret = generateSecretKey()
  const organizerSecret = generateSecretKey()
  const merchant = getPublicKey(merchantSecret)
  const organizer = getPublicKey(organizerSecret)
  const writerId = crypto.randomUUID()
  const db = new ConduitDB(`stock-journal-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(db)
  const productCoordinate = `30402:${merchant}:stock-item`
  const marketCoordinate = `30409:${organizer}:market`
  const occurrenceCoordinate = `31923:${organizer}:day`
  const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ productCoordinate, marketCoordinate, occurrenceCoordinate })}`
  const product = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "",
      tags: [
        ["d", "stock-item"],
        ["type", "simple", "physical"],
        ["title", "Stock item"],
        ["price", "1", "SAT"],
        ["stock", "20"],
      ],
    },
    merchantSecret
  )
  await initializeMerchantInventoryProduct({
    db,
    productCoordinate,
    merchantPubkey: merchant,
    stock: 20,
    signedProductEvent: product,
  })
  await commitMerchantInventoryAssignment({
    db,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    inventory: { mode: "tracked", quantity: 6 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    expectedRevision: null,
    mutationId: "initial-allocation",
    context: {
      kind: "validated-event-market-assignment",
      productEventId: product.id,
      marketEventId: product.id,
      occurrenceEventId: product.id,
      grantEventId: product.id,
      occurrenceEndMs: 200_000,
      terminal: false,
    },
    nowMs: 100_000,
  })
  const publish = () =>
    resumeMerchantInventoryPublication({
      db,
      merchantPubkey: merchant,
      sign: async (draft) => finalizeEvent(draft, merchantSecret),
      publish: async () => true,
    })
  await publish()
  const assignment =
    (await db.merchantInventoryAssignments.get(assignmentCoordinate))!
  const grant: EventMarketStockGrant = {
    version: 1,
    type: "grant",
    nonce: crypto.randomUUID(),
    merchantPubkey: merchant,
    organizerPubkey: organizer,
    writerId,
    productCoordinate,
    assignmentCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    productEventId: product.id,
    assignmentEventId: assignment.signedAssignmentEvent!.id,
    marketEventId: product.id,
    occurrenceEventId: product.id,
    grantEventId: product.id,
    quantity: 4,
    expiresAtMs: 190_000,
  }
  const grantRumor = createEventMarketStockAuthorityRumor({
    payload: grant,
    createdAt: 101,
  })
  return {
    db,
    merchantSecret,
    organizerSecret,
    merchant,
    organizer,
    writerId,
    productCoordinate,
    marketCoordinate,
    occurrenceCoordinate,
    assignmentCoordinate,
    product,
    grant,
    grantRumor,
    assignment,
    publish,
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function prepare(f: Fixture, grantRumor = f.grantRumor) {
  return prepareMerchantOrganizerStockPool({
    db: f.db,
    authenticatedPubkey: f.merchant,
    grantRumor,
    expectedAssignmentRevision: f.assignment.revision,
    nowMs: 101_000,
  })
}

function commitment(f: Fixture, poolId = f.grantRumor.id) {
  return finalizeEvent(
    {
      ...buildEventMarketAssignmentDraft({
        merchantPubkey: f.merchant,
        productCoordinate: f.productCoordinate,
        marketCoordinate: f.marketCoordinate,
        occurrenceCoordinate: f.occurrenceCoordinate,
        state: "active",
        inventory: { mode: "tracked", quantity: 6 },
        fulfillmentMethods: ["pickup"],
        previousEventId: f.grant.assignmentEventId,
        organizerStockPool: {
          state: "active",
          poolId,
          organizerPubkey: f.organizer,
          quantity: f.grant.quantity,
          importedQuantity: 0,
        },
      }),
      created_at: 102,
    },
    f.merchantSecret
  )
}

async function install(f: Fixture, committedAssignmentEvent = commitment(f)) {
  return installOrganizerStockHandover({
    db: f.db,
    authenticatedPubkey: f.organizer,
    writerId: f.writerId,
    grantRumor: f.grantRumor,
    committedAssignmentEvent,
    nowMs: 102_000,
  })
}

function acceptance(f: Fixture, quantity = 2) {
  return {
    db: f.db,
    authenticatedPubkey: f.organizer,
    writerId: f.writerId,
    poolId: f.grantRumor.id,
    orderId: crypto.randomUUID(),
    identityBinding: getPublicKey(generateSecretKey()),
    termsBinding: getPublicKey(generateSecretKey()),
    claimRef: getPublicKey(generateSecretKey()),
    quantity,
    evidence: "validated original order fixture",
    nowMs: 110_000,
  }
}

function closeInput(f: Fixture) {
  return {
    db: f.db,
    authenticatedPubkey: f.organizer,
    writerId: f.writerId,
    poolId: f.grantRumor.id,
    nowMs: 120_000,
  }
}

it("durably reserves Merchant stock before any seal and replays exactly one preparation", async () => {
  const f = await fixture()
  const pool = await prepare(f)
  expect(pool.state).toBe("prepared")
  expect(pool.grantWraps).toBeUndefined()
  expect((await prepare(f)).poolId).toBe(pool.poolId)
  expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(1)
  const current = await readMerchantInventoryAvailability(
    f.db,
    f.productCoordinate,
    101_000
  )
  expect(current.assignments[0]?.organizerStockHold).toMatchObject({
    poolId: f.grantRumor.id,
    quantity: 4,
    importedQuantity: 0,
    closed: false,
  })
  expect(current.ordinaryAvailable).toBe(14)
  expect(
    current.assignments[0]?.publicationJobs.at(-1)?.assignmentSnapshot
      ?.organizerStockHold?.poolId
  ).toBe(f.grantRumor.id)
})

it("rejects overlapping grants without replacing an unresolved organizer writer", async () => {
  const f = await fixture()
  await prepare(f)
  const next = createEventMarketStockAuthorityRumor({
    payload: { ...f.grant, nonce: crypto.randomUUID() },
    createdAt: 101,
  })
  const current = (await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  ))!
  await expectFailure(
    prepareMerchantOrganizerStockPool({
      db: f.db,
      authenticatedPubkey: f.merchant,
      grantRumor: next,
      expectedAssignmentRevision: current.revision,
      nowMs: 101_000,
    }),
    "reconciliation"
  )
  expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(1)
  expect(
    (await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate))
      ?.organizerStockHold?.poolId
  ).toBe(f.grantRumor.id)
})

it("requires the current published assignment baseline before handover", async () => {
  const f = await fixture()
  const work = f.assignment.publicationJobs[0]!
  await f.db.merchantInventoryAssignments.update(f.assignmentCoordinate, {
    publicationJobs: [{ ...work, state: "signed" }],
  })
  await expectFailure(prepare(f), "Publish")
  expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
  expect(
    (await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate))
      ?.organizerStockHold
  ).toBeUndefined()
})

it("requires the current published product baseline before handover", async () => {
  const f = await fixture()
  await f.db.merchantInventoryProducts.update(f.productCoordinate, {
    publicationJobs: [
      {
        id: "pending-product",
        revision: 1,
        state: "awaiting_signature",
        createdAt: 100_000,
        productStock: 20,
      },
    ],
  })
  await expectFailure(prepare(f), "Publish")
  expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
  expect(
    (await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate))
      ?.organizerStockHold
  ).toBeUndefined()
})

it("rolls back the hold if durable Merchant preparation fails", async () => {
  const f = await fixture()
  const failure = spyOn(
    f.db.eventMarketOrganizerStockPools,
    "add"
  ).mockRejectedValueOnce(new Error("Synthetic pool persistence failure"))
  try {
    await expectFailure(prepare(f))
  } finally {
    failure.mockRestore()
  }
  expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
  const assignment = await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  )
  expect(assignment?.organizerStockHold).toBeUndefined()
  expect(assignment?.revision).toBe(f.assignment.revision)
})

it("publishes a signed successor committing the exact private grant before organizer installation", async () => {
  const f = await fixture()
  await prepare(f)
  await f.publish()
  const current = (await f.db.merchantInventoryAssignments.get(
    f.assignmentCoordinate
  ))!
  const signed = current.signedAssignmentEvent!
  expect(parseEventMarketAssignmentEvent(signed)?.previousEventId).toBe(
    f.grant.assignmentEventId
  )
  expect(parseEventMarketAssignmentEvent(signed)?.stockPool).toMatchObject({
    state: "valid",
    pool: { poolId: f.grantRumor.id, quantity: 4, importedQuantity: 0 },
  })
  expect((await install(f, signed)).state).toBe("active")
})

it.each(["writer", "account", "commitment"] as const)(
  "rejects installation with the wrong %s",
  async (change) => {
    const f = await fixture()
    await expectFailure(
      installOrganizerStockHandover({
        db: f.db,
        authenticatedPubkey: change === "account" ? f.merchant : f.organizer,
        writerId: change === "writer" ? crypto.randomUUID() : f.writerId,
        grantRumor: f.grantRumor,
        committedAssignmentEvent:
          change === "commitment" ? commitment(f, f.product.id) : commitment(f),
        nowMs: 102_000,
      })
    )
    expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
  }
)

it("serializes organizer acceptances without overselling and retains exact replay bindings", async () => {
  const f = await fixture()
  await install(f)
  const first = acceptance(f, 3)
  const second = acceptance(f, 3)
  const results = await Promise.allSettled([
    commitOrganizerStockAcceptance(first),
    commitOrganizerStockAcceptance(second),
  ])
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1
  )
  const original = results[0]!.status === "fulfilled" ? first : second
  expect((await commitOrganizerStockAcceptance(original)).replayed).toBe(true)
  await expectFailure(
    commitOrganizerStockAcceptance({
      ...original,
      termsBinding: getPublicKey(generateSecretKey()),
    }),
    "different terms"
  )
  const pool = await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.grantRumor.id}`
  )
  expect(pool?.acceptedQuantity).toBe(3)
  expect(pool?.acceptedSequence).toBe(1)
  expect(await f.db.eventMarketOrganizerStockEntries.count()).toBe(1)
})

it("rolls the whole acceptance back when the same claim is reused for another order", async () => {
  const f = await fixture()
  await install(f)
  const first = acceptance(f, 1)
  await commitOrganizerStockAcceptance(first)
  await expectFailure(
    commitOrganizerStockAcceptance({
      ...acceptance(f, 1),
      claimRef: first.claimRef,
    })
  )
  const pool = await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.grantRumor.id}`
  )
  expect(pool?.acceptedQuantity).toBe(1)
  expect(pool?.acceptedSequence).toBe(1)
  expect(await f.db.eventMarketOrganizerStockEntries.count()).toBe(1)
})

it("closes its frontier before a competing acceptance can consume stock", async () => {
  const f = await fixture()
  await install(f)
  const results = await Promise.allSettled([
    beginOrganizerStockClose(closeInput(f)),
    commitOrganizerStockAcceptance(acceptance(f)),
  ])
  expect(results[0]!.status).toBe("fulfilled")
  expect(results[1]!.status).toBe("rejected")
  const pool = await f.db.eventMarketOrganizerStockPools.get(
    `${f.organizer}:${f.grantRumor.id}`
  )
  expect(pool?.state).toBe("closing")
  expect(
    parseEventMarketStockAuthorityRumor(pool!.closingRumor!)
  ).toMatchObject({
    type: "closed",
    sequence: 0,
    acceptedQuantity: 0,
    lastAcceptedId: f.grantRumor.id,
  })
  expect((await beginOrganizerStockClose(closeInput(f))).id).toBe(
    pool!.closingRumor!.id
  )
})

it("expires acceptance without returning unreconciled goods to Merchant", async () => {
  const f = await fixture()
  await prepare(f)
  await install(f)
  await expectFailure(
    commitOrganizerStockAcceptance({ ...acceptance(f), nowMs: 190_000 }),
    "ended"
  )
  expect(
    (
      await readMerchantInventoryAvailability(
        f.db,
        f.productCoordinate,
        200_000
      )
    ).ordinaryAvailable
  ).toBe(16)
  expect(
    (await beginOrganizerStockClose({ ...closeInput(f), nowMs: 200_000 })).id
  ).toHaveLength(64)
})

it("restores the same journal and writer after database reload without another debit", async () => {
  const f = await fixture()
  await install(f)
  const original = acceptance(f)
  const first = await commitOrganizerStockAcceptance(original)
  f.db.close()
  await f.db.open()
  expect((await install(f)).acceptedQuantity).toBe(2)
  const replay = await commitOrganizerStockAcceptance(original)
  expect(replay.replayed).toBe(true)
  expect(replay.entry.rumor.id).toBe(first.entry.rumor.id)
  const closed = await beginOrganizerStockClose(closeInput(f))
  expect(parseEventMarketStockAuthorityRumor(closed)).toMatchObject({
    type: "closed",
    sequence: 1,
    acceptedQuantity: 2,
    lastAcceptedId: first.entry.rumor.id,
  })
})

it("retains the prepared grant and Merchant hold after signer refusal", async () => {
  const f = await fixture()
  await prepare(f)
  const signer = runtimeAccountSigner(f.merchantSecret, {
    sign: async () => {
      throw new Error("Synthetic signer refusal")
    },
  })
  await expectFailure(
    prepareOrganizerStockEnvelopes({
      db: f.db,
      signer,
      authenticatedPubkey: f.merchant,
      poolId: f.grantRumor.id,
      work: "grant",
      shouldContinue: () => true,
    })
  )
  const retained = await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.grantRumor.id}`
  )
  expect(retained?.grantRumor.id).toBe(f.grantRumor.id)
  expect(retained?.grantWraps).toBeUndefined()
  expect(
    (
      await readMerchantInventoryAvailability(
        f.db,
        f.productCoordinate,
        200_000
      )
    ).ordinaryAvailable
  ).toBe(16)
})

it.each(["entry", "close"] as const)(
  "keeps committed organizer %s work when sealing is refused",
  async (work) => {
    const f = await fixture()
    await install(f)
    const entry = await commitOrganizerStockAcceptance(acceptance(f))
    const closing =
      work === "close"
        ? await beginOrganizerStockClose(closeInput(f))
        : undefined
    const signer = runtimeAccountSigner(f.organizerSecret, {
      sign: async () => {
        throw new Error("Synthetic organizer signer refusal")
      },
    })
    await expectFailure(
      prepareOrganizerStockEnvelopes({
        db: f.db,
        signer,
        authenticatedPubkey: f.organizer,
        poolId: f.grantRumor.id,
        work: work === "close" ? "close" : { entryId: entry.entry.rumor.id },
        shouldContinue: () => true,
      })
    )
    const retainedEntry = await f.db.eventMarketOrganizerStockEntries.get(
      entry.entry.id
    )
    const retainedPool = await f.db.eventMarketOrganizerStockPools.get(
      `${f.organizer}:${f.grantRumor.id}`
    )
    expect(retainedEntry?.rumor.id).toBe(entry.entry.rumor.id)
    expect(retainedEntry?.wraps).toBeUndefined()
    expect(retainedPool?.acceptedQuantity).toBe(2)
    expect(retainedPool?.state).toBe(work === "close" ? "closing" : "active")
    expect(retainedPool?.closingRumor?.id).toBe(closing?.id)
    expect(retainedPool?.closingWraps).toBeUndefined()
  }
)

it("creates real recipient/self NIP-59 grants once and retries byte-exact without another signature", async () => {
  const f = await fixture()
  await prepare(f)
  let signatures = 0
  const merchantSigner = runtimeAccountSigner(f.merchantSecret, {
    sign: async (draft) => {
      signatures++
      return finalizeEvent(draft, f.merchantSecret)
    },
  })
  const input = {
    db: f.db,
    signer: merchantSigner,
    authenticatedPubkey: f.merchant,
    poolId: f.grantRumor.id,
    work: "grant" as const,
    shouldContinue: () => true,
  }
  const wraps = await prepareOrganizerStockEnvelopes(input)
  expect(signatures).toBe(2)
  expect(wraps.recipient.kind).toBe(1059)
  expect(wraps.self.kind).toBe(1059)
  expect(
    (
      await unwrapPrivateMessageEnvelope(
        wraps.recipient,
        runtimeAccountSigner(f.organizerSecret)
      )
    ).id
  ).toBe(f.grantRumor.id)
  expect(
    (await unwrapPrivateMessageEnvelope(wraps.self, merchantSigner)).id
  ).toBe(f.grantRumor.id)
  f.db.close()
  await f.db.open()
  expect(JSON.stringify(await prepareOrganizerStockEnvelopes(input))).toBe(
    JSON.stringify(wraps)
  )
  expect(signatures).toBe(2)
  const saved = await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.grantRumor.id}`
  )
  expect(JSON.stringify(saved?.grantWraps)).toBe(JSON.stringify(wraps))
})

it.each(["entry", "close"] as const)(
  "retains exact organizer %s envelopes for Merchant and self",
  async (work) => {
    const f = await fixture()
    await install(f)
    const accepted = await commitOrganizerStockAcceptance(acceptance(f))
    const closed =
      work === "close"
        ? await beginOrganizerStockClose(closeInput(f))
        : undefined
    let signatures = 0
    const organizerSigner = runtimeAccountSigner(f.organizerSecret, {
      sign: async (draft) => {
        signatures++
        return finalizeEvent(draft, f.organizerSecret)
      },
    })
    const input = {
      db: f.db,
      signer: organizerSigner,
      authenticatedPubkey: f.organizer,
      poolId: f.grantRumor.id,
      work:
        work === "close"
          ? ("close" as const)
          : { entryId: accepted.entry.rumor.id },
      shouldContinue: () => true,
    }
    const wraps = await prepareOrganizerStockEnvelopes(input)
    const rumor = await unwrapPrivateMessageEnvelope(
      wraps.recipient,
      runtimeAccountSigner(f.merchantSecret)
    )
    expect(rumor.id).toBe(closed?.id ?? accepted.entry.rumor.id)
    expect(decodeCommerceMessageRumor(rumor).category).toBe("machine")
    expect(
      (await unwrapPrivateMessageEnvelope(wraps.self, organizerSigner)).id
    ).toBe(rumor.id)
    expect(JSON.stringify(await prepareOrganizerStockEnvelopes(input))).toBe(
      JSON.stringify(wraps)
    )
    expect(signatures).toBe(2)
  }
)

it("does not save partial envelopes after the authenticated signer session changes", async () => {
  const f = await fixture()
  await prepare(f)
  let active = true
  const signer = runtimeAccountSigner(f.merchantSecret, {
    hasAuthority: () => active,
    sign: async (draft) => {
      const signed = finalizeEvent(draft, f.merchantSecret)
      active = false
      return signed
    },
  })
  await expectFailure(
    prepareOrganizerStockEnvelopes({
      db: f.db,
      signer,
      authenticatedPubkey: f.merchant,
      poolId: f.grantRumor.id,
      work: "grant",
      shouldContinue: () => active,
    })
  )
  const pool = await f.db.eventMarketOrganizerStockPools.get(
    `${f.merchant}:${f.grantRumor.id}`
  )
  expect(pool?.grantWraps).toBeUndefined()
  expect(pool?.grantRumor.id).toBe(f.grantRumor.id)
})

it("keeps the unsigned durable grant when envelope persistence rolls back", async () => {
  const f = await fixture()
  await prepare(f)
  const failure = spyOn(
    f.db.eventMarketOrganizerStockPools,
    "put"
  ).mockRejectedValueOnce(new Error("Synthetic envelope persistence failure"))
  try {
    await expectFailure(
      prepareOrganizerStockEnvelopes({
        db: f.db,
        signer: runtimeAccountSigner(f.merchantSecret),
        authenticatedPubkey: f.merchant,
        poolId: f.grantRumor.id,
        work: "grant",
        shouldContinue: () => true,
      })
    )
  } finally {
    failure.mockRestore()
  }
  expect(
    (
      await f.db.eventMarketOrganizerStockPools.get(
        `${f.merchant}:${f.grantRumor.id}`
      )
    )?.grantWraps
  ).toBeUndefined()
  expect(
    (await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate))
      ?.organizerStockHold?.poolId
  ).toBe(f.grantRumor.id)
})

it("quarantines authenticated unknown-version stock rumors from generic messages", async () => {
  const f = await fixture()
  const unknown = createPrivateMessageRumor({
    pubkey: f.merchant,
    kind: 14,
    created_at: 101,
    tags: [
      ["p", f.organizer],
      ["subject", "conduit-event-stock"],
      ["conduit", "event-stock", "99"],
    ],
    content: "Unrecognized machine payload",
  })
  const wrap = await wrapPrivateMessage(
    unknown,
    { pubkey: f.organizer },
    runtimeAccountSigner(f.merchantSecret)
  )
  const rumor = await unwrapPrivateMessageEnvelope(
    wrap,
    runtimeAccountSigner(f.organizerSecret)
  )
  const decoded = decodeCommerceMessageRumor(rumor)
  expect(decoded.category).toBe("machine")
  expect(decoded).not.toHaveProperty("text")
  expect(decoded).not.toHaveProperty("parsedOrderMessage")
  expect(() => parseEventMarketStockAuthorityRumor(rumor)).toThrow()
})

it("pins Merchant preparation fields and nested grant bytes before awaiting storage", async () => {
  const f = await fixture()
  const request = {
    db: f.db,
    authenticatedPubkey: f.merchant,
    grantRumor: structuredClone(f.grantRumor),
    expectedAssignmentRevision: f.assignment.revision,
    nowMs: 101_000,
  }
  const pending = prepareMerchantOrganizerStockPool(request)
  request.authenticatedPubkey = f.organizer
  request.expectedAssignmentRevision = 999
  request.grantRumor.content = "Changed after invocation"
  request.grantRumor.tags.length = 0
  const prepared = await pending
  expect(prepared.poolId).toBe(f.grantRumor.id)
  expect(JSON.stringify(prepared.grantRumor)).toBe(JSON.stringify(f.grantRumor))
  expect(
    (await f.db.merchantInventoryAssignments.get(f.assignmentCoordinate))
      ?.organizerStockHold?.poolId
  ).toBe(f.grantRumor.id)
})

it("pins organizer acceptance terms against caller mutation during storage awaits", async () => {
  const f = await fixture()
  await install(f)
  const request = acceptance(f, 1)
  const original = { ...request }
  const pending = commitOrganizerStockAcceptance(request)
  request.quantity = 4
  request.orderId = crypto.randomUUID()
  request.claimRef = getPublicKey(generateSecretKey())
  request.evidence = "Changed after invocation"
  const accepted = await pending
  expect(accepted.entry.orderId).toBe(original.orderId)
  expect(accepted.entry.quantity).toBe(1)
  expect(accepted.entry.claimRef).toBe(original.claimRef)
  expect(accepted.entry.evidence).toBe(original.evidence)
  expect(
    (
      await f.db.eventMarketOrganizerStockPools.get(
        `${f.organizer}:${f.grantRumor.id}`
      )
    )?.acceptedQuantity
  ).toBe(1)
})

it("pins closing account and writer before awaiting the journal", async () => {
  const f = await fixture()
  await install(f)
  const request = closeInput(f)
  const pending = beginOrganizerStockClose(request)
  request.authenticatedPubkey = f.merchant
  request.writerId = crypto.randomUUID()
  request.poolId = f.product.id
  const closed = parseEventMarketStockAuthorityRumor(await pending)
  expect(closed).toMatchObject({
    type: "closed",
    organizerPubkey: f.organizer,
    writerId: f.writerId,
    poolId: f.grantRumor.id,
  })
})

it("pins the requested entry while its authenticated envelope preparation awaits", async () => {
  const f = await fixture()
  await install(f)
  const first = await commitOrganizerStockAcceptance(acceptance(f, 1))
  const second = await commitOrganizerStockAcceptance(acceptance(f, 1))
  const request = {
    db: f.db,
    signer: runtimeAccountSigner(f.organizerSecret),
    authenticatedPubkey: f.organizer,
    poolId: f.grantRumor.id,
    work: { entryId: first.entry.rumor.id },
    shouldContinue: () => true,
  }
  const pending = prepareOrganizerStockEnvelopes(request)
  request.work.entryId = second.entry.rumor.id
  request.authenticatedPubkey = f.merchant
  request.poolId = f.product.id
  const wraps = await pending
  expect(
    (
      await unwrapPrivateMessageEnvelope(
        wraps.recipient,
        runtimeAccountSigner(f.merchantSecret)
      )
    ).id
  ).toBe(first.entry.rumor.id)
  expect(
    (await f.db.eventMarketOrganizerStockEntries.get(second.entry.id))?.wraps
  ).toBeUndefined()
})

it.each(["read", "getPublicKey"] as const)(
  "rechecks the session after %s before returning cached envelopes",
  async (boundary) => {
    const f = await fixture()
    await prepare(f)
    const signer = runtimeAccountSigner(f.merchantSecret)
    const common = {
      db: f.db,
      signer,
      authenticatedPubkey: f.merchant,
      poolId: f.grantRumor.id,
      work: "grant" as const,
    }
    const original = await prepareOrganizerStockEnvelopes({
      ...common,
      shouldContinue: () => true,
    })
    let active = true
    const originalGet = f.db.eventMarketOrganizerStockPools.get.bind(
      f.db.eventMarketOrganizerStockPools
    )
    const originalKey = signer.getPublicKey.bind(signer)
    let keys = 0
    const guard =
      boundary === "read"
        ? spyOn(f.db.eventMarketOrganizerStockPools, "get").mockImplementation(
            async (key) => {
              const result = await originalGet(key)
              active = false
              return result
            }
          )
        : spyOn(signer, "getPublicKey").mockImplementation(async () => {
            const key = await originalKey()
            if (++keys === 2) active = false
            return key
          })
    try {
      await expectFailure(
        prepareOrganizerStockEnvelopes({
          ...common,
          shouldContinue: () => active,
        }),
        "session changed"
      )
    } finally {
      guard.mockRestore()
    }
    expect(
      JSON.stringify(
        (await originalGet(`${f.merchant}:${f.grantRumor.id}`))?.grantWraps
      )
    ).toBe(JSON.stringify(original))
    expect(
      JSON.stringify(
        await prepareOrganizerStockEnvelopes({
          ...common,
          shouldContinue: () => true,
        })
      )
    ).toBe(JSON.stringify(original))
  }
)

it.each(["grant", "entry"] as const)(
  "rejects acceptance before its %s timestamp without consuming stock",
  async (boundary) => {
    const f = await fixture()
    await install(f)
    if (boundary === "entry")
      await commitOrganizerStockAcceptance(acceptance(f, 1))
    await expectFailure(
      commitOrganizerStockAcceptance({
        ...acceptance(f, 1),
        nowMs: boundary === "grant" ? 100_999 : 109_999,
      })
    )
    const pool = await f.db.eventMarketOrganizerStockPools.get(
      `${f.organizer}:${f.grantRumor.id}`
    )
    expect(pool?.acceptedQuantity).toBe(boundary === "grant" ? 0 : 1)
    expect(await f.db.eventMarketOrganizerStockEntries.count()).toBe(
      boundary === "grant" ? 0 : 1
    )
  }
)

it.each(["grant", "entry"] as const)(
  "rejects closing before its %s timestamp without changing its active frontier",
  async (boundary) => {
    const f = await fixture()
    await install(f)
    if (boundary === "entry")
      await commitOrganizerStockAcceptance(acceptance(f, 1))
    await expectFailure(
      beginOrganizerStockClose({
        ...closeInput(f),
        nowMs: boundary === "grant" ? 100_999 : 109_999,
      })
    )
    const pool = await f.db.eventMarketOrganizerStockPools.get(
      `${f.organizer}:${f.grantRumor.id}`
    )
    expect(pool?.state).toBe("active")
    expect(pool?.closingRumor).toBeUndefined()
  }
)

it("permits equal valid timestamps while preserving a strictly linked journal sequence", async () => {
  const f = await fixture()
  await install(f)
  const first = await commitOrganizerStockAcceptance({
    ...acceptance(f, 1),
    nowMs: 101_000,
  })
  const second = await commitOrganizerStockAcceptance({
    ...acceptance(f, 1),
    nowMs: 101_000,
  })
  expect(parseEventMarketStockAuthorityRumor(second.entry.rumor)).toMatchObject(
    { type: "accepted", previousId: first.entry.rumor.id, sequence: 2 }
  )
  const closed = await beginOrganizerStockClose({
    ...closeInput(f),
    nowMs: 101_000,
  })
  expect(parseEventMarketStockAuthorityRumor(closed)).toMatchObject({
    type: "closed",
    lastAcceptedId: second.entry.rumor.id,
    sequence: 2,
    acceptedQuantity: 2,
  })
})
