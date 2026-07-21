import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import {
  appendOmfZapoutMarker,
  encodeLnurl,
  hasOmfZapoutMarker,
  OMF_ZAPOUT_MARKER_TAG,
  parseOmfZapoutReceipt,
  parseVerifiedOmfZapoutReceipt,
  parseZapReceiptDescription,
  verifyOmfZapoutReceiptAuthority,
} from "../packages/core/src/protocol/lightning"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const SENDER_SECRET = Uint8Array.from([...new Uint8Array(31), 9])
const WALLET_SECRET = Uint8Array.from([...new Uint8Array(31), 10])
const SENDER_PUBKEY = getPublicKey(SENDER_SECRET)
const RECIPIENT_PUBKEY = "2".repeat(64)
const WALLET_PUBKEY = getPublicKey(WALLET_SECRET)
const PAY_REQUEST_URL = "https://wallet.example/.well-known/lnurlp/merchant"
const LNURL = encodeLnurl(PAY_REQUEST_URL)
const HISTORIC_CREATED_AT = 1_765_000_000

type ZapReceiptInput = Parameters<typeof parseOmfZapoutReceipt>[0]

function zapRequest(
  tags: string[][] = [],
  lnurl = LNURL,
  createdAt = HISTORIC_CREATED_AT
) {
  return finalizeEvent(
    {
      created_at: createdAt,
      kind: 9734,
      content: "Paid publicly\nfrom checkout.",
      tags: [
        ["p", RECIPIENT_PUBKEY],
        ["amount", "42000"],
        ["lnurl", lnurl],
        ["relays", "wss://relay.example"],
        ...tags,
      ],
    },
    SENDER_SECRET
  )
}

function boundInvoice(
  description: string,
  createdAt = HISTORIC_CREATED_AT
): string {
  return makeBolt11Fixture({
    hrp: "lnbc420n",
    createdAt,
    fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(description)],
  })
}

function zapReceipt(
  description: string,
  overrides: Record<string, unknown> = {}
) {
  const input = {
    created_at: 1_765_000_010,
    kind: 9735,
    content: "",
    tags: [
      ["p", RECIPIENT_PUBKEY],
      ["P", SENDER_PUBKEY],
      ["amount", "42000"],
      ["bolt11", boundInvoice(description)],
      ["description", description],
    ],
    ...overrides,
  }
  return finalizeEvent(
    {
      created_at: input.created_at as number,
      kind: input.kind as number,
      content: input.content as string,
      tags: input.tags as string[][],
    },
    WALLET_SECRET
  )
}

describe("OMF zapout marker helpers", () => {
  it("detects the single OMF zapout marker tag", () => {
    expect(
      hasOmfZapoutMarker([["p", RECIPIENT_PUBKEY], [...OMF_ZAPOUT_MARKER_TAG]])
    ).toBe(true)
    expect(hasOmfZapoutMarker([["t", "omf-zapout"]])).toBe(false)
    expect(hasOmfZapoutMarker([["omf", "zapout", "cart"]])).toBe(false)
  })

  it("appends the marker once", () => {
    const initial = [["p", RECIPIENT_PUBKEY]]
    const first = appendOmfZapoutMarker(initial)
    const second = appendOmfZapoutMarker(first)

    expect(first).toEqual([["p", RECIPIENT_PUBKEY], [...OMF_ZAPOUT_MARKER_TAG]])
    expect(second).toEqual(first)
  })

  it("appends the canonical marker when only an extended marker-like tag exists", () => {
    const initial = [["omf", "zapout", "cart"]]

    expect(appendOmfZapoutMarker(initial)).toEqual([
      ["omf", "zapout", "cart"],
      [...OMF_ZAPOUT_MARKER_TAG],
    ])
  })

  it("parses zap receipt description JSON defensively", () => {
    const request = zapRequest()
    expect(parseZapReceiptDescription(JSON.stringify(request))).toMatchObject({
      id: request.id,
      kind: 9734,
    })
    expect(parseZapReceiptDescription("{bad json")).toBeNull()
    expect(parseZapReceiptDescription("[]")).toBeNull()
  })
})

describe("parseOmfZapoutReceipt", () => {
  it("detects marked receipts through the embedded zap request description", () => {
    const request = zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])
    const receipt = zapReceipt(JSON.stringify(request))

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toEqual({
      id: receipt.id,
      createdAt: 1_765_000_010,
      receiptPubkey: WALLET_PUBKEY,
      zapRequestId: request.id,
      zapRequestCreatedAt: 1_765_000_000,
      senderPubkey: SENDER_PUBKEY,
      recipientPubkey: RECIPIENT_PUBKEY,
      amountMsats: 42_000,
      comment: "Paid publicly from checkout.",
      sourceRelayUrls: [],
    })
  })

  it("ignores unmarked zap receipts", () => {
    const receipt = zapReceipt(JSON.stringify(zapRequest()))

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("ignores malformed descriptions", () => {
    const receipt = zapReceipt("{bad json")

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("ignores non-receipt event kinds", () => {
    const receipt = zapReceipt(
      JSON.stringify(zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])),
      { kind: 1 }
    )

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("ignores receipts whose outer event signature is invalid", () => {
    const receipt = zapReceipt(
      JSON.stringify(zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]))
    )

    expect(
      parseOmfZapoutReceipt({
        ...receipt,
        content: "tampered",
      } as ZapReceiptInput)
    ).toBeNull()
  })

  it("ignores descriptions that are not zap requests", () => {
    const request = {
      ...zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]),
      kind: 1,
    }
    const receipt = zapReceipt(JSON.stringify(request))

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("rejects unsigned or tampered embedded zap requests", () => {
    const request = {
      ...zapRequest([["p", "not-a-pubkey"], [...OMF_ZAPOUT_MARKER_TAG]]),
      id: "not-an-event-id",
      pubkey: "not-a-pubkey",
    }
    expect(
      parseOmfZapoutReceipt(
        zapReceipt(JSON.stringify(request)) as ZapReceiptInput
      )
    ).toBeNull()
  })

  it("rejects receipts whose recipient, sender, or amount conflicts with the request", () => {
    const description = JSON.stringify(zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]))
    for (const conflictingTags of [
      [
        ["p", "6".repeat(64)],
        ["P", SENDER_PUBKEY],
        ["amount", "42000"],
      ],
      [
        ["p", RECIPIENT_PUBKEY],
        ["P", "7".repeat(64)],
        ["amount", "42000"],
      ],
      [
        ["p", RECIPIENT_PUBKEY],
        ["P", SENDER_PUBKEY],
        ["amount", "43000"],
      ],
    ]) {
      const receipt = zapReceipt(description, {
        tags: [
          ...conflictingTags,
          ["bolt11", boundInvoice(description)],
          ["description", description],
        ],
      })
      expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
    }
  })

  it("rejects receipts whose invoice is not bound to the exact signed request", () => {
    const description = JSON.stringify(zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]))
    const receipt = zapReceipt(description, {
      tags: [
        ["p", RECIPIENT_PUBKEY],
        ["P", SENDER_PUBKEY],
        ["amount", "42000"],
        ["bolt11", boundInvoice(`${description} `)],
        ["description", description],
      ],
    })

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("rejects materially reversed or implausibly future event timestamps", () => {
    const request = zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])
    const description = JSON.stringify(request)
    const materiallyEarlyReceipt = zapReceipt(description, {
      created_at: request.created_at - 6,
    })
    const toleratedClockSkewReceipt = zapReceipt(description, {
      created_at: request.created_at - 5,
    })
    const futureCreatedAt = Math.floor(Date.now() / 1_000) + 3_600
    const futureReceipt = zapReceipt(description, {
      created_at: futureCreatedAt,
    })
    const futureRequest = zapRequest(
      [[...OMF_ZAPOUT_MARKER_TAG]],
      LNURL,
      futureCreatedAt
    )
    const futureDescription = JSON.stringify(futureRequest)
    const futureRequestReceipt = zapReceipt(futureDescription, {
      created_at: futureCreatedAt + 1,
      tags: [
        ["p", RECIPIENT_PUBKEY],
        ["P", SENDER_PUBKEY],
        ["amount", "42000"],
        ["bolt11", boundInvoice(futureDescription, futureCreatedAt)],
        ["description", futureDescription],
      ],
    })

    expect(
      parseOmfZapoutReceipt(materiallyEarlyReceipt as ZapReceiptInput)
    ).toBeNull()
    expect(
      parseOmfZapoutReceipt(toleratedClockSkewReceipt as ZapReceiptInput)
    ).not.toBeNull()
    expect(parseOmfZapoutReceipt(futureReceipt as ZapReceiptInput)).toBeNull()
    expect(
      parseOmfZapoutReceipt(futureRequestReceipt as ZapReceiptInput)
    ).toBeNull()
  })

  it("does not expose structured checkout fields in parsed public feed data", () => {
    const request = {
      ...zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]),
      orderId: "order-secret",
      cart: [{ title: "private item" }],
      shippingAddress: "private address",
    }
    const parsed = parseOmfZapoutReceipt(
      zapReceipt(JSON.stringify(request)) as ZapReceiptInput
    )
    const publicRecord = parsed as unknown as Record<string, unknown>

    expect(parsed).not.toBeNull()
    expect(publicRecord.orderId).toBeUndefined()
    expect(publicRecord.cart).toBeUndefined()
    expect(publicRecord.shippingAddress).toBeUndefined()
  })
})

describe("parseVerifiedOmfZapoutReceipt", () => {
  it("requires the recipient's resolved LNURL provider to sign the receipt", async () => {
    const request = zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])
    const receipt = zapReceipt(JSON.stringify(request))
    const resolverCalls: Array<[string, string]> = []

    const parsed = await parseVerifiedOmfZapoutReceipt(
      receipt as ZapReceiptInput,
      {
        resolveLnurlNostrPubkey: async (payRequestUrl, recipientPubkey) => {
          resolverCalls.push([payRequestUrl, recipientPubkey])
          return WALLET_PUBKEY
        },
      }
    )

    expect(parsed?.id).toBe(receipt.id)
    expect(resolverCalls).toEqual([[PAY_REQUEST_URL, RECIPIENT_PUBKEY]])
  })

  it("fails closed for a missing resolver, provider mismatch, or resolver failure", async () => {
    const request = zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])
    const receipt = zapReceipt(JSON.stringify(request)) as ZapReceiptInput

    await expect(parseVerifiedOmfZapoutReceipt(receipt)).resolves.toBeNull()
    await expect(
      parseVerifiedOmfZapoutReceipt(receipt, {
        resolveLnurlNostrPubkey: async () => "3".repeat(64),
      })
    ).resolves.toBeNull()
    await expect(
      parseVerifiedOmfZapoutReceipt(receipt, {
        resolveLnurlNostrPubkey: async () => {
          throw new Error("metadata unavailable")
        },
      })
    ).resolves.toBeNull()
  })

  it("reports verified, invalid, and unavailable authority outcomes", async () => {
    const request = zapRequest([[...OMF_ZAPOUT_MARKER_TAG]])
    const receipt = zapReceipt(JSON.stringify(request)) as ZapReceiptInput

    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => ({
          status: "resolved",
          pubkey: WALLET_PUBKEY,
        }),
      })
    ).resolves.toMatchObject({
      status: "verified",
      receipt: { id: receipt.id },
    })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => ({ status: "invalid" }),
      })
    ).resolves.toEqual({ status: "invalid", receipt: null })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => ({
          status: "resolved",
          pubkey: "3".repeat(64),
        }),
      })
    ).resolves.toEqual({ status: "invalid", receipt: null })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => ({ status: "unavailable" }),
      })
    ).resolves.toMatchObject({
      status: "authority_unavailable",
      receipt: { id: receipt.id },
    })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => null,
      })
    ).resolves.toMatchObject({ status: "authority_unavailable" })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt)
    ).resolves.toMatchObject({ status: "authority_unavailable" })
    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => {
          throw new Error("relay unavailable")
        },
      })
    ).resolves.toMatchObject({ status: "authority_unavailable" })
    await expect(
      verifyOmfZapoutReceiptAuthority({
        ...receipt,
        content: "tampered",
      } as ZapReceiptInput)
    ).resolves.toEqual({ status: "invalid", receipt: null })
  })

  it("uses a verified checkout-time provider attestation without mutable metadata", async () => {
    const request = zapRequest([
      [...OMF_ZAPOUT_MARKER_TAG],
      ["omf_provider", WALLET_PUBKEY],
    ])
    const receipt = zapReceipt(JSON.stringify(request)) as ZapReceiptInput
    let resolverCalls = 0

    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        verifyProviderAttestation: async () => "verified",
        resolveLnurlNostrPubkey: async () => {
          resolverCalls += 1
          return null
        },
      })
    ).resolves.toMatchObject({ status: "verified" })
    expect(resolverCalls).toBe(0)
  })

  it("does not downgrade duplicate provider attestations to mutable metadata", async () => {
    const request = zapRequest([
      [...OMF_ZAPOUT_MARKER_TAG],
      ["omf_provider", WALLET_PUBKEY],
      ["omf_provider", "3".repeat(64)],
    ])
    const receipt = zapReceipt(JSON.stringify(request)) as ZapReceiptInput
    let resolverCalls = 0

    await expect(
      verifyOmfZapoutReceiptAuthority(receipt, {
        resolveLnurlNostrPubkey: async () => {
          resolverCalls += 1
          return WALLET_PUBKEY
        },
      })
    ).resolves.toEqual({ status: "invalid", receipt: null })
    expect(resolverCalls).toBe(0)
  })

  it("does not resolve malformed or unsafe request LNURLs", async () => {
    const invalidLnurlRequest = zapRequest(
      [[...OMF_ZAPOUT_MARKER_TAG]],
      "lnurl1invalid"
    )
    const invalidLnurlReceipt = zapReceipt(JSON.stringify(invalidLnurlRequest))
    const unsafeLnurlRequest = zapRequest(
      [[...OMF_ZAPOUT_MARKER_TAG]],
      encodeLnurl("https://127.0.0.1/.well-known/lnurlp/test")
    )
    const unsafeLnurlReceipt = zapReceipt(JSON.stringify(unsafeLnurlRequest))
    let resolverCalls = 0
    const options = {
      resolveLnurlNostrPubkey: async () => {
        resolverCalls += 1
        return WALLET_PUBKEY
      },
    }

    await expect(
      parseVerifiedOmfZapoutReceipt(
        invalidLnurlReceipt as ZapReceiptInput,
        options
      )
    ).resolves.toBeNull()
    await expect(
      parseVerifiedOmfZapoutReceipt(
        unsafeLnurlReceipt as ZapReceiptInput,
        options
      )
    ).resolves.toBeNull()
    expect(resolverCalls).toBe(0)
  })
})
