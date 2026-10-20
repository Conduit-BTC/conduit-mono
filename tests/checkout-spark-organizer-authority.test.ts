import { afterEach, describe, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
  openCheckoutSparkOrganizerRecoveryAuthority,
  withCheckoutSparkOrganizerRecovery,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { commitOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-journal"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
async function fixture() {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  return f
}
async function reserve(f: Awaited<ReturnType<typeof fixture>>) {
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
  return commitOrganizerStockOrder({
    db: f.database,
    authenticatedPubkey: f.organizerPubkey,
    orderId: purchase.plan.orderId,
    identityBinding: purchase.orderBinding.identityHash,
    termsBinding: purchase.orderBinding.termsHash,
    claimRef: purchase.claimRef,
    entries: purchase.writerBindings,
    evidence: JSON.stringify({
      handoffId: purchase.handoffId,
      planDigest: purchase.plan.planDigest,
      orderBinding: purchase.orderBinding,
    }),
    nowMs: f.clock.now,
  })
}

describe("authenticated organizer checkout execution authority", () => {
  it("authenticates independent Buyer and Merchant seals without exposing the checkout wallet to UI", async () => {
    const f = await fixture()
    const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
    expect(purchase.plan.planDigest).toBe(f.plan.planDigest)
    expect(purchase.writerBindings).toEqual([
      { poolId: f.stockGrant!.id, writerId: f.writerId, quantity: 1 },
    ])
    expect(purchase.orderBinding).toEqual(f.initial.orderBinding)
    expect(purchase).not.toHaveProperty("wallet")
    expect(purchase).not.toHaveProperty("order")
    expect(JSON.stringify(purchase).includes(f.initial.wallet.mnemonic)).toBe(
      false
    )
    purchase.writerBindings[0]!.quantity = 99
    expect(
      assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
        .writerBindings[0]!.quantity
    ).toBe(1)
  })
  it("requires a complete atomic reserved-stock manifest before the executor can consume recovery", async () => {
    const f = await fixture()
    let calls = 0
    await expect(
      withCheckoutSparkOrganizerRecovery(f.authority, async () => {
        calls++
      })
    ).rejects.toThrow("Reserve")
    expect(calls).toBe(0)
    await reserve(f)
    await withCheckoutSparkOrganizerRecovery(
      f.authority,
      async ({ initial, state }) => {
        calls++
        expect(initial.wallet.walletId).toBe(f.plan.walletId)
        expect(state.plan.planDigest).toBe(f.plan.planDigest)
      }
    )
    expect(calls).toBe(1)
  })
  it("rejects deserialized/raw authority and a different locally selected writer", async () => {
    const f = await fixture()
    expect(() =>
      assertCheckoutSparkOrganizerRecoveryAuthority(
        JSON.parse(JSON.stringify(f.authority))
      )
    ).toThrow()
    await expect(
      openCheckoutSparkOrganizerRecoveryAuthority({
        ...f.authorityInput,
        writerId: crypto.randomUUID(),
      })
    ).rejects.toThrow()
  })
  it("does not let a Merchant use the separately encrypted organizer recovery", async () => {
    const f = await fixture()
    await expect(
      openCheckoutSparkOrganizerRecoveryAuthority({
        ...f.authorityInput,
        authenticatedPubkey: f.merchantPubkey,
      })
    ).rejects.toThrow()
  })
  it("keeps buyer cutoff independent of stock reservation and rejects pre-cutoff execution", async () => {
    const f = await fixture()
    f.clock.now = f.plan.takeoverAt - 1
    const authority = await openCheckoutSparkOrganizerRecoveryAuthority(
      f.authorityInput
    )
    await expect(
      withCheckoutSparkOrganizerRecovery(authority, async () => {})
    ).rejects.toThrow("Buyer routing")
  })
  it("revokes an open capability on signer/session change and time expiry", async () => {
    const f = await fixture()
    f.clock.active = false
    expect(() =>
      assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
    ).toThrow()
    f.clock.active = true
    f.clock.now += 5 * 60_000
    expect(() =>
      assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
    ).toThrow()
  })
  it("rechecks writer fencing, authenticated grant and exact accepted terms at the provider boundary", async () => {
    const f = await fixture()
    await reserve(f)
    await assertCheckoutSparkOrganizerRecoveryWriterCurrent(f.authority)
    const pool = (await f.database.eventMarketOrganizerStockPools.toArray())[0]!
    await f.database.eventMarketOrganizerStockPools.update(pool.id, {
      readOnlyRecovery: true,
    })
    await expect(
      assertCheckoutSparkOrganizerRecoveryWriterCurrent(f.authority)
    ).rejects.toThrow()
    await f.database.eventMarketOrganizerStockPools.update(pool.id, {
      readOnlyRecovery: undefined,
    })
    const entry = (
      await f.database.eventMarketOrganizerStockEntries.toArray()
    )[0]!
    await f.database.eventMarketOrganizerStockEntries.update(entry.id, {
      quantity: 2,
    })
    await expect(
      assertCheckoutSparkOrganizerRecoveryWriterCurrent(f.authority)
    ).rejects.toThrow()
  })
})
