import { afterEach, describe, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkOrganizerExecutionProgress,
  parseCheckoutSparkOrganizerExecutionProgress,
  buildCheckoutSparkOrganizerExecutionRumor,
  openCheckoutSparkOrganizerExecutionProgress,
  publishCheckoutSparkOrganizerExecutionProgress,
  DexieCheckoutSparkOrganizerProgressRepository,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import { DexieCheckoutSparkSettledRepository } from "@conduit/core/protocol/checkout-spark-settled-router-repository"
import {
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import { assertCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import { admitFixture } from "./helpers/public-event"
import { RelayPublishDiagnosticsError } from "@conduit/core/protocol/relay-publish"

const databases: ConduitDB[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})
async function fixture() {
  const f = await checkoutSparkOrganizerFixture({
    receiverDomain: "wallet.conduit.market",
  })
  databases.push(f.database)
  const plan = f.plan
  const credited = recordCheckoutSparkSettledCredit(f.initial.state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats: plan.funding.grossFundingSats,
    observedAt: ++f.clock.now,
  })
  const first = plan.recipients[0]!
  const receiver = qualifiedReceiverFixture({
    lud16: first.destination.value,
    amountSats: credited.legs[0]!.allocationSats! - 1,
    nowSeconds: Math.floor(f.clock.now / 1000),
  })
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId: first.legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, first.legId),
    paymentRequest: receiver.paymentRequest,
    paymentHash: receiver.paymentHash,
    invoiceAmountSats: credited.legs[0]!.allocationSats! - 1,
    maxFeeSats: 1,
    receiverBinding: receiver.receiverBinding,
    preparedAt: ++f.clock.now,
  })
  const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
  const payload = createCheckoutSparkOrganizerExecutionProgress({
    initialHandoffId: f.initial.handoffId,
    initialMerchantHandoffId: f.initial.merchantHandoffId,
    organizerPubkey: f.organizerPubkey,
    orderBinding: f.initial.orderBinding,
    writerBindings: purchase.writerBindings,
    state,
  })
  const repository = new DexieCheckoutSparkSettledRepository(f.database)
  await repository.importRecoveryState(state, () => {})
  const store = new DexieCheckoutSparkOrganizerProgressRepository(f.database)
  const sends: string[] = []
  let wraps = 0
  let accept = true
  const relay = "wss://relay.conduit.market"
  const inboxEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  for (const [pubkey, sign] of [
    [f.organizerPubkey, f.signOrganizer],
    [f.merchantPubkey, f.signMerchant],
  ] as const) {
    await inboxEvidence.merge({
      pubkey,
      observedAt: Date.now(),
      signedEvent: await admitFixture(
        sign({
          kind: 10050,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", relay]],
          content: "",
        })
      ),
    })
  }
  const transport = {
    accountNetworkLocalStateRepository: { get: async () => undefined },
    inboxDeclarationEvidenceRepository: inboxEvidence,
    recipientInboxRelays: [relay],
    resolveInboxRelays: async () => [relay],
    giftWrapFn: async (...args: Parameters<typeof wrapPrivateMessage>) => {
      wraps++
      return wrapPrivateMessage(...args)
    },
    publishFn: async (event: { id: string }) => {
      sends.push(event.id)
      return {
        attemptedRelayUrls: [relay],
        successfulRelayUrls: accept ? [relay] : [],
        failedRelayUrls: accept ? [] : [relay],
        relayFailureMessages: {},
      }
    },
  }
  return {
    ...f,
    state,
    payload,
    repository,
    store,
    transport,
    sends,
    get wraps() {
      return wraps
    },
    set accept(value: boolean) {
      accept = value
    },
  }
}

describe("organizer-authored post-cutoff execution progress", () => {
  it("keeps the exact organizer identity, original recovery and complete stock manifest without a wallet secret", async () => {
    const f = await fixture()
    const decoded = parseCheckoutSparkOrganizerExecutionProgress(
      JSON.parse(JSON.stringify(f.payload))
    )
    expect(decoded.snapshotId).toBe(f.payload.snapshotId)
    expect(decoded.state.plan.planDigest).toBe(f.plan.planDigest)
    expect(decoded.organizerPubkey).toBe(f.organizerPubkey)
    expect(decoded.merchantPubkey).toBe(f.merchantPubkey)
    expect(decoded).not.toHaveProperty("wallet")
    expect(JSON.stringify(decoded).includes(f.initial.wallet.mnemonic)).toBe(
      false
    )
    expect(
      decodeCommerceMessageRumor(
        buildCheckoutSparkOrganizerExecutionRumor(decoded)
      ).category
    ).toBe("machine")
  })
  it("rejects changed snapshot IDs, parties, partial manifests and unrelated terms", async () => {
    const f = await fixture()
    for (const value of [
      { ...f.payload, snapshotId: f.initial.handoffId },
      { ...f.payload, organizerPubkey: f.merchantPubkey },
      { ...f.payload, writerBindings: [] },
      {
        ...f.payload,
        orderBinding: {
          ...f.payload.orderBinding,
          termsHash: f.initial.handoffId,
        },
      },
      { ...f.payload, extra: true },
    ])
      expect(() =>
        parseCheckoutSparkOrganizerExecutionProgress(value)
      ).toThrow()
  })
  it("authenticates the organizer seal separately for Merchant and self, not a Merchant signature alias", async () => {
    const f = await fixture()
    const rumor = buildCheckoutSparkOrganizerExecutionRumor(f.payload)
    for (const [recipient, signer] of [
      [f.organizerPubkey, f.organizerSigner],
      [f.merchantPubkey, f.merchantSigner],
    ] as const) {
      const wrap = await wrapPrivateMessage(
        rumor,
        { pubkey: recipient },
        f.organizerSigner,
        { rumorKind: 16 }
      )
      const opened = await openCheckoutSparkOrganizerExecutionProgress({
        signedRecipientWrap: wrap,
        signer,
        shouldContinue: () => true,
      })
      expect(opened.snapshotId).toBe(f.payload.snapshotId)
    }
    const fake = await wrapPrivateMessage(
      { ...rumor, pubkey: f.merchantPubkey },
      { pubkey: f.organizerPubkey },
      f.merchantSigner,
      { rumorKind: 16 }
    )
    await expect(
      openCheckoutSparkOrganizerExecutionProgress({
        signedRecipientWrap: fake,
        signer: f.organizerSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
  })
  it("persists/readbacks both exact ciphertexts before either relay send and never rewraps an ACK-less retry", async () => {
    const f = await fixture()
    f.accept = false
    const input = {
      payload: f.payload,
      signer: f.organizerSigner,
      store: f.store,
      shouldContinue: () => true,
      transport: f.transport,
    }
    await expect(
      publishCheckoutSparkOrganizerExecutionProgress(input)
    ).rejects.toBeInstanceOf(RelayPublishDiagnosticsError)
    const saved = await f.store.load(
      f.organizerPubkey,
      f.plan.checkoutId,
      f.plan.planDigest,
      f.payload.snapshotId
    )
    expect(saved).not.toBeNull()
    expect(saved!.merchantAccepted && saved!.selfAccepted).toBe(false)
    expect(f.wraps).toBe(2)
    f.accept = true
    const result = await publishCheckoutSparkOrganizerExecutionProgress(input)
    expect(result.merchantAccepted && result.selfAccepted).toBe(true)
    expect(result.merchantWrap.id).toBe(saved!.merchantWrap.id)
    expect(result.selfWrap.id).toBe(saved!.selfWrap.id)
    expect(f.wraps).toBe(2)
    expect(new Set(f.sends).size).toBe(2)
  })
  it("cannot publish when atomic staging fails and revokes in-flight authorization", async () => {
    const f = await fixture()
    await expect(
      publishCheckoutSparkOrganizerExecutionProgress({
        payload: f.payload,
        signer: f.organizerSigner,
        store: {
          ...f.store,
          load: f.store.load.bind(f.store),
          stage: async () => {
            throw new Error("disk unavailable")
          },
          markAccepted: f.store.markAccepted.bind(f.store),
        },
        shouldContinue: () => true,
        transport: f.transport,
      })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
    f.clock.active = false
    await expect(
      publishCheckoutSparkOrganizerExecutionProgress({
        payload: f.payload,
        signer: f.organizerSigner,
        store: f.store,
        shouldContinue: () => f.clock.active,
        transport: f.transport,
      })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
  })
})
