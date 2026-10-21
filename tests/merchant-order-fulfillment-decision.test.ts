import { afterEach, describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  getUnresolvedMerchantFulfillmentLines,
  readMerchantFulfillmentDecision,
  saveMerchantFulfillmentDecision,
} from "../packages/core/src/protocol/merchant-order-fulfillment-decision"
import { openMarketsLocalOrderId } from "../packages/core/src/protocol/open-markets-orders"
import type { ParsedOrderMessage } from "../packages/core/src/protocol/orders"
import { getMerchantOrderFulfillment } from "../apps/merchant/src/lib/order-phase"
import {
  removeTestAccountSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"

const databases: ConduitDB[] = []
const leases: ReturnType<typeof setTestAccountSigner>[] = []
afterEach(async () => {
  __resetProtectedReadSigner()
  for (const lease of leases.splice(0)) removeTestAccountSigner(lease)
  for (const database of databases.splice(0)) await database.delete()
})

async function fixture() {
  const signer = NDKPrivateKeySigner.generate()
  const lease = setTestAccountSigner(signer)
  leases.push(lease)
  const merchant = (await signer.user()).pubkey
  installProtectedReadSigner(lease, merchant, () => true)
  const database = new ConduitDB(`fulfillment-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const authorization = getProtectedReadAuthorization(merchant)!
  const store = new CommerceInboxStore(authorization, database)
  const buyer = "b".repeat(64)
  const id = openMarketsLocalOrderId("external-order", buyer, merchant)
  const original: Extract<ParsedOrderMessage, { type: "order" }> = {
    id: "a".repeat(64),
    type: "order",
    wireFormat: "open_markets",
    wireOrderId: "external-order",
    orderId: id,
    createdAt: 1000,
    senderPubkey: buyer,
    recipientPubkey: merchant,
    rawContent: "",
    payload: {
      id,
      buyerPubkey: buyer,
      merchantPubkey: merchant,
      items: ["download", "book"].map((item) => ({
        productId: `30402:${merchant}:${item}`,
        quantity: 1,
        currency: "SATS",
      })),
      subtotal: 200,
      currency: "SATS",
      createdAt: 1000,
      openMarkets: {},
    },
  }
  return { original, store, database, authorization }
}

describe("supplemental merchant fulfillment decisions", () => {
  it("persists mixed decisions encrypted across reload without rewriting terms or inventory", async () => {
    const { original, store, database, authorization } = await fixture()
    const before = JSON.stringify(original)
    const decision = await saveMerchantFulfillmentDecision({
      original,
      store,
      choices: ["digital", "shipping"],
    })
    const rows = await database.commerceInboxDeliveries.toArray()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain("download")
    expect(JSON.stringify(rows)).not.toContain("digital")
    const reloaded = await readMerchantFulfillmentDecision({
      original,
      store: new CommerceInboxStore(authorization, database),
    })
    expect(reloaded).toEqual(decision)
    expect(
      getMerchantOrderFulfillment(original.payload.items, reloaded!.lines)
    ).toMatchObject({
      mode: "shipping",
      requiresShipping: true,
    })
    expect(JSON.stringify(original)).toBe(before)
    expect(await database.merchantInventoryAcceptedOrders.count()).toBe(0)
    expect(await database.merchantInventoryProducts.count()).toBe(0)
  })

  it("makes exact retries idempotent and refuses changed decisions", async () => {
    const input = await fixture()
    const first = await saveMerchantFulfillmentDecision({
      ...input,
      choices: ["digital", "digital"],
    })
    expect(
      await saveMerchantFulfillmentDecision({
        ...input,
        choices: ["digital", "digital"],
      })
    ).toEqual(first)
    await expect(
      saveMerchantFulfillmentDecision({
        ...input,
        choices: ["digital", "shipping"],
      })
    ).rejects.toThrow("different fulfillment decision")
    expect(await input.database.commerceInboxDeliveries.count()).toBe(1)
    expect(
      getMerchantOrderFulfillment(input.original.payload.items, first.lines)
        .requiresShipping
    ).toBe(false)
  })

  it("rejects different original evidence or changed buyer terms", async () => {
    const input = await fixture()
    await saveMerchantFulfillmentDecision({
      ...input,
      choices: ["digital", "digital"],
    })
    for (const original of [
      { ...input.original, id: "c".repeat(64) },
      {
        ...input.original,
        payload: { ...input.original.payload, subtotal: 201 },
      },
    ]) {
      await expect(
        readMerchantFulfillmentDecision({ ...input, original })
      ).rejects.toThrow("conflicts")
    }
    await expect(
      readMerchantFulfillmentDecision({
        ...input,
        original: {
          ...input.original,
          senderPubkey: "d".repeat(64),
        },
      })
    ).rejects.toThrow("original order")
  })

  it("requires every missing line and fences a changed active order", async () => {
    const input = await fixture()
    await expect(
      saveMerchantFulfillmentDecision({ ...input, choices: ["digital"] })
    ).rejects.toThrow("every unresolved item")
    await expect(
      saveMerchantFulfillmentDecision({
        ...input,
        choices: ["digital", "digital"],
        shouldContinue: () => false,
      })
    ).rejects.toThrow("changed")
    expect(await input.database.commerceInboxDeliveries.count()).toBe(0)
  })

  it("keeps the same external ID isolated between buyers", async () => {
    const input = await fixture()
    await saveMerchantFulfillmentDecision({
      ...input,
      choices: ["digital", "digital"],
    })
    const buyer = "c".repeat(64)
    const id = openMarketsLocalOrderId(
      "external-order",
      buyer,
      input.store.principal
    )
    const original = {
      ...input.original,
      id: "d".repeat(64),
      orderId: id,
      senderPubkey: buyer,
      payload: { ...input.original.payload, id, buyerPubkey: buyer },
    }
    expect(
      await readMerchantFulfillmentDecision({ ...input, original })
    ).toBeNull()
    expect(await input.database.commerceInboxDeliveries.count()).toBe(1)
  })

  it("cannot save choices over complete signed terms", async () => {
    const input = await fixture()
    const original = {
      ...input.original,
      payload: {
        ...input.original.payload,
        items: input.original.payload.items.map((item) => ({
          ...item,
          priceAtPurchase: 100,
          format: "physical" as const,
          fulfillment: { type: "shipping" as const },
        })),
      },
    }
    await expect(
      saveMerchantFulfillmentDecision({
        ...input,
        original,
        choices: ["digital", "digital"],
      })
    ).rejects.toThrow("every unresolved item")
    expect(await input.database.commerceInboxDeliveries.count()).toBe(0)
  })

  it("does not substitute a merchant choice for known buyer fulfillment", () => {
    const items = [
      {
        productId: "physical",
        quantity: 1,
        format: "physical" as const,
        fulfillment: { type: "shipping" as const },
        currency: "SATS",
      },
    ]
    expect(getUnresolvedMerchantFulfillmentLines({ items })).toEqual([])
    expect(
      getMerchantOrderFulfillment(items, [
        { index: 0, productId: "physical", quantity: 1, mode: "digital" },
      ])
    ).toMatchObject({ mode: "shipping", requiresShipping: true })
  })
})
