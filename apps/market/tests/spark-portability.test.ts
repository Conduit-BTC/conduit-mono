import { describe, expect, it } from "bun:test"

import {
  DefaultSparkSigner,
  UUID,
  encodeSparkAddress,
} from "@buildonspark/spark-sdk"

const PUBLIC_TEST_MNEMONIC = "abandon ".repeat(11) + "about"
const PAYMENT_ATTEMPT_ID = "c7fb0ad2-c85c-4d93-b542-6dc9d10d8c00"
const MAINNET_ACCOUNT_ONE = {
  identityPublicKey:
    "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
  sparkAddress:
    "spark1pgss9qfk8ygtphqqzkj2yhn43k3s7r3g8z822ffvpcm38ym094800574x5numh",
} as const
const MAINNET_ACCOUNT_ZERO = {
  identityPublicKey:
    "02698b27ac308b275671b3ca25436346469d04a5bba578ae39feba1d65897a6abc",
  sparkAddress:
    "spark1pgssy6vty7krpze82ecm8j39gd35v35aqjjmhftc4culawsavkyh564uc6zmqs",
} as const

/**
 * Public, non-funded portability vector. The expected constants were derived
 * independently from the exact Breez Spark signer versions pinned by Wisp and
 * Primal. Both use m/8797555'/account'/0' for the identity key. The values are
 * cross-checked here against Conduit's pinned @buildonspark/spark-sdk 0.11.0.
 *
 * Wisp Breez 0.11.0 signer:
 * https://github.com/breez/spark-sdk/blob/744b2dd7b036d8fae659b73abc9a09b2d0b9d68b/crates/spark/src/signer/default_signer.rs
 * Wisp Mainnet initialization:
 * https://github.com/barrydeen/wisp/blob/8efc9f80a3666208ad0b459d675eaad6d5a5a7da/app/src/main/kotlin/com/wisp/app/repo/SparkRepository.kt#L285-L305
 * Primal Breez 0.17.1 signer:
 * https://github.com/breez/spark-sdk/blob/f660f5a3bf24323e5c14235efcd28e5aef06c8aa/crates/spark/src/signer/default_signer.rs
 * Primal Mainnet/default-account initialization:
 * https://github.com/PrimalHQ/primal-android-app/blob/efb88b5af1db9d84eb36b471bf17d49d1c8a8a0c/data/wallet/repository/src/commonMain/kotlin/net/primal/wallet/data/spark/BreezSdkInstanceManager.kt
 */
describe("Spark portability fixture", () => {
  it("accepts Conduit payment-attempt UUIDs as Spark transfer IDs", () => {
    expect(UUID.parse(PAYMENT_ATTEMPT_ID).toString()).toBe(PAYMENT_ATTEMPT_ID)
  })

  it("matches the standard Mainnet account 1 identity and address", async () => {
    const derived = await deriveMainnetWallet(1)

    expect(derived).toEqual(MAINNET_ACCOUNT_ONE)
  })

  it("keeps Mainnet account 0 as an exact negative control", async () => {
    const derived = await deriveMainnetWallet(0)

    expect(derived).toEqual(MAINNET_ACCOUNT_ZERO)
    expect(derived.identityPublicKey).not.toBe(
      MAINNET_ACCOUNT_ONE.identityPublicKey
    )
    expect(derived.sparkAddress).not.toBe(MAINNET_ACCOUNT_ONE.sparkAddress)
  })
})

async function deriveMainnetWallet(accountNumber: number): Promise<{
  identityPublicKey: string
  sparkAddress: string
}> {
  const signer = new DefaultSparkSigner()
  const seed = await signer.mnemonicToSeed(PUBLIC_TEST_MNEMONIC)
  const identityPublicKey = await signer.createSparkWalletFromSeed(
    seed,
    accountNumber
  )
  return {
    identityPublicKey,
    sparkAddress: encodeSparkAddress({
      identityPublicKey,
      network: "MAINNET",
    }),
  }
}
