import { createHash, randomBytes } from "node:crypto"
import {
  decodeSparkAddress,
  DefaultSparkSigner,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.node.js"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../../tests/support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "../../tests/support/signed-bolt11-fixture"
import {
  createHermeticLnurlFixture,
  type HermeticLnurlIssuedInvoice,
} from "./hermetic-lnurl"
import { createHermeticSparkNative } from "./hermetic-spark-native"
import { createHermeticSparkTransport } from "./hermetic-spark-transport"

function fundingInvoice(amountSats: number, expirySeconds: number): string {
  const preimage = randomBytes(32)
  const paymentHash = createHash("sha256").update(preimage).digest()
  preimage.fill(0)
  const expiryWords: number[] = []
  for (let value = expirySeconds; value > 0; value = Math.floor(value / 32)) {
    expiryWords.unshift(value % 32)
  }
  return makeSignedBolt11Fixture({
    hrp: `lnbcrt${BigInt(amountSats) * 10n}n`,
    createdAt: Math.floor(Date.now() / 1_000),
    fields: [
      bolt11PaymentHashField(paymentHash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Offline router funding"),
      { tag: "x", words: expiryWords },
    ],
  })
}

/** External provider facts only; the unchanged application derives all authority. */
export function createHermeticRouterProvider(input: {
  recipients: readonly string[]
  nowSeconds: () => number
  /** Existing multi-order rehearsals explicitly select their original account. */
  selectedIdentity?: () => string | undefined
  onWalletInitialization?: () => void
  onFundingInvoice?: (request: {
    identityPublicKey: string
    amountSats: number
  }) => void
}) {
  let identity: string | undefined
  const issued = new Map<string, HermeticLnurlIssuedInvoice>()
  const native = createHermeticSparkNative({
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "REGTEST" }),
    nativeInvoiceCodec: {
      parseTransferId: (value) => UUID.parse(value),
      encodeSparkAddress,
      decodeSparkAddress,
      isValidSparkAddress,
      getNetworkFromSparkAddress,
    },
    async deriveIdentity(mnemonic, accountNumber) {
      input.onWalletInitialization?.()
      const signer = new DefaultSparkSigner()
      const seed = await signer.mnemonicToSeed(mnemonic)
      try {
        return await signer.createSparkWalletFromSeed(seed, accountNumber)
      } finally {
        seed.fill(0)
      }
    },
    issueFundingInvoice: async (request) => {
      identity = request.identityPublicKey
      input.onFundingInvoice?.(request)
      for (const invoice of issued.values())
        native.control.forIdentity(identity).registerPayout(invoice)
      return fundingInvoice(request.amountSats, request.expirySeconds)
    },
  })
  const control = () => {
    const selected = input.selectedIdentity?.() ?? identity
    if (!selected) throw new Error("Isolated checkout wallet was not prepared.")
    return native.control.forIdentity(selected)
  }
  const lnurl = createHermeticLnurlFixture({
    recipients: input.recipients.map((lud16) => ({ lud16 })),
    nowSeconds: input.nowSeconds,
    feeSats: 0,
    verification: {
      isInvoiceSettled: (paymentRequest) =>
        (input.selectedIdentity?.() ?? identity) !== undefined &&
        control().snapshot().outgoingPaymentCount ===
          control().outgoingInvoices().length &&
        control().outgoingInvoices().includes(paymentRequest),
    },
    onInvoiceIssued: async (invoice) => {
      issued.set(invoice.paymentRequest, invoice)
      if ((input.selectedIdentity?.() ?? identity) !== undefined)
        control().registerPayout(invoice)
    },
  })
  return {
    native,
    transport: createHermeticSparkTransport(native),
    lnurl,
    issued,
    control,
  }
}
