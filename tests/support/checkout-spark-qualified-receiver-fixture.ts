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
  const [username, domain] = lud16.split("@")
  const origin = `https://${domain}`
  const metadataRaw = JSON.stringify([
    ["text/plain", "Synthetic qualified receiver"],
    ["text/identifier", lud16],
  ])
  const preimage = Buffer.alloc(32, input.preimageByte ?? 25).toString("hex")
  const paymentHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex")
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${(input.amountSats ?? 995) * 10}n`,
    createdAt: input.nowSeconds ?? 1_800_000_000,
    fields: [
      bolt11PaymentHashField(Buffer.from(paymentHash, "hex")),
      bolt11PaymentSecretField(),
      bolt11DescriptionHashField(metadataRaw),
    ],
  })
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
    minSendable: 1_000,
    maxSendable: 10_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: metadataRaw,
  }
  const receiverBinding: CheckoutSparkReceiverBinding = {
    schemaVersion: 1,
    contractId: contracts[0]!.contractId,
    mode: "private",
    lud16,
    payRequestUrl,
    callbackUrl: metadata.callback,
    metadata: metadataRaw,
    verifyUrl: `${origin}/lnurlp/verify/${paymentHash}`,
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
