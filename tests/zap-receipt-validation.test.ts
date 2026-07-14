import { describe, expect, it } from "bun:test"
import { validateZapReceiptEvent } from "@conduit/core"
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools"

const REQUEST_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 9])
const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 10])
const PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 11])
const OTHER_PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 12])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const REQUEST_CREATED_AT = 1_800_000_000
const AMOUNT_MSATS = 50_000
const LNURL = "lnurl1receiptvalidation"
const INVOICE = "lnbc500n1receiptfixture"

function zapRequest(overrides: Partial<Event> = {}): Event {
  return finalizeEvent(
    {
      kind: 9734,
      created_at: REQUEST_CREATED_AT,
      content: "Zapped out 1 item on Conduit",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["amount", String(AMOUNT_MSATS)],
        ["lnurl", LNURL],
        ["relays", "wss://relay.example"],
        ["omf", "zapout"],
        ["client", "conduit-market"],
      ],
      ...overrides,
    },
    REQUEST_SIGNER_SECRET
  )
}

function zapReceipt(
  options: {
    request?: Event
    invoice?: string
    merchantPubkey?: string
    createdAt?: number
    providerSecret?: Uint8Array
  } = {}
): Event {
  const request = options.request ?? zapRequest()
  return finalizeEvent(
    {
      kind: 9735,
      created_at: options.createdAt ?? REQUEST_CREATED_AT + 2,
      content: "",
      tags: [
        ["p", options.merchantPubkey ?? MERCHANT_PUBKEY],
        ["P", request.pubkey],
        ["bolt11", options.invoice ?? INVOICE],
        ["description", JSON.stringify(request)],
      ],
    },
    options.providerSecret ?? PROVIDER_SECRET
  )
}

function validate(event: Event, overrides: Record<string, unknown> = {}) {
  const request = zapRequest()
  return validateZapReceiptEvent({
    event,
    zapRequestId: request.id,
    requestCreatedAt: REQUEST_CREATED_AT,
    recipientPubkey: MERCHANT_PUBKEY,
    expectedAmountMsats: AMOUNT_MSATS,
    expectedLnurl: LNURL,
    expectedInvoice: INVOICE,
    lnurlNostrPubkey: PROVIDER_PUBKEY,
    receiptNotAfterSeconds: REQUEST_CREATED_AT + 600,
    ...overrides,
  } as Parameters<typeof validateZapReceiptEvent>[0])
}

describe("strict zap receipt validation", () => {
  it("accepts a fully signed receipt linked to the exact request and invoice", () => {
    expect(validate(zapReceipt())).toBe(true)
  })

  it("rejects forged receipt and embedded-request signatures", () => {
    const receipt = zapReceipt()
    expect(validate({ ...receipt, content: "tampered" } as Event)).toBe(false)

    const request = zapRequest()
    const forgedRequest = { ...request, content: "tampered" }
    expect(validate(zapReceipt({ request: forgedRequest as Event }))).toBe(
      false
    )
  })

  it("rejects a different invoice, merchant, amount, LNURL, or provider", () => {
    expect(validate(zapReceipt({ invoice: "lnbc500n1different" }))).toBe(false)
    expect(
      validate(
        zapReceipt({ merchantPubkey: getPublicKey(OTHER_PROVIDER_SECRET) })
      )
    ).toBe(false)
    expect(
      validate(
        zapReceipt({
          request: zapRequest({
            tags: zapRequest().tags.map((tag) =>
              tag[0] === "amount" ? ["amount", "51000"] : tag
            ),
          }),
        })
      )
    ).toBe(false)
    expect(
      validate(
        zapReceipt({
          request: zapRequest({
            tags: zapRequest().tags.map((tag) =>
              tag[0] === "lnurl" ? ["lnurl", "lnurl1different"] : tag
            ),
          }),
        })
      )
    ).toBe(false)
    expect(
      validate(zapReceipt({ providerSecret: OTHER_PROVIDER_SECRET }))
    ).toBe(false)
  })

  it("rejects receipts outside the authorized observation window", () => {
    expect(validate(zapReceipt({ createdAt: REQUEST_CREATED_AT - 6 }))).toBe(
      false
    )
    expect(validate(zapReceipt({ createdAt: REQUEST_CREATED_AT + 601 }))).toBe(
      false
    )
  })
})
