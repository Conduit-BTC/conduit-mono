import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { fileURLToPath } from "node:url"
import * as pureSdk from "../apps/market/node_modules/@buildonspark/spark-sdk"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { createHermeticSparkTransport } from "../e2e/helpers/hermetic-spark-transport"
import { createHermeticSparkSdkFacade } from "../e2e/helpers/hermetic-spark-sdk-facade"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const MNEMONIC = createRuntimeMnemonic()

function setup(nativeInvoices = false) {
  const fixture = createHermeticSparkNative({
    async deriveIdentity(mnemonic, accountNumber) {
      const signer = new pureSdk.DefaultSparkSigner()
      const seed = await signer.mnemonicToSeed(mnemonic)
      try {
        return await signer.createSparkWalletFromSeed(seed, accountNumber)
      } finally {
        seed.fill(0)
      }
    },
    ...(nativeInvoices
      ? {
          nativeInvoiceCodec: {
            parseTransferId: pureSdk.UUID.parse,
            encodeSparkAddress: pureSdk.encodeSparkAddress,
            decodeSparkAddress: pureSdk.decodeSparkAddress,
            isValidSparkAddress: pureSdk.isValidSparkAddress,
            getNetworkFromSparkAddress: pureSdk.getNetworkFromSparkAddress,
          },
          encodeAddress: (identityPublicKey: string) =>
            pureSdk.encodeSparkAddress({
              identityPublicKey,
              network: "REGTEST",
            }),
        }
      : {}),
    async issueFundingInvoice({ amountSats }) {
      if (nativeInvoices)
        return makeSignedBolt11Fixture({
          hrp: `lnbcrt${amountSats * 10}n`,
          createdAt: Math.floor(Date.now() / 1000),
          fields: [
            bolt11PaymentHashField(new Uint8Array(32).fill(71)),
            bolt11PaymentSecretField(),
            bolt11PlainDescriptionField("Offline facade fixture"),
          ],
        })
      throw new Error("This test does not issue invoices")
    },
  })
  const transport = createHermeticSparkTransport(fixture)
  return {
    fixture,
    transport,
    sdk: createHermeticSparkSdkFacade({
      request: (command) => transport.request(command),
      pureSdk,
    }),
  }
}

it("round-trips open-amount native fulfillment and byte-accurate invoice query over the hermetic transport", async () => {
  const { sdk, transport, fixture } = setup(true)
  const { wallet } = await sdk.SparkWallet.initialize({
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST", log: false },
  })
  try {
    const sender = await wallet.getIdentityPublicKey()
    await wallet.createLightningInvoice({ amountSats: 113 })
    const control = fixture.control.forIdentity(sender)
    control.completeFunding()
    const invoiceId = sdk.UUID.parse("0197f9a0-0000-5000-8000-000000000001")
    const receiver =
      "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    const invoice = sdk.encodeSparkAddress({
      identityPublicKey: receiver,
      network: "REGTEST",
      sparkInvoiceFields: {
        version: 1,
        id: invoiceId.bytes,
        paymentType: {
          $case: "satsPayment",
          satsPayment: { amount: undefined },
        },
        senderPublicKey: Uint8Array.from(Buffer.from(sender, "hex")),
      },
    })
    expect(
      (await wallet.querySparkInvoices([invoice])).invoiceStatuses[0]!.status
    ).toBe(0)
    control.setNativeCompletion(false)
    await wallet.fulfillSparkInvoice([{ invoice, amount: 113n }])
    const queried = (await wallet.querySparkInvoices([invoice]))
      .invoiceStatuses[0]!
    expect(queried.status).toBe(2)
    expect(queried.invoice).toBe(invoice)
    expect(queried.transferType?.$case).toBe("satsTransfer")
    if (queried.transferType?.$case !== "satsTransfer")
      throw new Error("Expected native result")
    const actual = control.nativeSnapshot().transfers[0]!
    expect(queried.transferType.satsTransfer.transferId).toEqual(
      sdk.UUID.parse(actual.id).bytes
    )
    expect(
      queried.transferType.satsTransfer.transferId instanceof Uint8Array
    ).toBe(true)
    expect(actual.id).not.toBe(invoiceId.toString())
    expect((await wallet.getTransfer(actual.id))!.status).toBe(
      "TRANSFER_STATUS_SENDER_KEY_TWEAKED"
    )
    control.setNativeCompletion(true)
    expect(await wallet.getTransfer(actual.id)).toMatchObject({
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 113,
      valueSentByWallet: 113,
      valueReceivedByWallet: 0,
      sparkInvoice: invoice,
      receivers: [
        {
          identityPublicKey: receiver,
          amountSats: 113,
          status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
        },
      ],
    })
    await expect(
      wallet.fulfillSparkInvoice([{ invoice, amount: 113n }])
    ).rejects.toThrow()
    expect(control.nativeSnapshot().nativePaymentCount).toBe(1)
    expect((await wallet.getBalance()).satsBalance.owned).toBe(0n)
  } finally {
    await wallet.cleanup()
    await transport.close()
  }
})

it("preserves subclass construction so Merchant captures the actual native session", async () => {
  const { sdk, transport } = setup()
  const captured: InstanceType<typeof sdk.SparkWallet>[] = []
  class CapturedWallet extends sdk.SparkWallet {
    constructor(...args: ConstructorParameters<typeof sdk.SparkWallet>) {
      super(...args)
      captured.push(this)
    }
  }
  try {
    const { wallet } = await CapturedWallet.initialize({
      mnemonicOrSeed: MNEMONIC,
      accountNumber: 0,
      options: { network: "REGTEST", log: false },
    })
    expect(wallet === captured[0]).toBe(true)
    expect(wallet instanceof CapturedWallet).toBe(true)
    expect(await wallet.getBalance()).toMatchObject({ balance: 0n })
    await wallet.cleanup()
    await expect(wallet.getBalance()).rejects.toThrow()
  } finally {
    await transport.close()
  }
})

it("constructs an authenticated readonly subclass synchronously and closes its lazy native session", async () => {
  const { sdk, transport } = setup()
  const { wallet } = await sdk.SparkWallet.initialize({
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST", log: false },
  })
  const signer = new sdk.DefaultSparkSigner()
  const seed = await signer.mnemonicToSeed(MNEMONIC)
  try {
    await signer.createSparkWalletFromSeed(seed, 0)
  } finally {
    seed.fill(0)
  }
  class RetirementReader extends sdk.SparkReadonlyClient {
    async cleanup() {
      try {
        await this.connectionManager.closeConnections()
      } finally {
        await this.logging.close()
      }
    }
  }
  const reader = RetirementReader.createWithSigner(
    { network: "REGTEST", log: false },
    signer
  )
  try {
    expect(reader instanceof RetirementReader).toBe(true)
    expect(reader instanceof Promise).toBe(false)
    const address = await wallet.getSparkAddress()
    expect(await reader.getOwnedBalance(address)).toBe(0n)
    await reader.cleanup()
    await expect(reader.getOwnedBalance(address)).rejects.toThrow()
    expect((await wallet.getBalance()).balance).toBe(0n)
  } finally {
    await reader.cleanup()
    await wallet.cleanup()
    await transport.close()
  }
})

it("composes the real Market default loader and Merchant recovery opener without live native I/O", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL("./support/hermetic-spark-sdk-composition.ts", import.meta.url)
      ),
    ],
    { stdout: "pipe", stderr: "pipe" }
  )
  const [exitCode, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode).toBe(0)
  expect(output.includes("Hermetic SDK composition passed")).toBe(true)
}, 15_000)
