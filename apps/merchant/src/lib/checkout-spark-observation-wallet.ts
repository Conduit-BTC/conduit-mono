import merchantPackage from "../../package.json"
import type { MerchantSparkRecoveryWallet } from "./checkout-spark-settled-recovery"

type SparkSdk = typeof import("@buildonspark/spark-sdk")
type NativeWallet = InstanceType<SparkSdk["SparkWallet"]>

/** Query-only capability: never initializes, claims, changes privacy, or sends. */
export type MerchantSparkObservationWallet = Pick<
  MerchantSparkRecoveryWallet,
  | "getIdentityPublicKey"
  | "getLightningReceiveRequest"
  | "getTransfer"
  | "getTransferFromSsp"
  | "getLightningSendRequest"
  | "cleanup"
>

export interface MerchantSparkObservationWalletInput {
  /** Only supplied inside the isolated authenticated recovery callback. */
  mnemonic: string
  accountNumber: number
  network: "mainnet" | "regtest"
  expectedWalletIdentityPubkey: string
  /** Caller-owned order/account/visibility generation. */
  assertActive?: () => void
}

export interface MerchantSparkObservationWalletDependencies {
  loadSdk?: () => Promise<SparkSdk>
  sdkVersion?: string
}

const OBSERVATION_SDK_VERSION = "0.13.0"
const UNAVAILABLE = "Checkout Spark authenticated observation is unavailable."

/**
 * Source-audited for the exact pinned SDK: its public constructor is inert;
 * initialize/init/sync start claims and must never be used here. The supported
 * readonly client lacks SSP Lightning request reads. Keep this façade narrow,
 * re-audit upgrades, and fail closed rather than falling back to initialization.
 */
export async function openMerchantCheckoutSparkObservationWallet(
  input: MerchantSparkObservationWalletInput,
  dependencies: MerchantSparkObservationWalletDependencies = {}
): Promise<MerchantSparkObservationWallet> {
  const assertActive = input.assertActive
  const network = input.network
  assertActive?.()
  const expectedIdentity = input.expectedWalletIdentityPubkey
    .trim()
    .toLowerCase()
  if (
    (dependencies.sdkVersion ??
      merchantPackage.dependencies["@buildonspark/spark-sdk"]) !==
      OBSERVATION_SDK_VERSION ||
    !/^(02|03)[0-9a-f]{64}$/.test(expectedIdentity) ||
    !Number.isSafeInteger(input.accountNumber) ||
    input.accountNumber < 0 ||
    input.accountNumber > 0x7fffffff ||
    !["mainnet", "regtest"].includes(input.network)
  ) {
    throw new Error(UNAVAILABLE)
  }
  const normalizedMnemonic = input.mnemonic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
  const [{ validateMnemonic }, { wordlist }] = await Promise.all([
    import("@scure/bip39"),
    import("@scure/bip39/wordlists/english.js"),
  ])
  assertActive?.()
  if (!validateMnemonic(normalizedMnemonic, wordlist)) {
    throw new Error(UNAVAILABLE)
  }
  let wallet: NativeWallet | undefined
  let closed = false
  const assertCurrent = () => {
    if (closed) throw new Error(UNAVAILABLE)
    assertActive?.()
  }
  try {
    const { SparkWallet, DefaultSparkSigner } = await (
      dependencies.loadSdk ?? (() => import("@buildonspark/spark-sdk"))
    )()
    assertCurrent()
    const signer = new DefaultSparkSigner()
    const seed = await signer.mnemonicToSeed(normalizedMnemonic)
    let derivedIdentity: string
    try {
      assertCurrent()
      derivedIdentity = (
        await signer.createSparkWalletFromSeed(seed, input.accountNumber)
      )
        .trim()
        .toLowerCase()
    } finally {
      seed.fill(0)
    }
    assertCurrent()
    if (derivedIdentity !== expectedIdentity) throw new Error(UNAVAILABLE)
    // Authentication signatures only. A constructor/read regression attempting
    // leaf derivation, transaction signing, or transfer claiming fails closed.
    const authenticationSigner = new Proxy(signer, {
      get(target, property) {
        if (
          property !== "getIdentityPublicKey" &&
          property !== "signMessageWithIdentityKey"
        ) {
          throw new Error(UNAVAILABLE)
        }
        return target[property].bind(target)
      },
    })
    wallet = new SparkWallet(
      {
        log: false,
        network: network === "mainnet" ? "MAINNET" : "REGTEST",
        optimizationOptions: { auto: false },
        tokenOptimizationOptions: { enabled: false },
      },
      authenticationSigner
    )
    assertCurrent()
    if (
      (await wallet.getIdentityPublicKey()).toLowerCase() !== expectedIdentity
    ) {
      throw new Error(UNAVAILABLE)
    }
    assertCurrent()
  } catch {
    closed = true
    try {
      await wallet?.cleanup()
    } catch {
      // Provider errors can contain identifiers; do not propagate or log them.
    }
    wallet = undefined
    throw new Error(UNAVAILABLE)
  }

  const read = async <T>(query: (native: NativeWallet) => Promise<T>) => {
    assertCurrent()
    try {
      const result = await query(wallet!)
      assertCurrent()
      return result
    } catch {
      throw new Error(UNAVAILABLE)
    }
  }
  const exactTransfer = async (native: NativeWallet, id: string) => {
    const transfer = await native.getTransfer(id)
    assertCurrent()
    if (!transfer) return undefined
    const incoming =
      transfer.receiverIdentityPublicKey?.toLowerCase() === expectedIdentity ||
      transfer.receivers?.some(
        (receiver) =>
          receiver.identityPublicKey.toLowerCase() === expectedIdentity
      )
    const outgoing =
      transfer.senderIdentityPublicKey?.toLowerCase() === expectedIdentity ||
      transfer.senders?.some(
        (sender) => sender.identityPublicKey.toLowerCase() === expectedIdentity
      )
    if (
      transfer.id !== id ||
      (!incoming && !outgoing) ||
      transfer.transferDirection !== (incoming ? "INCOMING" : "OUTGOING")
    ) {
      throw new Error(UNAVAILABLE)
    }
    return transfer
  }
  return Object.freeze({
    getIdentityPublicKey: () => read(() => Promise.resolve(expectedIdentity)),
    getLightningReceiveRequest: (id: string) =>
      read(async (native) => {
        const receive = await native.getLightningReceiveRequest(id)
        if (
          receive &&
          (receive.id !== id || receive.network !== network.toUpperCase())
        ) {
          throw new Error(UNAVAILABLE)
        }
        return receive
      }),
    getTransfer: (id: string) => read((native) => exactTransfer(native, id)),
    getTransferFromSsp: (id: string) =>
      read(async (native) => {
        const ssp = await native.getTransferFromSsp(id)
        assertCurrent()
        if (!ssp) return undefined
        const transfer = await exactTransfer(native, id)
        if (
          ssp.sparkId !== id ||
          !transfer ||
          transfer.transferDirection !== "OUTGOING" ||
          !transfer.userRequest ||
          transfer.userRequest.id !== ssp.userRequest?.id
        ) {
          throw new Error(UNAVAILABLE)
        }
        return ssp
      }),
    getLightningSendRequest: (id: string) =>
      read(async (native) => {
        const request = await native.getLightningSendRequest(id)
        if (request && request.id !== id) throw new Error(UNAVAILABLE)
        return request
      }),
    async cleanup() {
      if (closed) return
      closed = true
      const closingWallet = wallet
      wallet = undefined
      try {
        await closingWallet?.cleanup()
      } catch {
        throw new Error(UNAVAILABLE)
      }
    },
  })
}
