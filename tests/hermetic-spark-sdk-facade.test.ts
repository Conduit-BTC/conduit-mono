import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { fileURLToPath } from "node:url"
import * as pureSdk from "../apps/market/node_modules/@buildonspark/spark-sdk"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { createHermeticSparkTransport } from "../e2e/helpers/hermetic-spark-transport"
import { createHermeticSparkSdkFacade } from "../e2e/helpers/hermetic-spark-sdk-facade"

const MNEMONIC = createRuntimeMnemonic()

function setup() {
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
    async issueFundingInvoice() {
      throw new Error("This test does not issue invoices")
    },
  })
  const transport = createHermeticSparkTransport(fixture)
  return {
    transport,
    sdk: createHermeticSparkSdkFacade({
      request: (command) => transport.request(command),
      pureSdk,
    }),
  }
}

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
