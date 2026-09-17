import { describe, expect, it } from "bun:test"
import { isValidLightningInvoice } from "../packages/core/src/protocol/lightning"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  bytesToBolt11Words,
  type Bolt11FixtureField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

function fields(): Bolt11FixtureField[] {
  return [
    bolt11PaymentHashField(),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
  ]
}

function features(...bits: number[]): Bolt11FixtureField {
  const words = new Array<number>(Math.floor(Math.max(...bits) / 5) + 1).fill(0)
  for (const bit of bits)
    words[words.length - 1 - Math.floor(bit / 5)]! |= 1 << (bit % 5)
  return { tag: "9", words }
}

describe("intrinsic BOLT11 reader validation", () => {
  it("accepts the independently signed BOLT11 specification donation vector", () => {
    // https://github.com/lightning/bolts/blob/master/11-payment-encoding.md#examples
    const bolt11 =
      "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql"
    expect(isValidLightningInvoice(bolt11)).toBe(true)
    expect(isValidLightningInvoice(bolt11.toUpperCase())).toBe(true)
    expect(isValidLightningInvoice(`LN${bolt11.slice(2)}`)).toBe(false)
  })

  it("recovers low-S and high-S signatures without an explicit payee", () => {
    expect(isValidLightningInvoice(makeSignedBolt11Fixture())).toBe(true)
    expect(
      isValidLightningInvoice(makeSignedBolt11Fixture({ highS: true }))
    ).toBe(true)
  })

  it("uses an explicit payee and requires low-S", () => {
    expect(
      isValidLightningInvoice(makeSignedBolt11Fixture({ includePayee: true }))
    ).toBe(true)
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({ includePayee: true, highS: true })
      )
    ).toBe(false)
    // A valid but unrelated explicit public key must fail signature verification.
    const otherPublicKey = new Uint8Array([2, ...new Uint8Array(32).fill(1)])
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: [
            ...fields(),
            { tag: "n", words: bytesToBolt11Words(otherPublicKey) },
          ],
        })
      )
    ).toBe(false)
  })

  it("rejects checksum-correct zero signatures and invalid recovery ids", () => {
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({ invalidSignature: true })
      )
    ).toBe(false)
    expect(
      isValidLightningInvoice(makeSignedBolt11Fixture({ recoveryId: 4 }))
    ).toBe(false)
  })

  it("requires a payment hash and a payment secret", () => {
    for (const tag of ["p", "s"]) {
      expect(
        isValidLightningInvoice(
          makeSignedBolt11Fixture({
            fields: fields().filter((field) => field.tag !== tag),
          })
        )
      ).toBe(false)
    }
  })

  it("rejects every incorrectly sized fixed field, even after a valid field", () => {
    for (const tag of ["p", "s", "h", "n"]) {
      expect(
        isValidLightningInvoice(
          makeSignedBolt11Fixture({
            fields: [...fields(), { tag, words: [1] }],
          })
        )
      ).toBe(false)
    }
  })

  it("rejects nonzero padding in fixed fields", () => {
    const secret = bolt11PaymentSecretField()
    secret.words[secret.words.length - 1]! |= 1
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: fields().map((field) => (field.tag === "s" ? secret : field)),
        })
      )
    ).toBe(false)
  })

  it("requires either an inline description or a description hash, never both", () => {
    const withoutDescription = fields().filter((field) => field.tag !== "d")
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({ fields: withoutDescription })
      )
    ).toBe(false)
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: [...withoutDescription, bolt11DescriptionHashField("order")],
        })
      )
    ).toBe(true)
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: [...fields(), bolt11DescriptionHashField("order")],
        })
      )
    ).toBe(false)
  })

  it("rejects invalid UTF-8 descriptions", () => {
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: [
            ...fields().filter((field) => field.tag !== "d"),
            { tag: "d", words: bytesToBolt11Words(new Uint8Array([0xff])) },
          ],
        })
      )
    ).toBe(false)
  })

  it("ignores unknown odd features and fields but rejects unknown required features", () => {
    for (const bit of [2, 20, 100]) {
      expect(
        isValidLightningInvoice(
          makeSignedBolt11Fixture({ fields: [...fields(), features(bit)] })
        )
      ).toBe(false)
    }
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({
          fields: [...fields(), features(101), { tag: "z", words: [31] }],
        })
      )
    ).toBe(true)
  })

  it("accepts current invoice features and assumed dependencies", () => {
    // BOLT9 now marks payment_secret/var_onion as ASSUMED. MPP does not
    // require the old explicit dependency bits; a valid s field is mandatory.
    for (const bit of [8, 14, 16, 17, 24, 36, 48]) {
      expect(
        isValidLightningInvoice(
          makeSignedBolt11Fixture({ fields: [...fields(), features(bit)] })
        )
      ).toBe(true)
    }
    expect(
      isValidLightningInvoice(
        makeSignedBolt11Fixture({ fields: [...fields(), features(16, 17)] })
      )
    ).toBe(true)
  })

  it("rejects non-minimal expiry, CLTV and feature fields", () => {
    for (const tag of ["x", "c", "9"]) {
      expect(
        isValidLightningInvoice(
          makeSignedBolt11Fixture({
            fields: [...fields(), { tag, words: [0, 1] }],
          })
        )
      ).toBe(false)
    }
  })
})
