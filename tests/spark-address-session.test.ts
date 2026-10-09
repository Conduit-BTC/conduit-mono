import { describe, expect, it } from "bun:test"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import { hexToBytes } from "../packages/core/node_modules/@noble/hashes/utils.js"
import {
  BreezLightningAddressClient,
  breezAddressMessage,
} from "../packages/core/src/wallets/breez-lightning-address"
import * as sdk from "../apps/market/node_modules/@buildonspark/spark-sdk"
import { mnemonicToSeedSync } from "../apps/market/node_modules/@scure/bip39"
import { generateSparkMnemonic } from "../apps/market/src/lib/spark-recovery"
import { loadFirstPartySparkModule } from "../apps/market/src/lib/spark-sdk"

async function fixture(wrongIdentity = false) {
  const mnemonic = generateSparkMnemonic()
  let cleanupCalls = 0
  let walletSigner: sdk.DefaultSparkSigner | undefined
  // Replace only network-wallet initialization. Native signer/identity derivation
  // and the production adapter's binding/revocation logic execute unchanged.
  const module = await loadFirstPartySparkModule(async () => ({
    ...sdk,
    SparkWallet: {
      async initialize(
        input: Parameters<typeof sdk.SparkWallet.initialize>[0]
      ) {
        walletSigner = input.signer as sdk.DefaultSparkSigner
        expect(walletSigner).toBeInstanceOf(sdk.DefaultSparkSigner)
        if (typeof input.mnemonicOrSeed !== "string")
          throw new Error("Expected test mnemonic.")
        await walletSigner.createSparkWalletFromSeed(
          mnemonicToSeedSync(input.mnemonicOrSeed),
          input.accountNumber
        )
        return {
          wallet: {
            getIdentityPublicKey: async () =>
              wrongIdentity
                ? `02${"aa".repeat(32)}`
                : Buffer.from(
                    await walletSigner!.getIdentityPublicKey()
                  ).toString("hex"),
            async cleanup() {
              cleanupCalls++
            },
          },
        }
      },
    } as unknown as typeof sdk.SparkWallet,
  }))
  return {
    module,
    input: {
      mnemonicOrSeed: mnemonic,
      accountNumber: 1,
      options: { log: false as const, network: "MAINNET" as const },
    },
    cleanupCalls: () => cleanupCalls,
    walletSigner: () => walletSigner,
  }
}

describe("production Spark address session seam", () => {
  it("signs with the initialized wallet identity and revokes address operations on cleanup", async () => {
    const f = await fixture()
    const { wallet } = await f.module.initialize(f.input)
    const signer = wallet.breezAddressSigner!
    const identity = await signer.getIdentityPublicKey()
    expect(identity).toBe(
      Buffer.from(await f.walletSigner()!.getIdentityPublicKey()).toString(
        "hex"
      )
    )
    let requests = 0
    const client = new BreezLightningAddressClient({
      domain: "conduit.cash",
      apiKey: "public-test-key",
      signer,
      runExclusive: (_, operation) => operation(),
      store: { read: async () => null, write: async () => {} },
      fetch: async (_, init) => {
        requests++
        const { signature, timestamp } = JSON.parse(String(init?.body))
        const digest = sha256(
          new TextEncoder().encode(
            breezAddressMessage({
              operation: "recover",
              domain: "conduit.cash",
              identity,
              timestamp,
            })
          )
        )
        expect(
          secp256k1.verify(
            hexToBytes(signature),
            digest,
            hexToBytes(identity),
            { prehash: false, format: "der" }
          )
        ).toBe(true)
        return new Response(JSON.stringify("user not found"), { status: 404 })
      },
    })
    expect(await client.lookup()).toEqual({ status: "absent" })
    await wallet.cleanup()
    expect(f.cleanupCalls()).toBe(1)
    expect(() => signer.assertActive()).toThrow("locked")
    await expect(signer.getIdentityPublicKey()).rejects.toThrow("locked")
    expect(() => signer.signDigest(new Uint8Array(32))).toThrow("locked")
    expect(await client.ensure()).toEqual({
      status: "unavailable",
      reason: "locked",
    })
    expect(requests).toBe(1)
  })

  it("rejects an initialized wallet with a different identity and cleans it up", async () => {
    const f = await fixture(true)
    await expect(f.module.initialize(f.input)).rejects.toThrow(
      "identity did not match recovery parameters"
    )
    expect(f.cleanupCalls()).toBe(1)
  })
})
