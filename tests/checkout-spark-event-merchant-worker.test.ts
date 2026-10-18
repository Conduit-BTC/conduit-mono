import { expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  SessionSigner,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  buildEventMarketOrderRumorTags,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkNativeTreasurySdkAdapter,
  createInMemoryInboxDeclarationEvidenceRepository,
  createMerchantCheckoutSparkRecoveryDiscovery,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  freezeCheckoutSparkSettledEventPlan,
  orderSchema,
  prepareCheckoutSparkNativeTreasuryRequest,
  projectCheckoutSparkMerchantSettlement,
  resolveCheckoutSparkLnurlInvoice,
  verifyCheckoutSparkInvoiceRecipient,
  type CheckoutSparkInvoiceRecipientDependencies,
  type MerchantCheckoutSparkRecoveryCandidate,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { acceptCheckoutSparkOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-handout"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import { CommerceInboxStore } from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { __resetInboxDeclarationCache } from "@conduit/core/protocol/private-message-routing"
import {
  activateAccountSigner,
  retireAccountSigner,
} from "@conduit/core/protocol/session-signer"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import {
  createCheckoutSparkOrganizerRecoveryPayload,
  buildCheckoutSparkOrganizerRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { openCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import type { ProtectedInboxReadResult } from "@conduit/core/protocol/protected-inbox-read"
import { routeCheckoutSparkOrganizerOrder } from "../apps/merchant/src/lib/checkout-spark-organizer-routing"
import { advanceMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  reconcileMerchantCheckoutSparkSettledCredit,
  type MerchantSparkRecoveryWallet,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  continueMerchantCheckoutSparkSettledPayout,
  selectMerchantCheckoutSparkSignedNextPayout,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { continueMerchantCheckoutSparkNativeTreasury } from "../apps/merchant/src/lib/checkout-spark-native-treasury-continuation"
import { prepareNextMerchantCheckoutSparkSettledPayout } from "../apps/merchant/src/lib/checkout-spark-settled-leg-preparation"
import { verifySavedMerchantCheckoutSparkRecipients } from "../apps/merchant/src/lib/checkout-spark-invoice-recipient"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import {
  EVENT_MARKET_FIXTURE_AT as AT,
  eventMarketFixtureInvoice,
} from "./support/checkout-spark-event-market-fixture"
import {
  qualifiedReceiverFixture,
  qualifiedReceiverMetadataFixture,
} from "./support/checkout-spark-qualified-receiver-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { admitFixture } from "./helpers/public-event"

const INBOX = "wss://relay.conduit.market"
// Public curve point only; no receiver credential is part of this fixture.
const RECEIVER =
  "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const ADDRESS = encodeSparkAddress({
  identityPublicKey: RECEIVER,
  network: "MAINNET",
})
const codec = {
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
}

function protectedRead(
  events: SignedPublicNostrEvent[]
): ProtectedInboxReadResult {
  return {
    events,
    coverage: "complete",
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: "success",
      observations: [{ type: "eose", relayIndex: 0 }],
      relays: [
        {
          relayIndex: 0,
          status: "success",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      authoritativeEmpty: events.length === 0,
    },
  }
}

it("automatically finishes an interrupted Organizer payment through the fresh Merchant worker without replay", async () => {
  const credentials = {
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 1,
    network: "mainnet" as const,
  }
  const native = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "MAINNET" }),
    nativeInvoiceCodec: codec,
    issueFundingInvoice: async ({ amountSats }) =>
      eventMarketFixtureInvoice(amountSats).paymentRequest,
  })
  const previousAddress = process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
  process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = ADDRESS
  let stage = "setup"
  let f: Awaited<ReturnType<typeof checkoutSparkOrganizerFixture>> | undefined
  let merchantDb: ConduitDB | undefined
  let owner: CommerceInbox | undefined
  let discovery:
    | Awaited<ReturnType<typeof createMerchantCheckoutSparkRecoveryDiscovery>>
    | undefined
  let merchantSigner: SessionSigner | undefined
  try {
    f = await checkoutSparkOrganizerFixture({
      commerceTotalSats: 1_000,
      receiverDomain: "wallet.conduit.market",
      wallet: credentials,
      preparePlan: async (graph) => {
        stage = "native provider initialization"
        const { wallet } = await native.module.initialize({
          mnemonicOrSeed: credentials.mnemonic,
          accountNumber: credentials.accountNumber,
          options: { log: false, network: "MAINNET" },
        })
        const identity = await wallet.getIdentityPublicKey()
        stage = "funding invoice preparation"
        const receive = await wallet.createLightningInvoice({
          amountSats: graph.input.funding.grossFundingSats,
          expirySeconds: 900,
        })
        const input = {
          ...graph.input,
          funding: {
            ...graph.input.funding,
            requestId: receive.id,
            paymentRequest: receive.invoice!.encodedInvoice,
            paymentHash: receive.invoice!.paymentHash,
            receiverIdentityPublicKey: identity,
            expiresAt: AT + 3_600_000,
          },
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
        }
        const invoiceId = deriveCheckoutSparkNativeTreasuryInvoiceId({
          ...input,
          sparkAddress: ADDRESS,
          senderIdentityPublicKey: identity,
          receiverIdentityPublicKey: RECEIVER,
        })
        stage = "native invoice preparation"
        const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(
          codec,
          {
            network: "mainnet",
            sparkAddress: ADDRESS,
            senderIdentityPublicKey: identity,
            receiverIdentityPublicKey: RECEIVER,
            invoiceId,
          }
        )
        await wallet.cleanup?.()
        stage = "frozen Event plan"
        const plan = freezeCheckoutSparkSettledEventPlan({
          ...input,
          nativeTreasury,
        })
        stage = "Organizer fixture initialization"
        return plan
      },
    })
    const { plan } = f
    const order = orderSchema.parse({
      ...f.order,
      buyerIdentityKind: "signed_in",
      shippingCostStatus: "included",
    })
    const organizerInitial = createCheckoutSparkOrganizerRecoveryPayload({
      merchantRecovery: f.merchantRecovery,
      order,
    })
    const organizerInitialWrap = await wrapPrivateMessage(
      buildCheckoutSparkOrganizerRecoveryRumor(organizerInitial),
      { pubkey: f.organizerPubkey },
      f.buyerSigner
    )
    const organizerAuthority =
      await openCheckoutSparkOrganizerRecoveryAuthority({
        ...f.authorityInput,
        initialWrap: organizerInitialWrap,
      })
    const control = native.control.forIdentity(
      plan.funding.receiverIdentityPublicKey
    )
    control.completeFunding()
    control.setNativeCompletion(false)
    control.setNativeSenderCommitment(true)
    const receivers = new Map<
      string,
      ReturnType<typeof qualifiedReceiverFixture>
    >()
    let invoiceSequence = 0
    let organizerActive = true
    let interruptOrganizer = true
    const relayEvents = new Map<string, SignedPublicNostrEvent>()
    const declarations = createInMemoryInboxDeclarationEvidenceRepository()
    for (const [pubkey, sign] of [
      [f.merchantPubkey, f.signMerchant],
      [f.organizerPubkey, f.signOrganizer],
    ] as const) {
      await declarations.merge({
        pubkey,
        observedAt: Date.now(),
        signedEvent: await admitFixture(
          sign({
            kind: 10050,
            tags: [["relay", INBOX]],
            content: "",
            created_at: Math.floor(Date.now() / 1_000),
          })
        ),
      })
    }
    const delivery = {
      resolveInboxRelays: async () => [INBOX],
      inboxDeclarationEvidenceRepository: declarations,
      accountNetworkLocalStateRepository: { get: async () => undefined },
      publishFn: async (event: { id: string }) => {
        relayEvents.set(
          event.id,
          structuredClone(event) as SignedPublicNostrEvent
        )
        return {
          attemptedRelayUrls: [INBOX],
          successfulRelayUrls: [INBOX],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
    }
    const receiverDependencies: CheckoutSparkInvoiceRecipientDependencies = {
      contracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchMetadata: async (lud16) =>
        qualifiedReceiverMetadataFixture(lud16).metadata,
      fetchVerify: async (url) => {
        const receiver = [...receivers.values()].find(
          (value) => value.receiverBinding.verifyUrl === url
        )
        if (!receiver)
          throw new Error("Exact receiving evidence is unavailable.")
        return receiver.verifier(
          control.outgoingInvoices().includes(receiver.paymentRequest)
        )
      },
    }
    const resolveInvoice: NonNullable<
      Parameters<typeof routeCheckoutSparkOrganizerOrder>[1]
    >["resolveInvoice"] = async (request) => {
      const receiver = qualifiedReceiverFixture({
        lud16: request.lud16,
        amountSats: request.amountSats,
        nowSeconds: Math.floor(f!.clock.now / 1_000),
        preimageByte: ++invoiceSequence,
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
    }
    const openWallet = async (
      input: Parameters<
        typeof import("../apps/merchant/src/lib/checkout-spark-settled-recovery").openMerchantCheckoutSparkRecoveryWallet
      >[0]
    ): Promise<MerchantSparkRecoveryWallet> => {
      const { wallet } = await native.module.initialize({
        mnemonicOrSeed: input.mnemonic,
        accountNumber: input.accountNumber,
        options: { network: "MAINNET", log: false },
      })
      let closed = false
      return {
        ensurePrivateReady: async () => {},
        getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
        getLightningReceiveRequest: (id) =>
          wallet.getLightningReceiveRequest(id),
        getTransfer: (id) => wallet.getTransfer(id),
        getTransferFromSsp: (id) => wallet.getTransferFromSsp(id),
        getLightningSendRequest: (id) => wallet.getLightningSendRequest(id),
        estimateLightningFee: ({ paymentRequest }) =>
          wallet.getLightningSendFeeEstimate({
            encodedInvoice: paymentRequest,
          }),
        openRetirementReader: () =>
          native.openAuthenticatedRetirementReader(credentials),
        nativeTreasury: createCheckoutSparkNativeTreasurySdkAdapter({
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
        }),
        ...(input.outgoing
          ? {
              outgoing: {
                getAvailableSats: async () =>
                  (await wallet.getBalance()).balance,
                estimateFee: ({ paymentRequest }) =>
                  wallet.getLightningSendFeeEstimate({
                    encodedInvoice: paymentRequest,
                  }),
                sendFrozen: async (request) => {
                  const result = await wallet.payLightningInvoice({
                    invoice: request.paymentRequest,
                    maxFeeSats: request.maxFeeSats,
                    transferId: UUID.parse(request.transferId),
                    preferSpark: false,
                  })
                  if (interruptOrganizer) {
                    interruptOrganizer = false
                    organizerActive = false
                  }
                  return result
                },
              },
            }
          : {}),
        cleanup: async () => {
          closed = true
          await wallet.cleanup?.()
        },
      }
    }
    const session = {
      db: f.database,
      authority: organizerAuthority,
      signer: f.organizerSigner,
      authenticatedPubkey: f.organizerPubkey,
      shouldContinue: () => organizerActive,
    }
    stage = "Organizer stock acceptance"
    await acceptCheckoutSparkOrganizerStockOrder({
      ...session,
      delivery,
      nowMs: f.clock.now,
    })
    stage = "Organizer first payment"
    let stopped = false
    try {
      await routeCheckoutSparkOrganizerOrder(session, {
        openWallet,
        now: () => ++f!.clock.now,
        wait: async (milliseconds) => {
          f!.clock.now += milliseconds
        },
        requireCrossTabLock: false,
        lockManager: null,
        resolveInvoice,
        receiverDependencies,
        progressTransport: delivery,
      })
    } catch {
      stopped = !organizerActive
    }
    expect(stopped).toBe(true)
    expect(control.snapshot().sendInvocationCount).toBe(1)
    expect(control.outgoingInvoices().length).toBe(1)
    expect(control.nativeSnapshot().nativeSendInvocationCount).toBe(0)

    stage = "Fresh Merchant authenticated recovery"
    merchantDb = new ConduitDB(`event-worker-merchant-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const repository = new DexieCheckoutSparkSettledRepository(merchantDb)
    const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
      merchantDb
    )
    merchantSigner = new SessionSigner(f.merchantSigner, {
      expectedPubkey: f.merchantPubkey,
      revision: crypto.randomUUID(),
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: true,
      }),
      hasAuthority: () => true,
    })
    activateAccountSigner(merchantSigner)
    installProtectedReadSigner(merchantSigner, f.merchantPubkey, () => true)
    const authorization = getProtectedReadAuthorization(f.merchantPubkey)!
    owner = new CommerceInbox(
      authorization,
      merchantSigner,
      new CommerceInboxStore(authorization, merchantDb)
    )
    const draft = {
      kind: 16,
      pubkey: f.buyerSigner.pubkey,
      created_at: Math.floor(order.createdAt / 1_000),
      tags: [
        ["p", f.merchantPubkey],
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
      { pubkey: f.merchantPubkey },
      f.buyerSigner
    )
    const initialWrap = await wrapPrivateMessage(
      buildCheckoutSparkRecoveryRumor(f.merchantRecovery),
      { pubkey: f.merchantPubkey },
      f.buyerSigner
    )
    relayEvents.set(orderWrap.id, orderWrap)
    relayEvents.set(initialWrap.id, initialWrap)
    __setCommerceTestOverrides({
      getAccountSigner: () => merchantSigner!,
      getCommerceInbox: () => owner!,
      checkoutSparkSettledRepository: repository,
      now: () => f!.clock.now,
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          [...relayEvents.values()].filter(
            (event) =>
              (!options.eventId || event.id === options.eventId) &&
              (options.since === undefined ||
                event.created_at >= options.since) &&
              (options.until === undefined || event.created_at <= options.until)
          )
        ),
    })
    discovery = await createMerchantCheckoutSparkRecoveryDiscovery(
      f.merchantPubkey,
      {
        onOrderRecovery: async ({
          state,
          witness,
          sourceEvents,
          assertCurrent,
        }) => {
          await repository.importMerchantOrderRecovery(
            state,
            witness,
            assertCurrent
          )
          await repository.recordMerchantPlanSources(
            state.plan,
            sourceEvents,
            assertCurrent
          )
        },
      }
    )
    let discoveryStarted = false
    const discover =
      async (): Promise<MerchantCheckoutSparkRecoveryCandidate> => {
        if (discoveryStarted) discovery!.restartScan()
        discoveryStarted = true
        let page = await discovery!.nextPage()
        for (let count = 0; page.history.hasMore && count < 16; count++)
          page = await discovery!.nextPage()
        expect(page.history.hasMore).toBe(false)
        expect(page.conflictCount).toBe(0)
        expect(page.decryptFailureCount).toBe(0)
        expect(page.candidates.length).toBe(1)
        return page.candidates[0]!
      }
    await discover()
    expect(
      (await repository.loadMerchantOrderWitness(
        f.merchantPubkey,
        plan.checkoutId,
        plan.planDigest
      )) !== null
    ).toBe(true)
    expect(await merchantDb.eventMarketOrganizerStockPools.count()).toBe(0)
    expect(await merchantDb.eventMarketOrganizerStockWriters.count()).toBe(0)

    const external = {
      repository,
      progressStore,
      progressTransport: { ...delivery, deliveryStore: owner.store },
      signer: merchantSigner,
      now: () => ++f!.clock.now,
      shouldContinue: () => true,
      lockManager: null,
      requireCrossTabLock: false,
      openWallet,
    }
    const workerDependencies: Parameters<
      typeof advanceMerchantCheckoutSparkOrder
    >[3] = {
      repository,
      now: external.now,
      requestRescan: () => {},
      // These delegate to real child modules. Only the external wallet, receiver,
      // relay and clock adapters are injected; no application result is mocked.
      verifyRecipients: (input) =>
        verifySavedMerchantCheckoutSparkRecipients({
          ...input,
          verifyInvoice: (request) =>
            verifyCheckoutSparkInvoiceRecipient(request, receiverDependencies),
        }),
      checkCredit: (principal, candidate, input) =>
        reconcileMerchantCheckoutSparkSettledCredit(principal, candidate, {
          ...input,
          ...external,
        }),
      inspectPayouts: (principal, candidate, input) =>
        inspectMerchantCheckoutSparkSettledPayoutHistory(principal, candidate, {
          ...input,
          ...external,
        }),
      selectPayout: selectMerchantCheckoutSparkSignedNextPayout,
      preparePayout: (principal, candidate, input, dependencies) =>
        prepareNextMerchantCheckoutSparkSettledPayout(
          principal,
          candidate,
          input,
          { ...dependencies, ...external, resolveInvoice }
        ),
      continuePayout: (principal, candidate, review, dependencies) =>
        continueMerchantCheckoutSparkSettledPayout(
          principal,
          candidate,
          review,
          { ...dependencies, ...external }
        ),
      continueNativeTreasury: (principal, candidate, dependencies) =>
        continueMerchantCheckoutSparkNativeTreasury(principal, candidate, {
          ...dependencies,
          ...external,
        }),
    }
    stage = "Automatic Merchant worker continuation"
    const statuses: string[] = []
    for (
      let invocation = 0;
      invocation < 32 && statuses.at(-1) !== "verified";
      invocation++
    ) {
      const status = await advanceMerchantCheckoutSparkOrder(
        f.merchantPubkey,
        await discover(),
        () => {},
        workerDependencies
      )
      statuses.push(status)
    }
    expect(statuses.at(-1)).toBe("verified")
    expect(control.snapshot().sendInvocationCount).toBe(3)
    expect(control.outgoingInvoices().length).toBe(3)
    expect(control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
    const settled = await repository.loadMerchantSettlement(
      f.merchantPubkey,
      plan.checkoutId,
      plan.planDigest
    )
    expect(
      settled !== null &&
        projectCheckoutSparkMerchantSettlement(settled).commerceVerified
    ).toBe(true)
    expect(
      settled !== null &&
        !projectCheckoutSparkMerchantSettlement(settled).feePending
    ).toBe(true)
    const saved = await repository.load(plan.checkoutId, plan.planDigest)
    expect(
      saved.status === "active" &&
        saved.state.legs.every((leg) => leg.status === "paid")
    ).toBe(true)
    stage = "Completed worker replay"
    expect(
      await advanceMerchantCheckoutSparkOrder(
        f.merchantPubkey,
        await discover(),
        () => {},
        workerDependencies
      )
    ).toBe("verified")
    expect(control.snapshot().sendInvocationCount).toBe(3)
    expect(control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
  } catch {
    // The test's failure surface must not print signed orders, invoices or keys.
    throw new Error(`Event Merchant worker regression failed during ${stage}.`)
  } finally {
    discovery?.dispose()
    owner?.stop()
    if (merchantSigner) retireAccountSigner(merchantSigner)
    __resetCommerceTestOverrides()
    __resetProtectedReadSigner()
    __resetInboxDeclarationCache()
    if (merchantDb) await merchantDb.delete()
    if (f) await f.database.delete()
    if (previousAddress === undefined)
      delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
    else process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = previousAddress
  }
}, 90_000)
