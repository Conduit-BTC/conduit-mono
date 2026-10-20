import { afterEach, describe, expect, it } from "bun:test"
import type { ConduitDB } from "@conduit/core/db"
import {
  buildCheckoutSparkMerchantEventProgressRumor,
  createCheckoutSparkMerchantEventProgress,
  openCheckoutSparkMerchantEventProgress,
  parseCheckoutSparkMerchantEventProgress,
} from "@conduit/core/protocol/checkout-spark-merchant-event-progress"
import {
  buildCheckoutSparkMerchantProgressRumor,
  createCheckoutSparkMerchantProgress,
} from "@conduit/core/protocol/checkout-spark-merchant-progress"
import {
  publishMerchantCheckoutSparkProgress,
  retryMerchantCheckoutSparkProgress,
  type MerchantCheckoutSparkProgressDeliveryStore,
} from "@conduit/core/protocol/checkout-spark-merchant-progress-delivery"
import { DexieMerchantCheckoutSparkProgressRepository } from "@conduit/core/protocol/checkout-spark-merchant-progress-repository"
import { DexieCheckoutSparkSettledRepository } from "@conduit/core/protocol/checkout-spark-settled-router-repository"
import {
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  createCheckoutSparkMerchantOrderWitness,
  readCheckoutSparkMerchantOrderEvidence,
} from "@conduit/core/protocol/checkout-spark-merchant-order-witness"
import {
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
} from "@conduit/core/protocol/private-message-primitives"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import {
  buildEventMarketOrderRumorTags,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
} from "@conduit/core/protocol/orders"
import {
  openCheckoutSparkOrganizerRecoveryAuthority,
  withCheckoutSparkOrganizerRecovery,
  assertCheckoutSparkOrganizerRecoveryAuthority,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { commitOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-journal"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { readRetainedCheckoutSparkOrganizerRecoveries } from "@conduit/core/protocol/checkout-spark-organizer-discovery"
import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import { RelayPublishDiagnosticsError } from "@conduit/core/protocol/relay-publish"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { admitFixture } from "./helpers/public-event"
import { validateCheckoutSparkPlanSources } from "@conduit/core/protocol/checkout-spark-plan-sources"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import {
  createCheckoutSparkOrganizerRecoveryPayload,
  buildCheckoutSparkOrganizerRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"

const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

async function fixture() {
  const base = await checkoutSparkOrganizerFixture({
    receiverDomain: "wallet.conduit.market",
  })
  base.order.buyerIdentityKind = "signed_in"
  base.order.shippingCostStatus = "included"
  const initial = createCheckoutSparkOrganizerRecoveryPayload({
    merchantRecovery: base.merchantRecovery,
    order: base.order,
  })
  const initialWrap = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerRecoveryRumor(initial),
    { pubkey: base.organizerPubkey },
    base.buyerSigner,
    { rumorKind: 16 }
  )
  const authorityInput = { ...base.authorityInput, initialWrap }
  const authority =
    await openCheckoutSparkOrganizerRecoveryAuthority(authorityInput)
  const f = { ...base, initial, initialWrap, authorityInput, authority }
  databases.push(f.database)
  const credited = recordCheckoutSparkSettledCredit(f.initial.state, {
    requestId: f.plan.funding.requestId,
    paymentHash: f.plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
    grossSats: f.plan.funding.grossFundingSats,
    creditedSats: f.plan.funding.grossFundingSats,
    observedAt: ++f.clock.now,
  })
  const first = f.plan.recipients[0]!
  const receiver = qualifiedReceiverFixture({
    lud16: first.destination.value,
    amountSats: credited.legs[0]!.allocationSats! - 1,
    nowSeconds: Math.floor(f.clock.now / 1000),
  })
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId: first.legId,
    transferId: deriveCheckoutSparkSettledTransferId(f.plan, first.legId),
    paymentRequest: receiver.paymentRequest,
    paymentHash: receiver.paymentHash,
    invoiceAmountSats: credited.legs[0]!.allocationSats! - 1,
    maxFeeSats: 1,
    receiverBinding: receiver.receiverBinding,
    preparedAt: ++f.clock.now,
  })
  const merchantProgress = createCheckoutSparkMerchantProgress({
    initialHandoffId: f.initial.merchantHandoffId,
    state,
  })
  const payload = createCheckoutSparkMerchantEventProgress({
    merchantProgress,
    orderBinding: f.initial.orderBinding,
  })
  // Establish the hash binding only through an actual Buyer-authored order.
  const order = f.order
  const orderRumor = createPrivateMessageRumor({
    kind: 16,
    pubkey: f.buyerSigner.pubkey,
    created_at: Math.floor(order.createdAt / 1000),
    tags: [
      ["p", f.merchantPubkey],
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
  const orderWrap = await wrapPrivateMessage(
    orderRumor,
    { pubkey: f.merchantPubkey },
    f.buyerSigner
  )
  const authenticated = await unwrapPrivateMessageEnvelope(
    orderWrap,
    f.merchantSigner
  )
  const evidence = readCheckoutSparkMerchantOrderEvidence(authenticated)
  expect(evidence).not.toBeNull()
  validateCheckoutSparkPlanSources(f.plan, f.sourceEvents)
  const witness = createCheckoutSparkMerchantOrderWitness(
    f.plan,
    evidence!,
    f.buyerSigner.pubkey,
    f.sourceEvents
  )!
  expect(witness?.schemaVersion).toBe(2)
  expect(witness.organizerOrderBinding).toEqual(f.initial.orderBinding)
  const repository = new DexieCheckoutSparkSettledRepository(f.database)
  await repository.importMerchantOrderRecovery(state, witness, () => {})
  const store = new DexieMerchantCheckoutSparkProgressRepository(f.database)
  const sends: { id: string; recipient: string }[] = []
  let wraps = 0
  let acceptOrganizer = true
  let failWrap = 0
  let expectedWraps = 2
  const relay = "wss://relay.conduit.market"
  const inboxEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  for (const [pubkey, sign] of [
    [f.organizerPubkey, f.signOrganizer],
    [f.merchantPubkey, f.signMerchant],
  ] as const)
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
  const transport = {
    accountNetworkLocalStateRepository: { get: async () => undefined },
    inboxDeclarationEvidenceRepository: inboxEvidence,
    recipientInboxRelays: [relay],
    resolveInboxRelays: async () => [relay],
    giftWrapFn: async (...args: Parameters<typeof wrapPrivateMessage>) => {
      if (++wraps === failWrap) throw new Error("Signer unavailable")
      return wrapPrivateMessage(...args)
    },
    publishFn: async (event: { id: string; tags: string[][] }) => {
      const recipient = event.tags.find((tag) => tag[0] === "p")![1]!
      const saved = await store.load(
        f.merchantPubkey,
        f.plan.checkoutId,
        f.plan.planDigest,
        merchantProgress.snapshotId
      )
      expect(saved?.record.schemaVersion).toBe(2)
      expect(saved?.record.organizerDelivery?.signedRecipientWrap).toBeDefined()
      expect(wraps).toBe(expectedWraps)
      sends.push({ id: event.id, recipient })
      const accepted = recipient !== f.organizerPubkey || acceptOrganizer
      return {
        attemptedRelayUrls: [relay],
        successfulRelayUrls: accepted ? [relay] : [],
        failedRelayUrls: accepted ? [] : [relay],
        relayFailureMessages: {},
      }
    },
  }
  return {
    ...f,
    state,
    merchantProgress,
    payload,
    repository,
    store,
    transport,
    sends,
    witness,
    get wraps() {
      return wraps
    },
    set acceptOrganizer(value: boolean) {
      acceptOrganizer = value
    },
    set failWrap(value: number) {
      failWrap = value
    },
    set expectedWraps(value: number) {
      expectedWraps = value
    },
  }
}

describe("reciprocal Merchant Event recovery progress", () => {
  it("has an independently bound Merchant namespace without full order, wallet or stock writer claims", async () => {
    const f = await fixture()
    const parsed = parseCheckoutSparkMerchantEventProgress(
      JSON.parse(JSON.stringify(f.payload))
    )
    expect(parsed.initialOrganizerHandoffId).toBe(f.initial.handoffId)
    expect(parsed.state.plan.planDigest).toBe(f.plan.planDigest)
    expect(parsed).not.toHaveProperty("wallet")
    expect(parsed).not.toHaveProperty("order")
    expect(parsed).not.toHaveProperty("writerBindings")
    expect(JSON.stringify(parsed)).not.toContain(f.initial.wallet.mnemonic)
    expect(
      decodeCommerceMessageRumor(
        buildCheckoutSparkMerchantEventProgressRumor(parsed)
      ).category
    ).toBe("machine")
    for (const value of [
      { ...parsed, snapshotId: f.initial.handoffId },
      { ...parsed, initialOrganizerHandoffId: f.initial.merchantHandoffId },
      { ...parsed, organizerPubkey: f.merchantPubkey },
      { ...parsed, orderBinding: { ...parsed.orderBinding, extra: undefined } },
      { ...parsed, state: { ...parsed.state, privateData: undefined } },
      { ...parsed, schemaVersion: 2 },
      { ...parsed, extra: undefined },
    ])
      expect(() => parseCheckoutSparkMerchantEventProgress(value)).toThrow()
  })

  it("authenticates Merchant to Organizer only and rejects wrong signer, expiry and revoked sessions", async () => {
    const f = await fixture()
    const wrap = await wrapPrivateMessage(
      buildCheckoutSparkMerchantEventProgressRumor(f.payload),
      { pubkey: f.organizerPubkey },
      f.merchantSigner,
      { rumorKind: 16 }
    )
    expect(
      (
        await openCheckoutSparkMerchantEventProgress({
          signedRecipientWrap: wrap,
          signer: f.organizerSigner,
          shouldContinue: () => true,
        })
      ).snapshotId
    ).toBe(f.payload.snapshotId)
    await expect(
      openCheckoutSparkMerchantEventProgress({
        signedRecipientWrap: wrap,
        signer: f.merchantSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    await expect(
      openCheckoutSparkMerchantEventProgress({
        signedRecipientWrap: wrap,
        signer: f.organizerSigner,
        shouldContinue: () => false,
      })
    ).rejects.toThrow()
    const fake = await wrapPrivateMessage(
      {
        ...buildCheckoutSparkMerchantEventProgressRumor(f.payload),
        pubkey: f.organizerPubkey,
      },
      { pubkey: f.organizerPubkey },
      f.organizerSigner,
      { rumorKind: 16 }
    )
    await expect(
      openCheckoutSparkMerchantEventProgress({
        signedRecipientWrap: fake,
        signer: f.organizerSigner,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
  })

  it("atomically retains two distinct exact messages and requires both ACKs, retrying no signatures", async () => {
    const f = await fixture()
    f.acceptOrganizer = false
    const input = {
      payload: f.merchantProgress,
      signer: f.merchantSigner,
      store: f.store,
      transport: f.transport,
      shouldContinue: () => true,
    }
    await expect(
      publishMerchantCheckoutSparkProgress(input)
    ).rejects.toBeInstanceOf(RelayPublishDiagnosticsError)
    const saved = (await f.store.load(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest,
      f.merchantProgress.snapshotId
    ))!
    expect(saved.relayAccepted).toBe(false)
    expect(saved.merchantAccepted).toBe(true)
    expect(saved.organizerAccepted).toBe(false)
    expect(saved.record.rumorId).not.toBe(
      saved.record.organizerDelivery!.rumorId
    )
    expect(f.wraps).toBe(2)
    f.acceptOrganizer = true
    const result = await retryMerchantCheckoutSparkProgress({
      ...input,
      record: saved.record,
      store: new DexieMerchantCheckoutSparkProgressRepository(f.database),
    })
    expect(result.relayAccepted).toBe(true)
    expect(result.record).toEqual(saved.record)
    expect(f.wraps).toBe(2)
    expect(
      f.sends.filter((send) => send.recipient === f.merchantPubkey)
    ).toHaveLength(1)
    expect(
      new Set(
        f.sends
          .filter((send) => send.recipient === f.organizerPubkey)
          .map((send) => send.id)
      ).size
    ).toBe(1)
  })

  it("never publishes a partial pair after second signing or atomic storage failure", async () => {
    const f = await fixture()
    f.failWrap = 2
    const input = {
      payload: f.merchantProgress,
      signer: f.merchantSigner,
      store: f.store,
      transport: f.transport,
      shouldContinue: () => true,
    }
    await expect(publishMerchantCheckoutSparkProgress(input)).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
    expect(
      await f.store.load(
        f.merchantPubkey,
        f.plan.checkoutId,
        f.plan.planDigest,
        f.merchantProgress.snapshotId
      )
    ).toBeNull()
    const failingStore: MerchantCheckoutSparkProgressDeliveryStore = {
      load: f.store.load.bind(f.store),
      loadOrganizerOrderBinding: f.store.loadOrganizerOrderBinding.bind(
        f.store
      ),
      stage: async () => {
        throw new Error("Disk unavailable")
      },
      markAccepted: f.store.markAccepted.bind(f.store),
    }
    await expect(
      publishMerchantCheckoutSparkProgress({ ...input, store: failingStore })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
  })

  it("requires a real schema-two order witness and cannot infer a binding from legacy state", async () => {
    const f = await fixture()
    const row = (await f.database.checkoutSparkPlanBindings.get(
      f.plan.checkoutId
    ))!
    const { organizerOrderBinding: ignored, ...old } = f.witness
    void ignored
    await f.database.checkoutSparkPlanBindings.put({
      ...row,
      orderWitness: { ...old, schemaVersion: 1 },
    })
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: f.merchantProgress,
        signer: f.merchantSigner,
        store: f.store,
        transport: f.transport,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    expect(f.wraps).toBe(0)
    expect(f.sends).toHaveLength(0)
  })

  it("keeps per-recipient ACKs monotonic and rejects a different organizer or poisoned aggregate status", async () => {
    const f = await fixture()
    const delivery = await publishMerchantCheckoutSparkProgress({
      payload: f.merchantProgress,
      signer: f.merchantSigner,
      store: f.store,
      transport: f.transport,
      shouldContinue: () => true,
    })
    const accepted = await f.store.markAccepted(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest,
      f.merchantProgress.snapshotId,
      () => {},
      { merchantAccepted: false, organizerAccepted: false }
    )
    expect(
      accepted.merchantAccepted &&
        accepted.organizerAccepted &&
        accepted.relayAccepted
    ).toBe(true)
    const wrongRecipient = await wrapPrivateMessage(
      buildCheckoutSparkMerchantEventProgressRumor(f.payload),
      { pubkey: f.buyerSigner.pubkey },
      f.merchantSigner,
      { rumorKind: 16 }
    )
    await expect(
      f.store.stage(
        {
          ...delivery.record,
          organizerDelivery: {
            ...delivery.record.organizerDelivery!,
            organizerPubkey: f.buyerSigner.pubkey,
            signedRecipientWrap: wrongRecipient,
          },
        },
        () => {}
      )
    ).rejects.toThrow()
    const row = (await f.database.checkoutSparkPlanBindings.get(
      f.plan.checkoutId
    ))!
    await f.database.checkoutSparkPlanBindings.put({
      ...row,
      merchantProgressOutbox: [
        { ...accepted, organizerAccepted: false, relayAccepted: true },
      ],
    })
    await expect(
      f.store.load(
        f.merchantPubkey,
        f.plan.checkoutId,
        f.plan.planDigest,
        f.merchantProgress.snapshotId
      )
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(2)
  })

  it("preserves existing active-account relay AUTH for both new role copies and the exact stored Organizer retry", async () => {
    const f = await fixture()
    const signer = new SessionSigner(f.merchantSigner, {
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
    installProtectedReadSigner(signer, f.merchantPubkey, () => f.clock.active)
    const store = new CommerceInboxStore(
      getProtectedReadAuthorization(f.merchantPubkey)!,
      f.database
    )
    let authentications = 0
    let visible = 0
    const transport = {
      ...f.transport,
      deliveryStore: store,
      relayAuthMethod: "nip07" as const,
      waitForSignerVisibility: async () => {
        visible++
      },
      publishFn: async (
        event: Parameters<NonNullable<typeof f.transport.publishFn>>[0],
        options: Parameters<
          NonNullable<
            import("@conduit/core/protocol/messaging").PublishPrivateMessageInput["publishFn"]
          >
        >[1]
      ) => {
        expect(options.relayAuthentication?.signer).toBe(signer)
        expect(options.relayAuthentication?.expectedPubkey).toBe(
          f.merchantPubkey
        )
        await options.relayAuthentication?.waitForSignerVisibility?.()
        authentications++
        return f.transport.publishFn(event)
      },
    }
    f.acceptOrganizer = false
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: f.merchantProgress,
        signer,
        store: f.store,
        transport,
        shouldContinue: () => f.clock.active,
      })
    ).rejects.toThrow()
    const saved = (await f.store.load(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest,
      f.merchantProgress.snapshotId
    ))!
    f.acceptOrganizer = true
    expect(
      (
        await retryMerchantCheckoutSparkProgress({
          record: saved.record,
          signer,
          store: f.store,
          transport,
          shouldContinue: () => f.clock.active,
        })
      ).relayAccepted
    ).toBe(true)
    expect(authentications).toBe(3)
    expect(visible).toBe(3)
    expect(f.wraps).toBe(2)
  })

  it("upgrades historical v5 self-only progress without replacing its ciphertext or losing its existing ACK", async () => {
    const f = await fixture()
    f.expectedWraps = 1
    const rumor = buildCheckoutSparkMerchantProgressRumor(f.merchantProgress)
    const self = await wrapPrivateMessage(
      rumor,
      { pubkey: f.merchantPubkey },
      f.merchantSigner,
      { rumorKind: 16 }
    )
    const legacy = {
      schemaVersion: 1 as const,
      merchantPubkey: f.merchantPubkey,
      checkoutId: f.plan.checkoutId,
      planDigest: f.plan.planDigest,
      snapshotId: f.merchantProgress.snapshotId,
      initialHandoffId: f.merchantProgress.initialHandoffId,
      rumorId: rumor.id,
      signedRecipientWrap: self,
      recordedAt: f.merchantProgress.recordedAt,
    }
    const original = JSON.stringify(legacy)
    const originalStored = await f.store.stage(legacy, () => {})
    await f.store.markAccepted(
      f.merchantPubkey,
      f.plan.checkoutId,
      f.plan.planDigest,
      f.merchantProgress.snapshotId,
      () => {}
    )
    const result = await retryMerchantCheckoutSparkProgress({
      record: legacy,
      signer: f.merchantSigner,
      store: f.store,
      transport: f.transport,
      shouldContinue: () => true,
    })
    expect(result.record.schemaVersion).toBe(2)
    expect(result.relayAccepted).toBe(true)
    expect(
      JSON.stringify(result.record.signedRecipientWrap) ===
        JSON.stringify(originalStored.record.signedRecipientWrap)
    ).toBe(true)
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0]!.recipient).toBe(f.organizerPubkey)
    expect(f.wraps).toBe(1)
    expect(JSON.stringify(legacy)).toBe(original)
    await expect(
      retryMerchantCheckoutSparkProgress({
        record: { ...legacy, recordedAt: legacy.recordedAt + 1 },
        signer: f.merchantSigner,
        store: f.store,
        transport: f.transport,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(1)
  })

  it("rejects mutable or cross-scope staged data before any network write", async () => {
    const f = await fixture()
    const corrupt: MerchantCheckoutSparkProgressDeliveryStore = {
      load: f.store.load.bind(f.store),
      loadOrganizerOrderBinding: f.store.loadOrganizerOrderBinding.bind(
        f.store
      ),
      stage: async (record) => {
        record.recordedAt++
        return {
          record,
          relayAccepted: false,
          merchantAccepted: false,
          organizerAccepted: false,
        }
      },
      markAccepted: f.store.markAccepted.bind(f.store),
    }
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: f.merchantProgress,
        signer: f.merchantSigner,
        store: corrupt,
        transport: f.transport,
        shouldContinue: () => true,
      })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
    expect(
      await f.store.load(
        f.merchantPubkey,
        f.plan.checkoutId,
        f.plan.planDigest,
        f.merchantProgress.snapshotId
      )
    ).toBeNull()
  })

  it("stops a revoked session after wrapping and before atomic staging or I/O", async () => {
    const f = await fixture()
    let current = true
    await expect(
      publishMerchantCheckoutSparkProgress({
        payload: f.merchantProgress,
        signer: f.merchantSigner,
        store: f.store,
        shouldContinue: () => current,
        transport: {
          ...f.transport,
          giftWrapFn: async (
            ...args: Parameters<typeof wrapPrivateMessage>
          ) => {
            const wrapped = await wrapPrivateMessage(...args)
            current = false
            return wrapped
          },
        },
      })
    ).rejects.toThrow()
    expect(f.sends).toHaveLength(0)
    expect(
      await f.store.load(
        f.merchantPubkey,
        f.plan.checkoutId,
        f.plan.planDigest,
        f.merchantProgress.snapshotId
      )
    ).toBeNull()
  })

  it("keeps unsupported and malformed companion packets out of ordinary orders and search", async () => {
    const f = await fixture()
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
    for (const payload of [
      { ...f.payload, schemaVersion: 99 },
      { ...f.payload, state: null },
    ]) {
      const rumor = createPrivateMessageRumor({
        ...buildCheckoutSparkMerchantEventProgressRumor(f.payload),
        content: JSON.stringify(payload),
      })
      const wrap = await wrapPrivateMessage(
        rumor,
        { pubkey: f.organizerPubkey },
        f.merchantSigner,
        { rumorKind: 16 }
      )
      expect(decodeCommerceMessageRumor(rumor).category).toBe("machine")
      await inbox.ingest(wrap, ["wss://relay.conduit.market"])
    }
    await inbox.waitForDecode()
    expect(await inbox.search("checkout_spark")).toHaveLength(0)
    expect(await inbox.store.projections()).toHaveLength(0)
    expect(
      (
        await readRetainedCheckoutSparkOrganizerRecoveries({
          inbox,
          shouldContinue: () => true,
        })
      ).selections
    ).toHaveLength(0)
  })

  it("discovers the authenticated companion privately and cold Organizer resumes its exact saved attempt", async () => {
    const f = await fixture()
    const delivery = await publishMerchantCheckoutSparkProgress({
      payload: f.merchantProgress,
      signer: f.merchantSigner,
      store: f.store,
      transport: f.transport,
      shouldContinue: () => true,
    })
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
    await inbox.ingest(f.initialWrap, ["wss://relay.conduit.market"])
    await inbox.ingest(delivery.record.organizerDelivery!.signedRecipientWrap, [
      "wss://relay.conduit.market",
    ])
    const read = await readRetainedCheckoutSparkOrganizerRecoveries({
      inbox,
      shouldContinue: () => true,
    })
    expect(read.selections).toHaveLength(1)
    expect(read.selections[0]!.merchantProgressWraps).toHaveLength(1)
    expect(await inbox.search("checkout_spark")).toHaveLength(0)
    expect(
      (await inbox.store.projections()).some(
        ({ projection }) =>
          projection.kind === "direct" || projection.kind === "order"
      )
    ).toBe(false)
    const authority = await openCheckoutSparkOrganizerRecoveryAuthority({
      ...f.authorityInput,
      ...read.selections[0]!,
    })
    const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(authority)
    await commitOrganizerStockOrder({
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
    const restored = await withCheckoutSparkOrganizerRecovery(
      authority,
      async ({ state }) => state
    )
    expect(restored.legs[0]!.intent).toEqual(f.state.legs[0]!.intent)
    expect(restored.credit).toEqual(f.state.credit)
    const changed = createCheckoutSparkMerchantEventProgress({
      merchantProgress: f.merchantProgress,
      orderBinding: {
        ...f.initial.orderBinding,
        termsHash: f.initial.merchantHandoffId,
      },
    })
    const badWrap = await wrapPrivateMessage(
      buildCheckoutSparkMerchantEventProgressRumor(changed),
      { pubkey: f.organizerPubkey },
      f.merchantSigner,
      { rumorKind: 16 }
    )
    await expect(
      openCheckoutSparkOrganizerRecoveryAuthority({
        ...f.authorityInput,
        merchantProgressWraps: [badWrap],
      })
    ).rejects.toThrow()
  })
})
