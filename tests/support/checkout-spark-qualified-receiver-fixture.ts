import { createHash } from "node:crypto"
import {
  parseCheckoutSparkReceiverContracts,
  type CheckoutSparkReceiverBinding,
} from "../../packages/core/src/protocol/checkout-spark-receiver-capability"
import { encodeLnurl } from "../../packages/core/src/protocol/lightning"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
} from "./bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./signed-bolt11-fixture"

/** Exact offline LNURL facts for one ordinary, qualified recipient. */
export function qualifiedReceiverMetadataFixture(
  lud16: string,
  range: { minSendable?: number; maxSendable?: number } = {}
) {
  const [username, domain] = lud16.split("@")
  const origin = `https://${domain}`
  const metadataRaw = JSON.stringify([
    ["text/plain", "Synthetic qualified receiver"],
    ["text/identifier", lud16],
  ])
  const contracts = parseCheckoutSparkReceiverContracts([
    {
      schemaVersion: 1,
      contractId: "synthetic-receiver-v1",
      qualification: "accepted",
      payRequestOrigins: [origin],
      callbackOrigins: [origin],
      verifyOrigins: [origin],
      verifyPathPrefix: "/lnurlp/verify/",
      modes: ["private"],
      binding: "metadata_hash",
    },
  ])
  const payRequestUrl = `${origin}/.well-known/lnurlp/${username}`
  const metadata = {
    payRequestUrl,
    lnurl: encodeLnurl(payRequestUrl),
    callback: `${origin}/lnurlp/${username}`,
    minSendable: range.minSendable ?? 1_000,
    maxSendable: range.maxSendable ?? 1_000_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: metadataRaw,
  }
  const verifyUrl = (paymentHash: string) =>
    `${origin}/lnurlp/verify/${paymentHash}`
  return { contracts, metadata, verifyUrl }
}

/** A genuine signed ordinary invoice bound to this provider's exact metadata. */
export function qualifiedReceiverInvoiceFixture(input: {
  lud16: string
  amountSats: number
  paymentHash: string
  createdAt: number
  network?: "mainnet" | "regtest"
  expiresSeconds?: number
}) {
  const provider = qualifiedReceiverMetadataFixture(input.lud16)
  const expiryWords: number[] = []
  if (input.expiresSeconds !== undefined) {
    let remaining = input.expiresSeconds
    do {
      expiryWords.unshift(remaining & 31)
      remaining = Math.floor(remaining / 32)
    } while (remaining > 0)
  }
  return makeSignedBolt11Fixture({
    hrp: `${input.network === "regtest" ? "lnbcrt" : "lnbc"}${input.amountSats * 10}n`,
    createdAt: input.createdAt,
    fields: [
      bolt11PaymentHashField(Buffer.from(input.paymentHash, "hex")),
      bolt11PaymentSecretField(),
      bolt11DescriptionHashField(provider.metadata.metadata),
      ...(input.expiresSeconds === undefined
        ? []
        : [{ tag: "x", words: expiryWords }]),
    ],
  })
}

/** Provider-owned ordinary HTTP facts and genuine crypto, never app-minted proof. */
export function qualifiedReceiverFixture(
  input: {
    lud16?: string
    amountSats?: number
    nowSeconds?: number
    preimageByte?: number
  } = {}
) {
  const lud16 = input.lud16 ?? "merchant@receiver.conduit.cash"
  const { contracts, metadata, verifyUrl } = qualifiedReceiverMetadataFixture(
    lud16,
    { maxSendable: 10_000_000 }
  )
  const preimage = Buffer.alloc(32, input.preimageByte ?? 25).toString("hex")
  const paymentHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex")
  const paymentRequest = qualifiedReceiverInvoiceFixture({
    lud16,
    amountSats: input.amountSats ?? 995,
    paymentHash,
    createdAt: input.nowSeconds ?? 1_800_000_000,
  })
  const receiverBinding: CheckoutSparkReceiverBinding = {
    schemaVersion: 1,
    contractId: contracts[0]!.contractId,
    mode: "private",
    lud16,
    payRequestUrl: metadata.payRequestUrl,
    callbackUrl: metadata.callback,
    metadata: metadata.metadata,
    verifyUrl: verifyUrl(paymentHash),
  }
  const verifier = (settled = true) => ({
    status: "OK",
    settled,
    preimage: settled ? preimage : null,
    pr: paymentRequest,
  })
  return {
    lud16,
    contracts,
    metadata,
    receiverBinding,
    paymentRequest,
    paymentHash,
    preimage,
    verifier,
  }
}
