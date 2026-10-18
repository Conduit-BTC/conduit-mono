import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { getEventHash, matchFilter } from "nostr-tools"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  buildEventMarketOrderRumorTags,
  EVENT_KINDS,
  createCheckoutSparkMerchantOrderWitness,
  readCheckoutSparkMerchantOrderEvidence,
  createCheckoutSparkNativeTreasurySdkAdapter,
  openCheckoutSparkRecoveryDelivery,
  checkoutSparkConduitFeeRecipient,
  parseProductEvent,
  projectCheckoutSparkMerchantSettlement,
  resolveCheckoutSparkLnurlInvoice,
  verifyCheckoutSparkInvoiceRecipient,
  type OrderLifecycle,
  type CheckoutSparkSettledReconciliation,
  type MerchantCheckoutSparkRecoveryCandidate,
  freezeCheckoutSparkSettledEventPlan,
  SessionSigner,
  createInMemoryInboxDeclarationEvidenceRepository,
  orderSchema,
} from "@conduit/core"
import {
  receiveOrganizerStockGrant,
  startMerchantOrganizerStockGrant,
  closeAndPublishOrganizerStockPool,
} from "@conduit/core/protocol/event-market-stock-workflow"
import { recoverMerchantInventoryProduct } from "@conduit/core/protocol/merchant-inventory-recovery"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  confirmOrganizerStockOrderHandout,
  restoreOrganizerStockOrderHandout,
  assertMerchantOrganizerStockOrderHandout,
} from "@conduit/core/protocol/event-market-stock-handout"
import {
  importMerchantOrganizerStockOrder,
  reconcileMerchantOrganizerStockClose,
} from "@conduit/core/protocol/event-market-stock-import"
import { openCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import { getFutureMarketClaimRef } from "@conduit/core/protocol/future-market-handoff"
import { formatEventMarketPickupClaimCode } from "@conduit/core/protocol/event-market-handoff"
import { routeCheckoutSparkOrganizerOrder } from "../apps/merchant/src/lib/checkout-spark-organizer-routing"
import type { CheckoutSparkOrganizerRoutingDependencies } from "../apps/merchant/src/lib/checkout-spark-organizer-routing"
import type { CheckoutSparkOrganizerProgressDelivery } from "@conduit/core/protocol/checkout-spark-organizer-progress"
import {
  outstandingOrganizerStockHold,
  resumeMerchantInventoryPublication,
} from "@conduit/core/protocol/merchant-inventory"
import { parseEventMarketAssignmentEvent } from "@conduit/core/protocol/event-market-assignment"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { continueMerchantCheckoutSparkNativeTreasury } from "../apps/merchant/src/lib/checkout-spark-native-treasury-continuation"
import {
  wrapPrivateMessage,
  unwrapPrivateMessageEnvelope,
} from "@conduit/core/protocol/private-message-primitives"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import { createCheckoutSparkSettledOutgoingProvider } from "../apps/market/src/lib/checkout-spark-settled-outgoing-provider"
import {
  getCheckoutSparkSettledPreparation,
  prepareCheckoutSparkSettledFunding,
  loadAuthorizedCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkEventRecoveryHandoff,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  createCheckoutSparkSettledShopperRunner,
  type CheckoutSparkSettledShopperRunInput,
  type CheckoutSparkSettledShopperRunnerDependencies,
} from "../apps/market/src/lib/checkout-spark-settled-shopper-runner"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { plainTestSigner } from "./helpers/plain-signer"
import { admitFixture } from "./helpers/public-event"
import { createInboxDeclarationFixtureEvidence } from "./helpers/inbox-declaration"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  eventMarketFixtureInvoice,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import {
  qualifiedReceiverFixture,
  qualifiedReceiverMetadataFixture,
} from "./support/checkout-spark-qualified-receiver-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

// Only the external wallet, receiver and relay surfaces are deterministic.
// Signed-source admission, preparation, local persistence and runners are real.
const RECEIVER =
  "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const ADDRESS = encodeSparkAddress({
  identityPublicKey: RECEIVER,
  network: "MAINNET",
})

it("composes interrupted Buyer checkout, cold Organizer routing, one physical claim, and once-only Merchant stock reconciliation", async () => {
  const f = await fixture({
    commerceTotalSats: 1_000,
    mode: "organizer_handoff",
    realStockGrant: true,
  })
  const organizerDb = new ConduitDB(
    `event-organizer-cold-${crypto.randomUUID()}`,
    {
      indexedDB,
      IDBKeyRange,
    }
  )
  try {
    f.hooks.handoffAfterFirstPayout = true
    f.control.setNativeCompletion(false)
    f.control.setNativeSenderCommitment(true)
    const buyerResult = await f.runner.run(f.runInput)
    expect(buyerResult).toEqual({
      status: "paused",
      reason: "authority_transferred",
    })
    expect(f.calls.payer).toBe(1)
    expect(f.control.snapshot().sendInvocationCount).toBe(1)
    const buyerState = await f.repository.load(
      f.plan.checkoutId,
      f.plan.planDigest
    )
    if (buyerState.status !== "active")
      throw new Error("Missing Buyer progress")
    const sellerLeg = buyerState.state.legs.find(
      (leg) =>
        f.plan.recipients.find((recipient) => recipient.legId === leg.legId)
          ?.kind === "merchant"
    )!
    expect(sellerLeg.status).toBe("paid")
    expect(sellerLeg.intent?.transferId).toBeTruthy()
    const sellerTransferId = sellerLeg.intent!.transferId
    const sellerPaymentHash = sellerLeg.intent!.paymentHash
    const initial = getCheckoutSparkRecoveryDelivery(
      f.prepared.recoveryHandoffId,
      f.storage
    )!
    const stockPool = await f.database.eventMarketOrganizerStockPools.get(
      `${f.merchantPubkey}:${f.stockGrant!.id}`
    )
    expect(stockPool?.grantWraps?.recipient).toBeDefined()
    await receiveOrganizerStockGrant({
      db: organizerDb,
      signer: f.organizerSessionSigner,
      authenticatedPubkey: f.organizerPubkey,
      expectedWriterId: f.writerId,
      grantEnvelope: stockPool!.grantWraps!.recipient,
      committedAssignmentEvent: f.events.assignment,
      shouldContinue: () => f.stockClock.active,
      nowMs: f.clock.now,
    })
    // The Organizer is a separate cold durable store, not the Buyer's paid projection.
    expect(await organizerDb.checkoutSparkReconciliations.count()).toBe(0)
    const authorityInput = {
      db: organizerDb,
      signer: f.organizerSessionSigner,
      authenticatedPubkey: f.organizerPubkey,
      writerId: f.writerId,
      initialWrap: initial.organizerDelivery!.signedRecipientWrap,
      buyerProgressWraps: listCheckoutSparkRecoveryDeliveries(f.storage)
        .filter((row) => row.record.handoffId !== initial.record.handoffId)
        .sort((a, b) => a.savedAt - b.savedAt)
        .map((row) => row.organizerDelivery!.signedRecipientWrap),
      shouldContinue: () => f.stockClock.active,
      now: () => f.clock.now,
    }
    const authority =
      await openCheckoutSparkOrganizerRecoveryAuthority(authorityInput)
    const session = {
      db: organizerDb,
      authority,
      signer: f.organizerSessionSigner,
      authenticatedPubkey: f.organizerPubkey,
      shouldContinue: () => f.stockClock.active,
    }
    await acceptCheckoutSparkOrganizerStockOrder({
      ...session,
      delivery: f.stockDelivery,
      nowMs: f.clock.now,
    })
    const accepted =
      await organizerDb.eventMarketOrganizerStockEntries.toArray()
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.quantity).toBe(1)
    expect(f.control.snapshot().sendInvocationCount).toBe(1)
    await f.manager.close(f.plan.walletId)
    const openWallet: NonNullable<
      CheckoutSparkOrganizerRoutingDependencies["openWallet"]
    > = async (input) => {
      const { wallet } = await f.native.module.initialize({
        mnemonicOrSeed: input.mnemonic,
        accountNumber: input.accountNumber,
        options: { log: false, network: "MAINNET" },
      })
      let closed = false
      const nativeTreasury = createCheckoutSparkNativeTreasurySdkAdapter({
        network: "MAINNET",
        isClosed: () => closed,
        read: (read) => read(),
        codec: {
          ...codec,
          nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
        },
        wallet: {
          getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
          getBalance: () => wallet.getBalance(),
          getTransfer: (id) => wallet.getTransfer(id),
          querySparkInvoices: (invoices) =>
            wallet.querySparkInvoices!(invoices),
          fulfillSparkInvoice: (invoices) =>
            wallet.fulfillSparkInvoice!(invoices),
        },
      })
      return {
        nativeTreasury,
        ensurePrivateReady: async () => {},
        getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
        getLightningReceiveRequest: (id) =>
          wallet.getLightningReceiveRequest(id),
        getTransfer: (id) => wallet.getTransfer(id),
        getTransferFromSsp: (id) => wallet.getTransferFromSsp(id),
        getLightningSendRequest: (id) => wallet.getLightningSendRequest(id),
        openRetirementReader: () =>
          f.native.openAuthenticatedRetirementReader(f.credentials),
        outgoing: {
          getAvailableSats: async () => (await wallet.getBalance()).balance,
          estimateFee: ({ paymentRequest }) =>
            wallet.getLightningSendFeeEstimate({
              encodedInvoice: paymentRequest,
            }),
          sendFrozen: (request) =>
            wallet.payLightningInvoice({
              invoice: request.paymentRequest,
              maxFeeSats: request.maxFeeSats,
              transferId: UUID.parse(request.transferId),
              preferSpark: false,
            }),
        },
        cleanup: async () => {
          closed = true
          await wallet.cleanup?.()
        },
      }
    }
    const organizerRepository = new DexieCheckoutSparkSettledRepository(
      organizerDb
    )
    const organizerDependencies: CheckoutSparkOrganizerRoutingDependencies = {
      repository: organizerRepository,
      openWallet,
      now: () => ++f.clock.now,
      wait: async (milliseconds) => {
        f.clock.now += milliseconds
      },
      requireCrossTabLock: false,
      lockManager: null,
      progressTransport: f.stockDelivery,
      resolveInvoice: async (request) => {
        const receiver = qualifiedReceiverFixture({
          lud16: request.lud16,
          amountSats: request.amountSats,
          nowSeconds: Math.floor(f.clock.now / 1000),
          preimageByte: ++f.calls.invoice,
        })
        f.receivers.set(receiver.paymentHash, receiver)
        f.control.registerPayout({
          paymentRequest: receiver.paymentRequest,
          preimage: receiver.preimage,
          feeSats: 0,
        })
        return resolveCheckoutSparkLnurlInvoice(request, {
          receiverContracts: receiver.contracts,
          fetchMetadata: async () => receiver.metadata,
          fetchInvoice: async () => ({
            invoice: receiver.paymentRequest,
            verifyUrl: receiver.receiverBinding.verifyUrl,
          }),
          fetchReceiverVerify: async () => receiver.verifier(false),
        })
      },
      receiverDependencies: {
        contracts: qualifiedReceiverMetadataFixture(
          "merchant@wallet.conduit.market"
        ).contracts,
        fetchMetadata: async (lud16) =>
          qualifiedReceiverMetadataFixture(lud16).metadata,
        fetchVerify: async (url) => {
          const receiver = [...f.receivers.values()].find(
            (value) => value.receiverBinding.verifyUrl === url
          )
          if (!receiver) throw new Error("Missing exact receiver evidence")
          return receiver.verifier(
            f.control.outgoingInvoices().includes(receiver.paymentRequest)
          )
        },
      },
    }
    const routed = await routeCheckoutSparkOrganizerOrder(
      session,
      organizerDependencies
    )
    expect(routed.status).toBe("complete")
    expect(routed.commerceProof).not.toBeNull()
    expect(f.calls.payer).toBe(1)
    expect(f.control.snapshot().sendInvocationCount).toBe(3)
    expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
    const inspectedWallet = await f.native.module.initialize({
      mnemonicOrSeed: f.credentials.mnemonic,
      accountNumber: f.credentials.accountNumber,
      options: { network: "MAINNET", log: false },
    })
    expect((await inspectedWallet.wallet.getBalance()).balance).toBe(0n)
    await inspectedWallet.wallet.cleanup?.()
    const completed = await organizerRepository.load(
      f.plan.checkoutId,
      f.plan.planDigest
    )
    if (completed.status !== "active")
      throw new Error("Missing Organizer progress")
    expect(completed.state.legs.every((leg) => leg.status === "paid")).toBe(
      true
    )
    const restoredSeller = completed.state.legs.find(
      (leg) => leg.legId === sellerLeg.legId
    )!
    expect(restoredSeller.intent?.transferId).toBe(sellerTransferId)
    expect(restoredSeller.intent?.paymentHash).toBe(sellerPaymentHash)
    const invocationCounts = [
      f.control.snapshot().sendInvocationCount,
      f.control.nativeSnapshot().nativeSendInvocationCount,
    ]
    const progressBinding = await organizerDb.checkoutSparkPlanBindings.get(
      f.plan.checkoutId
    )
    const organizerProgress = (progressBinding?.organizerProgressOutbox ??
      []) as CheckoutSparkOrganizerProgressDelivery[]
    expect(organizerProgress.length).toBeGreaterThan(0)
    organizerDb.close()
    await organizerDb.open()
    const restoredAuthority = await openCheckoutSparkOrganizerRecoveryAuthority(
      {
        ...authorityInput,
        organizerProgressWraps: organizerProgress.map((row) => row.selfWrap),
      }
    )
    const restoredSession = { ...session, authority: restoredAuthority }
    const again = await routeCheckoutSparkOrganizerOrder(
      restoredSession,
      organizerDependencies
    )
    expect(again.status).toBe("complete")
    expect(again.commerceProof).not.toBeNull()
    expect([
      f.control.snapshot().sendInvocationCount,
      f.control.nativeSnapshot().nativeSendInvocationCount,
    ]).toEqual(invocationCounts)
    const claimRef = getFutureMarketClaimRef({
      orderId: f.order.id,
      merchantPubkey: f.merchantPubkey,
      organizerPubkey: f.organizerPubkey,
      marketCoordinate: f.plan.eventMarket!.marketCoordinate,
    })
    const handoutInput = {
      ...restoredSession,
      commerceProof: again.commerceProof!,
      physicalReleaseConfirmed: true as const,
      delivery: f.stockDelivery,
      nowMs: f.clock.now,
    }
    await expect(
      confirmOrganizerStockOrderHandout({
        ...handoutInput,
        enteredClaimCode: "NOT-THE-CLAIM",
      })
    ).rejects.toThrow("pickup code")
    expect(
      (await organizerDb.eventMarketOrganizerStockEntries.toArray())[0]?.handout
    ).toBeUndefined()
    const handedOut = await confirmOrganizerStockOrderHandout({
      ...handoutInput,
      enteredClaimCode: formatEventMarketPickupClaimCode(claimRef),
    })
    expect(handedOut.replayed).toBe(false)
    const duplicate = await confirmOrganizerStockOrderHandout({
      ...handoutInput,
      enteredClaimCode: formatEventMarketPickupClaimCode(claimRef),
    })
    expect(duplicate.replayed).toBe(true)
    expect(duplicate.rumor.id).toBe(handedOut.rumor.id)
    const finalEntry = (
      await organizerDb.eventMarketOrganizerStockEntries.toArray()
    )[0]!
    expect(finalEntry.handout?.wraps?.recipient).toBeDefined()
    const orderDraft = {
      kind: 16,
      pubkey: f.buyer.pubkey,
      created_at: Math.floor(f.order.createdAt / 1000),
      tags: [
        ["p", f.merchantPubkey],
        ["type", "order"],
        ["order", f.order.id],
        ["amount", String(f.order.subtotal)],
        ["currency", "SATS"],
        ["item", f.order.items[0]!.productId, "1"],
        ...buildEventMarketOrderRumorTags(f.order),
      ],
      content: JSON.stringify(f.order),
    }
    const originalOrderEnvelope = await wrapPrivateMessage(
      { ...orderDraft, id: getEventHash(orderDraft) },
      { pubkey: f.merchantPubkey },
      f.buyer
    )
    const merchantSession = {
      db: f.database,
      signer: f.merchantSessionSigner,
      authenticatedPubkey: f.merchantPubkey,
      shouldContinue: () => f.stockClock.active,
      nowMs: f.clock.now,
    }
    const importInput = {
      ...merchantSession,
      originalOrderEnvelope,
      acceptedEnvelopes: [finalEntry.wraps!.recipient],
    }
    const imported = await importMerchantOrganizerStockOrder(importInput)
    expect(imported.replayed).toBe(false)
    expect(
      (await importMerchantOrganizerStockOrder(importInput)).replayed
    ).toBe(true)
    const productBeforeClose = await f.database.merchantInventoryProducts.get(
      f.plan.eventMarket!.lines[0]!.productCoordinate
    )
    expect(productBeforeClose?.stock).toBe(9)
    await restoreOrganizerStockOrderHandout({
      ...merchantSession,
      envelope: finalEntry.handout!.wraps!.recipient,
    })
    await assertMerchantOrganizerStockOrderHandout({
      ...merchantSession,
      order: f.order,
    })
    const poolId = f.stockGrant!.id
    await closeAndPublishOrganizerStockPool({
      ...restoredSession,
      poolId,
      writerId: f.writerId,
      nowMs: f.clock.now,
      delivery: f.stockDelivery,
    })
    const closingPool = await organizerDb.eventMarketOrganizerStockPools.get(
      `${f.organizerPubkey}:${poolId}`
    )
    const closeInput = {
      ...merchantSession,
      closingEnvelope: closingPool!.closingWraps!.recipient,
    }
    expect(
      (await reconcileMerchantOrganizerStockClose(closeInput)).replayed
    ).toBe(false)
    expect(
      (await reconcileMerchantOrganizerStockClose(closeInput)).replayed
    ).toBe(true)
    const assignment = await f.database.merchantInventoryAssignments.get(
      f.plan.eventMarket!.lines[0]!.assignmentCoordinate
    )
    expect(assignment?.organizerStockHold?.closed).toBe(true)
    expect(assignment?.organizerStockHold?.importedQuantity).toBe(1)
    expect(outstandingOrganizerStockHold(assignment!)).toBe(0)
    expect(
      (
        await f.database.merchantInventoryProducts.get(
          productBeforeClose!.coordinate
        )
      )?.stock
    ).toBe(9)
    expect(await f.database.merchantInventoryAcceptedOrders.count()).toBe(1)
    expect(await organizerDb.eventMarketOrganizerStockEntries.count()).toBe(1)
    expect(f.calls.payer).toBe(1)
    const publishedInventoryIds: string[] = []
    await resumeMerchantInventoryPublication({
      db: f.database,
      merchantPubkey: f.merchantPubkey,
      sign: (draft) => f.merchantSessionSigner.signEvent(draft),
      publish: async (event) => {
        publishedInventoryIds.push(event.id)
        return true
      },
      stockCheckpoint: {
        signer: f.merchantSessionSigner,
        shouldContinue: () => f.stockClock.active,
        delivery: f.stockDelivery,
      },
    })
    expect(publishedInventoryIds.length).toBeGreaterThan(0)
    const publishedProduct = await f.database.merchantInventoryProducts.get(
      productBeforeClose!.coordinate
    )
    expect(
      publishedProduct?.organizerStockCheckpoint?.acknowledgedRelayUrls.length
    ).toBeGreaterThan(0)
    expect(
      publishedProduct?.signedProductEvent.tags.find(
        (tag) => tag[0] === "stock"
      )?.[1]
    ).toBe("9")
    const publishedAssignment =
      await f.database.merchantInventoryAssignments.get(assignment!.coordinate)
    const publishedPool = parseEventMarketAssignmentEvent(
      publishedAssignment!.signedAssignmentEvent!
    )!.stockPool
    expect(publishedPool.state).toBe("valid")
    if (publishedPool.state !== "valid")
      throw new Error("Missing final signed pool")
    expect(publishedPool.pool.state).toBe("closed")
    expect(publishedPool.pool.importedQuantity).toBe(1)
  } finally {
    await organizerDb.delete()
    await f.cleanup()
  }
}, 60_000)
const relays = ["wss://relay.conduit.market"]
const codec = {
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
}
class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

async function fixture(
  options: {
    commerceTotalSats?: number
    mode?: "merchant_present" | "organizer_handoff"
    abortSecondWrapOnce?: boolean
    realStockGrant?: boolean
  } = {}
) {
  const writerId = crypto.randomUUID()
  let graph = checkoutSparkEventMarketFixture({
    ...options,
    ...(options.realStockGrant
      ? { stockGrant: { writerId, quantity: 5 } }
      : {}),
    receiverDomain: "wallet.conduit.market",
  })
  const database = new ConduitDB(`event-execution-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const stockClock = { active: true }
  const merchantSessionSigner = new SessionSigner(graph.merchantSigner, {
    expectedPubkey: graph.merchantPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => stockClock.active,
  })
  const organizerSessionSigner = new SessionSigner(graph.organizerSigner, {
    expectedPubkey: graph.organizerPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => stockClock.active,
  })
  const inboxEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  const stockDelivery = {
    resolveInboxRelays: async () => relays,
    inboxDeclarationEvidenceRepository: inboxEvidence,
    accountNetworkLocalStateRepository: { get: async () => undefined },
    publishFn: async () => ({
      attemptedRelayUrls: relays,
      successfulRelayUrls: relays,
      failedRelayUrls: [],
      relayFailureMessages: {},
    }),
  }
  if (options.realStockGrant) {
    for (const [pubkey, sign] of [
      [graph.merchantPubkey, graph.signMerchant],
      [graph.organizerPubkey, graph.signOrganizer],
    ] as const)
      await inboxEvidence.merge({
        pubkey,
        observedAt: Date.now(),
        signedEvent: await admitFixture(
          sign({
            kind: 10050,
            tags: [["relay", relays[0]!]],
            content: "",
            created_at: Math.floor(Date.now() / 1000),
          })
        ),
      })
    const preGrantSources = graph.sourceEvents.filter(
      (event) => event.kind !== 30410
    )
    preGrantSources.push(graph.originalAssignment)
    const recovered = await recoverMerchantInventoryProduct(
      {
        db: database,
        merchantPubkey: graph.merchantPubkey,
        authenticatedPubkey: graph.merchantPubkey,
        productCoordinate: graph.eventMarket.lines[0]!.productCoordinate,
        signedProductEvent: graph.events.product,
        shouldContinue: () => stockClock.active,
      },
      {
        plan: async () => ({
          relayUrls: relays,
          candidateRelayUrls: relays,
          maxRelayAttempts: 1,
          ownerSelectedRelayUrls: [],
          appRelayUrls: relays,
          personalRelayUrls: [],
          independentRelayUrls: [],
          relayListState: "missing",
          relayHintTruncated: false,
        }),
        fetch: async (filter) => ({
          events: preGrantSources.filter((event) => matchFilter(filter, event)),
          relays: relays.map((relayUrl) => ({ relayUrl, status: "success" })),
        }),
      }
    )
    expect(recovered.state).toBe("ready")
    const started = await startMerchantOrganizerStockGrant({
      db: database,
      signer: merchantSessionSigner,
      authenticatedPubkey: graph.merchantPubkey,
      shouldContinue: () => stockClock.active,
      grantRumor: graph.stockGrant!,
      expectedAssignmentRevision: 0,
      admissionEvidence: preGrantSources,
      nowMs: graph.stockGrant!.created_at * 1000,
      publishPublic: async () => true,
      delivery: stockDelivery,
    })
    const eventMarket = {
      ...graph.eventMarket,
      lines: graph.eventMarket.lines.map((line) => ({
        ...line,
        assignmentEventId: started.commitment.id,
      })),
    }
    const input = { ...graph.input, eventMarket }
    graph = {
      ...graph,
      eventMarket,
      input,
      plan: freezeCheckoutSparkSettledEventPlan(input),
      sourceEvents: graph.sourceEvents.map((event) =>
        event.id === graph.events.assignment.id ? started.commitment : event
      ),
      events: { ...graph.events, assignment: started.commitment },
    }
  }
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const identity = {
    kind: "signed_in" as const,
    pubkey: buyer.pubkey,
    signer: buyer,
  }
  const order = orderSchema.parse({
    ...createCheckoutSparkEventMarketFixtureOrder(graph, buyer.pubkey, AT),
    buyerIdentityKind: "signed_in",
    shippingCostStatus: "included",
  })
  const product = {
    ...parseProductEvent(await admitFixture(graph.events.product)),
    sourceEventId: graph.events.product.id,
  }
  const quoteAuthority = buildCheckoutSparkQuoteAuthority({
    authorization: {
      status: "ok",
      items: [
        {
          ...createCartItemFromProduct(product, order.items[0]!.fulfillment),
          quantity: 1,
        },
      ],
      listingReadProducts: [product],
      fulfillmentResolvedProducts: [product],
      shippingOptionEvidence: { status: "not_required", options: [] },
      pickupSourceEvents: graph.sourceEvents,
    },
    rateInput: null,
    nowMs: AT,
  })
  const clock = { now: AT, active: true }
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const storage = new MemoryStorage()
  let credentials = {
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 1,
    network: "mainnet" as const,
  }
  let sender = await deriveMerchantCheckoutSparkRecoveryIdentity(
    credentials.mnemonic,
    credentials.accountNumber
  )
  let walletId = `event-execution-wallet-${crypto.randomUUID()}`
  const native = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "MAINNET" }),
    nativeInvoiceCodec: codec,
    issueFundingInvoice: async ({ amountSats }) =>
      eventMarketFixtureInvoice(amountSats).paymentRequest,
  })
  const hooks: {
    beforeLightningSend?: () => Promise<void>
    beforeNativeSend?: () => Promise<void>
    acknowledgeOrganizer?: boolean
    failOrganizerOnce?: boolean
    handoffAfterOrganizer?: boolean
    handoffAfterFirstPayout?: boolean
  } = {}
  const manager = new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: "mainnet",
      now: () => ++clock.now,
      wait: async () => {},
      loadModule: async () => ({
        ...native.module,
        async initialize(input) {
          const opened = await native.module.initialize(input)
          return {
            wallet: {
              ...opened.wallet,
              async payLightningInvoice(input) {
                await hooks.beforeLightningSend?.()
                return opened.wallet.payLightningInvoice(input)
              },
              async fulfillSparkInvoice(input) {
                await hooks.beforeNativeSend?.()
                return opened.wallet.fulfillSparkInvoice!(input)
              },
              openRetirementReader: () =>
                native.openAuthenticatedRetirementReader(credentials),
            },
          }
        },
      }),
    }),
    async () => ({ release: async () => {} }),
    undefined,
    () => clock.now
  )
  const calls = {
    payer: 0,
    invoice: 0,
    published: [] as string[],
    organizerPublished: [] as string[],
    snapshots: 0,
  }
  const transport = {
    recipientInboxRelays: relays,
    publishFn: async (event: { id: string }) => {
      calls.published.push(event.id)
      return {
        attemptedRelayUrls: relays,
        successfulRelayUrls: relays,
        failedRelayUrls: [],
        relayFailureMessages: {},
      }
    },
  }
  const organizerTransport = {
    ...transport,
    publishFn: async (event: { id: string }) => {
      calls.organizerPublished.push(event.id)
      const failed =
        hooks.acknowledgeOrganizer === false || hooks.failOrganizerOnce === true
      hooks.failOrganizerOnce = false
      return {
        attemptedRelayUrls: relays,
        successfulRelayUrls: failed ? [] : relays,
        failedRelayUrls: failed ? relays : [],
        relayFailureMessages: {},
      }
    },
  }
  const metadata = qualifiedReceiverMetadataFixture(
    "merchant@wallet.conduit.market"
  )
  let abortSecondWrap = options.abortSecondWrapOnce === true
  const request = {
    checkoutId: graph.plan.checkoutId,
    orderId: graph.plan.orderId,
    merchantPubkey: graph.merchantPubkey,
    network: "mainnet" as const,
    takeoverAt: AT + 120_000,
    grossFundingSats: graph.plan.funding.grossFundingSats,
    fundingExpirySecs: 3_600,
    identity,
    quoteAuthority,
    sourceEvents: graph.sourceEvents,
    recipients: graph.input.recipients.map((recipient) =>
      recipient.kind === "conduit"
        ? {
            ...recipient,
            recipientId: checkoutSparkConduitFeeRecipient("production"),
            destination: {
              type: "lightning_address" as const,
              value: checkoutSparkConduitFeeRecipient("production"),
              source: {
                type: "conduit_allowlist" as const,
                policy: "production" as const,
              },
            },
          }
        : recipient
    ),
    eventMarket: quoteAuthority.eventMarket,
    organizerOrder: order,
    storage,
    recoveryStorage: storage,
  }
  const preparationDependencies = {
    now: () => clock.now,
    repository,
    receiverContracts: metadata.contracts,
    fetchPayoutMetadata: async (lud16: string) =>
      qualifiedReceiverMetadataFixture(lud16).metadata,
    treasuryConfiguration: { mainnetAddress: ADDRESS },
    validateTreasuryDestination: (request: {
      network: "mainnet" | "regtest"
      sparkAddress: string
    }) => manager.validateCheckoutTreasuryDestination(request),
    prepareTreasuryRequest:
      manager.prepareCheckoutTreasuryRequest.bind(manager),
    createWalletMaterial: () => ({ walletId, ...credentials }),
    openWallet: async () => {
      await manager.openWithMnemonic({ walletId, ...credentials })
    },
    closeWallet: manager.close.bind(manager),
    createFundingReceive: (
      wallet: { walletId: string },
      input: Parameters<SparkWalletManager["createCheckoutReceive"]>[1]
    ) => manager.createCheckoutReceive(wallet.walletId, input),
    publishEventRecoveryHandoff: (
      input: Parameters<typeof publishCheckoutSparkEventRecoveryHandoff>[0]
    ) =>
      publishCheckoutSparkEventRecoveryHandoff({
        ...input,
        now: () => clock.now,
        transport,
        organizerTransport: abortSecondWrap
          ? {
              ...organizerTransport,
              giftWrapFn: async () => {
                abortSecondWrap = false
                throw new Error("Controlled second recipient signing failure")
              },
            }
          : organizerTransport,
      }),
    publishRecoveryHandoff: (
      input: Parameters<typeof publishCheckoutSparkSettledRecoveryHandoff>[0]
    ) =>
      publishCheckoutSparkSettledRecoveryHandoff({
        ...input,
        now: () => clock.now,
        transport,
      }),
  }
  if (options.abortSecondWrapOnce) {
    const abandonedWalletId = walletId
    await expect(
      prepareCheckoutSparkSettledFunding(request, preparationDependencies)
    ).rejects.toThrow("preparation was safely closed")
    expect(calls.published.length).toBe(0)
    expect(calls.organizerPublished.length).toBe(0)
    expect(listCheckoutSparkRecoveryDeliveries(storage).length).toBe(0)
    expect(
      getCheckoutSparkSettledPreparation(request.checkoutId, storage)
    ).toBeNull()
    expect(
      await database.checkoutSparkPlanBindings.get(request.checkoutId)
    ).toBeUndefined()
    expect(manager.isOpen(abandonedWalletId)).toBe(false)
    credentials = {
      mnemonic: createRuntimeMnemonic(),
      accountNumber: 1,
      network: "mainnet",
    }
    sender = await deriveMerchantCheckoutSparkRecoveryIdentity(
      credentials.mnemonic,
      credentials.accountNumber
    )
    walletId = `event-execution-wallet-${crypto.randomUUID()}`
  }
  const prepared = await prepareCheckoutSparkSettledFunding(
    request,
    preparationDependencies
  )
  const { plan } = prepared
  const control = native.control.forIdentity(sender)
  const lifecycle = {
    orderId: plan.orderId,
    merchantPubkey: plan.merchantPubkey,
    buyerPubkey: buyer.pubkey,
    buyerIdentityKind: "signed_in",
    checkoutMode: "private_checkout",
    orderDeliveryStatus: "sent",
    phase: "placed",
    paymentStatus: "unpaid",
    currency: "SATS",
    totalSats: plan.commerceQuote.commerceTotalSats,
    createdAt: AT,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId,
    },
  } as OrderLifecycle
  await database.orderLifecycles.put(lifecycle)
  await repository.bindBuyerOrder(plan, buyer.pubkey, () => {})
  const receivers = new Map<
    string,
    ReturnType<typeof qualifiedReceiverFixture>
  >()
  const loadAuthorized: typeof loadAuthorizedCheckoutSparkSettledFunding = (
    id,
    input
  ) =>
    loadAuthorizedCheckoutSparkSettledFunding(id, {
      ...input,
      repository,
      storage,
      recoveryStorage: storage,
      now: () => clock.now,
    })
  const dependencies: CheckoutSparkSettledShopperRunnerDependencies = {
    repository,
    now: () => clock.now,
    readOrder: (id) => database.orderLifecycles.get(id),
    readPreparation: (id) => getCheckoutSparkSettledPreparation(id, storage),
    readInitialRecovery: (id) => getCheckoutSparkRecoveryDelivery(id, storage),
    loadAuthorized,
    sparkConfiguration: () => ({ status: "ready", network: "mainnet" }),
    sparkManager: () => manager,
    fundingBridge: (id) =>
      createCheckoutSparkSettledFundingBridge(id, {
        repository,
        storage,
        recoveryStorage: storage,
        loadAuthorized,
        now: () => clock.now,
        attestCredit: (id, request) =>
          manager.attestCheckoutReceiveCredit(id, request),
        payInvoice: async (request) => {
          await request.beforeSend?.()
          calls.payer++
          control.completeFunding()
          return {
            status: "paid",
            rail: "webln",
            preimage: randomBytes(32).toString("hex"),
          }
        },
        requireCrossTabLock: false,
        withStoreWriteLock: async (operation) => operation(),
      }),
    prepareLeg: (input, options) =>
      prepareCheckoutSparkSettledOutgoingLeg(input, {
        ...options,
        resolveInvoice: async (request) => {
          const receiver = qualifiedReceiverFixture({
            lud16: request.lud16,
            amountSats: request.amountSats,
            nowSeconds: AT / 1_000,
            preimageByte: ++calls.invoice,
          })
          receivers.set(receiver.paymentHash, receiver)
          control.registerPayout({
            paymentRequest: receiver.paymentRequest,
            preimage: receiver.preimage,
            feeSats: 0,
          })
          return resolveCheckoutSparkLnurlInvoice(request, {
            receiverContracts: receiver.contracts,
            fetchMetadata: async () => receiver.metadata,
            fetchInvoice: async () => ({
              invoice: receiver.paymentRequest,
              verifyUrl: receiver.receiverBinding.verifyUrl,
            }),
            fetchReceiverVerify: async () => receiver.verifier(false),
          })
        },
      }),
    outgoingProvider: (input) => {
      const provider = createCheckoutSparkSettledOutgoingProvider(input)
      const record = async (
        target: Parameters<typeof provider.reconcile>[0],
        observation: Awaited<ReturnType<typeof provider.reconcile>>
      ) => {
        if (observation.status !== "paid") return observation
        const receiver = receivers.get(target.intent.paymentHash)!
        const verified = await verifyCheckoutSparkInvoiceRecipient(
          { plan: input.plan, target, now: clock.now, assertCurrent: () => {} },
          {
            contracts: receiver.contracts,
            fetchMetadata: async () => receiver.metadata,
            fetchVerify: async () =>
              receiver.verifier(
                control.outgoingInvoices().includes(receiver.paymentRequest)
              ),
          }
        )
        if (verified.status !== "verified" || !verified.settled)
          throw new Error("Offline recipient settlement unavailable")
        await repository.recordInvoiceRecipientVerification(
          input.plan,
          target,
          verified.proof,
          () => {}
        )
        if (
          (hooks.handoffAfterOrganizer &&
            input.plan.recipients.find(
              (recipient) => recipient.legId === target.legId
            )?.kind === "organizer") ||
          (hooks.handoffAfterFirstPayout &&
            input.plan.recipients.find(
              (recipient) => recipient.legId === target.legId
            )?.kind === "merchant")
        )
          clock.now = input.plan.takeoverAt + 1
        return observation
      }
      return {
        preflight: provider.preflight,
        send: async (target) => record(target, await provider.send(target)),
        reconcile: async (target) =>
          record(target, await provider.reconcile(target)),
      }
    },
    wait: async (milliseconds) => {
      clock.now += milliseconds
    },
  }
  const runInput: CheckoutSparkSettledShopperRunInput = {
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    orderId: plan.orderId,
    merchantPubkey: plan.merchantPubkey,
    network: "mainnet",
    buyerPubkey: buyer.pubkey,
    currentBuyerPubkey: () => buyer.pubkey,
    shouldContinue: () => clock.active,
    authorization: {
      planDigest: plan.planDigest,
      walletId,
      grossFundingSats: plan.funding.grossFundingSats,
    },
    fundingMode: "pay_once",
    fundingPoll: { attempts: 1, intervalMs: 1 },
    fundingPayment: {
      buyerPubkey: buyer.pubkey,
      shouldContinue: () => clock.active,
      paymentTarget: { type: "webln" },
      timeoutMs: 60_000,
      appId: "market",
    },
    acknowledgeRecoverySnapshot: async (
      state: CheckoutSparkSettledReconciliation
    ) => {
      clock.now = Math.max(clock.now, state.updatedAt)
      await acknowledgeOrRetryCheckoutSparkSettledSnapshot({
        initialHandoffId: prepared.recoveryHandoffId,
        state,
        identity,
        storage,
        now: () => ++clock.now,
        transport,
        organizerTransport,
        requireCrossTabLock: false,
      })
      calls.snapshots++
    },
  }
  const previousAddress = process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
  process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = ADDRESS
  return {
    ...graph,
    writerId,
    merchantSessionSigner,
    organizerSessionSigner,
    stockDelivery,
    stockClock,
    plan,
    prepared,
    repository,
    database,
    storage,
    manager,
    native,
    control,
    clock,
    calls,
    hooks,
    runInput,
    preparationDependencies,
    request,
    dependencies,
    buyer,
    order,
    transport,
    credentials,
    receivers,
    runner: createCheckoutSparkSettledShopperRunner(dependencies),
    async cleanup() {
      if (previousAddress === undefined)
        delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
      else process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = previousAddress
      await manager.close(walletId)
      database.close()
      await database.delete()
    },
  }
}

describe("composed event checkout preparation and execution", () => {
  it("admits exact signed sources and durably ACKs both handoff recipients before exposing funding", async () => {
    const f = await fixture({ mode: "organizer_handoff" })
    try {
      expect(f.plan.schemaVersion).toBe(5)
      expect(f.prepared.state.schemaVersion).toBe(6)
      expect(f.prepared.fundingInvoice === f.plan.funding.paymentRequest).toBe(
        true
      )
      expect(
        getCheckoutSparkSettledPreparation(f.plan.checkoutId, f.storage)
          ?.fundingInvoiceExposedAt
      ).toBeGreaterThanOrEqual(AT)
      const deliveries = listCheckoutSparkRecoveryDeliveries(f.storage)
      expect(deliveries.length).toBe(1)
      expect(deliveries[0]!.deliveryProgress.acknowledgedRelayRefs.length).toBe(
        1
      )
      expect(
        deliveries[0]!.organizerDelivery?.acknowledgedRelayRefs.length
      ).toBe(1)
      expect(f.control.snapshot().sendInvocationCount).toBe(0)
      expect(f.calls.payer).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  it("abandons a definitely unexposed preparation after second-wrap signing fails and safely prepares the same checkout afresh", async () => {
    const f = await fixture({
      mode: "organizer_handoff",
      abortSecondWrapOnce: true,
    })
    try {
      expect(f.plan.schemaVersion).toBe(5)
      expect(listCheckoutSparkRecoveryDeliveries(f.storage).length).toBe(1)
      expect(
        getCheckoutSparkSettledPreparation(f.plan.checkoutId, f.storage)
          ?.recoveryHandoffId
      ).toBe(f.prepared.recoveryHandoffId)
      expect(f.calls.payer).toBe(0)
      expect(f.control.snapshot().sendInvocationCount).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  it.each([1_000, 0])(
    "routes %s-sat goods, the separate organizer fee and native Conduit payment through the real Buyer runner",
    async (commerceTotalSats) => {
      const f = await fixture({ commerceTotalSats })
      try {
        f.control.setNativeCompletion(false)
        f.control.setNativeSenderCommitment(true)
        const result = await f.runner.run(f.runInput)
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect({
          result,
          payer: f.calls.payer,
          invoices: f.calls.invoice,
          acks: f.calls.snapshots,
          legs:
            saved.status === "active"
              ? saved.state.legs.map((leg) => leg.status)
              : [],
          native:
            saved.status === "active"
              ? saved.state.treasuryFinalization?.status
              : null,
        }).toEqual({
          result: { status: "complete" },
          payer: 1,
          invoices: commerceTotalSats === 0 ? 1 : 3,
          acks: expect.any(Number),
          legs:
            commerceTotalSats === 0
              ? ["paid", "paid"]
              : ["paid", "paid", "paid", "paid"],
          native: "paid",
        })
        expect(saved.status).toBe("active")
        if (saved.status !== "active")
          throw new Error("Expected durable event execution")
        expect(saved.state.legs.every((leg) => leg.status === "paid")).toBe(
          true
        )
        expect(saved.state.treasuryFinalization?.status).toBe("paid")
        const record = await f.repository.loadMerchantSettlement(
          f.plan.merchantPubkey,
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(record?.schemaVersion).toBe(3)
        expect(
          projectCheckoutSparkMerchantSettlement(record!).commerceVerified
        ).toBe(true)
        expect(projectCheckoutSparkMerchantSettlement(record!).feePending).toBe(
          false
        )
        const organizer = f.plan.recipients.find(
          (recipient) => recipient.kind === "organizer"
        )!
        expect(record?.requiredCommerceLegIds.includes(organizer.legId)).toBe(
          false
        )
        expect(
          record?.paidLegs.find((leg) => leg.legId === organizer.legId)
            ?.recipientVerified
        ).toBe(true)
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        expect(
          (await f.manager.getFundsState(f.plan.walletId)).availableSats
        ).toBe(0)
        expect(f.calls.payer).toBe(1)
        expect(f.control.snapshot().sendInvocationCount).toBe(
          commerceTotalSats === 0 ? 1 : 3
        )
        expect(
          f.plan.recipients.some((recipient) => recipient.kind === "merchant")
        ).toBe(commerceTotalSats > 0)
      } finally {
        await f.cleanup()
      }
    },
    20_000
  )

  it("automatically retries the exact failed organizer progress delivery and requires both ACKs before every provider invocation", async () => {
    const f = await fixture({
      commerceTotalSats: 1_000,
      mode: "organizer_handoff",
    })
    let providerInvocations = 0
    try {
      const assertBothAcknowledged = async () => {
        const current = listCheckoutSparkRecoveryDeliveries(f.storage).sort(
          (a, b) => b.savedAt - a.savedAt
        )[0]!
        expect(current.record.handoffId === f.prepared.recoveryHandoffId).toBe(
          false
        )
        expect(
          current.deliveryProgress.acknowledgedRelayRefs.length
        ).toBeGreaterThan(0)
        expect(current.organizerDelivery?.merchantHandoffId).toBe(
          current.record.handoffId
        )
        expect(
          current.organizerDelivery?.acknowledgedRelayRefs.length
        ).toBeGreaterThan(0)
        providerInvocations++
      }
      f.hooks.beforeLightningSend = assertBothAcknowledged
      f.hooks.beforeNativeSend = assertBothAcknowledged
      f.hooks.failOrganizerOnce = true
      f.runInput.fundingPoll = { attempts: 4, intervalMs: 1 }
      f.control.setNativeCompletion(false)
      f.control.setNativeSenderCommitment(true)
      const result = await f.runner.run(f.runInput)
      expect(result).toEqual({ status: "complete" })
      expect(providerInvocations).toBe(4)
      expect(
        f.calls.organizerPublished[1] === f.calls.organizerPublished[2]
      ).toBe(true)
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
      expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      expect(f.calls.payer).toBe(1)
    } finally {
      await f.cleanup()
    }
  }, 30_000)

  it.each(["merchant_present", "organizer_handoff"] as const)(
    "continues the remaining native fee in Merchant recovery after Buyer cutoff for %s, independently checking every earlier recipient",
    async (mode) => {
      const f = await fixture({ commerceTotalSats: 1_000, mode })
      try {
        f.hooks.handoffAfterOrganizer = true
        f.control.setNativeCompletion(false)
        f.control.setNativeSenderCommitment(true)
        const buyerResult = await f.runner.run(f.runInput)
        expect(buyerResult).toEqual({
          status: "paused",
          reason: "authority_transferred",
        })
        const before = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (before.status !== "active")
          throw new Error("Expected partial event checkout")
        expect(
          before.state.legs.filter((leg) => leg.status === "paid").length
        ).toBe(3)
        expect(before.state.treasuryFinalization?.status).toBe("unprepared")

        const order = {
          ...f.order,
          buyerIdentityKind: "signed_in",
          shippingCostStatus: "included",
          createdAt: f.plan.createdAt,
          checkoutSparkPricing: f.plan.commerceQuote.pricing,
        }
        const draft = {
          kind: EVENT_KINDS.ORDER,
          pubkey: f.buyer.pubkey,
          created_at: AT / 1_000,
          tags: [
            ["p", f.plan.merchantPubkey],
            ["type", "order"],
            ["order", order.id],
            ["amount", String(order.subtotal)],
            ["currency", "SATS"],
            ["item", order.items[0]!.productId, "1"],
            [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
            ...buildEventMarketOrderRumorTags(order),
          ],
          content: JSON.stringify(order),
        }
        const orderWrap = await wrapPrivateMessage(
          { ...draft, id: getEventHash(draft) },
          { pubkey: f.plan.merchantPubkey },
          f.buyer
        )
        const authenticatedOrder = await unwrapPrivateMessageEnvelope(
          orderWrap,
          f.merchantSigner
        )
        const evidence =
          readCheckoutSparkMerchantOrderEvidence(authenticatedOrder)
        expect(evidence !== null).toBe(true)
        const witness =
          evidence &&
          createCheckoutSparkMerchantOrderWitness(
            f.plan,
            evidence,
            f.buyer.pubkey,
            f.sourceEvents
          )
        expect(witness !== null).toBe(true)
        await f.repository.importMerchantOrderRecovery(
          before.state,
          witness!,
          () => {}
        )
        const deliveries = listCheckoutSparkRecoveryDeliveries(f.storage).sort(
          (a, b) => b.savedAt - a.savedAt
        )
        const initialDelivery = getCheckoutSparkRecoveryDelivery(
          f.prepared.recoveryHandoffId,
          f.storage
        )!
        const initial = await openCheckoutSparkRecoveryDelivery({
          record: initialDelivery.record,
          signer: f.merchantSigner,
        })
        const latest = await openCheckoutSparkRecoveryDelivery({
          record: deliveries[0]!.record,
          signer: f.merchantSigner,
        })
        if (initial.schemaVersion !== 2 || latest.schemaVersion !== 3)
          throw new Error("Expected authenticated wallet and progress recovery")
        const candidate: MerchantCheckoutSparkRecoveryCandidate = {
          wrapId: deliveries[0]!.record.signedRecipientWrap.id,
          schemaVersion: 3,
          checkoutId: f.plan.checkoutId,
          orderId: f.plan.orderId,
          planDigest: f.plan.planDigest,
          takeoverAt: f.plan.takeoverAt,
          preparedAt: latest.preparedAt,
          initialWrapId: initialDelivery.record.signedRecipientWrap.id,
          initialHandoffId: initial.handoffId,
        }
        const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
          f.database
        )
        const inbox = await createInboxDeclarationFixtureEvidence(
          f.signMerchant({
            kind: 10_050,
            created_at: AT / 1_000,
            tags: [["relay", relays[0]!]],
            content: "",
          })
        )
        const result = await continueMerchantCheckoutSparkNativeTreasury(
          f.plan.merchantPubkey,
          candidate,
          {
            repository: f.repository,
            progressStore,
            signer: f.merchantSigner,
            now: () => ++f.clock.now,
            requireCrossTabLock: false,
            lockManager: null,
            shouldContinue: () => true,
            consumeRecovery: async (_principal, selected, adapter) => {
              await adapter.consumeSettled!(initial, latest, () => {})
              return {
                status: "consumed",
                coverage: "complete",
                discoveryCoverage: "complete",
                declarationState: "declared",
                candidate: selected,
              }
            },
            openWallet: async (input) => {
              const { wallet } = await f.native.module.initialize({
                mnemonicOrSeed: input.mnemonic,
                accountNumber: input.accountNumber,
                options: { log: false, network: "MAINNET" },
              })
              let closed = false
              const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
                network: "MAINNET",
                isClosed: () => closed,
                read: (read) => read(),
                codec: {
                  ...codec,
                  nativeTreasuryPolicy:
                    CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
                },
                wallet: {
                  getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
                  getBalance: () => wallet.getBalance(),
                  getTransfer: (id) => wallet.getTransfer(id),
                  querySparkInvoices: (invoices) =>
                    wallet.querySparkInvoices!(invoices),
                  fulfillSparkInvoice: (invoices) =>
                    wallet.fulfillSparkInvoice!(invoices),
                },
              })
              return {
                nativeTreasury: treasury,
                ensurePrivateReady: async () => {},
                getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
                getLightningReceiveRequest: (id) =>
                  wallet.getLightningReceiveRequest(id),
                getTransfer: (id) => wallet.getTransfer(id),
                getTransferFromSsp: (id) => wallet.getTransferFromSsp(id),
                getLightningSendRequest: (id) =>
                  wallet.getLightningSendRequest(id),
                openRetirementReader: () =>
                  f.native.openAuthenticatedRetirementReader(f.credentials),
                cleanup: async () => {
                  closed = true
                  await wallet.cleanup?.()
                },
              }
            },
            progressTransport: {
              ...f.transport,
              inboxDeclarationEvidenceRepository: inbox,
              accountNetworkLocalStateRepository: {
                get: async () => undefined,
              },
            },
          }
        )
        expect(result.status).toBe("consumed")
        expect(result.payout?.outcome).toBe("paid")
        expect(f.control.snapshot().sendInvocationCount).toBe(3)
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        expect(f.calls.payer).toBe(1)
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(
          saved.status === "active" &&
            saved.state.legs.every((leg) => leg.status === "paid")
        ).toBe(true)
        expect(
          (await f.manager.getFundsState(f.plan.walletId)).availableSats
        ).toBe(0)
      } finally {
        await f.cleanup()
      }
    },
    30_000
  )
})
