import { describe, expect, it } from "bun:test"
import { validateZapReceiptEvent } from "@conduit/core"
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const REQUEST_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 9])
const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 10])
const PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 11])
const OTHER_PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 12])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const REQUEST_CREATED_AT = 1_800_000_000
const AMOUNT_MSATS = 50_000
const LNURL = "lnurl1receiptvalidation"

function boundInvoice(description: string): string {
  return makeBolt11Fixture({
    hrp: "lnbc500n",
    createdAt: REQUEST_CREATED_AT,
    fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(description)],
  })
}

function zapRequest(overrides: Partial<Event> = {}): Event {
  return finalizeEvent(
    {
      kind: 9734,
      created_at: REQUEST_CREATED_AT,
      content: "Zapped out 1 item at https://shop.conduit.market/",
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

const DEFAULT_REQUEST = zapRequest()

function zapReceipt(
  options: {
    request?: Event
    invoice?: string
    merchantPubkey?: string
    createdAt?: number
    providerSecret?: Uint8Array
    description?: string
    extraTags?: string[][]
  } = {}
): Event {
  const request = options.request ?? DEFAULT_REQUEST
  const description = options.description ?? JSON.stringify(request)
  return finalizeEvent(
    {
      kind: 9735,
      created_at: options.createdAt ?? REQUEST_CREATED_AT + 2,
      content: "",
      tags: [
        ["p", options.merchantPubkey ?? MERCHANT_PUBKEY],
        ["P", request.pubkey],
        ["bolt11", options.invoice ?? boundInvoice(description)],
        ["description", description],
        ...(options.extraTags ?? []),
      ],
    },
    options.providerSecret ?? PROVIDER_SECRET
  )
}

function validate(event: Event, overrides: Record<string, unknown> = {}) {
  const request = DEFAULT_REQUEST
  const expectedInvoice = boundInvoice(JSON.stringify(request))
  return validateZapReceiptEvent({
    event,
    zapRequestId: request.id,
    requestCreatedAt: REQUEST_CREATED_AT,
    recipientPubkey: MERCHANT_PUBKEY,
    expectedAmountMsats: AMOUNT_MSATS,
    expectedLnurl: LNURL,
    expectedInvoice,
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
    const request = zapRequest()
    expect(
      validate(
        zapReceipt({
          request,
          invoice: boundInvoice(`${JSON.stringify(request)} `),
        })
      )
    ).toBe(false)
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

  it("rejects a description that is not the exact JSON committed by the invoice", () => {
    const request = zapRequest()
    const reserializedDescription = JSON.stringify(request, null, 2)

    expect(
      validate(
        zapReceipt({
          request,
          description: reserializedDescription,
          invoice: boundInvoice(JSON.stringify(request)),
        })
      )
    ).toBe(false)
  })

  it("rejects duplicate critical receipt tags", () => {
    const request = zapRequest()
    const description = JSON.stringify(request)
    const invoice = boundInvoice(description)
    const duplicateTagGroups = [
      [["p", MERCHANT_PUBKEY]],
      [["P", request.pubkey]],
      [["bolt11", invoice]],
      [["description", description]],
      [
        ["amount", String(AMOUNT_MSATS)],
        ["amount", String(AMOUNT_MSATS)],
      ],
    ]

    for (const duplicateTags of duplicateTagGroups) {
      expect(
        validate(zapReceipt({ request, invoice, extraTags: duplicateTags }))
      ).toBe(false)
    }
  })

  it("rejects duplicate critical zap-request tags", () => {
    const base = zapRequest()
    for (const duplicateTag of [
      ["p", MERCHANT_PUBKEY],
      ["amount", String(AMOUNT_MSATS)],
      ["lnurl", LNURL],
    ]) {
      const request = zapRequest({ tags: [...base.tags, duplicateTag] })
      const receipt = zapReceipt({ request })
      expect(
        validate(receipt, {
          zapRequestId: request.id,
          expectedInvoice: boundInvoice(JSON.stringify(request)),
        })
      ).toBe(false)
    }
  })
})
