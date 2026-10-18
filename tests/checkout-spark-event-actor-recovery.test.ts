import { afterEach, expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import {
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  buildEventMarketOrderRumorTags,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkMerchantProgress,
  deriveCheckoutSparkSettledTransferId,
  DexieCheckoutSparkSettledRepository,
  getMerchantCheckoutSparkRecoveryList,
  prepareCheckoutSparkSettledLeg,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  withMerchantCheckoutSparkRecovery,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  createCheckoutSparkOrganizerExecutionProgress,
  buildCheckoutSparkOrganizerExecutionRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import { selectCheckoutSparkOrganizerProgressForMerchant } from "@conduit/core/protocol/checkout-spark-recovery-actor-progress"
import { createCheckoutSparkOrganizerRecoveryPayload } from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { orderSchema } from "@conduit/core/schemas"
import {
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import type { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import type { ProtectedInboxReadResult } from "@conduit/core/protocol/protected-inbox-read"
import type { ConduitDB } from "@conduit/core/db"
import { selectMerchantCheckoutSparkSignedNextPayout } from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { eventMarketFixtureInvoice } from "./support/checkout-spark-event-market-fixture"

const databases: ConduitDB[] = []
const INBOX = "wss://event-actor-recovery.example"
afterEach(async () => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

async function fixture() {
  const f = await checkoutSparkOrganizerFixture({ commerceTotalSats: 1_000 })
  databases.push(f.database)
  const { plan } = f
  const order = orderSchema.parse({
    ...f.order,
    buyerIdentityKind: "signed_in",
    shippingCostStatus: "included",
  })
  const initial = createCheckoutSparkOrganizerRecoveryPayload({
    merchantRecovery: f.merchantRecovery,
    order,
  })
  const funded = recordCheckoutSparkSettledCredit(f.merchantRecovery.state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats: plan.funding.grossFundingSats,
    observedAt: plan.createdAt + 1_000,
  })
  const recipient = plan.recipients.find((row) => row.kind === "merchant")!
  const allocated = funded.legs.find((leg) => leg.legId === recipient.legId)!
  const amount = allocated.allocationSats! - 2
  const invoice = eventMarketFixtureInvoice(amount)
  const prepared = prepareCheckoutSparkSettledLeg(funded, {
    legId: recipient.legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, recipient.legId),
    ...invoice,
    invoiceAmountSats: amount,
    maxFeeSats: 2,
    preparedAt: plan.takeoverAt + 1,
  })
  const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
    legId: recipient.legId,
    transferId: prepared.legs[0]!.intent!.transferId,
    paymentHash: invoice.paymentHash,
    status: "submitted",
    observedAt: plan.takeoverAt + 2,
  })
  const progressOf = (state = submitted, terms = initial.orderBinding) =>
    createCheckoutSparkOrganizerExecutionProgress({
      initialHandoffId: initial.handoffId,
      initialMerchantHandoffId: f.merchantRecovery.handoffId,
      organizerPubkey: f.organizerPubkey,
      orderBinding: terms,
      writerBindings: [
        { poolId: f.stockGrant!.id, writerId: f.writerId, quantity: 1 },
      ],
      state,
    })
  const progress = progressOf()
  return {
    ...f,
    order,
    initial,
    funded,
    prepared,
    submitted,
    progress,
    progressOf,
  }
}

it("advances Buyer→Organizer→Merchant on exact IDs and accepts delayed subsumed evidence without rollback", async () => {
  const f = await fixture()
  const selected = selectCheckoutSparkOrganizerProgressForMerchant({
    initial: f.merchantRecovery,
    latestState: f.funded,
    orderBinding: f.initial.orderBinding,
    entries: [f.progress],
  })
  expect(selected.status).toBe("selected")
  if (selected.status !== "selected") throw new Error("Expected exact progress")
  expect(selected.progress.type).toBe("checkout_spark_organizer_execution")
  expect(selected.progress.state.legs[0]!.intent).toEqual(
    f.prepared.legs[0]!.intent
  )
  const intent = f.submitted.legs[0]!.intent!
  const paid = recordCheckoutSparkSettledLegStatus(f.submitted, {
    legId: intent.legId,
    transferId: intent.transferId,
    paymentHash: intent.paymentHash,
    status: "paid",
    finalFeeSats: 1,
    finalDebitSats: intent.invoiceAmountSats + 1,
    observedAt: f.plan.takeoverAt + 3,
  })
  expect(
    selectCheckoutSparkOrganizerProgressForMerchant({
      initial: f.merchantRecovery,
      latestState: createCheckoutSparkMerchantProgress({
        initialHandoffId: f.merchantRecovery.handoffId,
        state: paid,
      }).state,
      orderBinding: f.initial.orderBinding,
      entries: [f.progress],
    })
  ).toEqual({ status: "none" })
})

it("rejects changed original order hashes, actor, initial handoff and divergent outgoing attempts", async () => {
  const f = await fixture()
  const select = (entries: unknown[]) =>
    selectCheckoutSparkOrganizerProgressForMerchant({
      initial: f.merchantRecovery,
      latestState: f.funded,
      orderBinding: f.initial.orderBinding,
      entries: entries as (typeof f.progress)[],
    })
  expect(
    select([{ ...f.progress, merchantPubkey: f.organizerPubkey }])
  ).toEqual({ status: "conflict" })
  expect(
    select([{ ...f.progress, initialMerchantHandoffId: f.initial.handoffId }])
  ).toEqual({ status: "conflict" })
  const changedTerms = f.progressOf(f.submitted, {
    ...f.initial.orderBinding,
    termsHash: f.plan.planDigest,
  })
  expect(select([changedTerms])).toEqual({ status: "conflict" })
  const conflicting = structuredClone(f.progress)
  conflicting.state.legs[0]!.intent = {
    ...conflicting.state.legs[0]!.intent!,
    transferId: crypto.randomUUID(),
  }
  expect(select([f.progress, conflicting])).toEqual({ status: "conflict" })
})

function protectedRead(
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

it("reopens real Organizer ciphertext before Merchant continuation and retains the actual Buyer witness", async () => {
  const f = await fixture()
  const order = f.order
  const draft = {
    kind: 16,
    pubkey: f.buyerSigner.pubkey,
    created_at: Math.floor(order.createdAt / 1000),
    tags: [
      ["p", f.merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", String(order.subtotal)],
      ["currency", "SATS"],
      ["item", order.items[0]!.productId, "1"],
      [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
      ...buildEventMarketOrderRumorTags(order),
    ],
    content: JSON.stringify(order),
  }
  // Original order is independently sealed by the Buyer, never reconstructed
  // from an Organizer's state or hashes.
  const orderWrap = await wrapPrivateMessage(
    { ...draft, id: getEventHash(draft) },
    { pubkey: f.merchantPubkey },
    f.buyerSigner
  )
  const original = await unwrapPrivateMessageEnvelope(
    orderWrap,
    f.merchantSigner
  )
  const evidence = readCheckoutSparkMerchantOrderEvidence(original)
  expect(evidence).not.toBeNull()
  const witness = createCheckoutSparkMerchantOrderWitness(
    f.plan,
    evidence!,
    f.buyerSigner.pubkey,
    f.sourceEvents
  )
  expect(witness?.organizerOrderBinding).toEqual(f.initial.orderBinding)
  const repository = new DexieCheckoutSparkSettledRepository(f.database)
  await repository.importMerchantOrderRecovery(f.funded, witness!, () => {})
  const initialWrap = await wrapPrivateMessage(
    buildCheckoutSparkRecoveryRumor(f.merchantRecovery),
    { pubkey: f.merchantPubkey },
    f.buyerSigner
  )
  const organizerWrap = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerExecutionRumor(f.progress),
    { pubkey: f.merchantPubkey },
    f.organizerSigner
  )
  let activeProgress = f.progress
  const wrappers = [initialWrap, organizerWrap]
  const owner = {
    initialize: async () => {},
    waitForDecode: async () => {},
    loadOlder: async () => {},
    checkoutRecoveryDescriptors: async () => [
      { wrapId: initialWrap.id },
      {
        wrapId: wrappers[1]!.id,
        checkoutId: f.plan.checkoutId,
        organizerMessage: "execution",
        payloadDigest: activeProgress.snapshotId,
      },
    ],
    store: {
      key: (value: string) => value,
      database: f.database,
      wrappers: async () =>
        wrappers.map((event) => ({
          event,
          sources: [INBOX],
          state: "machine",
        })),
    },
  } as unknown as CommerceInbox
  installProtectedReadSigner(f.merchantSigner, f.merchantPubkey, () => true)
  __setCommerceTestOverrides({
    getCommerceInbox: () => owner,
    getAccountSigner: () => f.merchantSigner,
    resolveInboxRelayUrls: async () => [INBOX],
    readProtectedInbox: async (request) =>
      protectedRead(
        wrappers.filter(
          (wrap) => !request.eventId || wrap.id === request.eventId
        )
      ),
    checkoutSparkSettledRepository: repository,
  })
  const found = await getMerchantCheckoutSparkRecoveryList(f.merchantPubkey)
  expect(found.candidates).toHaveLength(1)
  let consumed = 0
  const beforeStock = await f.database.eventMarketOrganizerStockEntries.count()
  const result = await withMerchantCheckoutSparkRecovery(
    f.merchantPubkey,
    found.candidates[0]!,
    {
      consume: async () => {
        throw new Error("Must ingest exact Organizer progress first")
      },
      consumeMerchantProgress: async (initial, _buyer, progress, check) => {
        check()
        expect(initial.handoffId).toBe(f.merchantRecovery.handoffId)
        expect(progress.type).toBe("checkout_spark_organizer_execution")
        expect(progress.state.legs[0]!.intent).toEqual(
          f.prepared.legs[0]!.intent
        )
        await repository.importMerchantOrderRecovery(
          progress.state,
          witness!,
          check
        )
        consumed++
      },
    }
  )
  expect(result.status).toBe("consumed")
  expect(consumed).toBe(1)
  const saved = await repository.load(f.plan.checkoutId, f.plan.planDigest)
  expect(saved.status).toBe("active")
  if (saved.status !== "active")
    throw new Error("Expected retained exact state")
  expect(saved.state.legs[0]!.status).toBe("submitted")
  // State import is not an independently verified Merchant settlement record.
  expect(
    await repository.loadMerchantSettlement(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest
    )
  ).toBeNull()
  expect(await f.database.eventMarketOrganizerStockEntries.count()).toBe(
    beforeStock
  )
  expect(
    await repository.loadMerchantOrderWitness(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest
    )
  ).toEqual(witness)
  const selected = found.candidates[0]!
  const selection = await selectMerchantCheckoutSparkSignedNextPayout(
    f.merchantPubkey,
    selected,
    () => {},
    {
      repository,
      now: () => f.plan.takeoverAt + 10,
      consumeRecovery: async (_principal, candidate, adapter) => {
        await adapter.consumeMerchantProgress!(
          f.merchantRecovery,
          f.merchantRecovery,
          f.progress,
          () => {}
        )
        return {
          status: "consumed",
          coverage: "complete",
          discoveryCoverage: "complete",
          declarationState: "declared",
          candidate,
        }
      },
    }
  )
  // This is a real Organizer-authored possible send. It is retained as-is,
  // never misread as a selected Merchant self-wrap or replaced with a new ID.
  expect(selection.status).toBe("preparation_needed")
  activeProgress = f.progressOf(f.submitted, {
    ...f.initial.orderBinding,
    termsHash: f.plan.planDigest,
  })
  wrappers[1] = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerExecutionRumor(activeProgress),
    { pubkey: f.merchantPubkey },
    f.organizerSigner
  )
  // The forged terms are genuinely sealed by the authorized Organizer. They
  // still cannot replace the independently authenticated original Buyer terms.
  await expect(
    withMerchantCheckoutSparkRecovery(f.merchantPubkey, selected, {
      consume: async () => {
        throw new Error("Must not reach an app/provider")
      },
      consumeMerchantProgress: async () => {
        consumed++
      },
    })
  ).rejects.toThrow("adapter failed")
  expect(consumed).toBe(1)
  expect(await repository.load(f.plan.checkoutId, f.plan.planDigest)).toEqual(
    saved
  )
})
