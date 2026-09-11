import { createHash } from "node:crypto"

import {
  NWCClient,
  NWCWalletService,
  NWCWalletServiceKeyPair,
  type NWCWalletServiceRequestHandler,
  type Nip47GetInfoResponse,
  type Nip47LookupInvoiceRequest,
  type Nip47MakeInvoiceRequest,
  type Nip47PayInvoiceRequest,
  type Nip47Transaction,
} from "@getalby/sdk/nwc"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"

import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "../../tests/support/bolt11-fixture"

const DEFAULT_INVOICE_EXPIRY_SECONDS = 3_600
const TEST_WALLET_BALANCE_MSATS = 100_000_000
const TEST_PAYMENT_PREIMAGE = new Uint8Array(32).fill(0x2a)
const TEST_PAYMENT_PREIMAGE_HEX = Buffer.from(TEST_PAYMENT_PREIMAGE).toString(
  "hex"
)
const TEST_PAYMENT_HASH = new Uint8Array(
  createHash("sha256").update(TEST_PAYMENT_PREIMAGE).digest()
)
const TEST_PAYMENT_HASH_HEX = Buffer.from(TEST_PAYMENT_HASH).toString("hex")

type WalletCounters = {
  makeInvoice: number
  payInvoice: number
  lookupInvoice: number
}

type StoredInvoice = {
  amountMsats: number
  createdAt: number
  description: string
  expiresAt: number
  invoice: string
  settledAt: number | null
}

export type DeterministicNwcWalletSnapshot = {
  counters: WalletCounters
  invoiceState: "none" | "pending" | "settled"
}

export type DeterministicNwcOperationStage =
  | "buyer_payment"
  | "merchant_configuration"
  | "merchant_session"
  | "wallet_close"
  | "wallet_start"

export class DeterministicNwcOperationError extends Error {
  readonly code = "NWC_OPERATION_FAILED"

  constructor(readonly stage: DeterministicNwcOperationStage) {
    super(`Deterministic NWC operation failed at ${stage}.`)
    this.name = "DeterministicNwcOperationError"
  }
}

export type DeterministicNwcWallet = {
  start(): Promise<void>
  close(): Promise<void>
  configureMerchantConnection(
    configure: (connectionString: string) => Promise<void> | void
  ): Promise<void>
  payLastInvoice(): Promise<void>
  snapshot(): DeterministicNwcWalletSnapshot
  withMerchantClient<T>(
    operation: (client: NWCClient) => Promise<T> | T
  ): Promise<T>
}

export type DeterministicNwcWalletOptions = {
  relayUrl: string
  lud16?: string
  nowSeconds?: () => number
}

function runtimeNwcKeyPair(): { pubkey: string; secret: string } {
  const secretKey = generateSecretKey()
  const secretBuffer = Buffer.from(secretKey)
  try {
    return {
      pubkey: getPublicKey(secretKey),
      secret: secretBuffer.toString("hex"),
    }
  } finally {
    secretKey.fill(0)
    secretBuffer.fill(0)
  }
}

type SavedConsoleMethods = Pick<
  Console,
  "debug" | "dir" | "error" | "info" | "log" | "warn"
>

let consoleSuppressionDepth = 0
let savedConsoleMethods: SavedConsoleMethods | null = null

function suppressSdkConsole(): void {
  if (consoleSuppressionDepth === 0) {
    savedConsoleMethods = {
      debug: console.debug,
      dir: console.dir,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    }
    console.debug = () => undefined
    console.dir = () => undefined
    console.error = () => undefined
    console.info = () => undefined
    console.log = () => undefined
    console.warn = () => undefined
  }
  consoleSuppressionDepth += 1
}

function restoreSdkConsole(): void {
  consoleSuppressionDepth = Math.max(0, consoleSuppressionDepth - 1)
  if (consoleSuppressionDepth !== 0 || !savedConsoleMethods) return

  console.debug = savedConsoleMethods.debug
  console.dir = savedConsoleMethods.dir
  console.error = savedConsoleMethods.error
  console.info = savedConsoleMethods.info
  console.log = savedConsoleMethods.log
  console.warn = savedConsoleMethods.warn
  savedConsoleMethods = null
}

async function runContentFreeNwcOperation<T>(
  stage: DeterministicNwcOperationStage,
  operation: () => Promise<T> | T
): Promise<T> {
  suppressSdkConsole()
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DeterministicNwcOperationError) throw error
    throw new DeterministicNwcOperationError(stage)
  } finally {
    restoreSdkConsole()
  }
}

function buildConnectionUri(input: {
  clientSecret: string
  lud16: string
  relayUrl: string
  walletPubkey: string
}): string {
  const params = new URLSearchParams()
  params.append("relay", input.relayUrl)
  params.set("secret", input.clientSecret)
  params.set("lud16", input.lud16)
  return `nostr+walletconnect://${input.walletPubkey}?${params.toString()}`
}

function invoiceHrp(amountMsats: number): string {
  if (
    !Number.isSafeInteger(amountMsats) ||
    amountMsats <= 0 ||
    !Number.isSafeInteger(amountMsats * 10)
  ) {
    throw new Error("Deterministic NWC invoice amount must be positive msats.")
  }
  return `lntb${amountMsats * 10}p`
}

function requestMatchesInvoice(
  request: Nip47LookupInvoiceRequest,
  invoice: StoredInvoice
): boolean {
  if (!request.invoice && !request.payment_hash) return false
  return (
    (!request.invoice || request.invoice === invoice.invoice) &&
    (!request.payment_hash || request.payment_hash === TEST_PAYMENT_HASH_HEX)
  )
}

function toTransaction(invoice: StoredInvoice): Nip47Transaction {
  return {
    type: "incoming",
    state: invoice.settledAt === null ? "pending" : "settled",
    invoice: invoice.invoice,
    description: invoice.description,
    description_hash: "",
    preimage: invoice.settledAt === null ? "" : TEST_PAYMENT_PREIMAGE_HEX,
    payment_hash: TEST_PAYMENT_HASH_HEX,
    amount: invoice.amountMsats,
    fees_paid: 0,
    settled_at: invoice.settledAt ?? 0,
    created_at: invoice.createdAt,
    expires_at: invoice.expiresAt,
  }
}

/**
 * Create a local NIP-47 wallet service for hermetic commerce tests.
 *
 * The service uses runtime-only NWC connection keys, NIP-44 v2 through the
 * pinned SDK, and a deterministic in-memory invoice ledger. The secret-bearing
 * connection URI remains closure-held and is available only to the bounded
 * configuration callback.
 */
export function createDeterministicNwcWallet(
  options: DeterministicNwcWalletOptions
): DeterministicNwcWallet {
  const lud16 = options.lud16 ?? "merchant@example.com"
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))
  const walletCredentials = runtimeNwcKeyPair()
  const merchantClientCredentials = runtimeNwcKeyPair()
  const buyerClientCredentials = runtimeNwcKeyPair()
  let walletSecret = walletCredentials.secret
  const walletPubkey = walletCredentials.pubkey
  const merchantKeyPair = new NWCWalletServiceKeyPair(
    walletSecret,
    merchantClientCredentials.pubkey
  )
  const buyerKeyPair = new NWCWalletServiceKeyPair(
    walletSecret,
    buyerClientCredentials.pubkey
  )
  let merchantUri = buildConnectionUri({
    clientSecret: merchantClientCredentials.secret,
    lud16,
    relayUrl: options.relayUrl,
    walletPubkey,
  })
  let buyerUri = buildConnectionUri({
    clientSecret: buyerClientCredentials.secret,
    lud16,
    relayUrl: options.relayUrl,
    walletPubkey,
  })
  walletCredentials.secret = ""
  merchantClientCredentials.secret = ""
  buyerClientCredentials.secret = ""
  const service = new NWCWalletService({
    relayUrls: [options.relayUrl],
    logger: { debug() {} },
  })
  const counters: WalletCounters = {
    makeInvoice: 0,
    payInvoice: 0,
    lookupInvoice: 0,
  }
  let invoice: StoredInvoice | null = null
  let unsubscribeMerchant: (() => void) | null = null
  let unsubscribeBuyer: (() => void) | null = null
  let started = false
  let closed = false

  const info = (): Nip47GetInfoResponse => ({
    alias: "Hermetic commerce wallet",
    color: "#000000",
    pubkey: walletPubkey,
    network: "testnet",
    block_height: 0,
    block_hash: "0".repeat(64),
    methods: [
      "get_info",
      "get_balance",
      "make_invoice",
      "pay_invoice",
      "lookup_invoice",
    ],
    notifications: [],
    lud16,
  })

  const handler: NWCWalletServiceRequestHandler = {
    async getInfo() {
      return { result: info(), error: undefined }
    },
    async getBalance() {
      return {
        result: { balance: TEST_WALLET_BALANCE_MSATS },
        error: undefined,
      }
    },
    async makeInvoice(request: Nip47MakeInvoiceRequest) {
      counters.makeInvoice += 1
      const createdAt = nowSeconds()
      const expiry = request.expiry ?? DEFAULT_INVOICE_EXPIRY_SECONDS
      const description = request.description ?? "Conduit commerce smoke"
      invoice = {
        amountMsats: request.amount,
        createdAt,
        description,
        expiresAt: createdAt + expiry,
        invoice: makeBolt11Fixture({
          createdAt,
          fields: [
            bolt11PaymentHashField(TEST_PAYMENT_HASH),
            bolt11PlainDescriptionField(description),
          ],
          hrp: invoiceHrp(request.amount),
        }),
        settledAt: null,
      }
      return { result: toTransaction(invoice), error: undefined }
    },
    async payInvoice(request: Nip47PayInvoiceRequest) {
      counters.payInvoice += 1
      if (!invoice || request.invoice !== invoice.invoice) {
        return {
          result: undefined,
          error: { code: "NOT_FOUND", message: "Invoice was not issued." },
        }
      }
      invoice.settledAt ??= nowSeconds()
      return {
        result: { preimage: TEST_PAYMENT_PREIMAGE_HEX, fees_paid: 0 },
        error: undefined,
      }
    },
    async lookupInvoice(request: Nip47LookupInvoiceRequest) {
      counters.lookupInvoice += 1
      if (!invoice || !requestMatchesInvoice(request, invoice)) {
        return {
          result: undefined,
          error: { code: "NOT_FOUND", message: "Invoice was not issued." },
        }
      }
      return { result: toTransaction(invoice), error: undefined }
    },
  }

  return {
    async start() {
      if (started) return
      await runContentFreeNwcOperation("wallet_start", async () => {
        if (closed) throw new DeterministicNwcOperationError("wallet_start")
        unsubscribeMerchant = await service.subscribe(merchantKeyPair, handler)
        unsubscribeBuyer = await service.subscribe(buyerKeyPair, handler)
        await service.publishWalletServiceInfoEvent(
          walletSecret,
          [
            "get_info",
            "get_balance",
            "make_invoice",
            "pay_invoice",
            "lookup_invoice",
          ],
          []
        )
        started = true
      })
    },
    async close() {
      if (closed) return
      // The SDK intentionally publishes responses without awaiting relay ACKs.
      // Give those local publishes one turn to settle before closing the pool,
      // otherwise teardown can turn a successful response into an unhandled
      // rejected publication promise.
      try {
        await runContentFreeNwcOperation("wallet_close", async () => {
          await new Promise((resolve) => setTimeout(resolve, 25))
          unsubscribeMerchant?.()
          unsubscribeBuyer?.()
          unsubscribeMerchant = null
          unsubscribeBuyer = null
          service.close()
          started = false
        })
      } finally {
        merchantKeyPair.walletSecret = ""
        buyerKeyPair.walletSecret = ""
        walletSecret = ""
        merchantUri = ""
        buyerUri = ""
        if (invoice) {
          invoice.amountMsats = 0
          invoice.createdAt = 0
          invoice.description = ""
          invoice.expiresAt = 0
          invoice.invoice = ""
          invoice.settledAt = null
        }
        invoice = null
        closed = true
      }
    },
    async configureMerchantConnection(configure) {
      await runContentFreeNwcOperation("merchant_configuration", async () => {
        if (closed) {
          throw new DeterministicNwcOperationError("merchant_configuration")
        }
        await configure(merchantUri)
      })
    },
    async payLastInvoice() {
      await runContentFreeNwcOperation("buyer_payment", async () => {
        if (!started || !invoice) {
          throw new DeterministicNwcOperationError("buyer_payment")
        }
        const client = new NWCClient({
          nostrWalletConnectUrl: buyerUri,
          requireSecret: true,
          logger: { debug() {} },
        })
        try {
          await client.payInvoice({ invoice: invoice.invoice })
        } finally {
          client.close()
        }
      })
    },
    snapshot() {
      return {
        counters: { ...counters },
        invoiceState:
          invoice === null
            ? "none"
            : invoice.settledAt === null
              ? "pending"
              : "settled",
      }
    },
    async withMerchantClient(operation) {
      return await runContentFreeNwcOperation("merchant_session", async () => {
        if (!started || closed) {
          throw new DeterministicNwcOperationError("merchant_session")
        }
        const client = new NWCClient({
          nostrWalletConnectUrl: merchantUri,
          requireSecret: true,
          logger: { debug() {} },
        })
        try {
          return await operation(client)
        } finally {
          client.close()
        }
      })
    },
  }
}
