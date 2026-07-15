import { createHash } from "node:crypto"

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

export const BOLT11_SIGNATURE_WORDS = 104

export type Bolt11FixtureField = {
  tag: string
  words: number[]
}

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

export function makeBolt11Fixture({
  fields,
  signatureWords = new Array<number>(BOLT11_SIGNATURE_WORDS).fill(0),
  hrp = "lnbc500n",
  createdAt = 1_800_000_000,
}: {
  fields: Bolt11FixtureField[]
  signatureWords?: number[]
  hrp?: string
  createdAt?: number
}): string {
  if (signatureWords.length !== BOLT11_SIGNATURE_WORDS) {
    throw new Error("BOLT11 test signature must be 104 words")
  }
  const words = [
    ...numberToWords(createdAt, 7),
    ...fields.flatMap(encodeBolt11FixtureField),
    ...signatureWords,
  ]
  const checksum = createBech32Checksum(hrp, words)
  return `${hrp}1${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
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
