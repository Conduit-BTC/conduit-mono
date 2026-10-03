import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
} from "../../packages/core/src/protocol/lightning"
import type { CheckoutSparkNativeRetirementReader } from "@conduit/core"
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

interface HermeticPayout {
  paymentRequest: string
  preimage: string
  feeSats: number
}

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
          issueFundingInvoice: (invoice) =>
            input.issueFundingInvoice({ ...invoice, identityPublicKey }),
        }),
      }
      accounts.set(key, account)
    }
    return account.native
  }
  const module = createNativeModule(async (request) => {
    if (request.options.network !== nativeNetwork) unsupported()
    const account = await getAccount({
      mnemonic: request.mnemonicOrSeed,
      accountNumber: request.accountNumber,
      network,
    })
    return { wallet: account.openWallet() }
  }, nativeNetwork)
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
  issueFundingInvoice: (request: {
    amountSats: number
    expirySeconds: number
  }) => Promise<string>
}) {
  const network = input.network
  const nativeNetwork = network === "mainnet" ? "MAINNET" : "REGTEST"
  // Spark 0.12.1 protobuf Network: MAINNET=1, REGTEST=2.
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
        // Spark 0.12.1 protobuf: PREIMAGE_SWAP=0, COMPLETED=5.
        const transfers = request.types.includes(0)
          ? history().map(({ id, totalValue }) => ({
              id,
              totalValue,
              type: 0,
              status: 5,
              network: historyNetwork,
            }))
          : []
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
      async getTransfer(id) {
        assertOpen()
        const saved = history().find((transfer) => transfer.id === id)
        return saved ? structuredClone(saved) : undefined
      },
      async getTransferFromSsp(id) {
        assertOpen()
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
  network: "MAINNET" | "REGTEST"
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
    decodeSparkAddress: unsupported,
    isValidSparkAddress: () => false,
    getNetworkFromSparkAddress: unsupported,
  }
}
