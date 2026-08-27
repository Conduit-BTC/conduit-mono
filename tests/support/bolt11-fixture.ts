import { createHash } from "node:crypto"
import { secp256k1 } from "@noble/curves/secp256k1.js"

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

export const BOLT11_SIGNATURE_WORDS = 104

export type Bolt11FixtureField = {
  tag: string
  words: number[]
}

// This key exists only in this test process. Keep fixture assertions focused on
// invoice semantics rather than a reusable, authored signing credential.
const fixtureScalar = secp256k1.utils.randomSecretKey()

export function bytesToBolt11Words(bytes: Uint8Array): number[] {
  const words: number[] = []
  let value = 0
  let bits = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      words.push((value >> (bits - 5)) & 31)
      bits -= 5
    }
  }

  if (bits > 0) words.push((value << (5 - bits)) & 31)
  return words
}

function numberToWords(value: number, wordCount: number): number[] {
  const words = new Array<number>(wordCount).fill(0)
  let remaining = BigInt(value)
  for (let index = wordCount - 1; index >= 0; index -= 1) {
    words[index] = Number(remaining & 31n)
    remaining >>= 5n
  }
  return words
}

export function encodeBolt11FixtureField(field: Bolt11FixtureField): number[] {
  const tag = BECH32_CHARSET.indexOf(field.tag)
  if (tag < 0 || field.words.length > 1023) {
    throw new Error("Invalid BOLT11 test field")
  }
  return [tag, field.words.length >> 5, field.words.length & 31, ...field.words]
}

function bech32HrpExpand(hrp: string): number[] {
  return [
    ...Array.from(hrp, (char) => char.charCodeAt(0) >> 5),
    0,
    ...Array.from(hrp, (char) => char.charCodeAt(0) & 31),
  ]
}

function bech32Polymod(values: number[]): number {
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) checksum ^= BECH32_GENERATORS[index]!
    }
  }
  return checksum
}

function createBech32Checksum(hrp: string, words: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  return Array.from(
    { length: 6 },
    (_, index) => (polymod >> (5 * (5 - index))) & 31
  )
}

function bolt11WordsToPaddedBytes(words: number[]): Uint8Array {
  const bytes: number[] = []
  let value = 0
  let bits = 0

  for (const word of words) {
    value = (value << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
      value &= bits === 0 ? 0 : (1 << bits) - 1
    }
  }

  if (bits > 0) bytes.push((value << (8 - bits)) & 0xff)
  return Uint8Array.from(bytes)
}

function signBolt11Fixture(
  hrp: string,
  signedDataWords: number[],
  options: { highS: boolean; recoveryId?: number }
): number[] {
  const signedData = bolt11WordsToPaddedBytes(signedDataWords)
  const preimage = new Uint8Array(hrp.length + signedData.length)
  preimage.set(new TextEncoder().encode(hrp))
  preimage.set(signedData, hrp.length)
  const recoveredSignature = secp256k1.sign(preimage, fixtureScalar, {
    format: "recovered",
    lowS: true,
  })
  let compactSignature = recoveredSignature.slice(1)
  let recoveryId = recoveredSignature[0]!
  if (options.highS) {
    const lowSignature = secp256k1.Signature.fromBytes(
      compactSignature,
      "compact"
    )
    compactSignature = new secp256k1.Signature(
      lowSignature.r,
      secp256k1.Point.Fn.ORDER - lowSignature.s
    ).toBytes("compact")
    recoveryId ^= 1
  }
  if (options.recoveryId !== undefined) recoveryId = options.recoveryId

  const signature = new Uint8Array(65)
  signature.set(compactSignature, 0)
  signature[64] = recoveryId
  return bytesToBolt11Words(signature)
}

export function makeBolt11Fixture({
  fields,
  includePaymentSecret = true,
  signatureWords,
  signatureHighS = false,
  signatureRecoveryId,
  hrp = "lnbc500n",
  createdAt = 1_800_000_000,
}: {
  fields: Bolt11FixtureField[]
  includePaymentSecret?: boolean
  signatureWords?: number[]
  signatureHighS?: boolean
  signatureRecoveryId?: number
  hrp?: string
  createdAt?: number
}): string {
  const resolvedFields =
    includePaymentSecret && !fields.some((field) => field.tag === "s")
      ? [bolt11PaymentSecretField(), ...fields]
      : fields
  const signedDataWords = [
    ...numberToWords(createdAt, 7),
    ...resolvedFields.flatMap(encodeBolt11FixtureField),
  ]
  const resolvedSignatureWords =
    signatureWords ??
    signBolt11Fixture(hrp, signedDataWords, {
      highS: signatureHighS,
      ...(signatureRecoveryId !== undefined
        ? { recoveryId: signatureRecoveryId }
        : {}),
    })
  if (resolvedSignatureWords.length !== BOLT11_SIGNATURE_WORDS) {
    throw new Error("BOLT11 test signature must be 104 words")
  }
  const words = [...signedDataWords, ...resolvedSignatureWords]
  const checksum = createBech32Checksum(hrp, words)
  return `${hrp}1${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

export function bolt11PayeePubkeyField(): Bolt11FixtureField {
  return {
    tag: "n",
    words: bytesToBolt11Words(secp256k1.getPublicKey(fixtureScalar, true)),
  }
}

export function bolt11DescriptionHashWords(description: string): number[] {
  return bytesToBolt11Words(
    new Uint8Array(createHash("sha256").update(description, "utf8").digest())
  )
}

export function bolt11PaymentHashField(): Bolt11FixtureField {
  return {
    tag: "p",
    words: bytesToBolt11Words(new Uint8Array(32).fill(7)),
  }
}

export function bolt11PaymentSecretField(): Bolt11FixtureField {
  return {
    tag: "s",
    words: bytesToBolt11Words(new Uint8Array(32).fill(11)),
  }
}

export function bolt11FeatureField(...bits: number[]): Bolt11FixtureField {
  if (
    bits.some((bit) => !Number.isSafeInteger(bit) || bit < 0 || bit > 5_114)
  ) {
    throw new Error("Invalid BOLT11 test feature bit")
  }

  const highestBit = bits.length > 0 ? Math.max(...bits) : 0
  const words = new Array<number>(Math.floor(highestBit / 5) + 1).fill(0)
  for (const bit of bits) {
    const wordIndex = words.length - 1 - Math.floor(bit / 5)
    words[wordIndex] = words[wordIndex]! | (1 << (bit % 5))
  }

  return { tag: "9", words }
}

export function bolt11DescriptionHashField(
  description: string
): Bolt11FixtureField {
  return { tag: "h", words: bolt11DescriptionHashWords(description) }
}

export function bolt11PlainDescriptionField(
  description = "plain description"
): Bolt11FixtureField {
  return {
    tag: "d",
    words: bytesToBolt11Words(new TextEncoder().encode(description)),
  }
}

export function makeBoundBolt11Fixture(description: string): string {
  return makeBolt11Fixture({
    fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(description)],
  })
}
