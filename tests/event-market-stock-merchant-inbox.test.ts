import { afterEach, expect, it } from "bun:test"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import {
  buildEventMarketOrderRumorTags,
  serializeOrderRumorContent,
} from "@conduit/core/protocol/orders"
import {
  createPrivateMessageRumor,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import { acceptCheckoutSparkOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-handout"
import { prepareOrganizerStockEnvelopes } from "@conduit/core/protocol/event-market-stock-journal"
import { inspectEventMarketStockPacket } from "@conduit/core/protocol/event-market-stock-workflow"
import { readRetainedMerchantOrganizerStockImports } from "@conduit/core/protocol/event-market-stock-merchant-inbox"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import type { ConduitDB } from "@conduit/core/db"
import type { OrderSchema } from "@conduit/core/schemas"

const owners: CommerceInbox[] = [],
  databases: ConduitDB[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

async function fixture() {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  const merchantSigner = new SessionSigner(f.merchantSigner, {
    expectedPubkey: f.merchantPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => f.clock.active,
  })
  try {
    await acceptCheckoutSparkOrganizerStockOrder({
      db: f.database,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizerPubkey,
      authority: f.authority,
      shouldContinue: () => f.clock.active,
      nowMs: f.clock.now,
      delivery: {
        resolveInboxRelays: async () => {
          throw new Error("Controlled offline inbox")
        },
      },
    })
  } catch {
    /* the immutable reservation survives unavailable delivery */
  }
  const entries = await f.database.eventMarketOrganizerStockEntries.toArray()
  expect(entries).toHaveLength(1)
  const wraps = await prepareOrganizerStockEnvelopes({
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    poolId: entries[0]!.poolId,
    work: { entryId: entries[0]!.rumor.id },
    shouldContinue: () => f.clock.active,
  })
  const packet = await inspectEventMarketStockPacket({
    signer: merchantSigner,
    authenticatedPubkey: f.merchantPubkey,
    shouldContinue: () => f.clock.active,
    envelope: wraps.recipient,
  })
  installProtectedReadSigner(
    merchantSigner,
    f.merchantPubkey,
    () => f.clock.active
  )
  const authorization = getProtectedReadAuthorization(f.merchantPubkey)!
  const inbox = new CommerceInbox(
    authorization,
    authorization.signer,
    new CommerceInboxStore(authorization, f.database)
  )
  owners.push(inbox)
  const original = (order: OrderSchema = f.order) =>
    wrapPrivateMessage(
      createPrivateMessageRumor({
        kind: 16,
        pubkey: f.buyerSigner.pubkey,
        created_at: Math.floor(order.createdAt / 1000),
        tags: [
          ["p", f.merchantPubkey],
          ["type", "order"],
          ["order", order.id],
          ...buildEventMarketOrderRumorTags(order),
        ],
        content: serializeOrderRumorContent(order),
      }),
      { pubkey: f.merchantPubkey },
      f.buyerSigner,
      { rumorKind: 16 }
    )
  const read = () =>
    readRetainedMerchantOrganizerStockImports({
      inbox,
      marketCoordinate: f.eventMarket.marketCoordinate,
      packets: [packet!],
      shouldContinue: () => f.clock.active,
    })
  return { ...f, inbox, original, read, packet }
}

it("connects the exact retained Buyer order and organizer acceptance without turning discovery into settlement", async () => {
  const f = await fixture()
  expect((await f.read()).selections).toHaveLength(0)
  const original = await f.original()
  await f.inbox.ingest(original, ["wss://relay.conduit.market"])
  const result = await f.read()
  expect(result.selections).toHaveLength(1)
  expect(result.selections[0]!.originalOrderEnvelope.id).toBe(original.id)
  expect(result.selections[0]!.acceptedEnvelopes[0]!.id).toBe(
    f.packet!.envelope.id
  )
  expect(result.conflictingOrders).toBe(0)
  expect(result.selections[0]).not.toHaveProperty("paymentVerified")
  expect(JSON.stringify(result).includes(f.initial.wallet.mnemonic)).toBe(false)
  expect(await f.database.merchantInventoryAcceptedOrders.count()).toBe(0)
})

it("withholds conflicting same-order Buyer terms and does not reinterpret another market", async () => {
  const f = await fixture()
  await f.inbox.ingest(await f.original(), ["wss://relay.conduit.market"])
  await f.inbox.ingest(
    await f.original({ ...f.order, createdAt: f.order.createdAt + 1 }),
    ["wss://relay.conduit.market"]
  )
  const result = await f.read()
  expect(result.selections).toHaveLength(0)
  expect(result.conflictingOrders).toBe(1)
  expect(
    (
      await readRetainedMerchantOrganizerStockImports({
        inbox: f.inbox,
        marketCoordinate: `30409:${f.organizerPubkey}:other`,
        packets: [f.packet!],
        shouldContinue: () => true,
      })
    ).selections
  ).toHaveLength(0)
})

it("revokes Merchant discovery when its account session changes", async () => {
  const f = await fixture()
  f.clock.active = false
  await expect(f.read()).rejects.toThrow()
})
