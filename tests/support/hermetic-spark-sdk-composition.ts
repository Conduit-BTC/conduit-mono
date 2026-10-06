import { createHash } from "node:crypto"
import { createRuntimeMnemonic } from "./runtime-wallet-fixtures"
import { mock } from "bun:test"
import {
  createHermeticSparkNative,
  HERMETIC_SPARK_SSP_IDENTITY_PUBLIC_KEY as SSP_IDENTITY,
} from "../../e2e/helpers/hermetic-spark-native"
import { createHermeticSparkTransport } from "../../e2e/helpers/hermetic-spark-transport"
import { createHermeticSparkSdkFacade } from "../../e2e/helpers/hermetic-spark-sdk-facade"
import { collectCheckoutSparkNativeRetirementEvidence } from "../../packages/core/src/protocol/checkout-spark-native-retirement"
import { prepareCheckoutSparkNativeTreasuryRequest } from "../../packages/core/src/protocol/checkout-spark-treasury-sdk"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const MNEMONIC = createRuntimeMnemonic()
const SWAP_PRIMARY = "6e7247ed-b1f0-40cc-bebf-bd548910cace"
const SWAP_COUNTER = "a91407e3-c5ec-4c9b-80f9-2bdc1dadc88d"
const UNRELATED_IDENTITY = `03${SSP_IDENTITY.slice(2)}`
let stage = "setup"

function check(value: unknown) {
  if (!value) throw new Error("Hermetic SDK assertion failed")
}
function invoice(amountSats: number, preimage: Uint8Array) {
  return makeSignedBolt11Fixture({
    hrp: `lnbcrt${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(createHash("sha256").update(preimage).digest()),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Offline native SDK composition"),
      { tag: "x", words: [28, 4] },
    ],
  })
}

function internalSwap(walletIdentity: string) {
  const amount = { originalUnit: "SATOSHI", originalValue: 100 }
  const key = (identity: string) =>
    Uint8Array.from(Buffer.from(identity, "hex"))
  const row = (id: string, type: 4 | 5, sender: string, receiver: string) => ({
    id,
    type,
    status: 5,
    network: 2,
    totalValue: 100,
    senders: [{ id: `${id}:sender`, identityPublicKey: key(sender) }],
    receivers: [
      {
        id: `${id}:receiver`,
        identityPublicKey: key(receiver),
        status: 6,
        amountSats: 100,
      },
    ],
    leaves: [
      {
        leaf: { id: `${id}:leaf`, value: 100 },
        transferSenderId: `${id}:sender`,
        transferReceiverId: `${id}:receiver`,
      },
    ],
  })
  const userRequest = {
    typename: "LeavesSwapRequest",
    id: "hermetic-leaves-swap",
    status: "SUCCEEDED",
    network: "REGTEST",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    totalAmount: amount,
    targetAmount: amount,
    fee: { originalUnit: "SATOSHI", originalValue: 0 },
    outboundTransfer: { sparkId: SWAP_PRIMARY, totalAmount: amount },
    inboundTransfer: { sparkId: SWAP_COUNTER, totalAmount: amount },
    swapLeaves: [{ leafId: `${SWAP_COUNTER}:leaf` }],
  }
  return {
    history: [
      row(SWAP_PRIMARY, 4, walletIdentity, SSP_IDENTITY),
      row(SWAP_COUNTER, 5, SSP_IDENTITY, walletIdentity),
    ],
    ssp: [SWAP_PRIMARY, SWAP_COUNTER].map((sparkId) => ({
      sparkId,
      totalAmount: amount,
      userRequest,
    })),
  }
}

async function run() {
  // This process replaces only the external SDK module. Any accidental native
  // HTTP/WebSocket fallback fails, before it can contact a provider.
  globalThis.fetch = async () => {
    throw new Error("Hermetic network unavailable")
  }
  globalThis.WebSocket = class {
    constructor() {
      throw new Error("Hermetic network unavailable")
    }
  } as unknown as typeof WebSocket
  const pureSdk =
    await import("../../apps/market/node_modules/@buildonspark/spark-sdk")
  const fixture = createHermeticSparkNative({
    encodeAddress: (identityPublicKey) =>
      pureSdk.encodeSparkAddress({ identityPublicKey, network: "REGTEST" }),
    async deriveIdentity(mnemonic, accountNumber) {
      const signer = new pureSdk.DefaultSparkSigner()
      const seed = await signer.mnemonicToSeed(mnemonic)
      try {
        return await signer.createSparkWalletFromSeed(seed, accountNumber)
      } finally {
        seed.fill(0)
      }
    },
    issueFundingInvoice: async ({ amountSats }) =>
      invoice(amountSats, new Uint8Array(32).fill(72)),
  })
  const transport = createHermeticSparkTransport(fixture)
  const sdk = createHermeticSparkSdkFacade({
    request: (command) => transport.request(command),
    pureSdk,
  })
  let nativeInitializationAttempts = 0
  const forbidRealNativeInitialization = () => {
    nativeInitializationAttempts += 1
    throw new Error("Real native initialization is forbidden")
  }
  pureSdk.SparkWallet.initialize = forbidRealNativeInitialization
  pureSdk.SparkReadonlyClient.createPublic = forbidRealNativeInitialization
  pureSdk.SparkReadonlyClient.createWithSigner = forbidRealNativeInitialization
  mock.module("@buildonspark/spark-sdk", () => sdk)
  mock.module(
    import.meta
      .resolve("../../apps/market/node_modules/@buildonspark/spark-sdk"),
    () => sdk
  )
  mock.module(
    import.meta
      .resolve("../../apps/merchant/node_modules/@buildonspark/spark-sdk"),
    () => sdk
  )
  let buyer:
    | import("../../apps/market/src/lib/spark-wallet").SparkWalletManager
    | undefined
  let merchant:
    | Awaited<
        ReturnType<
          typeof import("../../apps/merchant/src/lib/checkout-spark-settled-recovery").openMerchantCheckoutSparkRecoveryWallet
        >
      >
    | undefined
  try {
    stage = "Market default module loader"
    const { FirstPartySparkSdkFactory } =
      await import("../../apps/market/src/lib/spark-sdk")
    const { SparkWalletManager } =
      await import("../../apps/market/src/lib/spark-wallet")
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      now: () => NOW,
      wait: async () => {},
    })
    buyer = new SparkWalletManager(factory)
    await buyer.openWithMnemonic({
      walletId: "hermetic-sdk-composition",
      mnemonic: MNEMONIC,
      accountNumber: 0,
    })
    stage = "Market native funding"
    const receive = await buyer.createCheckoutReceive(
      "hermetic-sdk-composition",
      {
        receiveMode: "ordinary_settled_v3",
        description: "Offline composition",
        requiredNetSats: 100,
        grossFundingSats: 100,
        expirySecs: 900,
      }
    )
    const identity = receive.receiverIdentityPublicKey!
    const control = fixture.control.forIdentity(identity)
    stage = "Normal SDK internal swap fixture"
    const swap = internalSwap(identity)
    control.setExtraHistory(swap.history)
    control.setExtraSspTransfers(swap.ssp)
    control.completeFunding()
    const credit = await buyer.attestCheckoutReceiveCredit(
      "hermetic-sdk-composition",
      receive
    )
    check(credit?.creditedSats === 100)
    stage = "Market native payout"
    const preimage = new Uint8Array(32).fill(73)
    const paymentRequest = invoice(99, preimage)
    control.registerPayout({
      paymentRequest,
      preimage: Buffer.from(preimage).toString("hex"),
      feeSats: 1,
    })
    const target = {
      transferId: "d39d4111-f12e-4d3f-8da4-bd659ee28e50",
      network: "regtest" as const,
      paymentRequest,
      amountSats: 99,
      maxFeeSats: 1,
      completionTimeoutSecs: 0,
    }
    check(
      (
        await buyer.sendCheckoutLightningObligation(
          "hermetic-sdk-composition",
          target
        )
      ).status === "paid"
    )
    stage = "Market manager authenticated retirement reader"
    const buyerNative = await buyer.openCheckoutRetirementReader(
      "hermetic-sdk-composition",
      {
        network: "regtest",
        receiverIdentityPublicKey: identity,
      }
    )
    try {
      let rejectedAddress = false
      try {
        await buyerNative.reader.getInternalSwapEvidence!({
          sparkAddress: `${buyerNative.sparkAddress}:unrelated`,
          transferId: SWAP_PRIMARY,
        })
      } catch {
        rejectedAddress = true
      }
      check(rejectedAddress)
      const collect = () =>
        collectCheckoutSparkNativeRetirementEvidence({
          authenticatedReader: buyerNative.reader,
          walletId: "hermetic-sdk-composition",
          network: "regtest",
          sparkAddress: buyerNative.sparkAddress,
          stateUpdatedAt: NOW,
          expectedTransferIds: [credit!.transferId, target.transferId],
          requireExactHistoryScope: true,
          now: () => NOW + 1,
        })
      control.setAdditionalOwnedSats(1)
      check((await collect()) === null)
      control.setAdditionalOwnedSats(0)
      const evidence = await collect()
      check(evidence?.fundingReceiveTerminal && evidence.sendHistoryTerminal)
      stage = "Market rejects unrelated internal swap"
      const unrelated = internalSwap(UNRELATED_IDENTITY)
      control.setExtraHistory(unrelated.history)
      check((await collect()) === null)
      control.setExtraHistory(swap.history)
      stage = "Market rejects conflicting internal swap request"
      control.setExtraSspTransfers(
        swap.ssp.map((transfer) => ({
          ...transfer,
          userRequest: {
            ...transfer.userRequest,
            swapLeaves: [{ leafId: "unrelated-leaf" }],
          },
        }))
      )
      check((await collect()) === null)
      control.setExtraSspTransfers(swap.ssp)
      check((await collect())?.sendHistoryTerminal)
      check(control.snapshot().sendInvocationCount === 1)
    } finally {
      await buyerNative.cleanup()
    }
    let buyerReaderClosed = false
    try {
      await buyerNative.reader.getOwnedBalance(buyerNative.sparkAddress)
    } catch {
      buyerReaderClosed = true
    }
    check(buyerReaderClosed)
    let buyerSwapReaderClosed = false
    try {
      await buyerNative.reader.getInternalSwapEvidence!({
        sparkAddress: buyerNative.sparkAddress,
        transferId: SWAP_PRIMARY,
      })
    } catch {
      buyerSwapReaderClosed = true
    }
    check(buyerSwapReaderClosed)
    await buyer.close("hermetic-sdk-composition")
    buyer = undefined
    stage = "Merchant actual recovery opener"
    const { openMerchantCheckoutSparkRecoveryWallet } =
      await import("../../apps/merchant/src/lib/checkout-spark-settled-recovery")
    merchant = await openMerchantCheckoutSparkRecoveryWallet({
      mnemonic: MNEMONIC,
      accountNumber: 0,
      network: "regtest",
      outgoing: true,
    })
    await merchant.ensurePrivateReady!()
    check((await merchant.getIdentityPublicKey()) === identity)
    check(
      (await merchant.getLightningReceiveRequest(receive.id))?.status ===
        "TRANSFER_COMPLETED"
    )
    check(
      (await merchant.getTransferFromSsp!(target.transferId))?.sparkId ===
        target.transferId
    )
    stage = "Merchant reviewed native SDK capability"
    const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(
      { ...sdk, parseTransferId: (value) => sdk.UUID.parse(value) },
      {
        network: "regtest",
        sparkAddress: pureSdk.encodeSparkAddress({
          identityPublicKey: SSP_IDENTITY,
          network: "REGTEST",
        }),
        senderIdentityPublicKey: identity,
        invoiceId: "0197f9a0-0000-5000-8000-000000000001",
      }
    )
    // The fixture's commerce payout used all funds. The reviewed real opener
    // must reach the balance check, not silently disable native capability.
    const nativePreflight =
      await merchant.nativeTreasury!.preflightCheckoutTreasury({
        network: "regtest",
        nativeTreasury,
        amountSats: 1,
        authorizedDebitSats: 1,
      })
    stage = `Merchant reviewed native SDK capability (${nativePreflight})`
    check(nativePreflight === "insufficient_funds")
    check(control.nativeSnapshot().nativeSendInvocationCount === 0)
    stage = "Merchant authenticated retirement reader"
    const native = await merchant.openRetirementReader!()
    let merchantRejectedAddress = false
    try {
      await native.reader.getInternalSwapEvidence!({
        sparkAddress: `${native.sparkAddress}:unrelated`,
        transferId: SWAP_COUNTER,
      })
    } catch {
      merchantRejectedAddress = true
    }
    check(merchantRejectedAddress)
    const collectMerchant = () =>
      collectCheckoutSparkNativeRetirementEvidence({
        authenticatedReader: native.reader,
        walletId: "hermetic-sdk-composition",
        network: "regtest",
        sparkAddress: native.sparkAddress,
        stateUpdatedAt: NOW,
        expectedTransferIds: [credit!.transferId, target.transferId],
        requireExactHistoryScope: true,
        now: () => NOW + 1,
      })
    const result = await collectMerchant()
    check(result?.fundingReceiveTerminal && result.sendHistoryTerminal)
    stage = "Merchant rejects unrelated internal swap"
    control.setExtraHistory(internalSwap(UNRELATED_IDENTITY).history)
    check((await collectMerchant()) === null)
    control.setExtraHistory(swap.history)
    stage = "Merchant rejects conflicting internal swap request"
    control.setExtraSspTransfers(
      swap.ssp.map((transfer) => ({
        ...transfer,
        userRequest: { ...transfer.userRequest, status: "FAILED" },
      }))
    )
    check((await collectMerchant()) === null)
    control.setExtraSspTransfers(swap.ssp)
    check((await collectMerchant())?.sendHistoryTerminal)
    const closedMerchant = merchant
    await merchant.cleanup()
    merchant = undefined
    let closed = false
    try {
      await native.reader.getOwnedBalance(native.sparkAddress)
    } catch {
      closed = true
    }
    check(closed)
    let merchantSwapReaderClosed = false
    try {
      await native.reader.getInternalSwapEvidence!({
        sparkAddress: native.sparkAddress,
        transferId: SWAP_COUNTER,
      })
    } catch {
      merchantSwapReaderClosed = true
    }
    check(merchantSwapReaderClosed)
    stage = "Merchant rejects reopening after cleanup"
    let merchantReopenRejected = false
    try {
      await closedMerchant.openRetirementReader!()
    } catch {
      merchantReopenRejected = true
    }
    check(merchantReopenRejected)
    check(control.snapshot().outgoingPaymentCount === 1)
    check(nativeInitializationAttempts === 0)
    process.stdout.write("Hermetic SDK composition passed\n")
  } finally {
    await buyer?.close("hermetic-sdk-composition")
    await merchant?.cleanup()
    await transport.close()
  }
}

run().catch(() => {
  process.stderr.write(`Hermetic SDK composition failed at ${stage}\n`)
  process.exitCode = 1
})
