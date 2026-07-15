import { afterEach, describe, expect, it, mock } from "bun:test"
import { createHash } from "node:crypto"

import {
  decodeLightningInvoiceMetadata,
  fetchZapInvoice,
  validateZapInvoiceDescriptionBinding,
} from "../packages/core/src/protocol/lightning"
import {
  BOLT11_SIGNATURE_WORDS,
  bolt11DescriptionHashField as buildDescriptionHashField,
  bolt11DescriptionHashWords as descriptionHashWords,
  bolt11PaymentHashField as paymentHashField,
  bolt11PlainDescriptionField as plainDescriptionField,
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

  it("rejects missing and ambiguous description commitments", () => {
    const missing = makeBolt11Invoice({
      fields: [paymentHashField(), plainDescriptionField()],
    })
    const duplicate = makeBolt11Invoice({
      fields: [
        paymentHashField(),
        descriptionHashField(),
        descriptionHashField(),
      ],
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
        invoice: duplicate,
        zapRequestJson: ZAP_REQUEST_JSON,
      })
    ).toMatchObject({ ok: false, code: "ambiguous_description" })
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
        "https://wallet.example/callback",
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
        "https://wallet.example/callback",
        50_000,
        ZAP_REQUEST_JSON
      )
    ).rejects.toMatchObject({ code: "description_hash_mismatch" })
  })
})
