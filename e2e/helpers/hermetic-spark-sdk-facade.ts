import type {
  SparkNativeModule,
  SparkNativeWallet,
} from "../../apps/market/src/lib/spark-sdk"
import type { CheckoutSparkNativeRetirementReader } from "@conduit/core"
import { HERMETIC_SPARK_SSP_IDENTITY_PUBLIC_KEY } from "./hermetic-spark-native"
import type {
  HermeticSparkRequestFn,
  WalletMethod,
  ReaderMethod,
} from "./hermetic-spark-transport-types"
import { OBSERVATION_METHODS } from "./hermetic-spark-transport-types"

type PureSdk = Pick<
  typeof import("../../apps/market/node_modules/@buildonspark/spark-sdk"),
  | "DefaultSparkSigner"
  | "UUID"
  | "SparkWalletEvent"
  | "SparkValidationError"
  | "Network"
  | "NetworkToProto"
  | "parseCompressedPublicKeyHex"
  | "manifestGrossSats"
  | "manifestNetSatsFor"
  | "manifestFeeSats"
  | "ReceiveQuoteAmountBasis"
  | "decodeSparkAddress"
  | "encodeSparkAddress"
  | "getNetworkFromSparkAddress"
  | "isValidSparkAddress"
>
type NativeConfig = { network?: string; log?: boolean }
type ReaderSigner = Pick<
  InstanceType<PureSdk["DefaultSparkSigner"]>,
  "getIdentityPublicKey" | "signSchnorrWithIdentityKey"
>
type ObservationSigner = Pick<
  InstanceType<PureSdk["DefaultSparkSigner"]>,
  "getIdentityPublicKey" | "signMessageWithIdentityKey"
>

function unavailable(): never {
  throw new Error("Hermetic Spark SDK unavailable")
}
function requireRegtest(options?: NativeConfig) {
  if (options?.network !== "REGTEST" || options.log !== false) unavailable()
}
function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function reviveParticipant(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw
  const participant = raw as { identityPublicKey?: unknown }
  const key = participant.identityPublicKey
  return Array.isArray(key) &&
    key.length === 33 &&
    key.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? { ...participant, identityPublicKey: Uint8Array.from(key) }
    : raw
}

/** Test-only external SDK replacement; application adapters are not replaced. */
export function createHermeticSparkSdkFacade(input: {
  request: HermeticSparkRequestFn
  pureSdk: PureSdk
}) {
  class SparkWallet implements SparkNativeWallet {
    #handle: string | undefined
    #closed = false
    #observationSigner: ObservationSigner | undefined
    #observationOpening: Promise<{ handle: string }> | undefined
    protected readonly config: {
      signer: InstanceType<PureSdk["DefaultSparkSigner"]>
      getSspIdentityPublicKey(): string
    }
    constructor(options?: NativeConfig, signer?: unknown) {
      requireRegtest(options)
      this.#observationSigner = signer as ObservationSigner | undefined
      this.config = {
        signer: (signer ??
          new input.pureSdk.DefaultSparkSigner()) as InstanceType<
          PureSdk["DefaultSparkSigner"]
        >,
        getSspIdentityPublicKey: () => HERMETIC_SPARK_SSP_IDENTITY_PUBLIC_KEY,
      }
    }
    private async openObservation() {
      if (this.#closed || !this.#observationSigner) unavailable()
      const identityPublicKey = hex(
        await this.#observationSigner.getIdentityPublicKey()
      )
      if (this.#closed) unavailable()
      const challenge = (await input.request({
        type: "observation.challenge",
        identityPublicKey,
        network: "REGTEST",
      })) as { challengeId: string; digest: string }
      if (this.#closed || !/^[0-9a-f]{64}$/.test(challenge.digest))
        unavailable()
      const digest = Uint8Array.from(
        challenge.digest.match(/../g)!.map((byte) => parseInt(byte, 16))
      )
      const signature = hex(
        await this.#observationSigner.signMessageWithIdentityKey(digest)
      )
      if (this.#closed) unavailable()
      const opened = (await input.request({
        type: "observation.open",
        challengeId: challenge.challengeId,
        signature,
      })) as { handle: string }
      if (this.#closed) {
        await input.request({
          type: "observation.close",
          handle: opened.handle,
        })
        unavailable()
      }
      return opened
    }
    static async initialize<T extends SparkWallet>(
      this: new (options?: NativeConfig, signer?: unknown) => T,
      request: Parameters<SparkNativeModule["initialize"]>[0]
    ): Promise<{ wallet: T }> {
      const wallet = new this(request.options)
      await wallet.initializeNative(request)
      return { wallet }
    }
    private async initializeNative(
      request: Parameters<SparkNativeModule["initialize"]>[0]
    ) {
      // Mirror the SDK's initialized signer so its real adapter subclass can
      // authenticate a readonly session. The runner independently verifies the
      // resulting identity challenge; no application proof is injected.
      const seed = await this.config.signer.mnemonicToSeed(
        request.mnemonicOrSeed
      )
      try {
        await this.config.signer.createSparkWalletFromSeed(
          seed,
          request.accountNumber
        )
      } finally {
        seed.fill(0)
      }
      const result = (await input.request({
        type: "wallet.open",
        input: request,
      })) as { handle: string }
      this.#handle = result.handle
      if (this.#closed) {
        await this.cleanup()
        unavailable()
      }
    }
    private async call<K extends WalletMethod>(
      method: K,
      args: unknown[]
    ): Promise<Awaited<ReturnType<NonNullable<SparkNativeWallet[K]>>>> {
      if (this.#closed) unavailable()
      if (this.#observationSigner) {
        if (!OBSERVATION_METHODS.some((allowed) => allowed === method))
          unavailable()
        this.#observationOpening ??= this.openObservation()
        const opened = await this.#observationOpening
        if (this.#closed) unavailable()
        return (await input.request({
          type: "observation.call",
          handle: opened.handle,
          method: method as (typeof OBSERVATION_METHODS)[number],
          args,
        })) as Awaited<ReturnType<NonNullable<SparkNativeWallet[K]>>>
      }
      if (!this.#handle) unavailable()
      return (await input.request({
        type: "wallet.call",
        handle: this.#handle,
        method,
        args,
      })) as Awaited<ReturnType<NonNullable<SparkNativeWallet[K]>>>
    }
    on() {
      if (this.#closed) unavailable()
    }
    off() {
      if (this.#closed) unavailable()
    }
    async cleanup() {
      this.#closed = true
      const handle = this.#handle
      this.#handle = undefined
      if (handle) await input.request({ type: "wallet.close", handle })
      const observation = await this.#observationOpening?.catch(() => undefined)
      this.#observationOpening = undefined
      if (observation)
        await input.request({
          type: "observation.close",
          handle: observation.handle,
        })
    }
    setPrivacyEnabled(enabled: boolean) {
      return this.call("setPrivacyEnabled", [enabled])
    }
    getWalletSettings() {
      return this.call("getWalletSettings", [])
    }
    getBalance() {
      return this.call("getBalance", [])
    }
    getTransfers(limit?: number, offset?: number) {
      return this.call("getTransfers", [limit, offset])
    }
    getSparkAddress() {
      return this.call("getSparkAddress", [])
    }
    transfer(request: Parameters<SparkNativeWallet["transfer"]>[0]) {
      return this.call("transfer", [request])
    }
    getTransfer(id: string) {
      return this.call("getTransfer", [id])
    }
    async querySparkInvoices(invoices: string[]) {
      const result = await this.call("querySparkInvoices", [invoices])
      return {
        ...result,
        invoiceStatuses: result.invoiceStatuses.map((entry) => ({
          ...entry,
          ...(entry.transferType?.$case === "satsTransfer"
            ? {
                transferType: {
                  $case: "satsTransfer" as const,
                  satsTransfer: {
                    transferId: Uint8Array.from(
                      entry.transferType.satsTransfer.transferId
                    ),
                  },
                },
              }
            : {}),
        })),
      }
    }
    fulfillSparkInvoice(invoices: Array<{ invoice: string; amount: bigint }>) {
      return this.call("fulfillSparkInvoice", [
        invoices.map((item) => ({ ...item, amount: item.amount.toString() })),
      ])
    }
    getTransferFromSsp(id: string) {
      return this.call("getTransferFromSsp", [id])
    }
    queryHTLC(
      request: Parameters<NonNullable<SparkNativeWallet["queryHTLC"]>>[0]
    ) {
      return this.call("queryHTLC", [request])
    }
    getLeaves() {
      return this.call("getLeaves", [])
    }
    createLightningInvoice(
      request: Parameters<SparkNativeWallet["createLightningInvoice"]>[0]
    ) {
      return this.call("createLightningInvoice", [request])
    }
    getIdentityPublicKey() {
      return this.call("getIdentityPublicKey", [])
    }
    getLightningReceiveQuote(
      request: Parameters<SparkNativeWallet["getLightningReceiveQuote"]>[0]
    ) {
      return this.call("getLightningReceiveQuote", [request])
    }
    getLightningReceiveRequest(id: string) {
      return this.call("getLightningReceiveRequest", [id])
    }
    getLightningSendFeeEstimate(
      request: Parameters<SparkNativeWallet["getLightningSendFeeEstimate"]>[0]
    ) {
      return this.call("getLightningSendFeeEstimate", [request])
    }
    payLightningInvoice(
      request: Parameters<SparkNativeWallet["payLightningInvoice"]>[0]
    ) {
      return this.call("payLightningInvoice", [
        { ...request, transferId: request.transferId?.toString() },
      ])
    }
    getLightningSendRequest(id: string) {
      return this.call("getLightningSendRequest", [id])
    }
  }
  class SparkReadonlyClient {
    #closed = false
    #opening: Promise<{ handle: string; sparkAddress: string }> | undefined
    constructor(
      _options?: NativeConfig,
      private readonly signer?: ReaderSigner,
      private readonly authMode: "identity" | "none" = "identity"
    ) {
      requireRegtest(_options)
    }
    static createPublic<T extends SparkReadonlyClient>(
      this: new (
        options?: NativeConfig,
        signer?: ReaderSigner,
        authMode?: "identity" | "none"
      ) => T,
      options?: NativeConfig
    ): T {
      return new this(options, undefined, "none")
    }
    static createWithSigner<T extends SparkReadonlyClient>(
      this: new (
        options?: NativeConfig,
        signer?: ReaderSigner,
        authMode?: "identity" | "none"
      ) => T,
      options: NativeConfig,
      signer: ReaderSigner
    ): T {
      return new this(options, signer, "identity")
    }
    protected readonly connectionManager = {
      closeConnections: async () => {
        this.#closed = true
        const opened = await this.#opening?.catch(() => undefined)
        if (opened)
          await input.request({ type: "reader.close", handle: opened.handle })
      },
    }
    protected readonly logging = { async close() {} }
    private async open() {
      if (this.#closed || !this.signer || this.authMode !== "identity")
        unavailable()
      const identityPublicKey = hex(await this.signer.getIdentityPublicKey())
      const challenge = (await input.request({
        type: "reader.challenge",
        identityPublicKey,
        network: "REGTEST",
      })) as { challengeId: string; digest: string }
      if (!/^[0-9a-f]{64}$/.test(challenge.digest)) unavailable()
      const digest = Uint8Array.from(
        challenge.digest.match(/../g)!.map((byte) => parseInt(byte, 16))
      )
      const signature = hex(
        await this.signer.signSchnorrWithIdentityKey(digest)
      )
      const opened = (await input.request({
        type: "reader.open",
        challengeId: challenge.challengeId,
        signature,
      })) as { handle: string; sparkAddress: string }
      if (this.#closed) {
        await input.request({ type: "reader.close", handle: opened.handle })
        unavailable()
      }
      return opened
    }
    private async call<K extends ReaderMethod>(
      method: K,
      args: unknown[]
    ): Promise<
      Awaited<ReturnType<NonNullable<CheckoutSparkNativeRetirementReader[K]>>>
    > {
      if (this.#closed) unavailable()
      this.#opening ??= this.open()
      const opened = await this.#opening
      if (this.#closed) unavailable()
      return (await input.request({
        type: "reader.call",
        handle: opened.handle,
        method,
        args,
      })) as Awaited<
        ReturnType<NonNullable<CheckoutSparkNativeRetirementReader[K]>>
      >
    }
    async getTransfers(request: {
      sparkAddress: string
      limit?: number
      offset?: number
      types?: Parameters<
        CheckoutSparkNativeRetirementReader["getTransfers"]
      >[0]["types"]
    }) {
      if (this.#closed) unavailable()
      if (this.authMode === "none") return { transfers: [], offset: -1 }
      const result = await this.call("getTransfers", [
        {
          ...request,
          types: request.types ?? [0, 1, 2, 3, 4, 5, 30, 40],
          limit: request.limit ?? 100,
          offset: request.offset ?? 0,
        },
      ])
      return {
        ...result,
        transfers: result.transfers.map((transfer) => ({
          ...transfer,
          ...(Array.isArray(transfer.senders)
            ? { senders: transfer.senders.map(reviveParticipant) }
            : {}),
          ...(Array.isArray(transfer.receivers)
            ? { receivers: transfer.receivers.map(reviveParticipant) }
            : {}),
        })),
      }
    }
    async getPendingTransfers(address: string) {
      if (this.#closed) unavailable()
      if (this.authMode === "none") return []
      return this.call("getPendingTransfers", [address])
    }
    async getAvailableBalance(address: string) {
      if (this.#closed) unavailable()
      if (this.authMode === "none") return 0n
      return this.call("getAvailableBalance", [address])
    }
    async getOwnedBalance(address: string) {
      if (this.#closed) unavailable()
      if (this.authMode === "none") return 0n
      return this.call("getOwnedBalance", [address])
    }
  }
  return {
    SparkWallet,
    SparkReadonlyClient,
    DefaultSparkSigner: input.pureSdk.DefaultSparkSigner,
    UUID: input.pureSdk.UUID,
    SparkWalletEvent: input.pureSdk.SparkWalletEvent,
    SparkValidationError: input.pureSdk.SparkValidationError,
    Network: input.pureSdk.Network,
    NetworkToProto: input.pureSdk.NetworkToProto,
    parseCompressedPublicKeyHex: input.pureSdk.parseCompressedPublicKeyHex,
    manifestGrossSats: input.pureSdk.manifestGrossSats,
    manifestNetSatsFor: input.pureSdk.manifestNetSatsFor,
    manifestFeeSats: input.pureSdk.manifestFeeSats,
    ReceiveQuoteAmountBasis: input.pureSdk.ReceiveQuoteAmountBasis,
    decodeSparkAddress: input.pureSdk.decodeSparkAddress,
    encodeSparkAddress: input.pureSdk.encodeSparkAddress,
    getNetworkFromSparkAddress: input.pureSdk.getNetworkFromSparkAddress,
    isValidSparkAddress: input.pureSdk.isValidSparkAddress,
  }
}
