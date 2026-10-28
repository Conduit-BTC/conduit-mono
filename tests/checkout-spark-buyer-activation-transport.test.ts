import { afterEach, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  activateCheckoutSparkBuyer,
  freezeCheckoutSparkSettledEventPlan,
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { createCheckoutSparkSettledRecoveryProgressPayload } from "@conduit/core/protocol/checkout-spark-recovery"
import {
  buildCheckoutSparkOrganizerRecoveryRumor,
  createCheckoutSparkOrganizerRecoveryProgressPayload,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import {
  buildCheckoutSparkOrganizerExecutionRumor,
  createCheckoutSparkOrganizerExecutionProgress,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  openCheckoutSparkOrganizerRecoveryAuthority,
  withCheckoutSparkOrganizerRecovery,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { readRetainedCheckoutSparkOrganizerRecoveries } from "@conduit/core/protocol/checkout-spark-organizer-discovery"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

it("authenticates a later immutable Buyer activation to Organizer without replacing the initial order or wallet", async () => {
  const f = await checkoutSparkOrganizerFixture({
    receiverDomain: "wallet.conduit.market",
    preparePlan: async (graph) => {
      const prepared = { ...graph.input, takeoverAt: undefined }
      return freezeCheckoutSparkSettledEventPlan({
        ...prepared,
        executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
      })
    },
  })
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
  await inbox.ingest(f.initialWrap)
  const read = () =>
    readRetainedCheckoutSparkOrganizerRecoveries({
      inbox,
      shouldContinue: () => f.clock.active,
    })
  const inactive = await read()
  expect(inactive.selections.length).toBe(1)
  expect(inactive.selections[0]!.takeoverAt).toBeNull()
  expect(
    assertCheckoutSparkOrganizerRecoveryAuthority(f.authority).buyerTakeoverAt
  ).toBeNull()
  let invoked = false
  await expect(
    withCheckoutSparkOrganizerRecovery(f.authority, async () => {
      invoked = true
    })
  ).rejects.toThrow("Buyer routing")
  expect(invoked).toBe(false)

  const activatedAt = f.plan.createdAt + 300_000
  const active = activateCheckoutSparkBuyer(f.initial.state, {
    buyerPubkey: f.buyerSigner.pubkey,
    activatedAt,
  })
  const progress = createCheckoutSparkOrganizerRecoveryProgressPayload({
    initialOrganizerHandoffId: f.initial.handoffId,
    merchantProgress: createCheckoutSparkSettledRecoveryProgressPayload({
      initialHandoffId: f.merchantRecovery.handoffId,
      state: active,
      senderPubkey: f.buyerSigner.pubkey,
      preparedAt: activatedAt,
    }),
  })
  const buyerWrap = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerRecoveryRumor(progress),
    { pubkey: f.organizerPubkey },
    f.buyerSigner,
    { rumorKind: 16 }
  )
  await inbox.ingest(buyerWrap)
  const selected = await read()
  expect(selected.conflictingCheckouts).toBe(0)
  expect(selected.selections.length).toBe(1)
  expect(selected.selections[0]!.takeoverAt).toBe(activatedAt + 120_000)
  expect(
    selected.selections[0]!.buyerActivationId ===
      active.buyerActivation!.activationId
  ).toBe(true)
  expect(selected.selections[0]!.initialWrap.id === f.initialWrap.id).toBe(true)

  const credited = recordCheckoutSparkSettledCredit(active, {
    requestId: f.plan.funding.requestId,
    paymentHash: f.plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
    grossSats: f.plan.funding.grossFundingSats,
    creditedSats: f.plan.funding.grossFundingSats,
    observedAt: activatedAt + 1,
  })
  const first = f.plan.recipients[0]!
  const receiver = qualifiedReceiverFixture({
    lud16: first.destination.value,
    amountSats: credited.legs[0]!.allocationSats! - 1,
    nowSeconds: Math.floor((activatedAt + 120_001) / 1000),
  })
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId: first.legId,
    transferId: deriveCheckoutSparkSettledTransferId(f.plan, first.legId),
    paymentRequest: receiver.paymentRequest,
    paymentHash: receiver.paymentHash,
    invoiceAmountSats: credited.legs[0]!.allocationSats! - 1,
    maxFeeSats: 1,
    receiverBinding: receiver.receiverBinding,
    preparedAt: activatedAt + 120_001,
  })
  const actorProgress = createCheckoutSparkOrganizerExecutionProgress({
    initialHandoffId: f.initial.handoffId,
    initialMerchantHandoffId: f.initial.merchantHandoffId,
    organizerPubkey: f.organizerPubkey,
    orderBinding: f.initial.orderBinding,
    writerBindings: assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
      .writerBindings,
    state,
  })
  const actorWrap = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerExecutionRumor(actorProgress),
    { pubkey: f.organizerPubkey },
    f.organizerSigner,
    { rumorKind: 16 }
  )
  f.clock.now = activatedAt + 120_002
  // Even a genuine Organizer seal cannot introduce Buyer activation.
  await expect(
    openCheckoutSparkOrganizerRecoveryAuthority({
      ...f.authorityInput,
      organizerProgressWraps: [actorWrap],
    })
  ).rejects.toThrow()
  const reopened = await openCheckoutSparkOrganizerRecoveryAuthority({
    ...f.authorityInput,
    buyerProgressWraps: [buyerWrap],
    organizerProgressWraps: [actorWrap],
  })
  expect(
    assertCheckoutSparkOrganizerRecoveryAuthority(reopened).plan.planDigest ===
      f.plan.planDigest
  ).toBe(true)
  expect(
    assertCheckoutSparkOrganizerRecoveryAuthority(reopened).buyerTakeoverAt
  ).toBe(activatedAt + 120_000)
  expect(progress.state.plan.walletId === f.initial.wallet.walletId).toBe(true)
})
