import { createHash } from "node:crypto"
import { createRuntimeMnemonic } from "./runtime-wallet-fixtures"
import { mock } from "bun:test"
import { createHermeticSparkNative } from "../../e2e/helpers/hermetic-spark-native"
import { createHermeticSparkTransport } from "../../e2e/helpers/hermetic-spark-transport"
import { createHermeticSparkSdkFacade } from "../../e2e/helpers/hermetic-spark-sdk-facade"
import { collectCheckoutSparkNativeRetirementEvidence } from "../../packages/core/src/protocol/checkout-spark-native-retirement"
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
    | Awaited<
        ReturnType<
          InstanceType<
            typeof import("../../apps/market/src/lib/spark-sdk").FirstPartySparkSdkFactory
          >["open"]
        >
      >
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
    const factory = new FirstPartySparkSdkFactory({
      network: "regtest",
      now: () => NOW,
      wait: async () => {},
    })
    buyer = await factory.open({
      walletId: "hermetic-sdk-composition",
      mnemonic: MNEMONIC,
      accountNumber: 0,
    })
    stage = "Market native funding"
    const receive = await buyer.createCheckoutReceive!({
      receiveMode: "ordinary_settled_v3",
      description: "Offline composition",
      requiredNetSats: 100,
      grossFundingSats: 100,
      expirySecs: 900,
    })
    const identity = receive.receiverIdentityPublicKey!
    const control = fixture.control.forIdentity(identity)
    control.completeFunding()
    const credit = await buyer.attestCheckoutReceiveCredit!(receive)
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
      (await buyer.sendCheckoutLightningObligation!(target)).status === "paid"
    )
    stage = "Market authenticated retirement reader"
    const buyerNative = await buyer.openCheckoutRetirementReader!({
      walletId: "hermetic-sdk-composition",
      network: "regtest",
      receiverIdentityPublicKey: identity,
    })
    try {
      const collect = () =>
        collectCheckoutSparkNativeRetirementEvidence({
          authenticatedReader: buyerNative.reader,
          walletId: "hermetic-sdk-composition",
          network: "regtest",
          sparkAddress: buyerNative.sparkAddress,
          stateUpdatedAt: NOW,
          expectedTransferIds: [credit!.transferId, target.transferId],
          now: () => NOW + 1,
        })
      control.setAdditionalOwnedSats(1)
      check((await collect()) === null)
      control.setAdditionalOwnedSats(0)
      const evidence = await collect()
      check(evidence?.fundingReceiveTerminal && evidence.sendHistoryTerminal)
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
    await buyer.disconnect()
    buyer = undefined
    stage = "Merchant actual recovery opener"
    const { openMerchantCheckoutSparkRecoveryWallet } =
      await import("../../apps/merchant/src/lib/checkout-spark-settled-recovery")
    merchant = await openMerchantCheckoutSparkRecoveryWallet({
      mnemonic: MNEMONIC,
      accountNumber: 0,
      network: "regtest",
    })
    await merchant.ensurePrivateReady()
    check((await merchant.getIdentityPublicKey()) === identity)
    check(
      (await merchant.getLightningReceiveRequest(receive.id))?.status ===
        "TRANSFER_COMPLETED"
    )
    check(
      (await merchant.getTransferFromSsp(target.transferId))?.sparkId ===
        target.transferId
    )
    stage = "Merchant authenticated retirement reader"
    const native = await merchant.openRetirementReader!()
    const result = await collectCheckoutSparkNativeRetirementEvidence({
      authenticatedReader: native.reader,
      walletId: "hermetic-sdk-composition",
      network: "regtest",
      sparkAddress: native.sparkAddress,
      stateUpdatedAt: NOW,
      expectedTransferIds: [credit!.transferId, target.transferId],
      now: () => NOW + 1,
    })
    check(result?.fundingReceiveTerminal && result.sendHistoryTerminal)
    await merchant.cleanup()
    merchant = undefined
    let closed = false
    try {
      await native.reader.getOwnedBalance(native.sparkAddress)
    } catch {
      closed = true
    }
    check(closed)
    check(control.snapshot().outgoingPaymentCount === 1)
    check(nativeInitializationAttempts === 0)
    process.stdout.write("Hermetic SDK composition passed\n")
  } finally {
    await buyer?.disconnect()
    await merchant?.cleanup()
    await transport.close()
  }
}

run().catch(() => {
  process.stderr.write(`Hermetic SDK composition failed at ${stage}\n`)
  process.exitCode = 1
})
