import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkMerchantOrderWitness,
  matchesCheckoutSparkMerchantOrderWitness,
  readCheckoutSparkMerchantOrderEvidence,
  restoreCheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantOrderWitness,
} from "@conduit/core/protocol/checkout-spark-merchant-order-witness"
import { createCheckoutSparkSettledReconciliation } from "@conduit/core/protocol/checkout-spark-settled-router"
import { DexieCheckoutSparkSettledRepository } from "@conduit/core/protocol/checkout-spark-settled-router-repository"
import { getOrganizerStockOrderBindings } from "@conduit/core/protocol/merchant-order-acceptance-bindings"
import {
  buildEventMarketOrderRumorTags,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  parseOrderMessageRumorEvent,
} from "@conduit/core/protocol/orders"
import {
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
} from "./support/checkout-spark-event-market-fixture"

async function fixture(
  mode: "merchant_present" | "organizer_handoff" = "organizer_handoff"
) {
  const graph = checkoutSparkEventMarketFixture({ mode })
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const order = createCheckoutSparkEventMarketFixtureOrder(graph, buyer.pubkey)
  order.buyerIdentityKind = "signed_in"
  order.shippingCostStatus = "included"
  order.note = "Private original Buyer note"
  const rumor = createPrivateMessageRumor({
    kind: 16,
    pubkey: buyer.pubkey,
    created_at: Math.floor(order.createdAt / 1000),
    tags: [
      ["p", graph.merchantPubkey],
      ["type", "order"],
      ["order", order.id],
      ["amount", String(order.subtotal)],
      ["currency", "SATS"],
      ...order.items.map((item) => [
        "item",
        item.productId,
        String(item.quantity),
      ]),
      [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
      ...buildEventMarketOrderRumorTags(order),
    ],
    content: JSON.stringify(order),
  })
  const envelope = await wrapPrivateMessage(
    rumor,
    { pubkey: graph.merchantPubkey },
    buyer
  )
  const authenticated = await unwrapPrivateMessageEnvelope(
    envelope,
    graph.merchantSigner
  )
  expect(parseOrderMessageRumorEvent(authenticated).type).toBe("order")
  const evidence = readCheckoutSparkMerchantOrderEvidence(authenticated)
  expect(evidence).not.toBeNull()
  const witness = createCheckoutSparkMerchantOrderWitness(
    graph.plan,
    evidence!,
    buyer.pubkey,
    graph.sourceEvents
  )
  expect(witness).not.toBeNull()
  return {
    ...graph,
    buyer,
    order,
    authenticated,
    evidence: evidence!,
    witness: witness!,
  }
}

function legacy(
  witness: CheckoutSparkMerchantOrderWitness
): CheckoutSparkMerchantOrderWitness {
  const { organizerOrderBinding, ...base } = witness
  void organizerOrderBinding
  return { ...base, schemaVersion: 1 }
}

async function rejects(operation: Promise<unknown>) {
  let error: unknown
  try {
    await operation
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
}

describe("actual Buyer order bindings for three-actor event recovery", () => {
  it("retains only canonical hashes of the real authenticated original order", async () => {
    const f = await fixture()
    const expected = getOrganizerStockOrderBindings(f.order)
    expect(f.witness.schemaVersion).toBe(2)
    expect(Object.keys(f.witness)).toHaveLength(9)
    expect(f.witness.organizerOrderBinding).toEqual({
      identityHash: expected.identityHash,
      termsHash: expected.termsHash,
      createdAt: f.order.createdAt,
    })
    expect(restoreCheckoutSparkMerchantOrderWitness(f.witness, f.plan)).toEqual(
      f.witness
    )
    expect(JSON.stringify(f.witness)).not.toContain(f.order.note!)
    expect(
      matchesCheckoutSparkMerchantOrderWitness(
        f.witness,
        parseOrderMessageRumorEvent(f.authenticated)
      )
    ).toBe(true)
    f.order.note = "A changed Buyer note"
    expect(f.witness.organizerOrderBinding?.termsHash).not.toBe(
      getOrganizerStockOrderBindings(f.order).termsHash
    )
  })

  it("does not manufacture an authenticated binding from copied or changed evidence", async () => {
    const f = await fixture()
    expect(
      createCheckoutSparkMerchantOrderWitness(
        f.plan,
        structuredClone(f.evidence),
        f.buyer.pubkey,
        f.sourceEvents
      )
    ).toBeNull()
    f.evidence.organizerOrderBinding!.termsHash = "0".repeat(64)
    expect(
      createCheckoutSparkMerchantOrderWitness(
        f.plan,
        f.evidence,
        f.buyer.pubkey,
        f.sourceEvents
      )
    ).toBeNull()
  })

  it("preserves historical eight-key witnesses and does not extend merchant-present records", async () => {
    const f = await fixture()
    const old = legacy(f.witness)
    const serialized = JSON.stringify(old)
    expect(Object.keys(old)).toHaveLength(8)
    expect(
      JSON.stringify(restoreCheckoutSparkMerchantOrderWitness(old, f.plan))
    ).toBe(serialized)
    expect(
      restoreCheckoutSparkMerchantOrderWitness(old, f.plan)
        .organizerOrderBinding
    ).toBeUndefined()
    const present = await fixture("merchant_present")
    expect(present.witness.schemaVersion).toBe(1)
    expect(Object.keys(present.witness)).toHaveLength(8)
    expect(present.witness.organizerOrderBinding).toBeUndefined()
  })

  it("strictly validates binding keys, identity, version and accepted time", async () => {
    const f = await fixture()
    for (const binding of [
      undefined,
      { ...f.witness.organizerOrderBinding!, extra: undefined },
      { ...f.witness.organizerOrderBinding!, identityHash: "0".repeat(64) },
      { ...f.witness.organizerOrderBinding!, termsHash: "invalid" },
      { ...f.witness.organizerOrderBinding!, createdAt: f.plan.createdAt - 1 },
      { ...f.witness.organizerOrderBinding!, createdAt: f.plan.takeoverAt },
    ]) {
      expect(() =>
        restoreCheckoutSparkMerchantOrderWitness(
          { ...f.witness, organizerOrderBinding: binding },
          f.plan
        )
      ).toThrow()
    }
    expect(() =>
      restoreCheckoutSparkMerchantOrderWitness(
        { ...f.witness, schemaVersion: 1 },
        f.plan
      )
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkMerchantOrderWitness(
        { ...f.witness, buyerPubkey: f.organizerPubkey },
        f.plan
      )
    ).toThrow()
    const changed = {
      ...f.witness,
      organizerOrderBinding: {
        ...f.witness.organizerOrderBinding!,
        termsHash: "0".repeat(64),
      },
    }
    expect(
      matchesCheckoutSparkMerchantOrderWitness(
        changed,
        parseOrderMessageRumorEvent(f.authenticated)
      )
    ).toBe(false)
    const other = await fixture("merchant_present")
    expect(() =>
      restoreCheckoutSparkMerchantOrderWitness(
        {
          ...other.witness,
          schemaVersion: 2,
          organizerOrderBinding: f.witness.organizerOrderBinding,
        },
        other.plan
      )
    ).toThrow()
  })

  it("upgrades only the exact existing original witness without changing payment state", async () => {
    const f = await fixture()
    const database = new ConduitDB(
      `event-order-witness-${crypto.randomUUID()}`,
      { indexedDB: new IDBFactory(), IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const state = createCheckoutSparkSettledReconciliation(f.plan)
      const old = legacy(f.witness)
      await repository.importMerchantOrderRecovery(state, old, () => {})
      const before = await repository.load(f.plan.checkoutId, f.plan.planDigest)
      await rejects(
        repository.importMerchantOrderRecovery(
          state,
          structuredClone(f.witness),
          () => {}
        )
      )
      expect(
        await repository.loadMerchantOrderWitness(
          f.merchantPubkey,
          f.plan.checkoutId,
          f.plan.planDigest
        )
      ).toEqual(old)
      await repository.importMerchantOrderRecovery(state, f.witness, () => {})
      expect(
        await repository.load(f.plan.checkoutId, f.plan.planDigest)
      ).toEqual(before)
      expect(
        await repository.loadMerchantOrderWitness(
          f.merchantPubkey,
          f.plan.checkoutId,
          f.plan.planDigest
        )
      ).toEqual(f.witness)
      database.close()
      await database.open()
      await repository.importMerchantOrderRecovery(
        state,
        structuredClone(f.witness),
        () => {}
      )
      await rejects(
        repository.importMerchantOrderRecovery(state, old, () => {})
      )
      expect(
        await repository.load(f.plan.checkoutId, f.plan.planDigest)
      ).toEqual(before)
    } finally {
      await database.delete()
    }
  })

  it("rejects changed original terms or identity during an authenticated witness upgrade", async () => {
    const f = await fixture()
    const database = new ConduitDB(
      `event-order-witness-conflict-${crypto.randomUUID()}`,
      { indexedDB: new IDBFactory(), IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const state = createCheckoutSparkSettledReconciliation(f.plan)
      const old = legacy(f.witness)
      await repository.importMerchantOrderRecovery(
        state,
        { ...old, contentHash: "0".repeat(64) },
        () => {}
      )
      await rejects(
        repository.importMerchantOrderRecovery(state, f.witness, () => {})
      )
      expect(
        (
          await repository.loadMerchantOrderWitness(
            f.merchantPubkey,
            f.plan.checkoutId,
            f.plan.planDigest
          )
        )?.schemaVersion
      ).toBe(1)
      expect(
        (await repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
    } finally {
      await database.delete()
    }
  })

  it("can rebind the original order after retirement without reviving payment execution", async () => {
    const f = await fixture()
    const database = new ConduitDB(
      `event-order-witness-retired-${crypto.randomUUID()}`,
      { indexedDB: new IDBFactory(), IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const state = createCheckoutSparkSettledReconciliation(f.plan)
      await repository.importMerchantOrderRecovery(
        state,
        legacy(f.witness),
        () => {}
      )
      await database.transaction(
        "rw",
        database.checkoutSparkReconciliations,
        database.checkoutSparkRetirements,
        async () => {
          await database.checkoutSparkRetirements.add({
            checkoutId: f.plan.checkoutId,
            schemaVersion: 1,
            planDigest: f.plan.planDigest,
            retiredAt: f.plan.takeoverAt + 1,
          })
          await database.checkoutSparkReconciliations.delete(f.plan.checkoutId)
        }
      )
      const before = await repository.load(f.plan.checkoutId, f.plan.planDigest)
      expect(before.status).toBe("retired")
      expect(
        await repository.importMerchantOrderRecovery(state, f.witness, () => {})
      ).toEqual(before)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      expect(
        await repository.loadMerchantOrderWitness(
          f.merchantPubkey,
          f.plan.checkoutId,
          f.plan.planDigest
        )
      ).toEqual(f.witness)
    } finally {
      await database.delete()
    }
  })
})
