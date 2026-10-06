import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
} from "../../packages/core/src/protocol/lightning"
import type { CheckoutSparkNativeRetirementReader } from "@conduit/core"
import { CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY } from "../../packages/core/src/protocol/checkout-spark-treasury-sdk"
import type {
  SparkNativeModule,
  SparkNativeWallet,
} from "../../apps/market/src/lib/spark-sdk"

type NativeReceive = Awaited<
  ReturnType<SparkNativeWallet["createLightningInvoice"]>
>
type NativeTransfer = NonNullable<
  Awaited<ReturnType<SparkNativeWallet["getTransfer"]>>
>
type NativeSend = NonNullable<
  Awaited<ReturnType<SparkNativeWallet["getLightningSendRequest"]>>
>
type NativeSspTransfer = NonNullable<
  Awaited<ReturnType<SparkNativeWallet["getTransferFromSsp"]>>
>
type NativeHistoryTransfer = Awaited<
  ReturnType<CheckoutSparkNativeRetirementReader["getPendingTransfers"]>
>[number]

/** Public deterministic secp256k1 test point; never a provider destination. */
export const HERMETIC_SPARK_SSP_IDENTITY_PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

interface HermeticPayout {
  paymentRequest: string
  preimage: string
  feeSats: number
}
type NativeInvoiceCodec = Pick<
  SparkNativeModule,
  | "parseTransferId"
  | "encodeSparkAddress"
  | "decodeSparkAddress"
  | "isValidSparkAddress"
  | "getNetworkFromSparkAddress"
>

function unsupported(): never {
  throw new Error("Unsupported hermetic Spark operation")
}

/**
 * Explicit-network native provider fixture, defaulting to regtest. It never
 * imports the Spark SDK, opens a connection, or creates application
 * credit/settlement proofs. Signed
 * invoices come from the test runner; invoice-signing keys stay outside this
 * module and any future browser transport. The runner must retain this registry
 * across client reconnects; it is not disk or browser-reload persistence.
 */
export function createHermeticSparkNative(input: {
  /** Fixed runner configuration; never inferred from a client request or env. */
  network?: "mainnet" | "regtest"
  /** Runner supplies the real local-only mnemonic/account derivation. */
  deriveIdentity: (mnemonic: string, accountNumber: number) => Promise<string>
  /** Optional real SDK encoder supplied by the runner, without provider I/O. */
  encodeAddress?: (identityPublicKey: string) => string
  /** Public pure codecs only. Supplying them enables synthetic native invoices. */
  nativeInvoiceCodec?: NativeInvoiceCodec
  issueFundingInvoice: (request: {
    identityPublicKey: string
    amountSats: number
    expirySeconds: number
  }) => Promise<string>
}) {
  const network = input.network ?? "regtest"
  if (network !== "mainnet" && network !== "regtest") unsupported()
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  const accounts = new Map<
    string,
    {
      identityPublicKey: string
      native: ReturnType<typeof createHermeticWalletNative>
    }
  >()
  async function getAccount(request: {
    mnemonic: string
    accountNumber: number
    network: string
  }) {
    if (
      request.network !== network ||
      !Number.isSafeInteger(request.accountNumber) ||
      request.accountNumber < 0 ||
      request.accountNumber > 0x7fffffff
    )
      unsupported()
    const identityPublicKey = (
      await input.deriveIdentity(request.mnemonic, request.accountNumber)
    ).toLowerCase()
    if (!/^(02|03)[0-9a-f]{64}$/.test(identityPublicKey)) unsupported()
    const key = `${network}:${request.accountNumber}:${identityPublicKey}`
    let account = accounts.get(key)
    if (!account) {
      account = {
        identityPublicKey,
        native: createHermeticWalletNative({
          network,
          identityPublicKey,
          accountNumber: request.accountNumber,
          sparkAddress: input.encodeAddress?.(identityPublicKey),
          nativeInvoiceCodec: input.nativeInvoiceCodec,
          issueFundingInvoice: (invoice) =>
            input.issueFundingInvoice({ ...invoice, identityPublicKey }),
        }),
      }
      accounts.set(key, account)
    }
    return account.native
  }
  const module = createNativeModule(
    async (request) => {
      if (request.options.network !== nativeNetwork) unsupported()
      const account = await getAccount({
        mnemonic: request.mnemonicOrSeed,
        accountNumber: request.accountNumber,
        network,
      })
      return { wallet: account.openWallet() }
    },
    nativeNetwork,
    input.nativeInvoiceCodec
  )
  return {
    module,
    async openAuthenticatedRetirementReader(request: {
      mnemonic: string
      accountNumber: number
      network: string
    }) {
      const account = await getAccount(request)
      return account.openReader()
    },
    control: {
      forIdentity(identityPublicKey: string) {
        const matches = [...accounts.values()].filter(
          (account) => account.identityPublicKey === identityPublicKey
        )
        if (matches.length !== 1) unsupported()
        return matches[0]!.native.control
      },
    },
  }
}

function createHermeticWalletNative(input: {
  network: "mainnet" | "regtest"
  identityPublicKey: string
  accountNumber: number
  sparkAddress?: string
  nativeInvoiceCodec?: NativeInvoiceCodec
  issueFundingInvoice: (request: {
    amountSats: number
    expirySeconds: number
  }) => Promise<string>
}) {
  const network = input.network
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  // Spark 0.13.0 protobuf Network: MAINNET=1, REGTEST=2.
  const historyNetwork = network === "mainnet" ? 1 : 2
  const identityPublicKey = input.identityPublicKey
  const issueFundingInvoice = input.issueFundingInvoice
  const accountId = `${network}:${input.accountNumber}:${identityPublicKey}`
  const sparkAddress = input.sparkAddress ?? `hermetic-${accountId}`
  let fundingRequested = false
  let receive: NativeReceive | undefined
  let incomingTransfer: NativeTransfer | undefined
  let availableSats = 0
  let additionalOwnedSats = 0
  let pendingTransfers: NativeHistoryTransfer[] = []
  let fundingInvoiceCount = 0
  let sendInvocationCount = 0
  let outgoingPaymentCount = 0
  let debitedSats = 0
  let privateEnabled = false
  const payouts = new Map<string, HermeticPayout>()
  const nativeOutgoing = new Map<string, NativeTransfer>()
  const returnedHtlcs: Array<{
    paymentHash: Uint8Array
    [key: string]: unknown
  }> = []
  let nativeSendInvocationCount = 0
  let nativePaymentCount = 0
  let nativeCompleted = true
  let nativeLostResponse = false
  let extraHistory: NativeHistoryTransfer[] = []
  const extraSspTransfers = new Map<string, NativeSspTransfer>()
  const outgoing = new Map<
    string,
    {
      invoice: string
      request: NativeSend
      transfer: NativeSspTransfer
      nativeTransfer: NativeTransfer
    }
  >()
  function history(): NativeTransfer[] {
    return [
      ...(incomingTransfer ? [incomingTransfer] : []),
      ...[...outgoing.values()].map((row) => row.nativeTransfer),
      ...nativeOutgoing.values(),
    ]
  }
  function openReader() {
    let closed = false
    function assertAddress(address: string) {
      if (closed) throw new Error("Hermetic Spark session is closed")
      if (address !== sparkAddress) unsupported()
    }
    const reader: CheckoutSparkNativeRetirementReader = {
      async getTransfers(request) {
        assertAddress(request.sparkAddress)
        // Spark 0.13.0 protobuf: PREIMAGE_SWAP=0, COMPLETED=5.
        const transfers = history()
          .flatMap(({ id, totalValue, type, status }) => {
            const nativeType = type === "TRANSFER" ? 1 : 0
            return request.types.includes(nativeType)
              ? [
                  {
                    id,
                    totalValue,
                    type: nativeType,
                    status:
                      status === "TRANSFER_STATUS_COMPLETED"
                        ? 5
                        : status === "TRANSFER_STATUS_RETURNED"
                          ? 7
                          : 3,
                    network: historyNetwork,
                  },
                ]
              : []
          })
          .concat(
            extraHistory.filter((row) =>
              request.types.some((type) => type === row.type)
            )
          )
        return page(transfers, request.limit, request.offset)
      },
      async getPendingTransfers(address) {
        assertAddress(address)
        return structuredClone(pendingTransfers)
      },
      async getAvailableBalance(address) {
        assertAddress(address)
        return BigInt(availableSats)
      },
      async getOwnedBalance(address) {
        assertAddress(address)
        return BigInt(availableSats) + BigInt(additionalOwnedSats)
      },
    }
    return {
      reader,
      sparkAddress,
      async cleanup() {
        closed = true
      },
    }
  }
  function openWallet(): SparkNativeWallet {
    let closed = false
    function assertOpen() {
      if (closed) throw new Error("Hermetic Spark session is closed")
    }
    return {
      on() {
        assertOpen()
      },
      off() {
        assertOpen()
      },
      async cleanup() {
        closed = true
      },
      async setPrivacyEnabled(enabled) {
        assertOpen()
        privateEnabled = enabled
        return { privateEnabled }
      },
      async getWalletSettings() {
        assertOpen()
        return { privateEnabled }
      },
      async getBalance() {
        assertOpen()
        return {
          balance: BigInt(availableSats),
          satsBalance: {
            available: BigInt(availableSats),
            owned: BigInt(availableSats) + BigInt(additionalOwnedSats),
            incoming: 0n,
          },
        }
      },
      async getTransfers(limit = 100, offset = 0) {
        assertOpen()
        return page(history(), limit, offset)
      },
      async getSparkAddress() {
        assertOpen()
        return sparkAddress
      },
      async openRetirementReader() {
        assertOpen()
        return openReader()
      },
      transfer: unsupported,
      async queryHTLC(request) {
        assertOpen()
        return {
          preimageRequests: structuredClone(
            returnedHtlcs.filter((row) =>
              request.paymentHashes.some(
                (hash) => hash === Buffer.from(row.paymentHash).toString("hex")
              )
            )
          ),
          offset: -1,
        }
      },
      getLeaves: unsupported,
      async querySparkInvoices(invoices) {
        assertOpen()
        if (!input.nativeInvoiceCodec) unsupported()
        return {
          offset: -1,
          invoiceStatuses: invoices.map((invoice) => {
            const decoded = input.nativeInvoiceCodec!.decodeSparkAddress(
              invoice,
              nativeNetwork
            )
            if (!decoded.sparkInvoiceFields) unsupported()
            const transfer = nativeOutgoing.get(invoice)
            return transfer
              ? {
                  invoice,
                  status: 2,
                  transferType: {
                    $case: "satsTransfer" as const,
                    satsTransfer: {
                      transferId: input.nativeInvoiceCodec!.parseTransferId(
                        transfer.id
                      ).bytes,
                    },
                  },
                }
              : { invoice, status: 0 }
          }),
        }
      },
      async fulfillSparkInvoice(invoices) {
        assertOpen()
        nativeSendInvocationCount += 1
        const codec = input.nativeInvoiceCodec
        if (!codec || invoices.length !== 1) unsupported()
        const { invoice, amount } = invoices[0]!
        const decoded = codec.decodeSparkAddress(invoice, nativeNetwork)
        const fields = decoded.sparkInvoiceFields as
          | {
              version?: number
              id?: string
              paymentType?: { type: string; amount?: number }
              senderPublicKey?: string
            }
          | undefined
        const sender = fields?.senderPublicKey
        const amountSats = Number(amount)
        if (
          !fields ||
          fields.version !== 1 ||
          !fields.id ||
          codec.parseTransferId(fields.id).bytes.length !== 16 ||
          fields.paymentType?.type !== "sats" ||
          fields.paymentType.amount !== undefined ||
          sender !== identityPublicKey ||
          !decoded.identityPublicKey ||
          !Number.isSafeInteger(amountSats) ||
          amountSats <= 0 ||
          nativeOutgoing.has(invoice) ||
          availableSats < amountSats
        )
          unsupported()
        const transfer: NativeTransfer = {
          id: crypto.randomUUID(),
          type: "TRANSFER",
          transferDirection: "OUTGOING",
          totalValue: amountSats,
          status: nativeCompleted
            ? "TRANSFER_STATUS_COMPLETED"
            : "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
          valueSentByWallet: amountSats,
          valueReceivedByWallet: 0,
          sparkInvoice: invoice,
          senderIdentityPublicKey: identityPublicKey,
          receiverIdentityPublicKey: decoded.identityPublicKey,
          senders: [{ identityPublicKey }],
          receivers: [
            {
              identityPublicKey: decoded.identityPublicKey,
              amountSats,
              status: nativeCompleted
                ? "TRANSFER_RECEIVER_STATUS_COMPLETED"
                : "TRANSFER_RECEIVER_STATUS_KEY_TWEAK_PENDING",
            },
          ],
        }
        nativeOutgoing.set(invoice, transfer)
        availableSats -= amountSats
        debitedSats += amountSats
        nativePaymentCount += 1
        if (nativeLostResponse)
          throw new Error("Synthetic native response lost")
        // A completed response is still not a receipt; adapters must query exact history.
        return { sats: [structuredClone(transfer)] }
      },
      async getTransfer(id) {
        assertOpen()
        const saved = history().find((transfer) => transfer.id === id)
        return saved ? structuredClone(saved) : undefined
      },
      async getTransferFromSsp(id) {
        assertOpen()
        const extra = extraSspTransfers.get(id)
        if (extra) return structuredClone(extra)
        const saved = outgoing.get(id)
        return saved ? structuredClone(saved.transfer) : undefined
      },
      async createLightningInvoice(request) {
        assertOpen()
        if (fundingRequested)
          throw new Error("Hermetic funding invoice already exists")
        if (
          !Number.isSafeInteger(request.amountSats) ||
          request.amountSats <= 0
        )
          unsupported()
        fundingRequested = true
        const encodedInvoice = await issueFundingInvoice({
          amountSats: request.amountSats,
          expirySeconds: request.expirySeconds ?? 900,
        })
        const metadata = decodeLightningInvoiceMetadata(encodedInvoice)
        const paymentHash = decodeLightningInvoicePaymentHash(encodedInvoice)
        if (
          getLightningInvoiceNetwork(encodedInvoice) !== network ||
          metadata.sats !== request.amountSats ||
          metadata.createdAt === null ||
          metadata.expiresAt === null ||
          !paymentHash
        ) {
          throw new Error(
            "Hermetic fixture requires a signed invoice for its configured network"
          )
        }
        receive = {
          id: `hermetic-funding-receive:${accountId}`,
          status: "LIGHTNING_PAYMENT_PENDING",
          network: nativeNetwork,
          invoice: {
            encodedInvoice,
            bitcoinNetwork: nativeNetwork,
            paymentHash,
            amount: {
              originalValue: request.amountSats,
              originalUnit: "SATOSHI",
            },
            createdAt: new Date(metadata.createdAt * 1_000).toISOString(),
            expiresAt: new Date(metadata.expiresAt * 1_000).toISOString(),
          },
        }
        fundingInvoiceCount += 1
        return structuredClone(receive)
      },
      async getIdentityPublicKey() {
        assertOpen()
        return identityPublicKey
      },
      getLightningReceiveQuote: unsupported,
      async getLightningReceiveRequest(id) {
        assertOpen()
        return receive?.id === id ? structuredClone(receive) : null
      },
      async getLightningSendFeeEstimate({ encodedInvoice }) {
        assertOpen()
        const payout = payouts.get(encodedInvoice)
        if (!payout) unsupported()
        return payout.feeSats
      },
      async payLightningInvoice(request) {
        assertOpen()
        sendInvocationCount += 1
        const transferId = request.transferId?.toString()
        const payout = payouts.get(request.invoice)
        if (!transferId || !payout || request.preferSpark !== false)
          unsupported()
        const previous = outgoing.get(transferId)
        if (previous) {
          if (previous.invoice !== request.invoice) unsupported()
          return structuredClone(previous.request)
        }
        const amountSats = decodeLightningInvoiceMetadata(request.invoice).sats
        if (
          amountSats === null ||
          payout.feeSats > request.maxFeeSats ||
          availableSats < amountSats + payout.feeSats
        )
          unsupported()
        const debit = amountSats + payout.feeSats
        const completed = {
          id: `hermetic-send:${transferId}`,
          typename: "LightningSendRequest",
          encodedInvoice: request.invoice,
          idempotencyKey: transferId,
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: payout.feeSats, originalUnit: "SATOSHI" },
          paymentPreimage: payout.preimage,
        }
        outgoing.set(transferId, {
          invoice: request.invoice,
          request: completed,
          nativeTransfer: {
            id: transferId,
            status: "TRANSFER_STATUS_COMPLETED",
            totalValue: debit,
            type: "LIGHTNING",
            transferDirection: "OUTGOING",
            userRequest: completed,
          },
          transfer: {
            sparkId: transferId,
            totalAmount: { originalValue: debit, originalUnit: "SATOSHI" },
            userRequest: {
              ...completed,
            },
          },
        })
        availableSats -= debit
        debitedSats += debit
        outgoingPaymentCount += 1
        // The send reply alone does not supply completion. The real adapter must
        // read the exact transfer/request history to recover its preimage/debit.
        return {
          ...completed,
          status: "LIGHTNING_PAYMENT_INITIATED",
          paymentPreimage: null,
        }
      },
      async getLightningSendRequest(id) {
        assertOpen()
        const saved = [...outgoing.values()].find(
          (row) => row.request.id === id
        )
        return saved ? structuredClone(saved.request) : null
      },
    }
  }
  return {
    openWallet,
    openReader,
    control: {
      setNativeCompletion(completed: boolean) {
        nativeCompleted = completed
        for (const transfer of nativeOutgoing.values()) {
          transfer.status = completed
            ? "TRANSFER_STATUS_COMPLETED"
            : "TRANSFER_STATUS_SENDER_KEY_TWEAKED"
          transfer.receivers![0]!.status = completed
            ? "TRANSFER_RECEIVER_STATUS_COMPLETED"
            : "TRANSFER_RECEIVER_STATUS_KEY_TWEAK_PENDING"
        }
      },
      setNativeLostResponse(lost: boolean) {
        nativeLostResponse = lost
      },
      setExtraHistory(transfers: readonly NativeHistoryTransfer[]) {
        extraHistory = structuredClone([...transfers])
      },
      /** Raw external-provider replies only; core derives any swap evidence. */
      setExtraSspTransfers(transfers: readonly NativeSspTransfer[]) {
        if (transfers.some((transfer) => !transfer.sparkId)) unsupported()
        extraSspTransfers.clear()
        for (const transfer of transfers) {
          extraSspTransfers.set(transfer.sparkId!, structuredClone(transfer))
        }
      },
      addUnattributedAvailableSats(sats: number) {
        if (
          !Number.isSafeInteger(sats) ||
          sats < 0 ||
          !Number.isSafeInteger(availableSats + sats)
        )
          unsupported()
        availableSats += sats
      },
      nativeSnapshot() {
        return {
          nativeSendInvocationCount,
          nativePaymentCount,
          transfers: structuredClone([...nativeOutgoing.values()]),
        }
      },
      setPendingTransfers(transfers: readonly NativeHistoryTransfer[]) {
        if (
          transfers.some(
            (transfer) =>
              transfer.network !== historyNetwork ||
              !Number.isSafeInteger(transfer.totalValue) ||
              transfer.totalValue < 0
          )
        )
          unsupported()
        pendingTransfers = structuredClone([...transfers])
      },
      setAdditionalOwnedSats(sats: number) {
        if (
          !Number.isSafeInteger(sats) ||
          sats < 0 ||
          !Number.isSafeInteger(availableSats + sats)
        )
          unsupported()
        additionalOwnedSats = sats
      },
      registerPayout(payout: HermeticPayout) {
        if (
          getLightningInvoiceNetwork(payout.paymentRequest) !== network ||
          !Number.isSafeInteger(payout.feeSats) ||
          payout.feeSats < 0
        )
          unsupported()
        payouts.set(payout.paymentRequest, { ...payout })
      },
      /** Synthetic terminal provider facts; returned leaves may already be spent. */
      registerReturnedLightning(request: {
        transferId: string
        paymentRequest: string
        feeSats: number
      }) {
        const amount = decodeLightningInvoiceMetadata(
          request.paymentRequest
        ).sats
        const hash = decodeLightningInvoicePaymentHash(request.paymentRequest)
        if (
          getLightningInvoiceNetwork(request.paymentRequest) !== network ||
          !amount ||
          !hash ||
          !Number.isSafeInteger(request.feeSats) ||
          request.feeSats < 0 ||
          outgoing.has(request.transferId)
        )
          unsupported()
        const debit = amount + request.feeSats
        const userRequest = {
          id: `hermetic-returned:${request.transferId}`,
          typename: "LightningSendRequest",
          encodedInvoice: request.paymentRequest,
          idempotencyKey: request.transferId,
          network: nativeNetwork,
          status: "USER_SWAP_RETURNED",
          fee: { originalValue: request.feeSats, originalUnit: "SATOSHI" },
          transfer: {
            sparkId: request.transferId,
            totalAmount: { originalValue: debit, originalUnit: "SATOSHI" },
          },
        }
        outgoing.set(request.transferId, {
          invoice: request.paymentRequest,
          request: userRequest,
          transfer: { ...userRequest.transfer, userRequest },
          nativeTransfer: {
            id: request.transferId,
            totalValue: debit,
            type: "LIGHTNING",
            transferDirection: "OUTGOING",
            status: "TRANSFER_STATUS_RETURNED",
            userRequest,
          },
        })
        const providerKey = Uint8Array.from(
          Buffer.from(`03${identityPublicKey.slice(2)}`, "hex")
        )
        const senderKey = Uint8Array.from(Buffer.from(identityPublicKey, "hex"))
        returnedHtlcs.push({
          paymentHash: Uint8Array.from(Buffer.from(hash, "hex")),
          senderIdentityPubkey: senderKey,
          receiverIdentityPubkey: providerKey,
          status: 2,
          transfer: {
            id: request.transferId,
            network: historyNetwork,
            status: 7,
            type: 0,
            senders: [{ id: "sender", identityPublicKey: senderKey }],
            receivers: [
              {
                id: "receiver",
                identityPublicKey: providerKey,
                amountSats: debit,
                status: 7,
              },
            ],
            leaves: [
              {
                transferSenderId: "sender",
                transferReceiverId: "receiver",
                leaf: {
                  id: `hermetic-returned-leaf:${request.transferId}`,
                  value: debit,
                  network: historyNetwork,
                  ownerIdentityPublicKey: senderKey,
                  status: "AVAILABLE",
                  treenodeStatus: 1,
                },
              },
            ],
          },
        })
      },
      completeFunding() {
        if (!receive) throw new Error("Hermetic funding invoice is not created")
        if (incomingTransfer) return
        const amountSats = receive.invoice.amount.originalValue
        incomingTransfer = {
          id: `hermetic-funding-transfer:${accountId}`,
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: amountSats,
          type: "LIGHTNING",
          transferDirection: "INCOMING",
          receiverIdentityPublicKey: identityPublicKey,
          userRequest: { id: receive.id },
        }
        receive = {
          ...receive,
          status: "TRANSFER_COMPLETED",
          transfer: {
            sparkId: incomingTransfer.id,
            userRequestId: receive.id,
            totalAmount: { originalValue: amountSats, originalUnit: "SATOSHI" },
          },
        }
        availableSats += amountSats
      },
      snapshot() {
        return {
          fundingInvoiceCount,
          sendInvocationCount,
          outgoingPaymentCount,
          debitedSats,
        }
      },
      /** Runner-only oracle; never expose invoice bytes in logs or SDK RPC. */
      outgoingInvoices() {
        return [...outgoing.values()].map((row) => row.invoice)
      },
    },
  }
}

function page<T>(transfers: readonly T[], limit: number, offset: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    unsupported()
  const end = offset + limit
  return {
    transfers: structuredClone(transfers.slice(offset, end)),
    offset: end < transfers.length ? end : -1,
  }
}

function createNativeModule(
  initialize: SparkNativeModule["initialize"],
  network: "MAINNET" | "REGTEST",
  codec?: NativeInvoiceCodec
): SparkNativeModule {
  return {
    eventNames: [],
    parseTransferId(value) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value
        )
      )
        unsupported()
      return { toString: () => value } as ReturnType<
        SparkNativeModule["parseTransferId"]
      >
    },
    inspectLightningReceiveQuote: unsupported,
    isPreSendFeeCapError: () => false,
    createPublicReadonlyClient: (options) => {
      if (options.network !== network) unsupported()
      return {
        async getAvailableBalance() {
          return 0n
        },
        async getOwnedBalance() {
          return 0n
        },
        async getTransfers() {
          return { transfers: [], offset: 0 }
        },
      }
    },
    initialize,
    ...(codec
      ? {
          ...codec,
          nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
        }
      : {}),
    decodeSparkAddress: codec?.decodeSparkAddress ?? unsupported,
    isValidSparkAddress: codec?.isValidSparkAddress ?? (() => false),
    getNetworkFromSparkAddress:
      codec?.getNetworkFromSparkAddress ?? unsupported,
  }
}
