import { afterEach, expect, it } from "bun:test"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { readRetainedCheckoutSparkOrganizerRecoveries } from "@conduit/core/protocol/checkout-spark-organizer-discovery"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import type { ConduitDB } from "@conduit/core/db"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"
import {
  openEventMarketFreePurchaseAuthority,
  assertEventMarketOrganizerPurchaseAuthority,
} from "@conduit/core/protocol/event-market-organizer-purchase"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"

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
  installProtectedReadSigner(
    f.organizerSigner,
    f.organizerPubkey,
    () => f.clock.active
  )
  const authorization = getProtectedReadAuthorization(f.organizerPubkey)!
  const store = new CommerceInboxStore(authorization, f.database)
  const inbox = new CommerceInbox(authorization, authorization.signer, store)
  owners.push(inbox)
  return { ...f, inbox }
}

it("discovers only ciphertext selections from the shared machine inbox, never the wallet or ordinary conversation", async () => {
  const f = await fixture()
  await f.inbox.ingest(f.initialWrap, ["wss://relay.conduit.market"])
  const read = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox: f.inbox,
    marketCoordinate: f.plan.eventMarket!.marketCoordinate,
    shouldContinue: () => f.clock.active,
  })
  expect(read.selections).toHaveLength(1)
  expect(read.selections[0]!.initialWrap.id).toBe(f.initialWrap.id)
  expect(read.selections[0]!.orderId).toBe(f.plan.orderId)
  expect(read.selections[0]!.buyerProgressWraps).toHaveLength(0)
  expect(JSON.stringify(read).includes(f.initial.wallet.mnemonic)).toBe(false)
  expect(await f.inbox.search("checkout_spark")).toHaveLength(0)
  expect(
    (await f.inbox.store.projections()).some(
      ({ projection }) =>
        projection.kind === "direct" || projection.kind === "order"
    )
  ).toBe(false)
  const unrelated = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox: f.inbox,
    marketCoordinate: `30409:${f.organizerPubkey}:other`,
    shouldContinue: () => f.clock.active,
  })
  expect(unrelated.selections).toHaveLength(0)
})

it("does not fabricate a selection from absence and fences a revoked session", async () => {
  const f = await fixture()
  expect(
    (
      await readRetainedCheckoutSparkOrganizerRecoveries({
        inbox: f.inbox,
        shouldContinue: () => true,
      })
    ).selections
  ).toHaveLength(0)
  f.clock.active = false
  await expect(
    readRetainedCheckoutSparkOrganizerRecoveries({
      inbox: f.inbox,
      shouldContinue: () => false,
    })
  ).rejects.toThrow()
})

it("discovers a real free purchase as machine-only ciphertext without inventing a financial plan or generic order", async () => {
  const f = await eventMarketFreePurchaseFixture()
  databases.push(f.database)
  installProtectedReadSigner(
    f.organizerSigner,
    f.organizerPubkey,
    () => f.clock.active
  )
  const authorization = getProtectedReadAuthorization(f.organizerPubkey)!
  const inbox = new CommerceInbox(
    authorization,
    authorization.signer,
    new CommerceInboxStore(authorization, f.database)
  )
  owners.push(inbox)
  const secondWrap = await wrapPrivateMessage(
    f.rumor,
    { pubkey: f.organizerPubkey },
    f.guestSigner,
    { rumorKind: 16 }
  )
  await inbox.ingest(f.wrap, ["wss://relay.conduit.market"])
  await inbox.ingest(secondWrap, ["wss://relay.conduit.market"])
  const read = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: f.payload.eventMarket.marketCoordinate,
    shouldContinue: () => f.clock.active,
  })
  expect(read.selections).toHaveLength(0)
  expect(read.freeSelections).toHaveLength(1)
  const selected = read.freeSelections[0]!
  expect(selected.orderId).toBe(f.payload.orderId)
  expect(selected.handoffId).toBe(f.payload.handoffId)
  expect(selected).not.toHaveProperty("checkoutId")
  expect(selected).not.toHaveProperty("planDigest")
  expect(selected).not.toHaveProperty("plan")
  expect(selected).not.toHaveProperty("wallet")
  const projections = await inbox.store.projections()
  expect(
    projections.filter(
      ({ projection }) => projection.kind === "event_free_purchase"
    )
  ).toHaveLength(1)
  expect(
    projections.some(
      ({ projection }) =>
        projection.kind === "direct" || projection.kind === "order"
    )
  ).toBe(false)
  expect(await inbox.search("event_market_free_purchase")).toHaveLength(0)
  const opened = await openEventMarketFreePurchaseAuthority({
    ...f.authorityInput,
    signedRecipientWrap: selected.signedRecipientWrap,
  })
  expect(assertEventMarketOrganizerPurchaseAuthority(opened).kind).toBe("free")
  await expect(
    openEventMarketFreePurchaseAuthority({
      ...f.authorityInput,
      signedRecipientWrap: selected.signedRecipientWrap,
      writerId: crypto.randomUUID(),
    })
  ).rejects.toThrow()
  const otherMarket = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: `${f.payload.eventMarket.marketCoordinate}-other`,
    shouldContinue: () => true,
  })
  expect(otherMarket.freeSelections).toHaveLength(0)
  expect(read.conflictingCheckouts).toBe(0)
})
