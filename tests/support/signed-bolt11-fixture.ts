import { createHash } from "node:crypto"
import { secp256k1 } from "../../packages/core/node_modules/@noble/curves/secp256k1.js"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  bytesToBolt11Words,
  encodeBolt11FixtureField,
  makeBolt11Fixture,
  type Bolt11FixtureField,
} from "./bolt11-fixture"

export function bolt11PaymentSecretField(): Bolt11FixtureField {
  return { tag: "s", words: bytesToBolt11Words(new Uint8Array(32).fill(9)) }
}

/** Signed test invoices only; the disposable signing key is never persisted. */
export function makeSignedBolt11Fixture({
  hrp = "lnbc400u",
  createdAt = 1_800_000_000,
  fields = [
    bolt11PaymentHashField(),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
  ],
  includePayee = false,
  highS = false,
  invalidSignature = false,
  recoveryId,
}: {
  hrp?: string
  createdAt?: number
  fields?: Bolt11FixtureField[]
  includePayee?: boolean
  highS?: boolean
  invalidSignature?: boolean
  recoveryId?: number
} = {}): string {
  const secretKey = secp256k1.utils.randomSecretKey()
  const invoiceFields = [
    ...fields,
    ...(includePayee
      ? [
          {
            tag: "n",
            words: bytesToBolt11Words(secp256k1.getPublicKey(secretKey)),
          },
        ]
      : []),
  ]
  const timestamp = Array.from({ length: 7 }, (_, index) =>
    Number((BigInt(createdAt) >> BigInt((6 - index) * 5)) & 31n)
  )
  const words = [
    ...timestamp,
    ...invoiceFields.flatMap(encodeBolt11FixtureField),
  ]
  const data = new Uint8Array(Math.ceil((words.length * 5) / 8))
  for (let bit = 0; bit < words.length * 5; bit += 1) {
    data[Math.floor(bit / 8)]! |=
      ((words[Math.floor(bit / 5)]! >> (4 - (bit % 5))) & 1) << (7 - (bit % 8))
  }
  const digest = createHash("sha256").update(hrp).update(data).digest()
  let signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, secretKey, { prehash: false, format: "recovered" }),
    "recovered"
  )
  if (highS) {
    signature = new secp256k1.Signature(
      signature.r,
      secp256k1.Point.Fn.ORDER - signature.s,
      signature.recovery! ^ 1
    )
  }
  const encoded = signature.toBytes("recovered")
  const compact = invalidSignature ? new Uint8Array(64) : encoded.slice(1)
  const boltSignature = new Uint8Array([...compact, recoveryId ?? encoded[0]!])
  return makeBolt11Fixture({
    fields: invoiceFields,
    hrp,
    createdAt,
    signatureWords: bytesToBolt11Words(boltSignature),
  })
}
