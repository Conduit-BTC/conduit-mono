// Offline compatibility proof only. Uses the public BIP39 test vector; never opens a wallet.
// Install @breeztech/breez-sdk-spark@0.26.1 in a temporary directory and pass its
// nodejs/breez_sdk_spark_wasm.js path. It is not an app/runtime dependency.
import { pathToFileURL } from "node:url"
import { bytesToHex } from "../../packages/core/node_modules/@noble/hashes/utils.js"
import { secp256k1 } from "../../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../../packages/core/node_modules/@noble/hashes/sha2.js"
import {
  DefaultSparkSigner,
  deriveViewerIdentityPublicKey,
} from "../../apps/market/node_modules/@buildonspark/spark-sdk"
import {
  entropyToMnemonic,
  mnemonicToSeedSync,
} from "../../apps/market/node_modules/@scure/bip39"
import { wordlist } from "../../apps/market/node_modules/@scure/bip39/wordlists/english.js"
import { breezAddressMessage } from "../../packages/core/src/wallets/breez-lightning-address"

const path = process.argv[2]
if (!path)
  throw new Error("Pass the temporary Breez SDK nodejs WASM module path.")
const breez = await import(pathToFileURL(path).href)
// Published BIP39 zero-entropy vector, deliberately non-funded.
const mnemonic = entropyToMnemonic(new Uint8Array(16), wordlist)
let cases = 0
for (const [network, nativeNetwork, account] of [
  ["mainnet", "MAINNET", 1],
  ["mainnet", "MAINNET", 7],
  ["regtest", "REGTEST", 0],
] as const) {
  const first = new DefaultSparkSigner()
  await first.createSparkWalletFromSeed(mnemonicToSeedSync(mnemonic), account)
  const signers = breez.defaultExternalSigners(
    mnemonic,
    undefined,
    network,
    account
  )
  const foreign = signers.sparkSigner
  try {
    const identity = await foreign.getIdentityPublicKey()
    const publicKey = new Uint8Array(identity.bytes)
    if (
      bytesToHex(publicKey) !==
        bytesToHex(await first.getIdentityPublicKey()) ||
      bytesToHex(publicKey) !==
        (await deriveViewerIdentityPublicKey(
          { network: nativeNetwork },
          mnemonic,
          account
        ))
    )
      throw new Error("Spark identity mismatch.")
    const message = new TextEncoder().encode(
      breezAddressMessage({
        operation: "register",
        domain: "conduit.cash",
        identity: bytesToHex(publicKey),
        username: "wallet-fixture",
        description: "Non-funded fixture",
        timestamp: 1700000000,
      })
    )
    const digest = sha256(message)
    const breezSignature = new Uint8Array(
      (await foreign.signMessage(message)).bytes
    )
    const firstSignature = await first.signMessageWithIdentityKey(digest)
    if (
      !secp256k1.verify(breezSignature, digest, publicKey, {
        prehash: false,
        format: "compact",
      }) ||
      !secp256k1.verify(firstSignature, digest, publicKey, {
        prehash: false,
        format: "der",
      })
    )
      throw new Error("SDK signature mismatch.")
    cases++
  } finally {
    foreign.free()
    signers.free()
  }
}
console.log(
  JSON.stringify({
    identityCases: cases,
    signaturesVerified: true,
    networkWalletsOpened: 0,
  })
)
