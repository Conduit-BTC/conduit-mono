import { describe, expect, it } from "bun:test"
import {
  appendOmfZapoutMarker,
  hasOmfZapoutMarker,
  OMF_ZAPOUT_MARKER_TAG,
  parseOmfZapoutReceipt,
  parseZapReceiptDescription,
} from "../packages/core/src/protocol/lightning"

const SENDER_PUBKEY = "1".repeat(64)
const RECIPIENT_PUBKEY = "2".repeat(64)
const WALLET_PUBKEY = "3".repeat(64)
const RECEIPT_ID = "4".repeat(64)
const ZAP_REQUEST_ID = "5".repeat(64)

type ZapReceiptInput = Parameters<typeof parseOmfZapoutReceipt>[0]

function zapRequest(tags: string[][] = []) {
  return {
    id: ZAP_REQUEST_ID,
    pubkey: SENDER_PUBKEY,
    created_at: 1_765_000_000,
    kind: 9734,
    content: "Paid publicly\nfrom checkout.",
    tags: [
      ["p", RECIPIENT_PUBKEY],
      ["amount", "42000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ...tags,
    ],
  }
}

function zapReceipt(
  description: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: RECEIPT_ID,
    pubkey: WALLET_PUBKEY,
    created_at: 1_765_000_010,
    kind: 9735,
    tags: [
      ["p", RECIPIENT_PUBKEY],
      ["P", SENDER_PUBKEY],
      ["amount", "42000"],
      ["bolt11", "lnbc1test"],
      ["description", description],
    ],
    ...overrides,
  }
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
    expect(
      parseZapReceiptDescription(JSON.stringify(zapRequest()))
    ).toMatchObject({
      id: ZAP_REQUEST_ID,
      kind: 9734,
    })
    expect(parseZapReceiptDescription("{bad json")).toBeNull()
    expect(parseZapReceiptDescription("[]")).toBeNull()
  })
})

describe("parseOmfZapoutReceipt", () => {
  it("detects marked receipts through the embedded zap request description", () => {
    const receipt = zapReceipt(
      JSON.stringify(zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]))
    )

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toEqual({
      id: RECEIPT_ID,
      createdAt: 1_765_000_010,
      receiptPubkey: WALLET_PUBKEY,
      zapRequestId: ZAP_REQUEST_ID,
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

  it("ignores descriptions that are not zap requests", () => {
    const request = {
      ...zapRequest([[...OMF_ZAPOUT_MARKER_TAG]]),
      kind: 1,
    }
    const receipt = zapReceipt(JSON.stringify(request))

    expect(parseOmfZapoutReceipt(receipt as ZapReceiptInput)).toBeNull()
  })

  it("falls back to receipt pubkeys when embedded request pubkeys are malformed", () => {
    const request = {
      ...zapRequest([["p", "not-a-pubkey"], [...OMF_ZAPOUT_MARKER_TAG]]),
      id: "not-an-event-id",
      pubkey: "not-a-pubkey",
    }
    const parsed = parseOmfZapoutReceipt(
      zapReceipt(JSON.stringify(request)) as ZapReceiptInput
    )

    expect(parsed).toMatchObject({
      zapRequestId: null,
      senderPubkey: SENDER_PUBKEY,
      recipientPubkey: RECIPIENT_PUBKEY,
    })
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
