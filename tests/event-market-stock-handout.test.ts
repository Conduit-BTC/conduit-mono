import { afterEach, expect, it } from "bun:test"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  confirmOrganizerStockOrderHandout,
  restoreOrganizerStockOrderHandout,
  retryOrganizerStockOrderHandout,
} from "@conduit/core/protocol/event-market-stock-handout"
import { assertCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  proveCheckoutSparkOrganizerCommerce,
  type CheckoutSparkOrganizerCommerceProof,
} from "@conduit/core/protocol/checkout-spark-organizer-commerce"
import { formatEventMarketPickupClaimCode } from "@conduit/core/protocol/event-market-handoff"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
} from "@conduit/core/protocol/event-market-stock-authority"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import type { ConduitDB } from "@conduit/core/db"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete()
})
const unavailableDelivery = {
  resolveInboxRelays: async () => {
    throw new Error("Controlled offline inbox")
  },
}
async function fixture() {
  const f = await checkoutSparkOrganizerFixture({
    commerceTotalSats: 0,
    supplier: false,
  })
  databases.push(f.database)
  const session = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
  const proof = await proveCheckoutSparkOrganizerCommerce({
    initial: f.initial,
    state: f.initial.state,
    now: () => f.clock.now,
    assertCurrent: () => {
      if (!f.clock.active) throw new Error("Stopped")
    },
    inspectPayout: async () => {
      throw new Error("Zero commerce has no goods payout")
    },
    readFunding: async () => {
      const funding = f.plan.funding,
        transferId = crypto.randomUUID()
      return {
        expectedRequest: {
          id: funding.requestId,
          network: f.plan.network,
          paymentHash: funding.paymentHash,
          paymentRequest: funding.paymentRequest,
          grossFundingSats: funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: funding.receiverIdentityPublicKey,
        receive: {
          id: funding.requestId,
          status: "TRANSFER_COMPLETED",
          network: "MAINNET",
          invoice: {
            encodedInvoice: funding.paymentRequest,
            bitcoinNetwork: "MAINNET",
            paymentHash: funding.paymentHash,
            amount: {
              originalValue: funding.grossFundingSats,
              originalUnit: "SATOSHI",
            },
          },
          transfer: {
            sparkId: transferId,
            userRequestId: funding.requestId,
            totalAmount: {
              originalValue: funding.grossFundingSats,
              originalUnit: "SATOSHI",
            },
          },
        },
        transfer: {
          id: transferId,
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: funding.grossFundingSats,
          transferDirection: "INCOMING",
          receiverIdentityPublicKey: funding.receiverIdentityPublicKey,
          userRequest: { id: funding.requestId },
        },
      }
    },
  })
  return { ...f, session, purchase, proof }
}
async function offline(operation: Promise<unknown>) {
  let cause: unknown
  try {
    await operation
  } catch (error) {
    cause = error
  }
  expect(cause).toBeInstanceOf(Error)
}
async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  return f.database.eventMarketOrganizerStockEntries
    .where("accountPubkey")
    .equals(f.organizerPubkey)
    .toArray()
}

it("reserves the full authenticated order once before payment and retains exact acceptance on delivery failure", async () => {
  const f = await fixture()
  await offline(
    acceptCheckoutSparkOrganizerStockOrder({
      ...f.session,
      authority: f.authority,
      delivery: unavailableDelivery,
      nowMs: f.clock.now,
    })
  )
  const first = await rows(f)
  expect(first).toHaveLength(1)
  expect(first[0]!.quantity).toBe(1)
  expect(first[0]!.evidence).toBe(
    JSON.stringify({
      handoffId: f.purchase.handoffId,
      planDigest: f.plan.planDigest,
      orderBinding: f.purchase.orderBinding,
    })
  )
  expect(first[0]!.evidence).not.toContain("mnemonic")
  await offline(
    acceptCheckoutSparkOrganizerStockOrder({
      ...f.session,
      authority: f.authority,
      delivery: unavailableDelivery,
      nowMs: f.clock.now + 1,
    })
  )
  expect((await rows(f))[0]!.rumor.id).toBe(first[0]!.rumor.id)
  const pool = await f.database.eventMarketOrganizerStockPools.get(
    `${f.organizerPubkey}:${first[0]!.poolId}`
  )
  expect(pool!.acceptedQuantity).toBe(1)
})

it("requires real commerce proof and exact claim, then keeps once-only handout and exact wraps across retries", async () => {
  const f = await fixture()
  await offline(
    acceptCheckoutSparkOrganizerStockOrder({
      ...f.session,
      authority: f.authority,
      delivery: unavailableDelivery,
      nowMs: f.clock.now,
    })
  )
  const confirmation = {
    ...f.session,
    authority: f.authority,
    commerceProof: f.proof,
    enteredClaimCode: formatEventMarketPickupClaimCode(f.purchase.claimRef),
    physicalReleaseConfirmed: true as const,
    nowMs: f.clock.now + 2,
    delivery: unavailableDelivery,
  }
  await offline(
    confirmOrganizerStockOrderHandout({
      ...confirmation,
      commerceProof: {} as CheckoutSparkOrganizerCommerceProof,
    })
  )
  expect((await rows(f))[0]!.handout).toBeUndefined()
  await offline(
    confirmOrganizerStockOrderHandout({
      ...confirmation,
      enteredClaimCode: "not-the-pickup-code",
    })
  )
  expect((await rows(f))[0]!.handout).toBeUndefined()
  await offline(confirmOrganizerStockOrderHandout(confirmation))
  const saved = (await rows(f))[0]!.handout!
  expect(saved.rumor).toBeDefined()
  expect(saved.wraps).toBeDefined()
  const payload = parseEventMarketStockAuthorityRumor(saved.rumor)
  expect(payload.type).toBe("handed_out")
  await offline(
    confirmOrganizerStockOrderHandout({
      ...confirmation,
      nowMs: f.clock.now + 20,
    })
  )
  await offline(
    retryOrganizerStockOrderHandout({
      ...f.session,
      orderId: f.plan.orderId,
      delivery: unavailableDelivery,
    })
  )
  const after = (await rows(f))[0]!.handout!
  expect(after.rumor.id).toBe(saved.rumor.id)
  expect(after.wraps!.recipient.id).toBe(saved.wraps!.recipient.id)
  expect(after.wraps!.self.id).toBe(saved.wraps!.self.id)
  expect(
    (await f.database.eventMarketOrganizerStockPools.get(
      `${f.organizerPubkey}:${f.purchase.writerBindings[0]!.poolId}`
    ))!.acceptedQuantity
  ).toBe(1)
})

it("authenticates recovered handout history, rejects conflicting physical release and does not debit again", async () => {
  const f = await fixture()
  await offline(
    acceptCheckoutSparkOrganizerStockOrder({
      ...f.session,
      authority: f.authority,
      delivery: unavailableDelivery,
      nowMs: f.clock.now,
    })
  )
  await offline(
    confirmOrganizerStockOrderHandout({
      ...f.session,
      authority: f.authority,
      commerceProof: f.proof,
      enteredClaimCode: formatEventMarketPickupClaimCode(f.purchase.claimRef),
      physicalReleaseConfirmed: true,
      nowMs: f.clock.now + 2,
      delivery: unavailableDelivery,
    })
  )
  const saved = (await rows(f))[0]!.handout!
  const restored = await restoreOrganizerStockOrderHandout({
    ...f.session,
    envelope: saved.wraps!.self,
  })
  expect(restored.replayed).toBe(true)
  const payload = parseEventMarketStockAuthorityRumor(saved.rumor)
  if (payload.type !== "handed_out") throw new Error("Expected handout")
  const conflictingRumor = createEventMarketStockAuthorityRumor({
    payload: { ...payload, handedOutAtMs: payload.handedOutAtMs + 1 },
    createdAt: Math.floor(payload.handedOutAtMs / 1000),
  })
  const conflicting = await wrapPrivateMessage(
    conflictingRumor,
    { pubkey: f.organizerPubkey },
    f.organizerSigner
  )
  await offline(
    restoreOrganizerStockOrderHandout({ ...f.session, envelope: conflicting })
  )
  expect((await rows(f))[0]!.handout!.rumor.id).toBe(saved.rumor.id)
  f.clock.active = false
  await offline(
    retryOrganizerStockOrderHandout({
      ...f.session,
      orderId: f.plan.orderId,
      delivery: unavailableDelivery,
    })
  )
})
