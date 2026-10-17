import { describe, expect, it } from "bun:test"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import {
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  DexieCheckoutSparkSettledRepository,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkNativeTreasurySdkAdapter,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  freezeCheckoutSparkSettledEventPlan,
  createInMemoryInboxDeclarationEvidenceRepository,
  resolveCheckoutSparkLnurlInvoice,
} from "@conduit/core"
import { acceptCheckoutSparkOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-handout"
import { routeCheckoutSparkOrganizerOrder } from "../apps/merchant/src/lib/checkout-spark-organizer-routing"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import {
  eventMarketFixtureInvoice,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  qualifiedReceiverFixture,
  qualifiedReceiverMetadataFixture,
} from "./support/checkout-spark-qualified-receiver-fixture"
import { admitFixture } from "./helpers/public-event"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"

const receiver =
  "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const address = encodeSparkAddress({
  identityPublicKey: receiver,
  network: "MAINNET",
})
const codec = {
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
}
const relays = ["wss://relay.conduit.market"]

async function fixture(commerceTotalSats = 1_000) {
  const credentials = { mnemonic: createRuntimeMnemonic(), accountNumber: 1 }
  const walletId = crypto.randomUUID()
  let clock = () => AT
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    credentials.mnemonic,
    credentials.accountNumber
  )
  const native = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "MAINNET" }),
    nativeInvoiceCodec: codec,
    issueFundingInvoice: async ({ amountSats }) =>
      eventMarketFixtureInvoice(amountSats).paymentRequest,
  })
  const manager = new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: "mainnet",
      now: () => clock(),
      wait: async () => {},
      loadModule: async () => native.module,
    }),
    async () => ({ release: async () => {} }),
    undefined,
    () => clock()
  )
  await manager.openWithMnemonic({ walletId, ...credentials })
  const f = await checkoutSparkOrganizerFixture({
    commerceTotalSats,
    receiverDomain: "wallet.conduit.market",
    wallet: credentials,
    preparePlan: async (graph) => {
      const receive = await manager.createCheckoutReceive(walletId, {
        description: "Offline organizer funding",
        requiredNetSats: graph.plan.funding.grossFundingSats,
        grossFundingSats: graph.plan.funding.grossFundingSats,
        expirySecs: 3_600,
        receiveMode: "ordinary_settled_v3",
      })
      const terms = {
        checkoutId: graph.plan.checkoutId,
        orderId: graph.plan.orderId,
        walletId,
        network: "mainnet" as const,
        createdAt: receive.createdAt,
        sparkAddress: address,
        receiverIdentityPublicKey: receiver,
        senderIdentityPublicKey: identity,
      }
      const treasury = await manager.prepareCheckoutTreasuryRequest({
        ...terms,
        invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId(terms),
      })
      return freezeCheckoutSparkSettledEventPlan({
        ...graph.input,
        walletId,
        createdAt: receive.createdAt,
        nativeTreasury: treasury,
        funding: {
          requestId: receive.id,
          paymentRequest: receive.paymentRequest,
          paymentHash: receive.paymentHash,
          receiverIdentityPublicKey: identity,
          grossFundingSats: receive.grossFundingSats,
          createdAt: receive.createdAt,
          expiresAt: receive.expiresAt,
        },
        recipients: graph.input.recipients.map((leg) =>
          leg.kind === "conduit"
            ? {
                ...leg,
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
            : leg
        ),
      })
    },
  })
  clock = () => ++f.clock.now
  const control = native.control.forIdentity(identity)
  control.completeFunding()
  control.setNativeCompletion(false)
  control.setNativeSenderCommitment(true)
  const inbox = createInMemoryInboxDeclarationEvidenceRepository()
  for (const [pubkey, sign] of [
    [f.organizerPubkey, f.signOrganizer],
    [f.merchantPubkey, f.signMerchant],
  ] as const) {
    await inbox.merge({
      pubkey,
      observedAt: Date.now(),
      signedEvent: await admitFixture(
        sign({
          kind: 10_050,
          tags: [["relay", relays[0]!]],
          content: "",
          created_at: Math.floor(Date.now() / 1_000),
        })
      ),
    })
  }
  const transportHooks: { failOnce?: boolean; signingFailure?: boolean } = {}
  const progressSends: string[] = []
  let wrapAttempts = 0
  const transport = {
    recipientInboxRelays: relays,
    resolveInboxRelays: async () => relays,
    inboxDeclarationEvidenceRepository: inbox,
    accountNetworkLocalStateRepository: { get: async () => undefined },
    giftWrapFn: async (...args: Parameters<typeof wrapPrivateMessage>) => {
      if (transportHooks.signingFailure) {
        wrapAttempts++
        throw new Error("Controlled signing failure")
      }
      return wrapPrivateMessage(...args)
    },
    publishFn: async (event: { id: string }) => {
      progressSends.push(event.id)
      const failed = transportHooks.failOnce === true
      transportHooks.failOnce = false
      return {
        attemptedRelayUrls: relays,
        successfulRelayUrls: failed ? [] : relays,
        failedRelayUrls: failed ? relays : [],
        relayFailureMessages: {},
      }
    },
  }
  const session = {
    db: f.database,
    authority: f.authority,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => f.clock.active,
  }
  await acceptCheckoutSparkOrganizerStockOrder({
    ...session,
    delivery: transport,
    nowMs: f.clock.now,
  })
  const repository = new DexieCheckoutSparkSettledRepository(f.database)
  const issued = new Map<string, ReturnType<typeof qualifiedReceiverFixture>>()
  const hooks: { beforeProvider?: () => Promise<void> } = {}
  const observations = { lightning: 0, native: 0 }
  const openWallet = async (input: {
    mnemonic: string
    accountNumber: number
  }) => {
    const { wallet } = await native.module.initialize({
      mnemonicOrSeed: input.mnemonic,
      accountNumber: input.accountNumber,
      options: { network: "MAINNET", log: false },
    })
    let closed = false
    const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
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
        querySparkInvoices: (invoices) => wallet.querySparkInvoices!(invoices),
        fulfillSparkInvoice: async (invoices) => {
          await hooks.beforeProvider?.()
          observations.native++
          return wallet.fulfillSparkInvoice!(invoices)
        },
      },
    })
    return {
      nativeTreasury: treasury,
      ensurePrivateReady: async () => {},
      getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
      getLightningReceiveRequest: (id: string) =>
        wallet.getLightningReceiveRequest(id),
      getTransfer: (id: string) => wallet.getTransfer(id),
      getTransferFromSsp: (id: string) => wallet.getTransferFromSsp(id),
      getLightningSendRequest: (id: string) =>
        wallet.getLightningSendRequest(id),
      openRetirementReader: () =>
        native.openAuthenticatedRetirementReader({
          ...credentials,
          network: "mainnet",
        }),
      outgoing: {
        getAvailableSats: async () => (await wallet.getBalance()).balance,
        estimateFee: ({ paymentRequest }: { paymentRequest: string }) =>
          wallet.getLightningSendFeeEstimate({
            encodedInvoice: paymentRequest,
          }),
        sendFrozen: async (request: {
          paymentRequest: string
          maxFeeSats: number
          transferId: string
        }) => {
          await hooks.beforeProvider?.()
          observations.lightning++
          return wallet.payLightningInvoice({
            invoice: request.paymentRequest,
            maxFeeSats: request.maxFeeSats,
            transferId: UUID.parse(request.transferId),
            preferSpark: false,
          })
        },
      },
      cleanup: async () => {
        closed = true
        await wallet.cleanup?.()
      },
    }
  }
  let nextPreimage = 0
  const dependencies = {
    repository,
    openWallet,
    now: clock,
    wait: async (milliseconds: number) => {
      f.clock.now += milliseconds
    },
    requireCrossTabLock: false,
    lockManager: null,
    progressTransport: transport,
    resolveInvoice: async (
      request: Parameters<typeof resolveCheckoutSparkLnurlInvoice>[0]
    ) => {
      const receiver = qualifiedReceiverFixture({
        lud16: request.lud16,
        amountSats: request.amountSats,
        nowSeconds: Math.floor(clock() / 1_000),
        preimageByte: ++nextPreimage,
      })
      issued.set(receiver.receiverBinding.verifyUrl, receiver)
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
    receiverDependencies: {
      contracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchMetadata: async (lud16: string) =>
        qualifiedReceiverMetadataFixture(lud16).metadata,
      fetchVerify: async (url: string) => {
        const receiver = issued.get(url)
        if (!receiver) throw new Error("Exact offline invoice unavailable")
        return receiver.verifier(
          control.outgoingInvoices().includes(receiver.paymentRequest)
        )
      },
    },
  }
  const prior = process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
  process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = address
  return {
    ...f,
    session,
    dependencies,
    repository,
    control,
    hooks,
    observations,
    manager,
    transportHooks,
    progressSends,
    get wrapAttempts() {
      return wrapAttempts
    },
    failSigning() {
      transportHooks.signingFailure = true
    },
    async cleanup() {
      if (prior === undefined)
        delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
      else process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = prior
      await manager.close(walletId)
      f.database.close()
      await f.database.delete()
    },
  }
}

describe("designated organizer automatic routing", () => {
  it.each([1_000, 0])(
    "uses the actual reserved writer and shared financial engine for %s-sat commerce",
    async (commerceTotalSats) => {
      const f = await fixture(commerceTotalSats)
      try {
        f.hooks.beforeProvider = async () => {
          const binding = await f.database.checkoutSparkPlanBindings.get(
            f.plan.checkoutId
          )
          const latest = binding?.organizerProgressOutbox?.at(-1) as
            { merchantAccepted?: boolean; selfAccepted?: boolean } | undefined
          expect(latest?.merchantAccepted).toBe(true)
          expect(latest?.selfAccepted).toBe(true)
        }
        const result = await routeCheckoutSparkOrganizerOrder(
          f.session,
          f.dependencies
        )
        expect({
          status: result.status,
          reason: result.reason,
          lightning: f.observations.lightning,
          native: f.observations.native,
        }).toEqual({
          status: "complete",
          reason: undefined,
          lightning: commerceTotalSats === 0 ? 1 : 3,
          native: 1,
        })
        expect(result.commerceProof !== null).toBe(true)
        expect(result.walletRetirement).toBe("retained")
        expect(f.observations.lightning).toBe(commerceTotalSats === 0 ? 1 : 3)
        expect(f.observations.native).toBe(1)
        expect(
          (await f.manager.getFundsState(f.plan.walletId)).availableSats
        ).toBe(0)
        const again = await routeCheckoutSparkOrganizerOrder(
          f.session,
          f.dependencies
        )
        expect(again.status).toBe("complete")
        expect(f.observations.lightning).toBe(commerceTotalSats === 0 ? 1 : 3)
        expect(f.observations.native).toBe(1)
      } finally {
        await f.cleanup()
      }
    },
    60_000
  )

  it("stops a changed writer before the provider can be invoked", async () => {
    const f = await fixture()
    try {
      await f.database.eventMarketOrganizerStockPools
        .toCollection()
        .modify((pool) => {
          pool.readOnlyRecovery = true
        })
      await expect(
        routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
      ).rejects.toThrow()
      expect(f.observations.lightning).toBe(0)
      expect(f.observations.native).toBe(0)
    } finally {
      await f.cleanup()
    }
  })

  it("automatically retries exact saved progress after a transient relay rejection without repeating a payout", async () => {
    const f = await fixture(0)
    try {
      f.transportHooks.failOnce = true
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("complete")
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
      expect(f.progressSends.length).toBeGreaterThan(
        new Set(f.progressSends).size
      )
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("does not turn an unknown signing failure into repeated automatic attempts", async () => {
    const f = await fixture(0)
    try {
      f.failSigning()
      await expect(
        routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
      ).rejects.toThrow("Controlled signing failure")
      expect(f.wrapAttempts).toBe(1)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("stops an unknown progress signing failure after a payment without repeating that payment", async () => {
    const f = await fixture(0)
    try {
      f.hooks.beforeProvider = async () => {
        f.failSigning()
      }
      await expect(
        routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
      ).rejects.toThrow("Controlled signing failure")
      expect(f.wrapAttempts).toBe(1)
      expect(f.observations).toEqual({ lightning: 1, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("does not trust a restored paid projection when the exact native commitment is no longer confirmed", async () => {
    const f = await fixture(0)
    try {
      expect(
        (await routeCheckoutSparkOrganizerOrder(f.session, f.dependencies))
          .status
      ).toBe("complete")
      f.control.setNativeSenderCommitment(false)
      const checked = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(checked.status).toBe("waiting")
      expect(checked.commerceProof).not.toBeNull()
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)
})
