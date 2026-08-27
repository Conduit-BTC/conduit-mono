import { afterEach, describe, expect, it, mock } from "bun:test"
import { createHash } from "node:crypto"
import { secp256k1 } from "@noble/curves/secp256k1.js"

import { config } from "../packages/core/src/config"
import {
  decodeLightningInvoiceAmount,
  decodeLightningInvoicePaymentHash,
  decodeLightningInvoiceMetadata,
  fetchZapInvoice,
  getLightningInvoiceNetwork,
  isAmountlessLightningInvoice,
  validateLightningInvoiceForPayment,
  validateZapInvoiceDescriptionBinding,
} from "../packages/core/src/protocol/lightning"
import {
  BOLT11_SIGNATURE_WORDS,
  bolt11DescriptionHashField as buildDescriptionHashField,
  bolt11DescriptionHashWords as descriptionHashWords,
  bolt11FeatureField as featureField,
  bolt11PayeePubkeyField as payeePubkeyField,
  bolt11PaymentHashField as paymentHashField,
  bolt11PaymentSecretField as paymentSecretField,
  bolt11PlainDescriptionField as plainDescriptionField,
  bytesToBolt11Words,
  encodeBolt11FixtureField as encodeTaggedField,
  makeBolt11Fixture as makeBolt11Invoice,
} from "./support/bolt11-fixture"

const CREATED_AT = 1_800_000_000
const ZAP_REQUEST_JSON = JSON.stringify({
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: CREATED_AT,
  kind: 9734,
  tags: [["p", "c".repeat(64)]],
  content: "Zapped out on Conduit ⚡",
  sig: "d".repeat(128),
})

function descriptionHashField(description = ZAP_REQUEST_JSON) {
  return buildDescriptionHashField(description)
}

describe("BOLT11 network decoding", () => {
  it("distinguishes regtest from the overlapping mainnet prefix", () => {
    const mainnet = makeBolt11Invoice({
      hrp: "lnbc500n",
      fields: [paymentHashField()],
    })
    const regtest = makeBolt11Invoice({
      hrp: "lnbcrt500n",
      fields: [paymentHashField()],
    })

    expect(getLightningInvoiceNetwork(mainnet)).toBe("mainnet")
    expect(getLightningInvoiceNetwork(regtest)).toBe("regtest")
  })

  it("accepts signed standard-signet invoices and rejects legacy lnsb HRPs", () => {
    const signet = makeBolt11Invoice({
      hrp: "lntbs500n",
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const amountlessSignet = makeBolt11Invoice({
      hrp: "lntbs",
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const legacySignet = makeBolt11Invoice({
      hrp: "lnsb500n",
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const legacyAmountlessSignet = makeBolt11Invoice({
      hrp: "lnsb",
      fields: [paymentHashField(), plainDescriptionField()],
    })

    expect(getLightningInvoiceNetwork(signet)).toBe("signet")
    expect(decodeLightningInvoiceAmount(signet)).toEqual({
      msats: 50_000,
      sats: 50,
      currency: "SATS",
    })
    expect(isAmountlessLightningInvoice(amountlessSignet)).toBe(true)

    const previousNetwork = config.lightningNetwork
    config.lightningNetwork = "signet"
    try {
      expect(
        validateLightningInvoiceForPayment({
          invoice: signet,
          expectedAmountMsats: 50_000,
          nowSeconds: CREATED_AT - 1,
        })
      ).toMatchObject({ ok: true })

      expect(getLightningInvoiceNetwork(legacySignet)).toBe("unknown")
      expect(isAmountlessLightningInvoice(legacyAmountlessSignet)).toBe(false)
      expect(decodeLightningInvoiceAmount(legacySignet)).toEqual({
        msats: null,
        sats: null,
        currency: null,
      })
      expect(
        validateLightningInvoiceForPayment({
          invoice: legacySignet,
          expectedAmountMsats: 50_000,
          nowSeconds: CREATED_AT - 1,
        })
      ).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/format could not be verified/i),
      })
    } finally {
      config.lightningNetwork = previousNetwork
    }
  })
})

describe("BOLT11 payment hash decoding", () => {
  it("accepts exactly one canonical 32-byte payment hash", () => {
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
    })

    expect(decodeLightningInvoicePaymentHash(invoice)).toBe("07".repeat(32))
  })

  it("uses the first valid payment hash when ordered alternatives are present", () => {
    const fallbackPaymentHash = {
      tag: "p",
      words: bytesToBolt11Words(new Uint8Array(32).fill(9)),
    }
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), fallbackPaymentHash, descriptionHashField()],
    })

    expect(decodeLightningInvoicePaymentHash(invoice)).toBe("07".repeat(32))
  })

  it("rejects missing or malformed primary and secondary payment hashes", () => {
    const missing = makeBolt11Invoice({
      fields: [descriptionHashField()],
    })
    const malformedPrimary = makeBolt11Invoice({
      fields: [
        {
          tag: "p",
          words: paymentHashField().words.slice(0, 51),
        },
        descriptionHashField(),
      ],
    })
    const malformedSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        {
          tag: "p",
          words: paymentHashField().words.slice(0, 51),
        },
        descriptionHashField(),
      ],
    })

    expect(decodeLightningInvoicePaymentHash(missing)).toBeNull()
    expect(decodeLightningInvoicePaymentHash(malformedPrimary)).toBeNull()
    expect(decodeLightningInvoicePaymentHash(malformedSecondary)).toBeNull()
  })
})

describe("BOLT11 payment structure validation", () => {
  const validate = (invoice: string) =>
    validateLightningInvoiceForPayment({
      invoice,
      expectedAmountMsats: 50_000,
      nowSeconds: CREATED_AT - 1,
    })

  it("accepts one payment hash and exactly one description commitment", () => {
    const plain = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const hashed = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
    })

    expect(validate(plain)).toMatchObject({ ok: true })
    expect(validate(hashed)).toMatchObject({ ok: true })
  })

  it("verifies recovered and explicit-payee compact signatures", () => {
    const recoveredPayee = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const explicitPayee = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), payeePubkeyField()],
    })

    expect(validate(recoveredPayee)).toMatchObject({ ok: true })
    expect(validate(explicitPayee)).toMatchObject({ ok: true })
  })

  it("accepts high-S only for recovery and ignores recovery for explicit payees", () => {
    const recoveredHighS = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
      signatureHighS: true,
    })
    const explicitHighS = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), payeePubkeyField()],
      signatureHighS: true,
    })
    const explicitWrongRecovery = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), payeePubkeyField()],
      signatureRecoveryId: 2,
    })

    expect(validate(recoveredHighS)).toMatchObject({ ok: true })
    expect(validate(explicitHighS)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/signature/i),
    })
    expect(validate(explicitWrongRecovery)).toMatchObject({ ok: true })
  })

  it("verifies the canonical BOLT11 signed payment vector", () => {
    const canonicalInvoice =
      "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh"

    expect(
      validateLightningInvoiceForPayment({
        invoice: canonicalInvoice,
        expectedAmountMsats: 250_000_000,
        nowSeconds: 1_496_314_688,
      })
    ).toMatchObject({ ok: true })
  })

  it("rejects invalid signatures and signatures bound to another payee", () => {
    const invalidSignature = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
      signatureWords: new Array<number>(BOLT11_SIGNATURE_WORDS).fill(0),
    })
    const mismatchedPayee = payeePubkeyField()
    mismatchedPayee.words = [...mismatchedPayee.words]
    mismatchedPayee.words[1] = mismatchedPayee.words[1]! ^ 1
    const wrongPayee = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), mismatchedPayee],
    })

    for (const invoice of [invalidSignature, wrongPayee]) {
      expect(validate(invoice)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/signature/i),
      })
    }
  })

  it("requires a payment hash while accepting valid ordered alternatives", () => {
    const missing = makeBolt11Invoice({
      fields: [plainDescriptionField()],
    })
    const repeated = makeBolt11Invoice({
      fields: [paymentHashField(), paymentHashField(), plainDescriptionField()],
    })
    const malformedSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        { tag: "p", words: paymentHashField().words.slice(0, 51) },
        plainDescriptionField(),
      ],
    })

    expect(validate(missing)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/payment hash/i),
    })
    expect(validate(repeated)).toMatchObject({ ok: true })
    expect(validate(malformedSecondary)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/payment hash/i),
    })
  })

  it("requires a payment secret while accepting valid ordered alternatives", () => {
    const missing = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
      includePaymentSecret: false,
    })
    const repeated = makeBolt11Invoice({
      fields: [
        paymentSecretField(),
        paymentSecretField(),
        paymentHashField(),
        plainDescriptionField(),
      ],
    })
    const malformed = paymentSecretField()
    malformed.words = malformed.words.slice(0, 51)
    const wrongLength = makeBolt11Invoice({
      fields: [malformed, paymentHashField(), plainDescriptionField()],
    })
    const malformedSecondary = makeBolt11Invoice({
      fields: [
        paymentSecretField(),
        malformed,
        paymentHashField(),
        plainDescriptionField(),
      ],
    })

    expect(validate(repeated)).toMatchObject({ ok: true })
    for (const invoice of [missing, wrongLength, malformedSecondary]) {
      expect(validate(invoice)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/payment secret/i),
      })
    }
  })

  it("rejects unknown mandatory features but ignores unknown optional features", () => {
    const unknownMandatory = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), featureField(52)],
    })
    const unknownOptional = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), featureField(53)],
    })

    expect(validate(unknownMandatory)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/feature bit 52/i),
    })
    expect(validate(unknownOptional)).toMatchObject({ ok: true })
  })

  it("accepts basic MPP without its now-assumed payment-secret feature bit", () => {
    const mandatoryBasicMpp = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), featureField(16)],
    })
    const optionalBasicMpp = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), featureField(17)],
    })
    const explicitPaymentSecretFeature = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        featureField(16, 14),
      ],
    })
    const missingPaymentSecretField = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField(), featureField(16)],
      includePaymentSecret: false,
    })

    expect(validate(mandatoryBasicMpp)).toMatchObject({ ok: true })
    expect(validate(optionalBasicMpp)).toMatchObject({ ok: true })
    expect(validate(explicitPaymentSecretFeature)).toMatchObject({
      ok: true,
    })
    expect(validate(missingPaymentSecretField)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/payment secret/i),
    })
  })

  it("accepts repeated descriptions of one form but rejects missing or mixed forms", () => {
    const missing = makeBolt11Invoice({
      fields: [paymentHashField()],
    })
    const both = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        descriptionHashField(),
      ],
    })
    const duplicatePlain = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField("first"),
        {
          tag: "d",
          words: bytesToBolt11Words(Uint8Array.from([0xc3, 0x28])),
        },
      ],
    })
    const duplicateHash = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(),
        descriptionHashField(`${ZAP_REQUEST_JSON} fallback`),
      ],
    })

    expect(validate(duplicatePlain)).toMatchObject({ ok: true })
    expect(validate(duplicateHash)).toMatchObject({ ok: true })
    for (const invoice of [missing, both]) {
      expect(validate(invoice)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/description/i),
      })
    }
  })

  it("rejects a plain description that is not valid UTF-8", () => {
    const invalidUtf8 = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        {
          tag: "d",
          words: bytesToBolt11Words(Uint8Array.from([0xc3, 0x28])),
        },
      ],
    })

    expect(validate(invalidUtf8)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/description/i),
    })
  })

  it("uses the first valid expiry when ordered alternatives are present", () => {
    const repeated = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        { tag: "x", words: [2] },
        { tag: "x", words: [31] },
      ],
    })

    expect(validate(repeated)).toMatchObject({ ok: true })
    expect(decodeLightningInvoiceMetadata(repeated)).toMatchObject({
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 2,
    })
    expect(
      validateLightningInvoiceForPayment({
        invoice: repeated,
        expectedAmountMsats: 50_000,
        nowSeconds: CREATED_AT + 3,
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/expired/i),
    })
  })

  it("rejects invalid primary or secondary expiry fields", () => {
    const zero = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        { tag: "x", words: [0] },
      ],
    })
    const unsafe = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        { tag: "x", words: new Array<number>(12).fill(31) },
      ],
    })
    const nonMinimalSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        { tag: "x", words: [2] },
        { tag: "x", words: [0, 2] },
      ],
    })
    const unsafeSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        { tag: "x", words: [2] },
        { tag: "x", words: new Array<number>(12).fill(31) },
      ],
    })

    for (const invoice of [
      zero,
      unsafe,
      nonMinimalSecondary,
      unsafeSecondary,
    ]) {
      expect(validate(invoice)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/expiry/i),
      })
    }
  })

  it("uses the first explicit payee and validates every repeated payee field", () => {
    const preferredPayee = payeePubkeyField()
    const alternatePayee = {
      tag: "n",
      words: bytesToBolt11Words(
        secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)
      ),
    }
    const preferredFirst = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        preferredPayee,
        alternatePayee,
      ],
    })
    const fallbackFirst = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        alternatePayee,
        preferredPayee,
      ],
    })
    const malformedSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        plainDescriptionField(),
        preferredPayee,
        { tag: "n", words: alternatePayee.words.slice(0, 52) },
      ],
    })

    expect(validate(preferredFirst)).toMatchObject({ ok: true })
    expect(validate(fallbackFirst)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/signature/i),
    })
    expect(validate(malformedSecondary)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/payee public key/i),
    })
  })
})

describe("NIP-57 BOLT11 description binding", () => {
  it("accepts a single description hash of the exact zap request JSON", () => {
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toEqual({
      ok: true,
      descriptionHashHex: createHash("sha256")
        .update(ZAP_REQUEST_JSON, "utf8")
        .digest("hex"),
    })
  })

  it("binds exact bytes rather than parsed JSON semantics", () => {
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
    })
    const reserialized = JSON.stringify(JSON.parse(ZAP_REQUEST_JSON), null, 2)

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice,
        zapRequestJson: reserialized,
      })
    ).toMatchObject({ ok: false, code: "description_hash_mismatch" })
  })

  it("uses the first repeated description hash as the preferred commitment", () => {
    const preferredFirst = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(),
        descriptionHashField(`${ZAP_REQUEST_JSON} fallback`),
      ],
    })
    const fallbackFirst = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(`${ZAP_REQUEST_JSON} fallback`),
        descriptionHashField(),
      ],
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: preferredFirst,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: true })
    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: fallbackFirst,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "description_hash_mismatch" })
  })

  it("rejects missing and mixed description commitments", () => {
    const missing = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const both = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(),
        plainDescriptionField(),
      ],
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: missing,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "missing_description_hash" })
    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: both,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "ambiguous_description" })
  })

  it("rejects malformed description hashes and non-zero padding", () => {
    const wrongLength = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        {
          tag: "h",
          words: descriptionHashWords(ZAP_REQUEST_JSON).slice(0, 51),
        },
      ],
    })
    const nonZeroPaddingWords = descriptionHashWords(ZAP_REQUEST_JSON)
    nonZeroPaddingWords[51] = nonZeroPaddingWords[51]! | 1
    const nonZeroPadding = makeBolt11Invoice({
      fields: [paymentHashField(), { tag: "h", words: nonZeroPaddingWords }],
    })
    const malformedSecondary = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(),
        {
          tag: "h",
          words: descriptionHashWords(ZAP_REQUEST_JSON).slice(0, 51),
        },
      ],
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: wrongLength,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "invalid_description_hash" })
    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: nonZeroPadding,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "invalid_description_hash" })
    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: malformedSecondary,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "invalid_description_hash" })
    expect(
      validateLightningInvoiceForPayment({
        invoice: malformedSecondary,
        expectedAmountMsats: 50_000,
        nowSeconds: CREATED_AT - 1,
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/description hash/i),
    })
  })

  it("rejects checksummed Bech32 data that is not a BOLT11 invoice", () => {
    const invoice = makeBolt11Invoice({
      hrp: "notbolt500n",
      fields: [paymentHashField(), descriptionHashField()],
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "invalid_bolt11" })
  })

  it("never treats signature words as a description hash", () => {
    const signatureWords = new Array<number>(BOLT11_SIGNATURE_WORDS).fill(0)
    const falseHash = encodeTaggedField(descriptionHashField())
    signatureWords.splice(0, falseHash.length, ...falseHash)
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField()],
      signatureWords,
    })

    expect(
      validateZapInvoiceDescriptionBinding({
        invoice,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "missing_description_hash" })
  })

  it("does not decode expiry data from the compact signature", () => {
    const signatureWords = new Array<number>(BOLT11_SIGNATURE_WORDS).fill(0)
    const falseExpiry = encodeTaggedField({ tag: "x", words: [31] })
    signatureWords.splice(0, falseExpiry.length, ...falseExpiry)
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
      signatureWords,
    })

    expect(decodeLightningInvoiceMetadata(invoice)).toMatchObject({
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3600,
    })
  })
})

describe("fetchZapInvoice description binding", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("returns a callback invoice only when it commits to the sent JSON", async () => {
    const invoice = makeBolt11Invoice({
      fields: [paymentHashField(), descriptionHashField()],
    })
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pr: invoice }),
    })) as unknown as typeof fetch

    await expect(
      fetchZapInvoice(
        "https://wallet.conduit.market/callback",
        50_000,
        ZAP_REQUEST_JSON
      )
    ).resolves.toEqual({ invoice })
  })

  it("rejects a callback invoice committed to another request", async () => {
    const invoice = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(`${ZAP_REQUEST_JSON} `),
      ],
    })
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pr: invoice }),
    })) as unknown as typeof fetch

    await expect(
      fetchZapInvoice(
        "https://wallet.conduit.market/callback",
        50_000,
        ZAP_REQUEST_JSON
      )
    ).rejects.toMatchObject({ code: "description_hash_mismatch" })
  })
})
