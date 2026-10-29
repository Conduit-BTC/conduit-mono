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
  assertCheckoutSparkOrganizerCommerceProof,
  assertCheckoutSparkOrganizerRecoveryAuthority,
  DexieCheckoutSparkSettledRepository,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkNativeTreasurySdkAdapter,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  freezeCheckoutSparkSettledEventPlan,
  createInMemoryInboxDeclarationEvidenceRepository,
  deriveCheckoutSparkSettledTransferId,
  prepareCheckoutSparkSettledLeg,
  proveSparkCheckoutReceiveCredit,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  resolveCheckoutSparkLnurlInvoice,
} from "@conduit/core"
import {
  acceptCheckoutSparkOrganizerStockOrder,
  confirmOrganizerStockOrderHandout,
} from "@conduit/core/protocol/event-market-stock-handout"
import { formatEventMarketPickupClaimCode } from "@conduit/core/protocol/event-market-handoff"
import { routeCheckoutSparkOrganizerOrder } from "../apps/merchant/src/lib/checkout-spark-organizer-routing"
import { CheckoutSparkOrganizerRoutingTimeoutError } from "../apps/merchant/src/lib/checkout-spark-organizer-routing-observation"
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
  const hooks: {
    beforeProvider?: () => Promise<void>
    beforeNativeFulfill?: () => Promise<void>
    beforeNativeQuery?: () => void
  } = {}
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
        querySparkInvoices: (invoices) => {
          hooks.beforeNativeQuery?.()
          return wallet.querySparkInvoices!(invoices)
        },
        fulfillSparkInvoice: async (invoices) => {
          await hooks.beforeProvider?.()
          await hooks.beforeNativeFulfill?.()
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

/** A real resolved Buyer intent, imported without its device-local origin by default. */
async function importBuyerPreparedOrganizerIntent(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { localOrigin?: boolean; possibleSend?: boolean } = {}
) {
  const recoveredAt = f.clock.now
  const wallet = await f.dependencies.openWallet({
    ...f.initial.wallet,
    outgoing: true,
  })
  try {
    const receive = await wallet.getLightningReceiveRequest(
      f.plan.funding.requestId
    )
    if (!receive?.transfer?.sparkId)
      throw new Error("Controlled receive is unavailable")
    const transfer = await wallet.getTransfer(receive.transfer.sparkId)
    if (!transfer) throw new Error("Controlled transfer is unavailable")
    const credit = proveSparkCheckoutReceiveCredit({
      expectedRequest: {
        id: f.plan.funding.requestId,
        network: f.plan.network,
        paymentRequest: f.plan.funding.paymentRequest,
        paymentHash: f.plan.funding.paymentHash,
        grossFundingSats: f.plan.funding.grossFundingSats,
      },
      expectedReceive: { mode: "ordinary_v3" },
      walletIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
      receive,
      transfer,
    })
    f.clock.now = f.plan.createdAt + 1_000
    const credited = recordCheckoutSparkSettledCredit(f.initial.state, {
      ...credit,
      paymentHash: f.plan.funding.paymentHash,
      observedAt: f.clock.now,
    })
    const recipient = f.plan.recipients.find((row) => row.kind === "organizer")!
    const leg = credited.legs.find((row) => row.legId === recipient.legId)!
    const invoice = await f.dependencies.resolveInvoice({
      lud16: recipient.destination.value,
      amountSats: leg.allocationSats! - 1,
      network: f.plan.network,
      nowSeconds: Math.floor(f.clock.now / 1_000),
      shouldContinue: () => true,
      receiverMode: "private",
    })
    let prepared = prepareCheckoutSparkSettledLeg(credited, {
      legId: recipient.legId,
      transferId: deriveCheckoutSparkSettledTransferId(f.plan, recipient.legId),
      paymentRequest: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      invoiceAmountSats: leg.allocationSats! - 1,
      maxFeeSats: 1,
      receiverBinding: invoice.receiverBinding,
      preparedAt: ++f.clock.now,
    })
    if (options.localOrigin) {
      const imported = await f.repository.importRecoveryState(
        credited,
        () => {}
      )
      if (imported.status !== "active")
        throw new Error("Expected active recovery")
      await f.repository.savePreparedWithInvoiceOrigin(
        prepared,
        imported.revision,
        { legId: recipient.legId, origin: invoice.origin! },
        () => {}
      )
    }
    if (options.possibleSend) {
      prepared = recordCheckoutSparkSettledLegStatus(prepared, {
        legId: recipient.legId,
        transferId: prepared.legs[0]!.intent!.transferId,
        paymentHash: invoice.paymentHash,
        status: "ambiguous",
        observedAt: ++f.clock.now,
      })
    }
    await f.repository.importRecoveryState(prepared, () => {})
    return { state: prepared, legId: recipient.legId }
  } finally {
    f.clock.now = recoveredAt
    await wallet.cleanup()
  }
}

describe("designated organizer automatic routing", () => {
  it("retains only an admitted native reference after Pause without further provider checks or recovery acknowledgments", async () => {
    const f = await fixture(0)
    let release!: () => void
    let running: Promise<unknown> | undefined
    try {
      let entered!: () => void
      let paused = false
      let queries = 0
      const admission = new Promise<void>((resolve) => {
        entered = resolve
      })
      const completion = new Promise<void>((resolve) => {
        release = resolve
      })
      f.hooks.beforeNativeFulfill = async () => {
        entered()
        await completion
      }
      f.hooks.beforeNativeQuery = () => {
        queries++
      }
      running = routeCheckoutSparkOrganizerOrder(
        { ...f.session, shouldContinue: () => !paused && f.clock.active },
        f.dependencies
      )
      await admission
      const admitted = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (admitted.status !== "active")
        throw new Error("Expected saved admission")
      const queriesAtPause = queries
      const acknowledgmentsAtPause = f.progressSends.length
      paused = true
      release()
      await expect(running).rejects.toThrow(
        "Organizer payment processing is no longer active."
      )
      const retained = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (retained.status !== "active")
        throw new Error("Expected retained admission")
      const final = retained.state.treasuryFinalization!
      expect(final.status).toBe("submitted")
      expect(
        final.providerTransferId === f.control.nativeSnapshot().transfers[0]!.id
      ).toBe(true)
      expect(
        JSON.stringify(final.intent) ===
          JSON.stringify(admitted.state.treasuryFinalization!.intent)
      ).toBe(true)
      expect(final.finalFeeSats).toBeNull()
      expect(final.finalDebitSats).toBeNull()
      expect(
        JSON.stringify(retained.state.credit) ===
          JSON.stringify(admitted.state.credit)
      ).toBe(true)
      expect(
        JSON.stringify(retained.state.legs.slice(0, -1)) ===
          JSON.stringify(admitted.state.legs.slice(0, -1))
      ).toBe(true)
      expect(queries).toBe(queriesAtPause)
      expect(f.progressSends.length).toBe(acknowledgmentsAtPause)
      expect(f.observations.native).toBe(1)
    } finally {
      release?.()
      await running?.catch(() => {})
      await f.cleanup()
    }
  }, 60_000)
  it("does not retain a late native reference after the original organizer account is revoked", async () => {
    const f = await fixture(0)
    let release!: () => void
    let running: Promise<unknown> | undefined
    try {
      let entered!: () => void
      const admission = new Promise<void>((resolve) => {
        entered = resolve
      })
      const completion = new Promise<void>((resolve) => {
        release = resolve
      })
      f.hooks.beforeNativeFulfill = async () => {
        entered()
        await completion
      }
      running = routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
      await admission
      f.organizerSigner.invalidateLocal()
      release()
      await expect(running).rejects.toThrow()
      const retained = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (retained.status !== "active")
        throw new Error("Expected retained admission")
      expect(retained.state.treasuryFinalization!.status).toBe("submitted")
      expect(retained.state.treasuryFinalization!.providerTransferId).toBeNull()
      expect(retained.state.treasuryFinalization!.finalFeeSats).toBeNull()
      expect(retained.state.treasuryFinalization!.finalDebitSats).toBeNull()
      expect(f.observations.native).toBe(1)
    } finally {
      release?.()
      await running?.catch(() => {})
      await f.cleanup()
    }
  }, 60_000)
  it("retains an actual completed goods proof after the processing deadline while the original authority is current", async () => {
    const f = await fixture()
    try {
      const startedAt = f.clock.now
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("complete")
      expect(result.commerceProof).not.toBeNull()
      f.clock.now = startedAt + 2 * 60_000 + 1
      expect(() =>
        assertCheckoutSparkOrganizerCommerceProof(result.commerceProof!, {
          organizerPubkey: f.organizerPubkey,
          initialHandoffId: f.initial.handoffId,
          order: f.order,
        })
      ).not.toThrow()
      expect(f.observations).toEqual({ lightning: 3, native: 1 })
      const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(
        f.authority
      )
      const confirmation = {
        ...f.session,
        commerceProof: result.commerceProof!,
        enteredClaimCode: formatEventMarketPickupClaimCode(purchase.claimRef),
        physicalReleaseConfirmed: true as const,
        delivery: f.dependencies.progressTransport,
        nowMs: f.clock.now,
      }
      await f.database.eventMarketOrganizerStockPools
        .toCollection()
        .modify((pool) => {
          pool.readOnlyRecovery = true
        })
      await expect(
        confirmOrganizerStockOrderHandout(confirmation)
      ).rejects.toThrow()
      expect(
        (await f.database.eventMarketOrganizerStockEntries.toArray()).every(
          (entry) => entry.handout === undefined
        )
      ).toBe(true)
      await f.database.eventMarketOrganizerStockPools
        .toCollection()
        .modify((pool) => {
          pool.readOnlyRecovery = undefined
        })
      await confirmOrganizerStockOrderHandout(confirmation)
      expect(
        (await f.database.eventMarketOrganizerStockEntries.toArray()).every(
          (entry) => entry.handout !== undefined
        )
      ).toBe(true)
      expect(f.observations).toEqual({ lightning: 3, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("retains pause, signer and original-open expiry fences on a completed proof", async () => {
    const f = await fixture(0)
    try {
      const openedAt = f.clock.now
      // Keep mutable controls in fields: the pinned Bun runtime can stale-fold
      // reassigned captured lets across async work (oven-sh/bun#26534).
      const controls = {
        paused: false,
        changed: null as
          "identity" | "revision" | "method" | "capability" | null,
      }
      const signer = new Proxy(f.organizerSigner, {
        get(target, property) {
          if (property === "pubkey" && controls.changed === "identity")
            return f.merchantPubkey
          if (property === "revision" && controls.changed === "revision")
            return "changed-session"
          if (property === "authMethod" && controls.changed === "method")
            return "nip46"
          if (property === "capabilities" && controls.changed === "capability")
            return { ...target.capabilities, nip44: false }
          const value = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      const result = await routeCheckoutSparkOrganizerOrder(
        {
          ...f.session,
          signer,
          shouldContinue: () => !controls.paused && f.clock.active,
        },
        f.dependencies
      )
      expect(result.status).toBe("complete")
      expect(result.commerceProof).not.toBeNull()
      const assertProof = () =>
        assertCheckoutSparkOrganizerCommerceProof(result.commerceProof!, {
          organizerPubkey: f.organizerPubkey,
          initialHandoffId: f.initial.handoffId,
          order: f.order,
        })
      f.clock.now = openedAt + 2 * 60_000 + 1
      expect(assertProof).not.toThrow()
      controls.paused = true
      expect(assertProof).toThrow()
      controls.paused = false
      for (const boundary of [
        "identity",
        "revision",
        "method",
        "capability",
      ] as const) {
        controls.changed = boundary
        expect(assertProof).toThrow()
        controls.changed = null
        expect(assertProof).not.toThrow()
      }
      f.clock.now = openedAt - 1
      expect(assertProof).toThrow()
      f.clock.now = openedAt + 5 * 60_000
      expect(assertProof).toThrow()
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("revokes a completed proof when its original account session is retired", async () => {
    const f = await fixture(0)
    try {
      const startedAt = f.clock.now
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("complete")
      expect(result.commerceProof).not.toBeNull()
      f.clock.now = startedAt + 2 * 60_000 + 1
      f.organizerSigner.invalidateLocal()
      expect(() =>
        assertCheckoutSparkOrganizerCommerceProof(result.commerceProof!, {
          organizerPubkey: f.organizerPubkey,
          initialHandoffId: f.initial.handoffId,
          order: f.order,
        })
      ).toThrow()
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("retains the commerce proof's own expiry even with an independently current authority clock", async () => {
    const f = await fixture(0)
    try {
      const verificationClock = { offset: 0 }
      const result = await routeCheckoutSparkOrganizerOrder(f.session, {
        ...f.dependencies,
        now: () => f.dependencies.now() + verificationClock.offset,
      })
      expect(result.status).toBe("complete")
      expect(result.commerceProof).not.toBeNull()
      verificationClock.offset = 5 * 60_000
      expect(() =>
        assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
      ).not.toThrow()
      expect(() =>
        assertCheckoutSparkOrganizerCommerceProof(result.commerceProof!, {
          organizerPubkey: f.organizerPubkey,
          initialHandoffId: f.initial.handoffId,
          order: f.order,
        })
      ).toThrow("Exact event commerce payment verification is unavailable.")
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("still rejects new preparation and sends at the exact processing deadline", async () => {
    const f = await fixture(0)
    try {
      const startedAt = f.clock.now
      const openWallet = f.dependencies.openWallet
      let invoiceRequests = 0
      const resolveInvoice = f.dependencies.resolveInvoice
      f.dependencies.resolveInvoice = async (input) => {
        invoiceRequests++
        return resolveInvoice(input)
      }
      f.dependencies.openWallet = async (input) => {
        const wallet = await openWallet(input)
        return {
          ...wallet,
          ensurePrivateReady: async () => {
            f.clock.now = startedAt + 2 * 60_000
          },
        }
      }
      const failure = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      ).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        name: "CheckoutSparkOrganizerRoutingTimeoutError",
        diagnostic: {
          stage: "Opening the checkout wallet",
          elapsedMs: expect.any(Number),
          writerChecks: expect.any(Number),
          writerCheckMs: expect.any(Number),
        },
      })
      expect(invoiceRequests).toBe(0)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("measures delayed writer rechecks without exposing recovery data or extending the deadline", async () => {
    const f = await fixture(0)
    const decrypt = f.organizerSigner.decryptNip44.bind(f.organizerSigner)
    try {
      f.organizerSigner.decryptNip44 = async (...args) => {
        const result = await decrypt(...args)
        f.clock.now += 4_000
        return result
      }
      const failure = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CheckoutSparkOrganizerRoutingTimeoutError)
      if (!(failure instanceof CheckoutSparkOrganizerRoutingTimeoutError))
        throw new Error("Expected the bounded recovery timeout")
      expect(failure.diagnostic.elapsedMs).toBeGreaterThanOrEqual(120_000)
      expect(failure.diagnostic.writerChecks).toBeGreaterThan(1)
      expect(failure.diagnostic.writerCheckMs).toBeGreaterThan(80_000)
      expect(Object.keys(failure.diagnostic).sort()).toEqual([
        "completedWorkflowSteps",
        "elapsedMs",
        "lastNativeObservation",
        "lastNativePreflight",
        "lastNativeSend",
        "lastPayoutObservation",
        "lastProgressAck",
        "lastRecipientObservation",
        "lastWorkflowOutcome",
        "lastWorkflowWaitReason",
        "scheduledBackoffMs",
        "stage",
        "writerCheckMs",
        "writerChecks",
      ])
      expect(Object.isFrozen(failure.diagnostic)).toBe(true)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      f.organizerSigner.decryptNip44 = decrypt
      await f.cleanup()
    }
  }, 60_000)

  it("retains an exact payout lookup verdict when the following writer check times out", async () => {
    const f = await fixture(0)
    const decrypt = f.organizerSigner.decryptNip44.bind(f.organizerSigner)
    try {
      await importBuyerPreparedOrganizerIntent(f, { possibleSend: true })
      const startedAt = f.clock.now
      const controls = { observed: false }
      const openWallet = f.dependencies.openWallet
      f.dependencies.openWallet = async (input) => ({
        ...(await openWallet(input)),
        getTransferFromSsp: async () => {
          controls.observed = true
          throw new Error("Controlled lookup unavailable")
        },
      })
      f.organizerSigner.decryptNip44 = async (...args) => {
        const result = await decrypt(...args)
        if (controls.observed) f.clock.now = startedAt + 120_000
        return result
      }
      const failure = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      ).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        name: "CheckoutSparkOrganizerRoutingTimeoutError",
        diagnostic: { lastPayoutObservation: "lookup_unavailable" },
      })
      expect(controls.observed).toBe(true)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      f.organizerSigner.decryptNip44 = decrypt
      await f.cleanup()
    }
  }, 60_000)

  it("distinguishes paid exact history from an unsettled recipient before a later writer timeout", async () => {
    const f = await fixture(0)
    const decrypt = f.organizerSigner.decryptNip44.bind(f.organizerSigner)
    try {
      const startedAt = f.clock.now
      const controls = { observed: false }
      const fetchVerify = f.dependencies.receiverDependencies.fetchVerify
      f.dependencies.receiverDependencies.fetchVerify = async (url) => {
        const result = await fetchVerify(url)
        if (f.observations.lightning > 0) controls.observed = true
        return { ...result, settled: false, preimage: null }
      }
      f.organizerSigner.decryptNip44 = async (...args) => {
        const result = await decrypt(...args)
        if (controls.observed) f.clock.now = startedAt + 120_000
        return result
      }
      const failure = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      ).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        name: "CheckoutSparkOrganizerRoutingTimeoutError",
        diagnostic: {
          lastPayoutObservation: "paid",
          lastRecipientObservation: "verified_unsettled",
        },
      })
      expect(controls.observed).toBe(true)
      expect(f.observations).toEqual({ lightning: 1, native: 0 })
    } finally {
      f.organizerSigner.decryptNip44 = decrypt
      await f.cleanup()
    }
  }, 60_000)

  it.each(["accepted", "unavailable"] as const)(
    "retains the %s progress acknowledgment before a later writer timeout",
    async (ack) => {
      const f = await fixture(0)
      const decrypt = f.organizerSigner.decryptNip44.bind(f.organizerSigner)
      try {
        const startedAt = f.clock.now
        const controls = { observed: false }
        const publish = f.dependencies.progressTransport.publishFn
        f.transportHooks.failOnce = ack === "unavailable"
        f.dependencies.progressTransport.publishFn = async (event) => {
          const result = await publish(event)
          controls.observed = true
          return result
        }
        f.organizerSigner.decryptNip44 = async (...args) => {
          const result = await decrypt(...args)
          if (controls.observed) f.clock.now = startedAt + 120_000
          return result
        }
        const failure = await routeCheckoutSparkOrganizerOrder(
          f.session,
          f.dependencies
        ).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(
          CheckoutSparkOrganizerRoutingTimeoutError
        )
        if (!(failure instanceof CheckoutSparkOrganizerRoutingTimeoutError))
          throw new Error("Expected the bounded recovery timeout")
        expect(failure.diagnostic.lastProgressAck).toBe(ack)
        expect(controls.observed).toBe(true)
        expect(f.observations).toEqual({ lightning: 0, native: 0 })
      } finally {
        f.organizerSigner.decryptNip44 = decrypt
        await f.cleanup()
      }
    },
    60_000
  )

  it.each(["paid", "pending_sender"] as const)(
    "retains the exact native %s verdict independently of send acceptance at timeout",
    async (verdict) => {
      const f = await fixture(0)
      const decrypt = f.organizerSigner.decryptNip44.bind(f.organizerSigner)
      try {
        const startedAt = f.clock.now
        const controls = { observed: false }
        f.control.setNativeSenderCommitment(verdict === "paid")
        const openWallet = f.dependencies.openWallet
        f.dependencies.openWallet = async (input) => {
          const wallet = await openWallet(input)
          return {
            ...wallet,
            nativeTreasury: {
              ...wallet.nativeTreasury,
              inspectCheckoutTreasury: async (
                request: Parameters<
                  typeof wallet.nativeTreasury.inspectCheckoutTreasury
                >[0]
              ) => {
                const result =
                  await wallet.nativeTreasury.inspectCheckoutTreasury(request)
                if (f.observations.native > 0) controls.observed = true
                return result
              },
            },
          }
        }
        f.organizerSigner.decryptNip44 = async (...args) => {
          const result = await decrypt(...args)
          if (controls.observed) f.clock.now = startedAt + 120_000
          return result
        }
        const failure = await routeCheckoutSparkOrganizerOrder(
          f.session,
          f.dependencies
        ).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(
          CheckoutSparkOrganizerRoutingTimeoutError
        )
        if (!(failure instanceof CheckoutSparkOrganizerRoutingTimeoutError))
          throw new Error("Expected the bounded recovery timeout")
        expect(failure.diagnostic).toMatchObject({
          lastNativeObservation: verdict,
          lastNativePreflight: "ready",
          lastNativeSend: "submitted",
        })
        expect(f.observations).toEqual({ lightning: 1, native: 1 })
      } finally {
        f.organizerSigner.decryptNip44 = decrypt
        await f.cleanup()
      }
    },
    60_000
  )

  it("retains the completed workflow wait reason and scheduled backoff at the next authority timeout", async () => {
    const f = await fixture(0)
    try {
      await importBuyerPreparedOrganizerIntent(f, { possibleSend: true })
      const startedAt = f.clock.now
      const openWallet = f.dependencies.openWallet
      f.dependencies.openWallet = async (input) => ({
        ...(await openWallet(input)),
        getTransferFromSsp: async () => {
          throw new Error("Controlled lookup unavailable")
        },
      })
      const waits: number[] = []
      f.dependencies.wait = async (milliseconds) => {
        waits.push(milliseconds)
        f.clock.now = startedAt + 120_000
      }
      const failure = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CheckoutSparkOrganizerRoutingTimeoutError)
      if (!(failure instanceof CheckoutSparkOrganizerRoutingTimeoutError))
        throw new Error("Expected the bounded recovery timeout")
      expect(failure.diagnostic).toMatchObject({
        lastPayoutObservation: "lookup_unavailable",
        lastRecipientObservation: "not_observed",
        lastWorkflowOutcome: "wait",
        lastWorkflowWaitReason: "provider_evidence_unavailable",
        completedWorkflowSteps: 1,
        scheduledBackoffMs: 1_000,
      })
      expect(waits).toEqual([1_000])
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("adopts a pre-cutoff Buyer intent without bypassing unavailable fresh-device recipient proof or changing retry bytes", async () => {
    const f = await fixture(0)
    try {
      const buyer = await importBuyerPreparedOrganizerIntent(f)
      f.dependencies.receiverDependencies.fetchVerify = async () => {
        throw new Error("Controlled recipient verification is unavailable")
      }
      expect(buyer.state.updatedAt < f.plan.takeoverAt).toBe(true)
      expect(f.clock.now > f.plan.takeoverAt).toBe(true)
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("waiting")
      expect(result.reason).toBe("recipient_unverified")
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (saved.status !== "active")
        throw new Error("Expected retained recovery")
      expect(saved.state.updatedAt >= f.plan.takeoverAt).toBe(true)
      expect(
        JSON.stringify({ ...saved.state, updatedAt: buyer.state.updatedAt }) ===
          JSON.stringify(buyer.state)
      ).toBe(true)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
      const first = await f.database.checkoutSparkPlanBindings.get(
        f.plan.checkoutId
      )
      const firstSnapshots = JSON.stringify(first?.organizerProgressOutbox)
      const again = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(again.reason).toBe("recipient_unverified")
      const retained = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (retained.status !== "active")
        throw new Error("Expected retained recovery")
      expect(
        JSON.stringify(retained.state) === JSON.stringify(saved.state)
      ).toBe(true)
      const second = await f.database.checkoutSparkPlanBindings.get(
        f.plan.checkoutId
      )
      expect(
        JSON.stringify(second?.organizerProgressOutbox) === firstSnapshots
      ).toBe(true)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("automatically continues a cold Buyer-prepared unpaid invoice using its qualified portable receiver binding", async () => {
    const f = await fixture(0)
    try {
      const buyer = await importBuyerPreparedOrganizerIntent(f)
      let invoiceRequests = 0
      let recipientReads = 0
      const resolveInvoice = f.dependencies.resolveInvoice
      const fetchVerify = f.dependencies.receiverDependencies.fetchVerify
      f.dependencies.resolveInvoice = async (input) => {
        invoiceRequests++
        return resolveInvoice(input)
      }
      f.dependencies.receiverDependencies.fetchVerify = async (url) => {
        recipientReads++
        return fetchVerify(url)
      }
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("complete")
      expect(recipientReads).toBeGreaterThan(0)
      expect(invoiceRequests).toBe(0)
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (saved.status !== "active")
        throw new Error("Expected retained recovery")
      expect(
        JSON.stringify(saved.state.legs[0]!.intent) ===
          JSON.stringify(buyer.state.legs[0]!.intent)
      ).toBe(true)
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
      expect(
        (await routeCheckoutSparkOrganizerOrder(f.session, f.dependencies))
          .status
      ).toBe("complete")
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it("automatically completes a pre-cutoff Buyer intent with its actual same-device invoice origin and never pays it twice", async () => {
    const f = await fixture(0)
    try {
      const buyer = await importBuyerPreparedOrganizerIntent(f, {
        localOrigin: true,
      })
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("complete")
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (saved.status !== "active")
        throw new Error("Expected retained recovery")
      expect(
        JSON.stringify(saved.state.legs[0]!.intent) ===
          JSON.stringify(buyer.state.legs[0]!.intent)
      ).toBe(true)
      expect(saved.state.legs.every((leg) => leg.status === "paid")).toBe(true)
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
      expect(
        (await routeCheckoutSparkOrganizerOrder(f.session, f.dependencies))
          .status
      ).toBe("complete")
      expect(f.observations).toEqual({ lightning: 1, native: 1 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it.each(["unsupported", "conflicting"] as const)(
    "does not dispatch a cold prepared invoice with %s recipient evidence",
    async (kind) => {
      const f = await fixture(0)
      try {
        const buyer = await importBuyerPreparedOrganizerIntent(f)
        if (kind === "unsupported")
          f.dependencies.receiverDependencies.contracts = []
        else {
          const fetchVerify = f.dependencies.receiverDependencies.fetchVerify
          f.dependencies.receiverDependencies.fetchVerify = async (url) => ({
            ...(await fetchVerify(url)),
            pr: f.plan.funding.paymentRequest,
          })
        }
        const result = await routeCheckoutSparkOrganizerOrder(
          f.session,
          f.dependencies
        )
        expect(result.status).toBe("waiting")
        expect(result.reason).toBe("recipient_unverified")
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (saved.status !== "active")
          throw new Error("Expected retained recovery")
        expect(
          JSON.stringify(saved.state.legs) === JSON.stringify(buyer.state.legs)
        ).toBe(true)
        expect(f.observations).toEqual({ lightning: 0, native: 0 })
      } finally {
        await f.cleanup()
      }
    },
    60_000
  )

  it.each(["identity", "writer"] as const)(
    "stops %s revocation during cold recipient verification before dispatch",
    async (change) => {
      const f = await fixture(0)
      try {
        const buyer = await importBuyerPreparedOrganizerIntent(f)
        const fetchVerify = f.dependencies.receiverDependencies.fetchVerify
        let reads = 0
        f.dependencies.receiverDependencies.fetchVerify = async (url) => {
          const result = await fetchVerify(url)
          reads++
          if (change === "identity") f.clock.active = false
          else
            await f.database.eventMarketOrganizerStockPools
              .toCollection()
              .modify((pool) => {
                pool.readOnlyRecovery = true
              })
          return result
        }
        await expect(
          routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
        ).rejects.toThrow()
        expect(reads).toBe(1)
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (saved.status !== "active")
          throw new Error("Expected retained recovery")
        expect(
          JSON.stringify(saved.state.legs) === JSON.stringify(buyer.state.legs)
        ).toBe(true)
        expect(f.observations).toEqual({ lightning: 0, native: 0 })
      } finally {
        await f.cleanup()
      }
    },
    60_000
  )

  it("does not turn a pre-cutoff possible send into a new dispatch after metadata adoption", async () => {
    const f = await fixture(0)
    try {
      const buyer = await importBuyerPreparedOrganizerIntent(f, {
        possibleSend: true,
      })
      const result = await routeCheckoutSparkOrganizerOrder(
        f.session,
        f.dependencies
      )
      expect(result.status).toBe("waiting")
      expect(result.reason).toBe("prior_possible_send")
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (saved.status !== "active")
        throw new Error("Expected retained recovery")
      expect(
        JSON.stringify(saved.state.legs) === JSON.stringify(buyer.state.legs)
      ).toBe(true)
      expect(f.observations).toEqual({ lightning: 0, native: 0 })
    } finally {
      await f.cleanup()
    }
  }, 60_000)

  it.each(["session", "conflict"] as const)(
    "stops %s changes while adopting a pre-cutoff snapshot",
    async (change) => {
      const f = await fixture(0)
      try {
        await importBuyerPreparedOrganizerIntent(f)
        const save = f.repository.save.bind(f.repository)
        let intercepted = false
        f.repository.save = async (state, revision, assertCurrent) => {
          if (!intercepted) {
            intercepted = true
            if (change === "session") f.clock.active = false
            else {
              const prior = await f.repository.load(
                f.plan.checkoutId,
                f.plan.planDigest
              )
              if (prior.status !== "active")
                throw new Error("Expected retained recovery")
              await save(
                { ...prior.state, updatedAt: f.clock.now },
                prior.revision,
                () => {}
              )
            }
          }
          return save(state, revision, assertCurrent)
        }
        await expect(
          routeCheckoutSparkOrganizerOrder(f.session, f.dependencies)
        ).rejects.toThrow()
        expect(intercepted).toBe(true)
        expect(f.observations).toEqual({ lightning: 0, native: 0 })
      } finally {
        await f.cleanup()
      }
    },
    60_000
  )

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
