import { describe, expect, it } from "bun:test"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import {
  adaptFirstPartySparkWallet,
  FirstPartySparkSdkFactory,
  prepareCheckoutTreasuryRequest,
  SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  type SparkNativeModule,
  type SparkNativeWallet,
} from "../apps/market/src/lib/spark-sdk"
import type {
  SparkCheckoutTreasuryInput,
  SparkCheckoutTreasurySendInput,
} from "../apps/market/src/lib/spark-wallet"
import { createCheckoutSparkNativeTreasurySdkAdapter } from "../packages/core/src/protocol/checkout-spark-treasury-sdk"

// Public points and synthetic requests only. No SDK wallet or network is opened.
const SENDER =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const RECEIVER = `03${SENDER.slice(2)}`
const INVOICE_ID = "0197f9a0-0000-5000-8000-000000000001"
const TRANSFER_ID = "0197f9a0-0000-7000-8000-000000000002"
const ADDRESS = encodeSparkAddress({
  identityPublicKey: RECEIVER,
  network: "MAINNET",
})
const unused = async (): Promise<never> => {
  throw new Error("Unexpected mock boundary.")
}

function module(overrides: Partial<SparkNativeModule> = {}): SparkNativeModule {
  return {
    eventNames: [],
    nativeTreasuryPolicy: SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
    parseTransferId: UUID.parse,
    encodeSparkAddress,
    decodeSparkAddress,
    isValidSparkAddress,
    getNetworkFromSparkAddress,
    isPreSendFeeCapError: () => false,
    inspectLightningReceiveQuote: () => {
      throw new Error("Unexpected quote.")
    },
    createPublicReadonlyClient: () => {
      throw new Error("Unexpected public reader.")
    },
    initialize: unused,
    ...overrides,
  }
}

function fixture(
  options: {
    transfer?: Partial<
      NonNullable<Awaited<ReturnType<SparkNativeWallet["getTransfer"]>>>
    >
    queryStatus?: number
    module?: Partial<SparkNativeModule>
    wallet?: Partial<SparkNativeWallet>
  } = {}
) {
  const nativeModule = module(options.module)
  const nativeTreasury = prepareCheckoutTreasuryRequest(nativeModule, {
    network: "mainnet",
    sparkAddress: ADDRESS,
    senderIdentityPublicKey: SENDER,
    receiverIdentityPublicKey: RECEIVER,
    invoiceId: INVOICE_ID,
  })
  const request: SparkCheckoutTreasuryInput = {
    network: "mainnet",
    nativeTreasury,
    amountSats: 57,
    authorizedDebitSats: 57,
  }
  const transfer = {
    id: TRANSFER_ID,
    type: "TRANSFER",
    transferDirection: "OUTGOING",
    status: "TRANSFER_STATUS_COMPLETED",
    totalValue: 57,
    valueSentByWallet: 57,
    valueReceivedByWallet: 0,
    sparkInvoice: nativeTreasury.invoiceRequest,
    senderIdentityPublicKey: SENDER,
    receiverIdentityPublicKey: RECEIVER,
    senders: [{ identityPublicKey: SENDER }],
    receivers: [
      {
        identityPublicKey: RECEIVER,
        amountSats: 57,
        status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
      },
    ],
    ...options.transfer,
  }
  const queries: string[][] = []
  const reads: string[] = []
  const fulfills: Array<Array<{ invoice: string; amount: bigint }>> = []
  let queryStatus = options.queryStatus ?? 2
  const wallet: SparkNativeWallet = {
    on() {},
    off() {},
    cleanup: async () => {},
    setPrivacyEnabled: unused,
    getWalletSettings: unused,
    getSparkAddress: unused,
    getTransfers: unused,
    transfer: unused,
    createLightningInvoice: unused,
    getTransferFromSsp: unused,
    getLightningReceiveQuote: unused,
    getLightningReceiveRequest: unused,
    getLightningSendFeeEstimate: unused,
    payLightningInvoice: unused,
    getLightningSendRequest: unused,
    getIdentityPublicKey: async () => SENDER,
    getBalance: async () => ({
      balance: 57n,
      satsBalance: { available: 57n, owned: 57n, incoming: 0n },
    }),
    querySparkInvoices: async (invoices) => {
      queries.push(invoices)
      return {
        offset: -1,
        invoiceStatuses: [
          {
            invoice: invoices[0]!,
            status: queryStatus,
            ...(queryStatus === 0
              ? {}
              : {
                  transferType: {
                    $case: "satsTransfer" as const,
                    satsTransfer: { transferId: UUID.parse(TRANSFER_ID).bytes },
                  },
                }),
          },
        ],
      }
    },
    getTransfer: async (id) => {
      reads.push(id)
      return transfer
    },
    fulfillSparkInvoice: async (invoices) => {
      fulfills.push(invoices)
      return {}
    },
    ...options.wallet,
  }
  const client = adaptFirstPartySparkWallet({
    walletId: "synthetic-wallet",
    wallet,
    module: nativeModule,
    network: "MAINNET",
    pollIntervalMs: 1,
    retirementReadTimeoutMs: 1_000,
    transferCompletionTimeoutSecs: 1,
    wait: async () => {},
    now: () => 1_800_000_000_000,
  })
  return {
    client,
    request,
    transfer,
    queries,
    reads,
    fulfills,
    setQueryStatus: (status: number) => {
      queryStatus = status
    },
    wallet,
    nativeModule,
  }
}

describe("native checkout treasury SDK boundary", () => {
  it("shares exact proof with cold, read-only Merchant adapters without enabling fulfillment", async () => {
    const f = fixture()
    const readOnly = createCheckoutSparkNativeTreasurySdkAdapter({
      wallet: { ...f.wallet, fulfillSparkInvoice: undefined },
      codec: f.nativeModule,
      network: "MAINNET",
      read: (read) => read(),
    })
    expect((await readOnly.inspectCheckoutTreasury(f.request)).status).toBe(
      "paid"
    )
    expect(await readOnly.preflightCheckoutTreasury(f.request)).toBe(
      "unavailable"
    )
    const cold = createCheckoutSparkNativeTreasurySdkAdapter({
      wallet: f.wallet,
      codec: f.nativeModule,
      network: "MAINNET",
      read: (read) => read(),
    })
    f.setQueryStatus(0)
    expect(
      await cold.sendCheckoutTreasury({
        ...f.request,
        priorSendMayHaveOccurred: true,
      })
    ).toEqual({ status: "ambiguous" })
    expect(f.fulfills).toEqual([])
    expect(
      (
        await readOnly.inspectCheckoutTreasury({
          ...f.request,
          providerTransferId: TRANSFER_ID,
        })
      ).status
    ).toBe("lookup_unavailable")
  })

  it("rejects cross-network static destinations and cross-wallet cold identity", async () => {
    const f = fixture()
    const regtestAddress = encodeSparkAddress({
      identityPublicKey: RECEIVER,
      network: "REGTEST",
    })
    expect(() =>
      prepareCheckoutTreasuryRequest(f.nativeModule, {
        network: "mainnet",
        sparkAddress: regtestAddress,
        invoiceId: INVOICE_ID,
        senderIdentityPublicKey: SENDER,
      })
    ).toThrow("invalid")
    const cold = createCheckoutSparkNativeTreasurySdkAdapter({
      wallet: { ...f.wallet, getIdentityPublicKey: async () => RECEIVER },
      codec: f.nativeModule,
      network: "MAINNET",
      read: (read) => read(),
    })
    expect((await cold.inspectCheckoutTreasury(f.request)).status).toBe(
      "conflicting_evidence"
    )
    expect(f.queries).toEqual([])
  })

  it("closes the admission lane across concurrent calls before any fulfillment response", async () => {
    let finish!: () => void
    let admissions = 0
    const f = fixture({
      queryStatus: 0,
      wallet: {
        fulfillSparkInvoice: () => {
          admissions += 1
          return new Promise<void>((resolve) => {
            finish = resolve
          })
        },
      },
    })
    const request = { ...f.request, priorSendMayHaveOccurred: false }
    const first = f.client.sendCheckoutTreasury!(request)
    const second = f.client.sendCheckoutTreasury!(request)
    for (let index = 0; index < 40 && admissions === 0; index += 1)
      await Promise.resolve()
    expect(admissions).toBe(1)
    finish()
    expect(await first).toEqual({ status: "submitted" })
    expect(await second).toEqual({ status: "ambiguous" })
    expect(admissions).toBe(1)
  })

  it("rejects invoice query mismatches, extra entries and transfer-ID substitution", async () => {
    const base = fixture()
    const entry = {
      invoice: base.request.nativeTreasury.invoiceRequest,
      status: 2,
      transferType: {
        $case: "satsTransfer" as const,
        satsTransfer: { transferId: UUID.parse(TRANSFER_ID).bytes },
      },
    }
    for (const invoiceStatuses of [
      [{ ...entry, invoice: "another-canonical-request" }],
      [entry, entry],
      [{ ...entry, status: 5 }],
      [{ ...entry, transferType: undefined }],
      [
        {
          ...entry,
          transferType: {
            $case: "satsTransfer" as const,
            satsTransfer: { transferId: new Uint8Array(3) },
          },
        },
      ],
    ]) {
      const f = fixture({
        wallet: {
          querySparkInvoices: async () => ({ offset: -1, invoiceStatuses }),
        },
      })
      expect((await f.client.inspectCheckoutTreasury!(f.request)).status).toBe(
        "conflicting_evidence"
      )
      expect(f.reads).toEqual([])
    }
  })
  it("validates static authority and freezes an unsigned open-amount request without wallet initialization", async () => {
    let initializations = 0
    const factory = new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () =>
        module({
          initialize: async () => {
            initializations += 1
            return unused()
          },
        }),
    })
    const destination = await factory.validateCheckoutTreasuryDestination({
      network: "mainnet",
      sparkAddress: ADDRESS,
    })
    expect(destination.receiverIdentityPublicKey).toBe(RECEIVER)
    const input = {
      network: "mainnet" as const,
      sparkAddress: ADDRESS,
      senderIdentityPublicKey: SENDER,
      invoiceId: INVOICE_ID,
    }
    const frozen = await factory.prepareCheckoutTreasuryRequest(input)
    expect(await factory.prepareCheckoutTreasuryRequest(input)).toEqual(frozen)
    expect(Object.isFrozen(frozen)).toBe(true)
    const decoded = decodeSparkAddress(frozen.invoiceRequest, "MAINNET")
    expect(decoded.signature).toBeUndefined()
    expect(decoded.sparkInvoiceFields).toMatchObject({
      version: 1,
      id: INVOICE_ID,
      senderPublicKey: SENDER,
      paymentType: { type: "sats" },
    })
    expect(decoded.sparkInvoiceFields?.paymentType?.amount).toBeUndefined()
    expect(decoded.sparkInvoiceFields?.expiryTime).toBeUndefined()
    expect(initializations).toBe(0)
    await expect(
      factory.validateCheckoutTreasuryDestination({
        network: "mainnet",
        sparkAddress: frozen.invoiceRequest,
      })
    ).rejects.toThrow("static receiving")
    await expect(
      factory.validateCheckoutTreasuryDestination({
        network: "regtest",
        sparkAddress: ADDRESS,
      })
    ).rejects.toThrow("another network")
    await expect(
      factory.prepareCheckoutTreasuryRequest({
        ...input,
        receiverIdentityPublicKey: SENDER,
      })
    ).rejects.toThrow("authority")
  })

  it("queries the exact invoice then reads its distinct provider transfer freshly", async () => {
    const f = fixture()
    expect(await f.client.inspectCheckoutTreasury!(f.request)).toEqual({
      invoiceId: INVOICE_ID,
      providerTransferId: TRANSFER_ID,
      status: "paid",
      finalFeeSats: 0,
      finalDebitSats: 57,
    })
    expect(f.queries).toEqual([[f.request.nativeTreasury.invoiceRequest]])
    expect(f.reads).toEqual([TRANSFER_ID])
    expect(TRANSFER_ID).not.toBe(INVOICE_ID)
  })

  it("does not turn invoice FINALIZED or an immediate response into a claimed receipt", async () => {
    const f = fixture({
      transfer: {
        status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
        receivers: [
          {
            identityPublicKey: RECEIVER,
            amountSats: 57,
            status: "TRANSFER_RECEIVER_STATUS_INITIATED",
          },
        ],
      },
    })
    expect((await f.client.inspectCheckoutTreasury!(f.request)).status).toBe(
      "pending"
    )
    f.setQueryStatus(0)
    expect(
      await f.client.sendCheckoutTreasury!({
        ...f.request,
        priorSendMayHaveOccurred: false,
      })
    ).toEqual({ status: "submitted" })
    expect(f.fulfills).toEqual([
      [{ invoice: f.request.nativeTreasury.invoiceRequest, amount: 57n }],
    ])
    expect((await f.client.inspectCheckoutTreasury!(f.request)).status).toBe(
      "not_found"
    )
  })

  it.each([
    { totalValue: 58 },
    { valueSentByWallet: 58 },
    { valueReceivedByWallet: 1 },
    { sparkInvoice: "other-request" },
    { id: INVOICE_ID },
    { type: "PREIMAGE_SWAP" },
    { transferDirection: "INCOMING" },
    { senders: [{ identityPublicKey: RECEIVER }] },
    {
      receivers: [
        {
          identityPublicKey: SENDER,
          amountSats: 57,
          status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
        },
      ],
    },
    {
      receivers: [
        {
          identityPublicKey: RECEIVER,
          amountSats: 58,
          status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
        },
      ],
    },
    { receivers: undefined },
    { senders: undefined },
  ])("rejects conflicting exact transfer evidence %j", async (transfer) => {
    const f = fixture({ transfer })
    expect((await f.client.inspectCheckoutTreasury!(f.request)).status).toBe(
      "conflicting_evidence"
    )
  })

  it("rejects saved provider-ID and invoice substitutions even with the same UUID", async () => {
    const f = fixture()
    expect(
      (
        await f.client.inspectCheckoutTreasury!({
          ...f.request,
          providerTransferId: INVOICE_ID,
        })
      ).status
    ).toBe("conflicting_evidence")
    const changed = encodeSparkAddress({
      identityPublicKey: RECEIVER,
      network: "MAINNET",
      sparkInvoiceFields: {
        version: 1,
        id: UUID.parse(INVOICE_ID).bytes,
        paymentType: { $case: "satsPayment", satsPayment: { amount: 57 } },
      },
    })
    expect(
      (
        await f.client.inspectCheckoutTreasury!({
          ...f.request,
          nativeTreasury: {
            ...f.request.nativeTreasury,
            invoiceRequest: changed,
          },
        })
      ).status
    ).toBe("conflicting_evidence")
  })

  it("leaves lost responses uncertain and refuses empty-query replay in this session or after restart", async () => {
    let calls = 0
    const f = fixture({
      queryStatus: 0,
      wallet: {
        fulfillSparkInvoice: async () => {
          calls += 1
          throw new Error("Lost response")
        },
      },
    })
    const first: SparkCheckoutTreasurySendInput = {
      ...f.request,
      priorSendMayHaveOccurred: false,
    }
    expect(await f.client.sendCheckoutTreasury!(first)).toEqual({
      status: "ambiguous",
    })
    expect(await f.client.sendCheckoutTreasury!(first)).toEqual({
      status: "ambiguous",
    })
    expect(calls).toBe(1)
    const restarted = fixture({ queryStatus: 0 })
    expect(
      await restarted.client.sendCheckoutTreasury!({
        ...restarted.request,
        priorSendMayHaveOccurred: true,
      })
    ).toEqual({ status: "ambiguous" })
    expect(restarted.fulfills).toEqual([])
  })

  it("fails closed without the pinned fee capability, exact funds, or current sender authority", async () => {
    const future = fixture({
      queryStatus: 0,
      module: { nativeTreasuryPolicy: undefined },
    })
    expect(await future.client.preflightCheckoutTreasury!(future.request)).toBe(
      "unavailable"
    )
    expect(
      (await future.client.inspectCheckoutTreasury!(future.request)).status
    ).toBe("lookup_unavailable")
    const poor = fixture({
      wallet: {
        getBalance: async () => ({
          balance: 56n,
          satsBalance: { available: 56n, owned: 56n, incoming: 0n },
        }),
      },
    })
    expect(await poor.client.preflightCheckoutTreasury!(poor.request)).toBe(
      "insufficient_funds"
    )
    const extra = fixture({
      wallet: {
        getBalance: async () => ({
          balance: 58n,
          satsBalance: { available: 58n, owned: 58n, incoming: 0n },
        }),
      },
    })
    expect(await extra.client.preflightCheckoutTreasury!(extra.request)).toBe(
      "unavailable"
    )
    const changed = fixture({
      wallet: { getIdentityPublicKey: async () => RECEIVER },
    })
    expect(
      await changed.client.preflightCheckoutTreasury!(changed.request)
    ).toBe("recipient_unverified")
    const veto = fixture({ queryStatus: 0 })
    expect(
      await veto.client.sendCheckoutTreasury!({
        ...veto.request,
        priorSendMayHaveOccurred: false,
        assertBeforeSend: async () => {
          throw new Error("Authority expired")
        },
      })
    ).toEqual({ status: "not_sent" })
    expect(veto.fulfills).toEqual([])
  })

  it("requires terminal receiver claim and never treats RETURNED as spendable refund evidence", async () => {
    const inconsistent = fixture({
      transfer: {
        receivers: [
          {
            identityPublicKey: RECEIVER,
            amountSats: 57,
            status: "TRANSFER_RECEIVER_STATUS_INITIATED",
          },
        ],
      },
    })
    expect(
      (await inconsistent.client.inspectCheckoutTreasury!(inconsistent.request))
        .status
    ).toBe("conflicting_evidence")
    const returned = fixture({
      queryStatus: 4,
      transfer: { status: "TRANSFER_STATUS_RETURNED" },
    })
    expect(
      await returned.client.inspectCheckoutTreasury!(returned.request)
    ).toEqual({
      invoiceId: INVOICE_ID,
      providerTransferId: TRANSFER_ID,
      status: "terminal_failure",
    })
  })
})
