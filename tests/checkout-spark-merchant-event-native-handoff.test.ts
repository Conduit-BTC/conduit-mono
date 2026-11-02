import { expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { ConduitDB } from "@conduit/core/db"
import {
  SessionSigner,
  activateCheckoutSparkBuyer,
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  createPrivateMessageRumor,
  deriveCheckoutSparkNativeTreasuryBudget,
  deriveCheckoutSparkSettledTransferId,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  freezeCheckoutSparkSettledEventPlan,
  getCheckoutSparkBuyerTakeoverAt,
  openCheckoutSparkMerchantProgressWrap,
  prepareCheckoutSparkNativeTreasury,
  prepareCheckoutSparkSettledLeg,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkNativeRetirementObservation,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { checkoutSparkRecoveryTiming } from "@conduit/core/protocol/checkout-spark-recovery-timing"
import {
  buildEventMarketOrderRumorTags,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
} from "@conduit/core/protocol/orders"
import {
  continueMerchantCheckoutSparkNativeTreasury,
  type MerchantCheckoutSparkNativeTreasuryContinuationDependencies,
} from "../apps/merchant/src/lib/checkout-spark-native-treasury-continuation"
import type { MerchantSparkRecoveryWallet } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { plainTestSigner } from "./helpers/plain-signer"
import { createInboxDeclarationFixtureEvidence } from "./helpers/inbox-declaration"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  eventMarketFixtureInvoice,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

it("continues a Buyer-prepared native fee after Merchant-managed Event handoff with exact encrypted self progress", async () => {
  const graph = checkoutSparkEventMarketFixture({
    commerceTotalSats: 500,
    supplier: true,
    organizerFee: "absent",
    mode: "merchant_present",
  })
  const plan = freezeCheckoutSparkSettledEventPlan({
    ...graph.input,
    takeoverAt: undefined,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  expect(plan.schemaVersion).toBe(6)
  expect(plan.eventMarket?.mode).toBe("merchant_present")
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const merchant = new SessionSigner(graph.merchantSigner, {
    expectedPubkey: graph.merchantPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => true,
  })
  const initialState = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state: initialState,
    senderPubkey: buyer.pubkey,
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 1,
    preparedAt: AT + 1,
    sourceEvents: graph.sourceEvents,
  })
  const initialWrap = await wrapPrivateMessage(
    buildCheckoutSparkRecoveryRumor(initial),
    { pubkey: graph.merchantPubkey },
    buyer
  )
  let state = activateCheckoutSparkBuyer(initialState, {
    buyerPubkey: buyer.pubkey,
    activatedAt: AT + 1_000,
  })
  expect(state.schemaVersion).toBe(7)
  const takeoverAt = getCheckoutSparkBuyerTakeoverAt(
    plan,
    state.buyerActivation
  )
  expect(takeoverAt).toBe(AT + 121_000)
  let buyerTime = AT + 2_000
  const credit = {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: plan.funding.grossFundingSats,
    creditedSats: plan.funding.grossFundingSats,
    observedAt: buyerTime++,
  }
  state = recordCheckoutSparkSettledCredit(state, credit)
  const paidLegs: CheckoutSparkMerchantSettlementRecord["paidLegs"][number][] =
    []
  for (const recipient of plan.recipients.filter(
    (leg) => leg.kind !== "conduit"
  )) {
    const allocationSats = state.legs.find(
      (leg) => leg.legId === recipient.legId
    )!.allocationSats!
    const invoice = eventMarketFixtureInvoice(allocationSats - 1)
    const transferId = deriveCheckoutSparkSettledTransferId(
      plan,
      recipient.legId
    )
    state = prepareCheckoutSparkSettledLeg(state, {
      legId: recipient.legId,
      transferId,
      ...invoice,
      invoiceAmountSats: allocationSats - 1,
      maxFeeSats: 1,
      preparedAt: buyerTime++,
    })
    const observedAt = buyerTime++
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: recipient.legId,
      transferId,
      paymentHash: invoice.paymentHash,
      status: "paid",
      finalFeeSats: 1,
      finalDebitSats: allocationSats,
      observedAt,
    })
    paidLegs.push({
      legId: recipient.legId,
      transferId,
      allocationSats,
      finalFeeSats: 1,
      finalDebitSats: allocationSats,
      observedAt,
      recipientVerified: true,
    })
  }
  const settledCommerce = state
  const settlement: CheckoutSparkMerchantSettlementRecord = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: credit.transferId,
      creditedSats: credit.creditedSats,
      observedAt: credit.observedAt,
    },
    paidLegs,
  }
  const buyerPrepared = prepareCheckoutSparkNativeTreasury(settledCommerce, {
    settlement,
    preparedAt: buyerTime++,
  })
  expect(buyerPrepared.updatedAt < takeoverAt!).toBe(true)
  expect(buyerPrepared.treasuryFinalization?.status).toBe("prepared")
  const intent = buyerPrepared.treasuryFinalization!.intent!
  const activation = JSON.stringify(buyerPrepared.buyerActivation)
  const buyerProgress = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: initial.handoffId,
    senderPubkey: buyer.pubkey,
    state: buyerPrepared,
    preparedAt: buyerTime,
  })

  const order = createCheckoutSparkEventMarketFixtureOrder(
    { ...graph, plan },
    buyer.pubkey,
    AT + 500
  )
  order.buyerIdentityKind = "signed_in"
  order.shippingCostStatus = "included"
  const orderRumor = createPrivateMessageRumor({
    kind: 16,
    pubkey: buyer.pubkey,
    created_at: Math.floor(order.createdAt / 1_000),
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
  const orderWrap = await wrapPrivateMessage(
    orderRumor,
    { pubkey: graph.merchantPubkey },
    buyer
  )
  const evidence = readCheckoutSparkMerchantOrderEvidence(
    await unwrapPrivateMessageEnvelope(orderWrap, merchant)
  )
  expect(evidence !== null).toBe(true)
  const witness = createCheckoutSparkMerchantOrderWitness(
    plan,
    evidence!,
    buyer.pubkey,
    graph.sourceEvents
  )
  expect(witness !== null).toBe(true)
  const database = new ConduitDB(
    `merchant-event-native-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
    database
  )
  try {
    const imported = await repository.importMerchantOrderRecovery(
      settledCommerce,
      witness!,
      () => {}
    )
    expect(imported.status).toBe("active")
    if (imported.status !== "active") throw new Error("Expected active fixture")
    // Independent synthetic provider facts, as in the existing native fixture;
    // importing Buyer progress alone never creates this settlement ledger.
    await database.checkoutSparkPlanBindings.update(plan.checkoutId, {
      merchantSettlement: settlement,
    })
    await repository.saveTreasuryPrepared(
      buyerPrepared,
      imported.revision,
      settlement,
      () => {}
    )
    const candidate: MerchantCheckoutSparkRecoveryCandidate = {
      wrapId: initialWrap.id,
      schemaVersion: 2,
      checkoutId: plan.checkoutId,
      orderId: plan.orderId,
      planDigest: plan.planDigest,
      preparedAt: initial.preparedAt,
      ...checkoutSparkRecoveryTiming(plan, buyerPrepared.buyerActivation),
    }
    const relay = "wss://merchant.inbox.relay.dev"
    const inbox = await createInboxDeclarationFixtureEvidence(
      graph.signMerchant({
        kind: 10050,
        created_at: AT / 1_000,
        tags: [["relay", relay]],
        content: "",
      })
    )
    const checkpointLabels: Array<
      CheckoutSparkNativeRetirementObservation["recoveryCheckpoint"]
    > = []
    const openedStatuses: string[] = []
    let sends = 0
    let merchantTime = takeoverAt! + 1
    const budget = deriveCheckoutSparkNativeTreasuryBudget(
      buyerPrepared,
      settlement
    )
    const wallet: MerchantSparkRecoveryWallet = {
      ensurePrivateReady: async () => {},
      getIdentityPublicKey: async () => plan.funding.receiverIdentityPublicKey,
      getLightningReceiveRequest: async () => null,
      getTransfer: async () => undefined,
      cleanup: async () => {},
      nativeTreasury: {
        inspectCheckoutTreasury: async (request) =>
          sends === 0
            ? {
                invoiceId: request.nativeTreasury.invoiceId,
                status: "not_found",
              }
            : {
                invoiceId: request.nativeTreasury.invoiceId,
                status: "paid",
                providerTransferId: "synthetic-native-event-transfer",
                finalFeeSats: 0,
                finalDebitSats: budget.authorizedDebitSats,
              },
        preflightCheckoutTreasury: async () => "ready",
        sendCheckoutTreasury: async (request) => {
          await request.assertBeforeSend?.()
          expect(openedStatuses.slice(0, 2)).toEqual(["prepared", "submitted"])
          expect(request.priorSendMayHaveOccurred).toBe(false)
          expect(request.amountSats).toBe(intent.amountSats)
          sends++
          return { status: "submitted" }
        },
      },
    }
    const dependencies: MerchantCheckoutSparkNativeTreasuryContinuationDependencies =
      {
        repository,
        progressStore,
        signer: merchant,
        lockManager: null,
        requireCrossTabLock: false,
        now: () => merchantTime++,
        assertDispatchPlan: () => {},
        deriveIdentity: async () => plan.funding.receiverIdentityPublicKey,
        proveCommerce: async () => settlement,
        openWallet: async () => wallet,
        consumeRecovery: async (_principal, selected, adapter) => {
          await adapter.consumeSettled!(initial, buyerProgress, () => {})
          return {
            status: "consumed",
            coverage: "complete",
            discoveryCoverage: "complete",
            declarationState: "declared",
            candidate: selected,
          }
        },
        onObservation: (observation) => {
          if (observation.recoveryCheckpoint)
            checkpointLabels.push(observation.recoveryCheckpoint)
        },
        progressTransport: {
          recipientInboxRelays: [relay],
          inboxDeclarationEvidenceRepository: inbox,
          accountNetworkLocalStateRepository: { get: async () => undefined },
          waitForSignerVisibility: async () => {},
          // Real production wrapping/encryption is deliberately not overridden.
          publishFn: async (event) => {
            const staged = await progressStore.list(
              graph.merchantPubkey,
              plan.checkoutId,
              plan.planDigest
            )
            const exact = staged.find(
              (entry) => entry.record.signedRecipientWrap.id === event.id
            )
            expect(exact !== undefined).toBe(true)
            // Signed wire fields are exact; object insertion order is not signed.
            expect(exact!.record.signedRecipientWrap).toEqual(
              JSON.parse(JSON.stringify(event))
            )
            const opened = await openCheckoutSparkMerchantProgressWrap({
              signedRecipientWrap: exact!.record.signedRecipientWrap,
              signer: merchant,
            })
            expect(opened.payload.state.schemaVersion).toBe(7)
            expect(opened.payload.state.plan.schemaVersion).toBe(6)
            expect(
              opened.payload.state.plan.planDigest === plan.planDigest
            ).toBe(true)
            expect(
              JSON.stringify(opened.payload.state.buyerActivation) ===
                activation
            ).toBe(true)
            expect(
              JSON.stringify(
                opened.payload.state.treasuryFinalization!.intent
              ) === JSON.stringify(intent)
            ).toBe(true)
            openedStatuses.push(
              opened.payload.state.treasuryFinalization!.status
            )
            return {
              attemptedRelayUrls: [relay],
              successfulRelayUrls: [relay],
              failedRelayUrls: [],
              relayFailureMessages: {},
            }
          },
        },
      }
    const first = await continueMerchantCheckoutSparkNativeTreasury(
      graph.merchantPubkey,
      candidate,
      dependencies
    )
    expect(checkpointLabels.includes("prepared_snapshot")).toBe(true)
    expect(first.payout?.outcome).toBe("paid")
    expect(sends).toBe(1)
    expect(openedStatuses).toEqual(["prepared", "submitted", "paid"])
    const saved = await repository.load(plan.checkoutId, plan.planDigest)
    expect(
      saved.status === "active" &&
        saved.state.treasuryFinalization?.status === "paid"
    ).toBe(true)
    const again = await continueMerchantCheckoutSparkNativeTreasury(
      graph.merchantPubkey,
      candidate,
      dependencies
    )
    expect(again.payout?.outcome).toBe("already_paid")
    expect(sends).toBe(1)
  } finally {
    await database.delete()
  }
}, 15_000)
