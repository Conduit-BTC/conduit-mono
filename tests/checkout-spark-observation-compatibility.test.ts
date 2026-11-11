import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test"
import merchantPackage from "../apps/merchant/package.json"
import { openMerchantCheckoutSparkObservationWallet } from "../apps/merchant/src/lib/checkout-spark-observation-wallet"

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
let networkAttempts = 0
beforeAll(() => {
  globalThis.fetch = (() => {
    networkAttempts++
    throw new Error("Offline observation test attempted HTTP")
  }) as unknown as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("Offline observation test attempted WebSocket")
    }
  } as unknown as typeof WebSocket
})
afterEach(() => expect(networkAttempts).toBe(0))
afterAll(() => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
})

async function syntheticIdentity() {
  const sdk =
    await import("../apps/merchant/node_modules/@buildonspark/spark-sdk/dist/index.browser.js")
  const mnemonic = `${Array(11).fill("abandon").join(" ")} about`
  const signer = new sdk.DefaultSparkSigner()
  const seed = await signer.mnemonicToSeed(mnemonic)
  try {
    return {
      sdk,
      mnemonic,
      identity: await signer.createSparkWalletFromSeed(seed, 0),
    }
  } finally {
    seed.fill(0)
  }
}

describe("version-audited query-only Merchant observation", () => {
  it("supports the installed audited SDK constructor without initialization or network", async () => {
    expect(merchantPackage.dependencies["@buildonspark/spark-sdk"]).toBe(
      "0.14.0"
    )
    const { sdk, mnemonic, identity } = await syntheticIdentity()
    const initialize = spyOn(sdk.SparkWallet, "initialize").mockImplementation(
      () => {
        throw new Error("Observation must never initialize a wallet")
      }
    )
    try {
      const wallet = await openMerchantCheckoutSparkObservationWallet(
        {
          mnemonic,
          accountNumber: 0,
          network: "regtest",
          expectedWalletIdentityPubkey: identity,
        },
        { loadSdk: async () => sdk }
      )
      try {
        expect(await wallet.getIdentityPublicKey()).toBe(identity)
        expect("initialize" in wallet).toBe(false)
        expect("sendPayment" in wallet).toBe(false)
        expect(Object.isFrozen(wallet)).toBe(true)
      } finally {
        await wallet.cleanup()
      }
      await expect(wallet.getIdentityPublicKey()).rejects.toThrow(
        "observation is unavailable"
      )
      expect(initialize).not.toHaveBeenCalled()
    } finally {
      initialize.mockRestore()
    }
  })

  it.each(["0.13.0", "0.15.0"])(
    "rejects unsupported SDK %s before SDK loading",
    async (sdkVersion) => {
      let loads = 0
      await expect(
        openMerchantCheckoutSparkObservationWallet(
          {
            mnemonic: "synthetic unused mnemonic",
            accountNumber: 0,
            network: "regtest",
            expectedWalletIdentityPubkey: `02${"a".repeat(64)}`,
          },
          {
            sdkVersion,
            loadSdk: async () => {
              loads++
              throw new Error("Unaudited SDK must not load")
            },
          }
        )
      ).rejects.toThrow("observation is unavailable")
      expect(loads).toBe(0)
    }
  )
})
