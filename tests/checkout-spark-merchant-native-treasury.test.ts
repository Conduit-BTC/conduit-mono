import { describe, expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { UUID } from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { ConduitDB } from "@conduit/core/db"
import {
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  createCheckoutSparkNativeTreasurySdkAdapter,
  createCheckoutSparkSettledRecoveryPayload,
  getNdk,
  parseCheckoutSparkMerchantProgressRumor,
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
  startMerchantCheckoutSparkReconciliation,
  type MerchantCheckoutSparkReconciliationSummary,
  type CheckoutSparkMerchantProgressPayload,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  continueMerchantCheckoutSparkNativeTreasury,
  type MerchantCheckoutSparkNativeTreasuryContinuationDependencies as Dependencies,
} from "../apps/merchant/src/lib/checkout-spark-native-treasury-continuation"
import { selectMerchantCheckoutSparkSignedNextPayout } from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import {
  proveMerchantCheckoutSparkNativeCommerce,
  type MerchantSparkRecoveryWallet,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { advanceMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  AT,
  nativeTreasuryFixture,
} from "./support/checkout-spark-native-treasury-fixture"
import { createInboxDeclarationFixtureEvidence } from "./helpers/inbox-declaration"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const INBOX = "wss://merchant.inbox.relay.dev"
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const WRAP_SECRET = generateSecretKey()
const BUYER = "f".repeat(64)
async function fixture(
  options: {
    restoredStatus?: "prepared" | "submitted" | "ambiguous"
    inspectionOnly?: boolean
    ackFailure?: number
    ambiguous?: boolean
    preflight?: "ready" | "fee_over_cap" | "unavailable"
    pendingUntilSenderCommitted?: boolean
    assertRecoveryCurrent?: () => void
  } = {}
) {
  const f = nativeTreasuryFixture(undefined, undefined, MERCHANT)
  const inboxEvidence = await createInboxDeclarationFixtureEvidence(
    finalizeEvent(
      {
        kind: 10_050,
        created_at: AT / 1_000,
        tags: [["relay", INBOX]],
        content: "",
      },
      MERCHANT_SECRET
    )
  )
  let state = f.state
  if (options.restoredStatus) {
    state = prepareCheckoutSparkNativeTreasury(state, {
      settlement: f.record,
      preparedAt: AT + 4,
    })
    if (options.restoredStatus !== "prepared") {
      state = recordCheckoutSparkNativeTreasuryStatus(state, {
        invoiceId: f.plan.nativeTreasury!.invoiceId,
        status: options.restoredStatus,
        observedAt: AT + 5,
      })
    }
  }
  const database = new ConduitDB(`merchant-native-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
    database
  )
  const witness = {
    schemaVersion: 1 as const,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    orderId: f.plan.orderId,
    rumorId: "9".repeat(64),
    contentHash: "8".repeat(64),
    checkoutId: f.plan.checkoutId,
    planDigest: f.plan.planDigest,
  }
  await repository.importMerchantOrderRecovery(state, witness, () => {})
  const binding = await database.checkoutSparkPlanBindings.get(
    f.plan.checkoutId
  )
  await database.checkoutSparkPlanBindings.put({
    ...binding!,
    merchantSettlement: f.record,
  })
  const payload = createCheckoutSparkSettledRecoveryPayload({
    state,
    senderPubkey: BUYER,
    mnemonic: crypto.randomUUID(),
    accountNumber: 0,
    preparedAt: AT + 6,
  })
  const selected: MerchantCheckoutSparkRecoveryCandidate = {
    wrapId: "7".repeat(64),
    schemaVersion: 2,
    checkoutId: f.plan.checkoutId,
    orderId: f.plan.orderId,
    planDigest: f.plan.planDigest,
    takeoverAt: f.plan.takeoverAt,
    preparedAt: payload.preparedAt,
  }
  const calls: string[] = []
  const progress: CheckoutSparkMerchantProgressPayload[] = []
  let sends = 0
  let publishes = 0
  let nativeInspections = 0
  let senderCommitted = !options.pendingUntilSenderCommitted
  let clock = f.plan.takeoverAt + 1
  const wallet: MerchantSparkRecoveryWallet = {
    ensurePrivateReady: async () => {
      calls.push("private")
    },
    getIdentityPublicKey: async () => f.plan.funding.receiverIdentityPublicKey,
    getLightningReceiveRequest: async () => null,
    getTransfer: async () => undefined,
    cleanup: async () => {
      calls.push("cleanup")
    },
    nativeTreasury: {
      inspectCheckoutTreasury: async (request) => {
        calls.push("inspect")
        nativeInspections += 1
        expect(request.nativeTreasury).toEqual(f.plan.nativeTreasury)
        expect(request.amountSats).toBe(112)
        if (options.pendingUntilSenderCommitted) {
          return senderCommitted
            ? {
                invoiceId: request.nativeTreasury.invoiceId,
                status: "paid",
                providerTransferId: "actual-native-provider-id",
                finalFeeSats: 0,
                finalDebitSats: 112,
              }
            : {
                invoiceId: request.nativeTreasury.invoiceId,
                status: "pending",
                providerTransferId: "actual-native-provider-id",
                pendingPhase: "sender",
              }
        }
        return sends && !options.ambiguous
          ? {
              invoiceId: request.nativeTreasury.invoiceId,
              status: "paid",
              providerTransferId: "actual-native-provider-id",
              finalFeeSats: 0,
              finalDebitSats: 112,
            }
          : { invoiceId: request.nativeTreasury.invoiceId, status: "not_found" }
      },
      preflightCheckoutTreasury: async () => {
        calls.push("preflight")
        return options.preflight ?? "ready"
      },
      sendCheckoutTreasury: async (request) => {
        await request.assertBeforeSend?.()
        expect(request.priorSendMayHaveOccurred).toBe(false)
        const local = await repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(
          local.status === "active" && local.state.treasuryFinalization!.status
        ).toBe("submitted")
        expect(
          progress
            .slice(0, 2)
            .map((item) => item.state.treasuryFinalization!.status)
        ).toEqual(["prepared", "submitted"])
        expect(publishes).toBeGreaterThanOrEqual(2)
        sends++
        calls.push("send")
        return { status: options.ambiguous ? "ambiguous" : "submitted" }
      },
    },
  }
  const dependencies: Dependencies = {
    repository,
    progressStore,
    signer: plainTestSigner({
      user: async () => new NDKUser({ pubkey: MERCHANT }),
    } as NDKSigner as never),
    now: () => clock++,
    inspectionOnly: options.inspectionOnly,
    lockManager: null,
    requireCrossTabLock: false,
    assertDispatchPlan: () => {},
    deriveIdentity: async () => f.plan.funding.receiverIdentityPublicKey,
    proveCommerce: async () => {
      calls.push("commerce-proof")
      return f.record
    },
    openWallet: async (input) => {
      expect(input.outgoing).toBe(true)
      calls.push("open")
      return wallet
    },
    consumeRecovery: async (_principal, candidate, adapter) => {
      await adapter.consume(
        payload,
        options.assertRecoveryCurrent ?? (() => {})
      )
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate,
      }
    },
    progressTransport: {
      recipientInboxRelays: [INBOX],
      inboxDeclarationEvidenceRepository: inboxEvidence,
      accountNetworkLocalStateRepository: { get: async () => undefined },
      giftWrapFn: (async (rumor, recipient) => {
        progress.push(parseCheckoutSparkMerchantProgressRumor(rumor))
        const local = await repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(local.status === "active" && local.state).toEqual(
          progress.at(-1)!.state
        )
        expect(rumor.content).not.toContain(payload.wallet.mnemonic)
        return new NDKEvent(
          getNdk(),
          finalizeEvent(
            {
              kind: 1059,
              created_at: AT / 1000,
              tags: [["p", recipient.pubkey]],
              content: `synthetic-opaque-native-wrap-${progress.length}`,
            },
            WRAP_SECRET
          )
        )
      }) as NonNullable<Dependencies["progressTransport"]>["giftWrapFn"],
      publishFn: async (event) => {
        const staged = await progressStore.list(
          MERCHANT,
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(
          staged.some(
            ({ record }) => record.signedRecipientWrap.id === event.id
          )
        ).toBe(true)
        publishes++
        calls.push("ack")
        return {
          attemptedRelayUrls: [INBOX],
          successfulRelayUrls: publishes === options.ackFailure ? [] : [INBOX],
          failedRelayUrls: publishes === options.ackFailure ? [INBOX] : [],
          relayFailureMessages: {},
        }
      },
    },
  }
  return {
    ...f,
    state,
    database,
    repository,
    selected,
    dependencies,
    calls,
    progress,
    sends: () => sends,
    nativeInspections: () => nativeInspections,
    commitNativeSender: () => {
      senderCommitted = true
    },
    run: () =>
      continueMerchantCheckoutSparkNativeTreasury(
        MERCHANT,
        selected,
        dependencies
      ),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let step = 0; step < 12; step += 1) await Promise.resolve()
}

function fakeClock(start: number) {
  let time = start
  const timers: Array<{
    at: number
    callback: () => void
    cancelled: boolean
  }> = []
  return {
    now: () => time,
    schedule(callback: () => void, delayMs: number) {
      const timer = { at: time + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    nextDelay() {
      const next = timers
        .filter((timer) => !timer.cancelled)
        .sort((left, right) => left.at - right.at)[0]
      return next ? next.at - time : null
    },
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = timers
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0]
        if (!next) break
        time = next.at
        next.cancelled = true
        next.callback()
        await flush()
      }
      time = end
      await flush()
    },
  }
}

describe("Merchant native treasury continuation", () => {
  it("pre-wallet admission classification: Merchant transient local read does not enter wallet", async () => {
    const f = await fixture()
    const load = f.repository.load.bind(f.repository)
    const proveCommerce = f.dependencies.proveCommerce!
    const openWallet = f.dependencies.openWallet!
    let readsAfterSubmittedProof: number | null = null
    let failedRead = false
    let walletCalls = 0
    f.dependencies.proveCommerce = async (input) => {
      const settlement = await proveCommerce(input)
      if (
        input.state.treasuryFinalization?.status === "submitted" &&
        readsAfterSubmittedProof === null
      )
        readsAfterSubmittedProof = 0
      return settlement
    }
    f.repository.load = async (...args) => {
      if (!failedRead && readsAfterSubmittedProof !== null) {
        readsAfterSubmittedProof++
        // Core's final store read performs the adapter's durable comparison
        // and snapshot read. Fail only the next read: the provider adapter's
        // own pre-wallet durable check. No stored data or payment input changes.
        if (readsAfterSubmittedProof === 3) {
          failedRead = true
          throw new Error("Temporary local read unavailable")
        }
      }
      return load(...args)
    }
    f.dependencies.openWallet = async (input) => {
      const wallet = await openWallet(input)
      const treasury = wallet.nativeTreasury!
      return {
        ...wallet,
        nativeTreasury: {
          ...treasury,
          sendCheckoutTreasury: async (request) => {
            walletCalls++
            return treasury.sendCheckoutTreasury(request)
          },
        },
      }
    }
    try {
      const result = await f.run()
      expect(failedRead).toBe(true)
      expect(readsAfterSubmittedProof).toBe(3)
      expect(walletCalls).toBe(0)
      expect(f.sends()).toBe(0)
      expect(
        f.progress.map((item) => item.state.treasuryFinalization!.status)
      ).toEqual(["prepared", "submitted"])
      expect(result.payout).toEqual({
        outcome: "wait",
        reason: "provider_evidence_unavailable",
        sendAttempted: false,
      })
      const saved = await load(f.plan.checkoutId, f.plan.planDigest)
      if (saved.status !== "active") throw new Error("Expected active")
      expect(saved.state.treasuryFinalization!.status).toBe("terminal_failure")
      expect(saved.state.treasuryFinalization!.providerTransferId).toBeNull()
      expect(
        JSON.stringify(saved.state.treasuryFinalization!.intent) ===
          JSON.stringify(f.progress.at(-1)!.state.treasuryFinalization!.intent)
      ).toBe(true)
    } finally {
      f.repository.load = load
      await f.database.delete()
    }
  }, 15_000)
  it.each(["pause", "logout", "account_replacement"] as const)(
    "retains an admitted native transfer reference only for an account-current %s before fulfillment returns",
    async (revocation) => {
      let accountCurrent = true
      const f = await fixture({
        assertRecoveryCurrent() {
          if (!accountCurrent) throw new Error("Recovery account changed")
        },
      })
      const entered = deferred()
      const release = deferred()
      const transferId = UUID.parse(crypto.randomUUID()).toString()
      let active = true
      let sends = 0
      let invoiceQueries = 0
      let transferReads = 0
      const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
        network: "MAINNET",
        read: (read) => read(),
        codec: {
          nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
          parseTransferId: UUID.parse,
          encodeSparkAddress: () => f.plan.nativeTreasury!.invoiceRequest,
          decodeSparkAddress: () => ({
            identityPublicKey: f.plan.nativeTreasury!.receiverIdentityPublicKey,
          }),
          isValidSparkAddress: () => true,
          getNetworkFromSparkAddress: () => "MAINNET",
        },
        wallet: {
          getIdentityPublicKey: async () =>
            f.plan.funding.receiverIdentityPublicKey,
          getBalance: async () => ({
            satsBalance: { available: 112n, owned: 112n, incoming: 0n },
          }),
          querySparkInvoices: async (invoices) => {
            invoiceQueries += 1
            return { invoiceStatuses: [{ invoice: invoices[0]!, status: 0 }] }
          },
          getTransfer: async () => {
            transferReads += 1
            return undefined
          },
          fulfillSparkInvoice: async (invoices) => {
            sends += 1
            entered.resolve()
            await release.promise
            return {
              satsTransactionSuccess: [
                {
                  invoice: invoices[0]!.invoice,
                  transferResponse: {
                    id: transferId,
                    type: "TRANSFER",
                    transferDirection: "OUTGOING",
                    status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
                    totalValue: 112,
                    valueSentByWallet: 112,
                    valueReceivedByWallet: 0,
                    sparkInvoice: f.plan.nativeTreasury!.invoiceRequest,
                    senders: [
                      {
                        identityPublicKey:
                          f.plan.nativeTreasury!.senderIdentityPublicKey,
                      },
                    ],
                    receivers: [
                      {
                        identityPublicKey:
                          f.plan.nativeTreasury!.receiverIdentityPublicKey,
                        amountSats: 112,
                        status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
                      },
                    ],
                  },
                },
              ],
              satsTransactionErrors: [],
              tokenTransactionSuccess: [],
              tokenTransactionErrors: [],
              invalidInvoices: [],
            }
          },
        },
      })
      const openWallet = f.dependencies.openWallet!
      f.dependencies.openWallet = async (input) => ({
        ...(await openWallet(input)),
        nativeTreasury: treasury,
      })
      f.dependencies.shouldContinue = () => active
      const work = f.run().catch(() => null)
      try {
        await entered.promise
        const admitted = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(
          admitted.status === "active" && admitted.state.treasuryFinalization
        ).toMatchObject({ status: "submitted", providerTransferId: null })
        expect(sends).toBe(1)
        const queriesBeforeRevocation = { invoiceQueries, transferReads }
        const progressBeforeRevocation = f.progress.length

        // Pause prevents new dispatch, not retention of this admitted response.
        active = false
        accountCurrent = revocation === "pause"
        release.resolve()
        await work
        expect(f.calls.at(-1)).toBe("cleanup")
        const drained = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (drained.status !== "active") throw new Error("Fixture missing")
        expect(drained.state.treasuryFinalization?.status).not.toBe("paid")
        expect(drained.state.treasuryFinalization?.finalFeeSats).toBeNull()
        expect(drained.state.treasuryFinalization?.finalDebitSats).toBeNull()
        expect(drained.state.treasuryFinalization?.providerTransferId).toBe(
          revocation === "pause" ? transferId : null
        )
        expect({ invoiceQueries, transferReads }).toEqual(
          queriesBeforeRevocation
        )
        expect(f.progress).toHaveLength(progressBeforeRevocation)
        expect(
          (
            await f.repository.loadMerchantSettlement(
              MERCHANT,
              f.plan.checkoutId,
              f.plan.planDigest
            )
          )?.nativeTreasury
        ).toBeNull()

        if (revocation !== "pause") return

        // A later fresh activation still reconciles the original possible send.
        active = true
        expect((await f.run()).payout).toMatchObject({
          reason: "provider_evidence_unavailable",
          sendAttempted: false,
        })
        expect(sends).toBe(1)
        expect(drained.state.plan).toEqual(f.plan)
        expect(drained.state.treasuryFinalization?.providerTransferId).toBe(
          transferId
        )
      } finally {
        release.resolve()
        await work
        await f.database.delete()
      }
    },
    15_000
  )

  it("completes a restored native fee on exact sender commitment without an online receiver or another send", async () => {
    const f = await fixture({ restoredStatus: "submitted" })
    const transferId = UUID.parse("0197f9a0-0000-7000-8000-000000000003")
    let sends = 0
    const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
      network: "MAINNET",
      read: (read) => read(),
      codec: {
        nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
        parseTransferId: UUID.parse,
        encodeSparkAddress: () => f.plan.nativeTreasury!.invoiceRequest,
        decodeSparkAddress: () => ({
          identityPublicKey: f.plan.nativeTreasury!.receiverIdentityPublicKey,
        }),
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => "MAINNET",
      },
      wallet: {
        getIdentityPublicKey: async () =>
          f.plan.funding.receiverIdentityPublicKey,
        getBalance: async () => {
          throw new Error("A prior send must be reconciled, not prepared again")
        },
        querySparkInvoices: async (invoices) => ({
          invoiceStatuses: [
            {
              invoice: invoices[0]!,
              status: 2,
              transferType: {
                $case: "satsTransfer" as const,
                satsTransfer: { transferId: transferId.bytes },
              },
            },
          ],
        }),
        getTransfer: async () => ({
          id: transferId.toString(),
          type: "TRANSFER",
          transferDirection: "OUTGOING",
          status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          totalValue: 112,
          valueSentByWallet: 112,
          valueReceivedByWallet: 0,
          sparkInvoice: f.plan.nativeTreasury!.invoiceRequest,
          senders: [
            {
              identityPublicKey: f.plan.nativeTreasury!.senderIdentityPublicKey,
            },
          ],
          receivers: [
            {
              identityPublicKey:
                f.plan.nativeTreasury!.receiverIdentityPublicKey,
              amountSats: 112,
              status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
            },
          ],
        }),
        fulfillSparkInvoice: async () => {
          sends += 1
          throw new Error("A restored committed transfer must never be resent")
        },
      },
    })
    const openWallet = f.dependencies.openWallet!
    f.dependencies.openWallet = async (input) => ({
      ...(await openWallet(input)),
      nativeTreasury: treasury,
    })
    try {
      expect((await f.run()).payout).toMatchObject({
        outcome: "paid",
        sendAttempted: false,
      })
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.treasuryFinalization
      ).toMatchObject({
        status: "paid",
        providerTransferId: transferId.toString(),
        finalFeeSats: 0,
        finalDebitSats: 112,
      })
      expect(
        await f.repository.loadMerchantSettlement(
          MERCHANT,
          f.plan.checkoutId,
          f.plan.planDigest
        )
      ).toMatchObject({
        nativeTreasury: {
          providerTransferId: transferId.toString(),
          finalFeeSats: 0,
          finalDebitSats: 112,
        },
      })
      expect((await f.run()).payout?.outcome).toBe("already_paid")
      expect(f.sends()).toBe(0)
      expect(sends).toBe(0)
      expect(saved.status).toBe("active")
    } finally {
      await f.database.delete()
    }
  }, 15_000)

  it("keeps native continuation and cleanup unchanged when finite progress observers fail", async () => {
    const f = await fixture()
    const phases: string[] = []
    let observations = 0
    f.dependencies.onObservation = (observation) => {
      phases.push(observation.phase)
      observations += 1
      if (observations % 2 === 0)
        return Promise.reject(new Error("Observer failed"))
      throw new Error("Observer failed")
    }
    f.dependencies.proveCommerce = async (input) => {
      input.onObservation?.({ phase: "funding_proof", status: "not_verified" })
      return f.record
    }
    try {
      expect((await f.run()).payout?.outcome).toBe("paid")
      expect(phases).toContain("recovery_delivery")
      expect(phases).toContain("wallet_open")
      expect(phases).toContain("privacy_readiness")
      expect(phases).toContain("funding_proof")
      expect(f.sends()).toBe(1)
      expect(f.calls.at(-1)).toBe("cleanup")
      await Promise.resolve()
    } finally {
      await f.database.delete()
    }
  })
  it("automatically keeps Merchant observation active after an unrecognized native response until exact sender commitment", async () => {
    const f = await fixture()
    const clock = fakeClock(f.plan.takeoverAt + 1)
    const transferId = UUID.parse(crypto.randomUUID())
    let phase: "unavailable" | "pending" | "committed" = "unavailable"
    let fulfills = 0
    const transfer = (status: string) => ({
      id: transferId.toString(),
      type: "TRANSFER",
      transferDirection: "OUTGOING",
      status,
      totalValue: 112,
      valueSentByWallet: 112,
      valueReceivedByWallet: 0,
      sparkInvoice: f.plan.nativeTreasury!.invoiceRequest,
      senders: [
        { identityPublicKey: f.plan.nativeTreasury!.senderIdentityPublicKey },
      ],
      receivers: [
        {
          identityPublicKey: f.plan.nativeTreasury!.receiverIdentityPublicKey,
          amountSats: 112,
          status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
        },
      ],
    })
    const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
      network: "MAINNET",
      read: (read) => read(),
      codec: {
        nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
        parseTransferId: UUID.parse,
        encodeSparkAddress: () => f.plan.nativeTreasury!.invoiceRequest,
        decodeSparkAddress: () => ({
          identityPublicKey: f.plan.nativeTreasury!.receiverIdentityPublicKey,
        }),
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => "MAINNET",
      },
      wallet: {
        getIdentityPublicKey: async () =>
          f.plan.funding.receiverIdentityPublicKey,
        getBalance: async () => ({
          satsBalance: { available: 112n, owned: 112n, incoming: 0n },
        }),
        querySparkInvoices: async (invoices) => {
          if (!fulfills)
            return { invoiceStatuses: [{ invoice: invoices[0]!, status: 0 }] }
          if (phase === "unavailable")
            throw new Error("Synthetic exact query unavailable")
          return {
            invoiceStatuses: [
              {
                invoice: invoices[0]!,
                status: phase === "committed" ? 2 : 1,
                transferType: {
                  $case: "satsTransfer" as const,
                  satsTransfer: { transferId: transferId.bytes },
                },
              },
            ],
          }
        },
        getTransfer: async () =>
          transfer(
            phase === "committed"
              ? "TRANSFER_STATUS_SENDER_KEY_TWEAKED"
              : "TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK"
          ),
        fulfillSparkInvoice: async (invoices) => {
          fulfills += 1
          return {
            satsTransactionSuccess: [
              {
                invoice: invoices[0]!.invoice,
                transferResponse: transfer("TRANSFER_STATUS_FUTURE"),
              },
            ],
            satsTransactionErrors: [],
            tokenTransactionSuccess: [],
            tokenTransactionErrors: [],
            invalidInvoices: [],
          }
        },
      },
    })
    const openWallet = f.dependencies.openWallet!
    f.dependencies.openWallet = async (input) => ({
      ...(await openWallet(input)),
      nativeTreasury: treasury,
    })
    const runs = [deferred(), deferred(), deferred()]
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    const results: Array<{
      outcome: string
      reason?: string
      sendAttempted: boolean
    }> = []
    let completedRuns = 0
    let commerceDispatches = 0
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: (candidate, assertCurrent) =>
        advanceMerchantCheckoutSparkOrder(MERCHANT, candidate, assertCurrent, {
          repository: f.repository,
          now: clock.now,
          notifySuppliers: () => {},
          checkCredit: async () => {
            throw new Error("Verified funding must not be repeated")
          },
          inspectPayouts: async () => ({
            status: "consumed" as const,
            coverage: "complete" as const,
            discoveryCoverage: "complete" as const,
            declarationState: "declared" as const,
            candidate,
            payoutHistory: {
              status: "inspected" as const,
              checkedLegs: 1,
              newlyConfirmedLegs: 0,
              unresolvedLegs: 0,
              withoutIntentLegs: 0,
              alreadyPaidLegs: 1,
            },
          }),
          selectPayout: (principal, selected, guard, dependencies) =>
            selectMerchantCheckoutSparkSignedNextPayout(
              principal,
              selected,
              guard,
              {
                ...dependencies,
                consumeRecovery: f.dependencies.consumeRecovery,
              }
            ),
          preparePayout: async () => {
            commerceDispatches += 1
            throw new Error("Paid commerce must not be prepared again")
          },
          continuePayout: async () => {
            commerceDispatches += 1
            throw new Error("Paid commerce must not be sent again")
          },
          continueNativeTreasury: (principal, selected, dependencies) =>
            continueMerchantCheckoutSparkNativeTreasury(principal, selected, {
              ...f.dependencies,
              ...dependencies,
              repository: f.repository,
              now: clock.now,
            }),
          onPayoutObservation: (result) => results.push(result),
          requestRescan: () => {},
        }),
      onUpdate(summary) {
        updates.push(summary)
        if (summary.checking || summary.lastCheckedAt === null) return
        runs[completedRuns++]?.resolve()
      },
    })
    const load = async () => {
      const snapshot = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      if (snapshot.status !== "active") throw new Error("Missing fixture")
      return snapshot.state.treasuryFinalization!
    }
    try {
      worker.replaceCandidates([f.selected])
      await clock.advance(0)
      await runs[0]!.promise
      const admitted = await load()
      expect(results[0]).toEqual({
        outcome: "send_ambiguous",
        reason: "native_unrecognized_result",
        sendAttempted: true,
      })
      expect(admitted.status).toBe("submitted")
      expect(admitted.providerTransferId).toBeNull()
      expect(admitted.finalFeeSats).toBeNull()
      expect(admitted.finalDebitSats).toBeNull()
      // This existing display classification is not terminal to the worker.
      expect(updates.at(-1)?.counts.needs_attention).toBe(1)
      expect(clock.nextDelay()).toBe(30_000)

      phase = "pending"
      await clock.advance(30_000)
      await runs[1]!.promise
      const pending = await load()
      expect(pending.status).toBe("ambiguous")
      expect(pending.intent).toEqual(admitted.intent)
      expect(pending.providerTransferId).toBe(transferId.toString())
      expect(pending.finalFeeSats).toBeNull()
      expect(pending.finalDebitSats).toBeNull()
      expect(results[1]?.reason).toBe("prior_possible_send")
      expect(clock.nextDelay()).toBe(60_000)

      phase = "committed"
      await clock.advance(60_000)
      await runs[2]!.promise
      const paid = await load()
      expect(paid).toMatchObject({
        status: "paid",
        providerTransferId: transferId.toString(),
        finalFeeSats: 0,
        finalDebitSats: 112,
      })
      expect(paid.intent).toEqual(admitted.intent)
      expect(results[2]?.outcome).toBe("paid")
      expect(fulfills).toBe(1)
      expect(commerceDispatches).toBe(0)
      expect(
        (
          await f.repository.loadMerchantSettlement(
            MERCHANT,
            f.plan.checkoutId,
            f.plan.planDigest
          )
        )?.nativeTreasury?.providerTransferId
      ).toBe(transferId.toString())
    } finally {
      await worker.stopAndDrain()
      await f.database.delete()
    }
  }, 15_000)

  it("automatically rechecks the same pending native fee until sender commitment without requiring a receiver claim", async () => {
    const f = await fixture({
      restoredStatus: "submitted",
      pendingUntilSenderCommitted: true,
    })
    const clock = fakeClock(f.plan.takeoverAt + 1)
    const firstRun = deferred()
    const secondRun = deferred()
    const updates: MerchantCheckoutSparkReconciliationSummary[] = []
    let completedRuns = 0
    let rescans = 0
    let fundingChecks = 0
    let lightningPreparations = 0
    let lightningContinuations = 0
    const consumed = {
      status: "consumed" as const,
      coverage: "complete" as const,
      discoveryCoverage: "complete" as const,
      declarationState: "declared" as const,
      candidate: f.selected,
    }
    const worker = startMerchantCheckoutSparkReconciliation({
      now: clock.now,
      schedule: clock.schedule,
      reconcile: (candidate, assertCurrent) =>
        advanceMerchantCheckoutSparkOrder(MERCHANT, candidate, assertCurrent, {
          repository: f.repository,
          now: clock.now,
          notifySuppliers: () => {},
          checkCredit: async () => {
            fundingChecks += 1
            throw new Error("Verified funding must not be repeated")
          },
          inspectPayouts: async () => ({
            ...consumed,
            candidate,
            payoutHistory: {
              status: "inspected" as const,
              checkedLegs: 1,
              newlyConfirmedLegs: 0,
              unresolvedLegs: 0,
              withoutIntentLegs: 0,
              alreadyPaidLegs: 1,
            },
          }),
          selectPayout: (principal, selected, guard, dependencies) =>
            selectMerchantCheckoutSparkSignedNextPayout(
              principal,
              selected,
              guard,
              {
                ...dependencies,
                consumeRecovery: f.dependencies.consumeRecovery,
              }
            ),
          preparePayout: async () => {
            lightningPreparations += 1
            throw new Error("Paid commerce must not be prepared again")
          },
          continuePayout: async () => {
            lightningContinuations += 1
            throw new Error("Paid commerce must not be sent again")
          },
          continueNativeTreasury: (principal, selected, dependencies) =>
            continueMerchantCheckoutSparkNativeTreasury(principal, selected, {
              ...f.dependencies,
              ...dependencies,
              repository: f.repository,
              now: clock.now,
            }),
          requestRescan: () => {
            rescans += 1
          },
        }),
      onUpdate(summary) {
        updates.push(summary)
        if (summary.checking || summary.lastCheckedAt === null) return
        completedRuns += 1
        if (completedRuns === 1) firstRun.resolve()
        if (completedRuns === 2) secondRun.resolve()
      },
    })
    try {
      worker.replaceCandidates([f.selected])
      await clock.advance(0)
      await firstRun.promise

      const pending = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        pending.status === "active" &&
          pending.state.treasuryFinalization?.status
      ).toBe("ambiguous")
      expect(f.nativeInspections()).toBe(1)
      expect(f.sends()).toBe(0)
      expect(rescans).toBe(1)
      expect(clock.nextDelay()).toBe(30_000)

      f.commitNativeSender()
      await clock.advance(30_000)
      await secondRun.promise

      const completed = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        completed.status === "active" && completed.state.treasuryFinalization
      ).toMatchObject({
        status: "paid",
        providerTransferId: "actual-native-provider-id",
        finalFeeSats: 0,
        finalDebitSats: 112,
      })
      expect(
        await f.repository.loadMerchantSettlement(
          MERCHANT,
          f.plan.checkoutId,
          f.plan.planDigest
        )
      ).toMatchObject({
        nativeTreasury: {
          providerTransferId: "actual-native-provider-id",
          finalFeeSats: 0,
          finalDebitSats: 112,
        },
      })
      expect(f.nativeInspections()).toBe(2)
      expect(f.sends()).toBe(0)
      expect(rescans).toBe(2)
      expect(fundingChecks).toBe(0)
      expect(lightningPreparations).toBe(0)
      expect(lightningContinuations).toBe(0)
      expect(updates.at(-1)?.counts.progress_pending).toBe(1)
    } finally {
      await worker.stopAndDrain()
      await f.database.delete()
    }
  }, 15_000)

  it("keeps a restored prepared request query-only when terminal-state repair lacks exact readback", async () => {
    const f = await fixture({
      restoredStatus: "prepared",
      inspectionOnly: true,
    })
    try {
      const result = await f.run()
      expect(result.payout).toMatchObject({
        outcome: "wait",
        reason: "inspection_only",
        sendAttempted: false,
      })
      expect(f.calls.filter((call) => call === "inspect")).toHaveLength(1)
      expect(f.calls).not.toContain("preflight")
      expect(f.calls).not.toContain("ack")
      expect(f.calls).toContain("cleanup")
      expect(f.progress).toHaveLength(0)
      expect(f.sends()).toBe(0)
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(saved.status === "active" && saved.state).toEqual(f.state)
    } finally {
      await f.database.delete()
    }
  })

  it("selects native finalization before any Lightning review or invoice preparation", async () => {
    const f = await fixture()
    try {
      expect(
        await selectMerchantCheckoutSparkSignedNextPayout(
          MERCHANT,
          f.selected,
          () => {},
          f.dependencies
        )
      ).toEqual({ status: "native_treasury" })
      expect(f.calls).not.toContain("open")
      expect(f.sends()).toBe(0)
    } finally {
      await f.database.delete()
    }
  })
  // Three cryptographic progress ACKs are a multi-step integration harness.
  it("ACKs durable prepared/submitted native snapshots and retains exact provider receipt", async () => {
    const f = await fixture()
    try {
      expect((await f.run()).payout).toMatchObject({
        outcome: "paid",
        sendAttempted: true,
      })
      expect(f.sends()).toBe(1)
      expect(
        f.calls
          .slice(0, f.calls.indexOf("send"))
          .filter((call) => call === "ack")
      ).toHaveLength(2)
      const record = await f.repository.loadMerchantSettlement(
        MERCHANT,
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(record!.nativeTreasury).toMatchObject({
        providerTransferId: "actual-native-provider-id",
        principalSats: 112,
        unusedCommerceReserveSats: 1,
      })
      expect(
        f.progress.every(
          (item) =>
            item.schemaVersion === 3 && item.state.legs[1]!.intent === null
        )
      ).toBe(true)
      expect(f.calls.at(-1)).toBe("cleanup")
    } finally {
      await f.database.delete()
    }
  }, 15_000)
  it.each([1, 2])(
    "does not send when native recovery snapshot ACK %s fails",
    async (ackFailure) => {
      const f = await fixture({ ackFailure })
      const checkpoints: unknown[] = []
      f.dependencies.onObservation = (observation) => {
        const checkpoint = Object.getOwnPropertyDescriptor(
          observation,
          "recoveryCheckpoint"
        )?.value
        if (checkpoint !== undefined) checkpoints.push(checkpoint)
      }
      try {
        expect((await f.run()).payout).toMatchObject({
          reason: "recovery_handoff_unavailable",
          sendAttempted: false,
        })
        expect(f.sends()).toBe(0)
        expect(f.calls.at(-1)).toBe("cleanup")
        expect(checkpoints.at(-1)).toBe(
          ackFailure === 1 ? "prepared_snapshot" : "submitted_snapshot"
        )
      } finally {
        await f.database.delete()
      }
    }
  )
  it("distinguishes a saved progress retry and recovers its exact ACK before one native send", async () => {
    const f = await fixture({ ackFailure: 1 })
    const checkpoints: unknown[] = []
    f.dependencies.onObservation = (observation) => {
      const checkpoint = Object.getOwnPropertyDescriptor(
        observation,
        "recoveryCheckpoint"
      )?.value
      if (checkpoint !== undefined) checkpoints.push(checkpoint)
    }
    try {
      expect((await f.run()).payout).toMatchObject({
        reason: "recovery_handoff_unavailable",
        sendAttempted: false,
      })
      expect(checkpoints.at(-1)).toBe("prepared_snapshot")
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") throw new Error("Expected active fixture")
      const intent = saved.state.treasuryFinalization!.intent
      const staged = await f.dependencies.progressStore!.list(
        MERCHANT,
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(staged).toHaveLength(1)
      expect(staged[0]!.relayAccepted).toBe(false)
      const publish = f.dependencies.progressTransport!.publishFn!
      f.dependencies.progressTransport!.publishFn = async (...args) => {
        const delivery = await publish(...args)
        return {
          ...delivery,
          successfulRelayUrls: [],
          failedRelayUrls: [INBOX],
        }
      }
      checkpoints.length = 0
      f.calls.length = 0
      expect((await f.run()).payout).toMatchObject({
        reason: "recovery_handoff_unavailable",
        sendAttempted: false,
      })
      expect(checkpoints).toEqual(["saved_progress"])
      expect(f.calls).not.toContain("open")
      expect(f.progress).toHaveLength(1)
      expect(f.sends()).toBe(0)
      expect(
        (
          await f.dependencies.progressStore!.list(
            MERCHANT,
            f.plan.checkoutId,
            f.plan.planDigest
          )
        )[0]!.record
      ).toEqual(staged[0]!.record)
      f.dependencies.progressTransport!.publishFn = publish
      expect((await f.run()).payout?.outcome).toBe("paid")
      expect(f.sends()).toBe(1)
      const paid = await f.repository.load(f.plan.checkoutId, f.plan.planDigest)
      expect(
        paid.status === "active" && paid.state.treasuryFinalization!.intent
      ).toEqual(intent)
      expect((await f.run()).payout?.outcome).toBe("already_paid")
      expect(f.sends()).toBe(1)
    } finally {
      await f.database.delete()
    }
  }, 15_000)
  it("queries only after an ambiguous send and NOT_FOUND, including another continuation", async () => {
    const f = await fixture({ ambiguous: true })
    try {
      expect((await f.run()).payout?.outcome).toBe("send_ambiguous")
      expect(f.sends()).toBe(1)
      expect((await f.run()).payout).toMatchObject({
        reason: "prior_possible_send",
        sendAttempted: false,
      })
      expect(f.sends()).toBe(1)
    } finally {
      await f.database.delete()
    }
  })
  it.each(["submitted", "ambiguous"] as const)(
    "never re-admits an imported %s snapshot",
    async (restoredStatus) => {
      const f = await fixture({ restoredStatus })
      try {
        expect((await f.run()).payout).toMatchObject({
          reason: "prior_possible_send",
          sendAttempted: false,
        })
        expect(f.calls).toContain("inspect")
        expect(f.calls).not.toContain("preflight")
        expect(f.calls).not.toContain("send")
        expect(f.sends()).toBe(0)
      } finally {
        await f.database.delete()
      }
    }
  )
  it.each(["fee_over_cap", "unavailable"] as const)(
    "blocks unsupported provider preflight %s",
    async (preflight) => {
      const f = await fixture({ preflight })
      try {
        await f.run()
        expect(f.sends()).toBe(0)
        expect(f.calls.at(-1)).toBe("cleanup")
      } finally {
        await f.database.delete()
      }
    }
  )
  it("requires current signer and authenticated order before opening a wallet", async () => {
    const f = await fixture()
    try {
      f.dependencies.signer = null
      await expect(f.run()).rejects.toThrow()
      expect(f.calls).not.toContain("open")
      f.dependencies.signer = plainTestSigner({
        user: async () => new NDKUser({ pubkey: MERCHANT }),
      } as NDKSigner as never)
      f.dependencies.repository = {
        ...f.dependencies.repository!,
        loadMerchantOrderWitness: async () => null,
      } as NonNullable<Dependencies["repository"]>
      await expect(f.run()).rejects.toThrow()
      expect(f.calls).not.toContain("open")
    } finally {
      await f.database.delete()
    }
  })
  it("stops at the frozen treasury policy gate before deriving or opening a wallet", async () => {
    const f = await fixture()
    try {
      f.dependencies.assertDispatchPlan = () => {
        throw new Error("Unapproved treasury destination")
      }
      await expect(f.run()).rejects.toThrow()
      expect(f.calls).not.toContain("open")
      expect(f.sends()).toBe(0)
    } finally {
      await f.database.delete()
    }
  })
  it("vetoes unknown activity discovered at the final guarded SDK invoice query", async () => {
    const f = await fixture()
    const commerce = await commerceProofFixture(f)
    let queries = 0
    let fulfills = 0
    const treasury = createCheckoutSparkNativeTreasurySdkAdapter({
      network: "MAINNET",
      read: (read) => read(),
      codec: {
        nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
        parseTransferId: UUID.parse,
        encodeSparkAddress: () => f.plan.nativeTreasury!.invoiceRequest,
        decodeSparkAddress: () => ({
          identityPublicKey: f.plan.nativeTreasury!.receiverIdentityPublicKey,
        }),
        isValidSparkAddress: () => true,
        getNetworkFromSparkAddress: () => "MAINNET",
      },
      wallet: {
        getIdentityPublicKey: async () =>
          f.plan.funding.receiverIdentityPublicKey,
        getBalance: async () => ({
          satsBalance: { available: 112n, owned: 112n, incoming: 0n },
        }),
        getTransfer: async () => undefined,
        querySparkInvoices: async (invoices) => {
          if (++queries === 2)
            commerce.transfers.push({
              id: "last-moment-unknown",
              type: 1,
              status: 5,
              network: 1,
              totalValue: 1,
            })
          return {
            invoiceStatuses: [{ invoice: invoices[0]!, status: 0 }],
          }
        },
        fulfillSparkInvoice: async () => {
          fulfills += 1
        },
      },
    })
    const originalOpen = f.dependencies.openWallet!
    f.dependencies.openWallet = async (input) => ({
      ...(await originalOpen(input)),
      nativeTreasury: treasury,
    })
    f.dependencies.proveCommerce = async () =>
      proveMerchantCheckoutSparkNativeCommerce(commerce.input)
    try {
      expect((await f.run()).payout).toMatchObject({
        outcome: "wait",
        reason: "provider_evidence_unavailable",
        sendAttempted: false,
      })
      expect(queries).toBe(2)
      expect(fulfills).toBe(0)
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.treasuryFinalization!.status
      ).toBe("terminal_failure")
      expect((await f.run()).payout).toMatchObject({
        outcome: "wait",
        reason: "provider_evidence_unavailable",
        sendAttempted: false,
      })
      expect(fulfills).toBe(0)
    } finally {
      await f.database.delete()
    }
  }, 15_000)
})

async function commerceProofFixture(f = nativeTreasuryFixture()) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(32).fill(7))
  )
  const paymentHash = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  const leg = f.state.legs[0]!
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${leg.intent!.invoiceAmountSats * 10}n`,
    createdAt: AT / 1000,
    fields: [
      bolt11PaymentHashField(hash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const state = {
    ...f.state,
    legs: f.state.legs.map((item, index) =>
      index
        ? item
        : { ...item, intent: { ...item.intent!, paymentRequest, paymentHash } }
    ),
  }
  const request = {
    typename: "LightningSendRequest",
    id: "exact-commerce-request",
    status: "LIGHTNING_PAYMENT_SUCCEEDED",
    fee: { originalValue: 4, originalUnit: "SATOSHI" },
    encodedInvoice: paymentRequest,
    idempotencyKey: leg.intent!.transferId,
    paymentPreimage: "07".repeat(32),
  }
  const transfers = ["attributed-credit", leg.intent!.transferId].map((id) => ({
    id,
    type: 0,
    status: 5,
    network: 1,
    totalValue: 100,
  }))
  const calls: string[] = []
  const wallet: MerchantSparkRecoveryWallet = {
    ensurePrivateReady: async () => {},
    cleanup: async () => {},
    getIdentityPublicKey: async () => f.plan.funding.receiverIdentityPublicKey,
    getLightningReceiveRequest: async () => ({
      id: f.plan.funding.requestId,
      status: "TRANSFER_COMPLETED",
      network: "MAINNET",
      invoice: {
        encodedInvoice: f.plan.funding.paymentRequest,
        paymentHash: f.plan.funding.paymentHash,
        bitcoinNetwork: "MAINNET",
        amount: { originalValue: 1113, originalUnit: "SATOSHI" },
      },
      transfer: {
        sparkId: "attributed-credit",
        userRequestId: f.plan.funding.requestId,
        totalAmount: { originalValue: 1111, originalUnit: "SATOSHI" },
      },
    }),
    getTransfer: async (id) => ({
      id,
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 1111,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
      userRequest: { id: f.plan.funding.requestId },
    }),
    getTransferFromSsp: async (id) => ({
      sparkId: id,
      totalAmount: { originalValue: 999, originalUnit: "SATOSHI" },
      userRequest: request,
    }),
    getLightningSendRequest: async () => request,
    openRetirementReader: async () => ({
      sparkAddress: "synthetic-checkout-address",
      reader: {
        getTransfers: async () => ({ transfers, offset: -1 }),
        getAvailableBalance: async () => 112n,
        getOwnedBalance: async () => 112n,
        getPendingTransfers: async () => [],
      },
    }),
  }
  const repository: Parameters<
    typeof proveMerchantCheckoutSparkNativeCommerce
  >[0]["repository"] = {
    recordMerchantCredit: async () => {
      calls.push("credit")
      return f.record
    },
    recordMerchantPayout: async () => {
      calls.push("commerce")
      return f.record
    },
    loadMerchantSettlement: async () => f.record,
    assertLocalInvoiceOrigin: async () => {
      calls.push("recipient")
    },
  }
  const input = {
    state,
    wallet,
    repository,
    now: () => AT + 100_000,
    assertCurrent: () => {},
  }
  return { ...f, input, calls, transfers, wallet, repository }
}

describe("Merchant native treasury fresh commerce proof", () => {
  it("requires exact credited funding, recipient proof and actual commerce debit before history scope", async () => {
    const f = await commerceProofFixture()
    expect(await proveMerchantCheckoutSparkNativeCommerce(f.input)).toEqual(
      f.record
    )
    expect(f.calls).toEqual(["credit", "recipient", "commerce"])
  })
  it("does not include unattributed deposits even if available funds equal the intended debit", async () => {
    const f = await commerceProofFixture()
    f.transfers.push({
      id: "unrelated-deposit",
      type: 0,
      status: 5,
      network: 1,
      totalValue: 1,
    })
    await expect(
      proveMerchantCheckoutSparkNativeCommerce(f.input)
    ).rejects.toThrow()
  })
  it("keeps exact receipt proof independent of residual wallet funds without authorizing another send", async () => {
    const f = await commerceProofFixture()
    f.transfers.push({
      id: "unrelated-deposit-after-native-send",
      type: 0,
      status: 5,
      network: 1,
      totalValue: 1,
    })
    f.wallet.openRetirementReader = async () => {
      throw new Error("Receipt proof must not read wallet ownership")
    }
    expect(
      await proveMerchantCheckoutSparkNativeCommerce({
        ...f.input,
        proofMode: "receipt",
      })
    ).toEqual(f.record)
    expect(f.calls).toEqual(["credit", "recipient", "commerce"])
    await expect(
      proveMerchantCheckoutSparkNativeCommerce(f.input)
    ).rejects.toThrow("Receipt proof must not read wallet ownership")
  })
  it("still requires exact funding and recipient evidence when reconciling a native receipt", async () => {
    const funding = await commerceProofFixture()
    funding.wallet.getLightningReceiveRequest = async () => null
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...funding.input,
        proofMode: "receipt",
      })
    ).rejects.toThrow()
    expect(funding.calls).toEqual([])

    const recipient = await commerceProofFixture()
    recipient.repository.assertLocalInvoiceOrigin = async () => {
      throw new Error("Recipient origin missing")
    }
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...recipient.input,
        proofMode: "receipt",
      })
    ).rejects.toThrow("Recipient origin missing")
    expect(recipient.calls).not.toContain("commerce")
  })
  it("does not trust paid signed metadata when provider or recipient evidence is unavailable", async () => {
    const f = await commerceProofFixture()
    f.wallet.getLightningSendRequest = async () => null
    await expect(
      proveMerchantCheckoutSparkNativeCommerce(f.input)
    ).rejects.toThrow()
    const g = await commerceProofFixture()
    g.repository.assertLocalInvoiceOrigin = async () => {
      throw new Error("Recipient origin missing")
    }
    await expect(
      proveMerchantCheckoutSparkNativeCommerce(g.input)
    ).rejects.toThrow()
    expect(g.calls).not.toContain("commerce")
  })
})
