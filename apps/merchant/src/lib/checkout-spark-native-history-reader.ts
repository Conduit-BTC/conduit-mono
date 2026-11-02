import merchantPackage from "../../package.json"
import {
  inspectCheckoutSparkNativeTreasuryHistory,
  getCheckoutSparkNativeTreasuryPolicyForSdkVersion,
  type CheckoutSparkNativeTreasuryHistoryDiagnostic,
  type CheckoutSparkNativeTreasurySdkInput,
  type CheckoutSparkNativeTreasurySdkTransfer,
} from "@conduit/core"

type SparkSdk = typeof import("@buildonspark/spark-sdk")
type SparkTypes = typeof import("@buildonspark/spark-sdk/types")
type RawTransfer = Parameters<SparkTypes["mapTransferToWalletTransfer"]>[0]

export interface MerchantCheckoutSparkNativeHistoryInput {
  /** Supplied only within the authenticated exact-checkout recovery callback. */
  mnemonic: string
  accountNumber: number
  fundingIdentityPublicKey: string
  request: CheckoutSparkNativeTreasurySdkInput
  assertCurrent: () => void
  checkCurrent: () => Promise<void>
}

export interface MerchantCheckoutSparkNativeHistoryDependencies {
  loadSdk?: () => Promise<SparkSdk>
  loadTypes?: () => Promise<SparkTypes>
  sdkVersion?: string
  /** Tests may shorten, but never widen, the production read budgets. */
  timeoutMs?: number
  readTimeoutMs?: number
}

const UNAVAILABLE = "Checkout Spark native history is unavailable."
const PAGE_SIZE = 20
const MAX_PAGES = 2

function boundedBudget(value: number | undefined, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(maximum, value)
    : maximum
}

async function within<T>(
  operation: Promise<T>,
  milliseconds: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(UNAVAILABLE)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pinned authenticated queries only. No wallet initialization, claim/sync,
 * transaction signing, provider send, persistence, or payment-state mutation.
 * Raw provider facts and wallet material never leave this invocation.
 */
export async function inspectMerchantCheckoutSparkNativeHistory(
  input: MerchantCheckoutSparkNativeHistoryInput,
  dependencies: MerchantCheckoutSparkNativeHistoryDependencies = {}
): Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic> {
  const totalBudget = boundedBudget(dependencies.timeoutMs, 30_000)
  const readBudget = boundedBudget(dependencies.readTimeoutMs, 10_000)
  const cleanupReserve = Math.min(1_000, totalBudget / 10)
  const deadline = performance.now() + totalBudget
  let closed = false
  let seed: Uint8Array | undefined
  let cleanup: (() => Promise<void>) | undefined
  const assertCurrent = () => {
    if (closed || performance.now() >= deadline - cleanupReserve)
      throw new Error(UNAVAILABLE)
    input.assertCurrent()
  }
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent()
    const budget = () =>
      Math.max(
        1,
        Math.min(readBudget, deadline - cleanupReserve - performance.now())
      )
    await within(Promise.resolve().then(input.checkCurrent), budget())
    assertCurrent()
    const result = await within(
      Promise.resolve().then(() => {
        assertCurrent()
        return operation()
      }),
      budget()
    )
    assertCurrent()
    await within(Promise.resolve().then(input.checkCurrent), budget())
    assertCurrent()
    return result
  }
  const inspect =
    async (): Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic> => {
      assertCurrent()
      const request = structuredClone(input.request)
      const fundingIdentity = input.fundingIdentityPublicKey
      const accountNumber = input.accountNumber
      const sdkVersion =
        dependencies.sdkVersion ??
        merchantPackage.dependencies["@buildonspark/spark-sdk"]
      if (
        sdkVersion !== "0.13.0" ||
        !/^(02|03)[0-9a-f]{64}$/.test(fundingIdentity) ||
        fundingIdentity !== request.nativeTreasury.senderIdentityPublicKey ||
        !Number.isSafeInteger(accountNumber) ||
        accountNumber < 0 ||
        accountNumber > 0x7fffffff ||
        !["mainnet", "regtest"].includes(request.network)
      )
        return "unavailable"
      const mnemonic = input.mnemonic.trim().toLowerCase().replace(/\s+/g, " ")
      const [sdk, types, { validateMnemonic }, { wordlist }] = await read(() =>
        Promise.all([
          (dependencies.loadSdk ?? (() => import("@buildonspark/spark-sdk")))(),
          (
            dependencies.loadTypes ??
            (() => import("@buildonspark/spark-sdk/types"))
          )(),
          import("@scure/bip39"),
          import("@scure/bip39/wordlists/english.js"),
        ])
      )
      if (!validateMnemonic(mnemonic, wordlist)) return "unavailable"
      const signer = new sdk.DefaultSparkSigner()
      await read(async () => {
        const derivedSeed = await signer.mnemonicToSeed(mnemonic)
        if (closed) {
          derivedSeed.fill(0)
          throw new Error(UNAVAILABLE)
        }
        seed = derivedSeed
      })
      const walletSeed = seed!
      let identity: string
      try {
        identity = await read(() =>
          signer.createSparkWalletFromSeed(walletSeed, accountNumber)
        )
      } finally {
        walletSeed.fill(0)
        seed = undefined
      }
      assertCurrent()
      if (identity !== fundingIdentity) return "unavailable"
      const authenticationSigner = new Proxy(signer, {
        get(target, property) {
          if (
            property !== "getIdentityPublicKey" &&
            property !== "signMessageWithIdentityKey"
          )
            throw new Error(UNAVAILABLE)
          const method = Reflect.get(target, property, target)
          return (...args: unknown[]) => {
            assertCurrent()
            return Reflect.apply(method, target, args)
          }
        },
      })
      class HistoryReader extends sdk.SparkReadonlyClient {
        async dispose() {
          await Promise.allSettled([
            Promise.resolve().then(() =>
              this.connectionManager.closeConnections()
            ),
            Promise.resolve().then(() => this.logging.close()),
          ])
        }
      }
      const network = request.network === "mainnet" ? "MAINNET" : "REGTEST"
      const reader = HistoryReader.createWithSigner(
        { network, log: false },
        authenticationSigner
      )
      cleanup = () => reader.dispose()
      assertCurrent()
      const sparkAddress = sdk.encodeSparkAddress({
        network,
        identityPublicKey: identity,
      })
      // These are the pinned SDK's protobuf network values, not address strings.
      const expectedRawNetwork = request.network === "mainnet" ? 1 : 2
      const map = (
        transfer: RawTransfer
      ): CheckoutSparkNativeTreasurySdkTransfer => {
        assertCurrent()
        if (transfer.network !== expectedRawNetwork)
          throw new Error(UNAVAILABLE)
        return types.mapTransferToWalletTransfer(transfer, identity)
      }
      const invoiceQuery = await read(() =>
        reader.getSparkInvoices({
          invoices: [request.nativeTreasury.invoiceRequest],
          limit: 1,
          offset: 0,
        })
      ).catch(() => null)
      let transfers: CheckoutSparkNativeTreasurySdkTransfer[] | null
      try {
        transfers = []
        let offset = 0
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await read(() =>
            reader.getTransfers({ sparkAddress, limit: PAGE_SIZE, offset })
          )
          if (
            !Array.isArray(result.transfers) ||
            result.transfers.length > PAGE_SIZE ||
            !Number.isSafeInteger(result.offset) ||
            result.offset < -1 ||
            (result.offset !== -1 && result.offset <= offset)
          )
            throw new Error(UNAVAILABLE)
          transfers.push(...result.transfers.map(map))
          if (result.offset === -1) break
          offset = result.offset
        }
      } catch {
        transfers = null
      }
      assertCurrent()
      const result = await inspectCheckoutSparkNativeTreasuryHistory({
        codec: {
          nativeTreasuryPolicy:
            getCheckoutSparkNativeTreasuryPolicyForSdkVersion(sdkVersion),
          parseTransferId: sdk.UUID.parse,
          encodeSparkAddress: sdk.encodeSparkAddress,
          decodeSparkAddress: sdk.decodeSparkAddress,
          isValidSparkAddress: sdk.isValidSparkAddress,
          getNetworkFromSparkAddress: sdk.getNetworkFromSparkAddress,
        },
        network,
        request,
        walletIdentityPublicKey: identity,
        invoiceQuery,
        transfers,
        getTransfer: async (id) => {
          assertCurrent()
          if (sdk.UUID.parse(id).toString() !== id) throw new Error(UNAVAILABLE)
          const exact = await read(() => reader.getTransfersByIds([id]))
          if (exact.length === 0) return undefined
          if (exact.length !== 1 || exact[0]!.id !== id)
            throw new Error(UNAVAILABLE)
          return map(exact[0]!)
        },
      })
      await read(async () => undefined)
      return result
    }
  try {
    return await within(inspect(), Math.max(1, totalBudget - cleanupReserve))
  } catch {
    return "unavailable"
  } finally {
    closed = true
    seed?.fill(0)
    if (cleanup) {
      try {
        await within(cleanup(), Math.max(1, deadline - performance.now()))
      } catch {
        // Best effort and bounded; provider details never escape or get logged.
      }
    }
  }
}
