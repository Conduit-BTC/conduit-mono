import { describe, expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent } from "nostr-tools"
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
import { plainTestSigner } from "./helpers/plain-signer"
import {
  AT,
  MERCHANT,
  nativeTreasuryFixture,
} from "./support/checkout-spark-native-treasury-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const INBOX = "wss://merchant.inbox.relay.dev"
const BUYER = "f".repeat(64)
async function fixture(
  options: {
    restoredStatus?: "prepared" | "submitted" | "ambiguous"
    inspectionOnly?: boolean
    ackFailure?: number
    ambiguous?: boolean
    preflight?: "ready" | "fee_over_cap" | "unavailable"
  } = {}
) {
  const f = nativeTreasuryFixture()
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
        expect(request.nativeTreasury).toEqual(f.plan.nativeTreasury)
        expect(request.amountSats).toBe(112)
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
      await adapter.consume(payload, () => {})
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
            new Uint8Array(32).fill(12)
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
    run: () =>
      continueMerchantCheckoutSparkNativeTreasury(
        MERCHANT,
        selected,
        dependencies
      ),
  }
}

describe("Merchant native treasury continuation", () => {
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
      try {
        expect((await f.run()).payout).toMatchObject({
          reason: "recovery_handoff_unavailable",
          sendAttempted: false,
        })
        expect(f.sends()).toBe(0)
        expect(f.calls.at(-1)).toBe("cleanup")
      } finally {
        await f.database.delete()
      }
    }
  )
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
