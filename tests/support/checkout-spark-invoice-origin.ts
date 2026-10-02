import {
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkLnurlInvoiceInput,
} from "../../packages/core/src/protocol/checkout-spark-lnurl-invoice"

/** Exercise the real resolver with deterministic, offline LNURL responses. */
export function resolveCheckoutSparkFixtureInvoice(
  input: CheckoutSparkLnurlInvoiceInput,
  paymentRequest: string
) {
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
