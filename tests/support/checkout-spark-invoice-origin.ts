import {
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceInput,
} from "../../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import {
  decodeLightningInvoicePaymentHash,
  normalizeLightningInvoice,
} from "../../packages/core/src/protocol/lightning"
import { qualifiedReceiverMetadataFixture } from "./checkout-spark-qualified-receiver-fixture"

/** Exercise the real resolver with deterministic, offline LNURL responses. */
export function resolveCheckoutSparkFixtureInvoice(
  input: CheckoutSparkLnurlInvoiceInput,
  paymentRequest: string,
  options: {
    minSendable?: number
    maxSendable?: number
    onInvoice?: (amountMsats: number) => void
  } = {}
) {
  if (input.receiverMode === "private") {
    const provider = qualifiedReceiverMetadataFixture(input.lud16, options)
    const exactInvoice = normalizeLightningInvoice(paymentRequest).toLowerCase()
    const paymentHash = decodeLightningInvoicePaymentHash(exactInvoice)
    return resolveCheckoutSparkLnurlInvoice(input, {
      receiverContracts: provider.contracts,
      fetchMetadata: async () => provider.metadata,
      fetchInvoice: async (_callback, amountMsats) => {
        options.onInvoice?.(amountMsats)
        return {
          invoice: paymentRequest,
          verifyUrl: provider.verifyUrl(paymentHash ?? ""),
        }
      },
      fetchReceiverVerify: async () => ({
        status: "OK",
        settled: false,
        preimage: null,
        pr: exactInvoice,
      }),
    })
  }
  const [username, domain] = input.lud16.split("@")
  const endpoint = `https://${domain}/.well-known/lnurlp/${username}`
  return resolveCheckoutSparkLnurlInvoice(input, {
    fetchMetadata: async () => ({
      payRequestUrl: endpoint,
      lnurl: "lnurl1fixture",
      callback: "https://wallet.conduit.market/fixture-invoice",
      minSendable: 1_000,
      maxSendable: 1_000_000_000,
      tag: "payRequest",
      allowsNostr: false,
      metadata: "[]",
    }),
    fetchInvoice: async () => ({ invoice: paymentRequest }),
  })
}
