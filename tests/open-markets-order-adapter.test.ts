import { afterEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { wrapEvent } from "nostr-tools/nip59"
import { ConduitDB } from "../packages/core/src/db"
import { projectCommerceInbox } from "../packages/core/src/protocol/commerce"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import {
  getProtectedReadAuthorization,
  installProtectedReadSigner,
  __resetProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import { admitFixture } from "./helpers/public-event"
import { createHash } from "node:crypto"
import { createPrivateMessageRumor } from "../packages/core/src/protocol/messaging"
import { parseOrderMessageRumorEvent } from "../packages/core/src/protocol/orders"
import { encodeOpenMarketsMerchantReply } from "../packages/core/src/protocol/commerce-wire"
import { extractOrderSummary } from "../packages/core/src/protocol/order-summary"
import {
  getMerchantPaymentVerificationCandidates,
  verifyMerchantPaymentCandidates,
} from "../apps/merchant/src/lib/merchant-payment-verification"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const owners: CommerceInbox[] = []
const databases: ConduitDB[] = []
const sha256 = (value: Uint8Array) =>
  new Uint8Array(createHash("sha256").update(value).digest())
const bytesToHex = (value: Uint8Array) => Buffer.from(value).toString("hex")
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

function fixture() {
  const merchant = generateSecretKey()
  const buyer = generateSecretKey()
  const pubkey = getPublicKey(merchant)
  const buyerPubkey = getPublicKey(buyer)
  const signer: NostrKeySigner = {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, merchant),
    encryptNip44: async (peer, text) =>
      v2.encrypt(text, v2.utils.getConversationKey(merchant, peer)),
    decryptNip44: async (peer, text) =>
      v2.decrypt(text, v2.utils.getConversationKey(merchant, peer)),
  }
  installProtectedReadSigner(signer, pubkey, () => true)
  const authorization = getProtectedReadAuthorization(pubkey)!
  const database = new ConduitDB(`open-markets-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  const store = new CommerceInboxStore(authorization, database)
  const owner = new CommerceInbox(authorization, signer, store)
  owners.push(owner)
  const product = `30402:${pubkey}:book`
  const order = {
    kind: 16,
    pubkey: buyerPubkey,
    created_at: 1_800_000_000,
    tags: [
      ["p", pubkey],
      ["subject", "Order"],
      ["type", "1"],
      ["order", "external-order"],
      ["amount", "200"],
      ["item", product, "2"],
      ["address", "An address requiring merchant review"],
    ],
    content: "Please confirm delivery before invoicing.",
  }
  return {
    owner,
    store,
    database,
    signer,
    pubkey,
    buyerPubkey,
    product,
    order,
    buyer,
    merchant,
  }
}

function reply(
  f: ReturnType<typeof fixture>,
  type: string,
  payload: Record<string, unknown>
) {
  return createPrivateMessageRumor(
    encodeOpenMarketsMerchantReply(
      {
        pubkey: f.pubkey,
        kind: 16,
        created_at: f.order.created_at + 1,
        tags: [
          ["p", f.buyerPubkey],
          ["order", "local-domain-id"],
          ["type", type],
        ],
        content: JSON.stringify(payload),
      },
      "external-order"
    )
  )
}

async function receive(
  f: ReturnType<typeof fixture>,
  rumor: Parameters<typeof wrapEvent>[0],
  sender = f.buyer
) {
  await f.owner.ingest(await admitFixture(wrapEvent(rumor, sender, f.pubkey)), [
    "wss://fixture.example",
  ])
  await f.owner.waitForDecode()
  return projectCommerceInbox(f.owner.getSnapshot(), f.pubkey).merchant.data
}

describe("Open Markets orders through the authenticated shared inbox", () => {
  it("reaches Merchant review without inventing missing item prices", async () => {
    const f = fixture()
    await f.owner.initialize()
    const wrapper = wrapEvent(f.order, f.buyer, f.pubkey)
    await f.owner.ingest(await admitFixture(wrapper), ["wss://fixture.example"])
    await f.owner.waitForDecode()
    const conversations = projectCommerceInbox(f.owner.getSnapshot(), f.pubkey)
      .merchant.data
    expect(conversations).toHaveLength(1)
    const message = conversations[0]!.messages!.find((m) => m.type === "order")!
    expect(message.type).toBe("order")
    if (message.type !== "order") throw new Error("Expected an order")
    expect(message.payload.items[0]!.productId).toBe(f.product)
    expect(message.payload.items[0]!.priceAtPurchase).toBeUndefined()
    expect(message.payload.subtotal).toBe(200)
    expect(message.payload.shippingAddress).toBeUndefined()
    expect(f.owner.getSnapshot().diagnostics.orderAdapter).toEqual({
      canonicalOrders: 0,
      compatibleOrders: 1,
      compatibleReplies: 0,
      conflictingOrders: 0,
    })
    await receive(f, f.order)
    expect(f.owner.getSnapshot().orderMessages.length).toBe(1)
    expect(
      f.owner.getSnapshot().diagnostics.orderAdapter?.compatibleOrders
    ).toBe(1)
  })

  it("uses a distinct local order identity for another buyer using the same wire ID", async () => {
    const f = fixture()
    await receive(f, f.order)
    const other = generateSecretKey()
    const conversations = await receive(
      f,
      { ...f.order, pubkey: getPublicKey(other) },
      other
    )
    expect(conversations.length).toBe(2)
    expect(new Set(conversations.map((row) => row.orderId)).size).toBe(2)
    expect(
      conversations.every((row) =>
        row.messages?.every(
          (message) => message.senderPubkey === row.buyerPubkey
        )
      )
    ).toBe(true)
  })

  it("preserves numeric reply fields and richer merchant state through a real self-copy", async () => {
    const f = fixture()
    await receive(f, f.order)
    for (const [type, payload, numeric] of [
      [
        "status_update",
        { status: "accepted", note: "Accepted for review" },
        "3",
      ],
      ["status_update", { status: "paid" }, "3"],
      [
        "shipping_update",
        { carrier: "Example", trackingNumber: "tracking" },
        "4",
      ],
    ] as const) {
      const rumor = reply(f, type, payload)
      expect(
        rumor.tags.some((tag) => tag[0] === "type" && tag[1] === numeric)
      ).toBe(true)
      expect(
        rumor.tags.some(
          (tag) => tag[0] === "order" && tag[1] === "external-order"
        )
      ).toBe(true)
      expect(rumor.content.startsWith("{")).toBe(false)
      const parsed = parseOrderMessageRumorEvent(rumor)
      expect(parsed.type).toBe(type)
      await receive(f, rumor, f.merchant)
    }
    const summary = extractOrderSummary(f.owner.getSnapshot().orderMessages)
    expect(summary.accepted).toBe(true)
    expect(summary.paymentConfirmed).toBe(true)
    expect(summary.shippingUpdateReceived).toBe(true)
    expect(summary.itemSubtotal).toBeNull()
  })

  it("keeps ordinary order notes on kind 14 and links only their exact party-scoped order", async () => {
    const f = fixture()
    await receive(f, f.order)
    const rumor = reply(f, "message", { note: "Please confirm delivery" })
    expect(rumor.kind).toBe(14)
    await receive(f, rumor, f.merchant)
    const snapshot = f.owner.getSnapshot()
    expect(snapshot.directMessages.length).toBe(1)
    expect(
      snapshot.orderMessages.filter((message) => message.type === "message")
        .length
    ).toBe(1)
    const stranger = generateSecretKey()
    await receive(
      f,
      {
        ...rumor,
        pubkey: getPublicKey(stranger),
        tags: [
          ["p", f.pubkey],
          ["subject", "external-order"],
        ],
      },
      stranger
    )
    expect(
      f.owner
        .getSnapshot()
        .orderMessages.filter((message) => message.type === "message").length
    ).toBe(1)
  })

  it("requires the exact merchant invoice and wallet settlement before confirming a Lightning claim", async () => {
    const f = fixture()
    const now = Math.floor(Date.now() / 1000)
    f.order.created_at = now - 5
    await receive(f, f.order)
    const preimage = generateSecretKey()
    const hash = bytesToHex(sha256(preimage))
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      createdAt: now,
      fields: [
        bolt11PaymentHashField(sha256(preimage)),
        bolt11PlainDescriptionField("Synthetic adapter invoice"),
      ],
    })
    const receipt = {
      ...f.order,
      kind: 17,
      created_at: now + 2,
      tags: [
        ["p", f.pubkey],
        ["subject", "Receipt"],
        ["order", "external-order"],
        ["amount", "200"],
        ["payment", "lightning", invoice, bytesToHex(preimage)],
      ],
      content: "Payment sent",
    }
    let conversations = await receive(f, receipt)
    expect(getMerchantPaymentVerificationCandidates(conversations).length).toBe(
      0
    )
    const differentInvoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      createdAt: now,
      fields: [
        bolt11PaymentHashField(sha256(generateSecretKey())),
        bolt11PlainDescriptionField("Different synthetic invoice"),
      ],
    })
    conversations = await receive(
      f,
      reply(f, "payment_request", {
        invoice: differentInvoice,
        amount: 200,
        currency: "SATS",
      }),
      f.merchant
    )
    expect(getMerchantPaymentVerificationCandidates(conversations).length).toBe(
      0
    )
    const request = reply(f, "payment_request", {
      invoice,
      amount: 200,
      currency: "SATS",
    })
    expect(
      request.tags.some(
        (tag) =>
          tag[0] === "payment" && tag[1] === "lightning" && tag[2] === invoice
      )
    ).toBe(true)
    conversations = await receive(f, request, f.merchant)
    const candidates = getMerchantPaymentVerificationCandidates(conversations)
    expect(candidates.length).toBe(1)
    expect(
      extractOrderSummary(conversations[0]!.messages!).paymentConfirmed
    ).toBe(false)
    let confirmations = 0
    const confirmedEvidence = new Set<string>()
    const settlement = {
      type: "incoming" as const,
      state: "settled" as const,
      invoice,
      amountMsats: 200_000,
      paymentHash: hash,
      settledAt: now,
    }
    const dependencies = {
      candidates,
      confirmedEvidence,
      lookupInvoice: async () => settlement,
      publishConfirmation: async () => {
        confirmations++
      },
    }
    for (const settlementChange of [
      { state: "pending" as const },
      { type: "outgoing" as const },
      { amountMsats: 199_000 },
      { paymentHash: bytesToHex(sha256(generateSecretKey())) },
      { invoice: "different-invoice" },
    ]) {
      await verifyMerchantPaymentCandidates({
        ...dependencies,
        lookupInvoice: async () => ({ ...settlement, ...settlementChange }),
      })
    }
    expect(confirmations).toBe(0)
    await verifyMerchantPaymentCandidates(dependencies)
    await verifyMerchantPaymentCandidates(dependencies)
    expect(confirmations).toBe(1)
    await receive(f, { ...receipt, created_at: now + 3 })
    expect(
      getMerchantPaymentVerificationCandidates(
        projectCommerceInbox(f.owner.getSnapshot(), f.pubkey).merchant.data
      ).length
    ).toBe(1)
  })

  it("retains malformed proofs and unmodeled shipping states without granting authority", async () => {
    const f = fixture()
    await receive(f, f.order)
    const preimage = generateSecretKey()
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(sha256(preimage)),
        bolt11PlainDescriptionField("Synthetic negative proof"),
      ],
    })
    const receiptTags = [
      ["p", f.pubkey],
      ["subject", "Receipt"],
      ["order", "external-order"],
      ["amount", "200"],
      ["payment", "lightning", invoice, bytesToHex(preimage)],
    ]
    for (const tags of [
      receiptTags.map((tag) => (tag[0] === "amount" ? ["amount", "201"] : tag)),
      receiptTags.map((tag) =>
        tag[0] === "payment"
          ? ["payment", "lightning", invoice, bytesToHex(generateSecretKey())]
          : tag
      ),
      receiptTags.map((tag) =>
        tag[0] === "payment" ? ["payment", "bitcoin", "unsupported"] : tag
      ),
      [...receiptTags, ["payment", "lightning", invoice, bytesToHex(preimage)]],
    ])
      await receive(f, { ...f.order, kind: 17, tags })
    for (const status of ["processing", "delivered", "exception"]) {
      await receive(f, {
        ...f.order,
        tags: [
          ["p", f.pubkey],
          ["subject", "Shipping"],
          ["order", "external-order"],
          ["type", "4"],
          ["status", status],
        ],
      })
    }
    expect(f.owner.getSnapshot().orderMessages.length).toBe(1)
    expect(f.owner.getSnapshot().externalRecords.length).toBe(7)
    expect(
      extractOrderSummary(f.owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(false)
  })

  it("treats bare confirmation as a report and cannot use one invoice for two orders", async () => {
    const f = fixture()
    await receive(f, f.order)
    await receive(
      f,
      {
        ...f.order,
        pubkey: f.pubkey,
        tags: [
          ["p", f.buyerPubkey],
          ["subject", "Order status"],
          ["order", "external-order"],
          ["type", "3"],
          ["status", "confirmed"],
        ],
      },
      f.merchant
    )
    expect(
      extractOrderSummary(f.owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(false)
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(sha256(generateSecretKey())),
        bolt11PlainDescriptionField("Synthetic reused invoice"),
      ],
    })
    const request = reply(f, "payment_request", {
      invoice,
      amount: 200,
      currency: "SATS",
    })
    await receive(f, request, f.merchant)
    await receive(f, {
      ...f.order,
      tags: f.order.tags.map((tag) =>
        tag[0] === "order" ? ["order", "second-order"] : tag
      ),
    })
    const secondRequest = createPrivateMessageRumor({
      ...request,
      tags: request.tags.map((tag) => {
        if (tag[0] === "order") return ["order", "second-order"]
        if (tag[0] === "conduit")
          return [
            "conduit",
            "1",
            "payment_request",
            JSON.stringify({
              invoice,
              amount: 200,
              currency: "SATS",
              orderId: "second-order",
            }),
          ]
        return tag
      }),
    })
    const conversations = await receive(f, secondRequest, f.merchant)
    expect(conversations.length).toBe(2)
    expect(getMerchantPaymentVerificationCandidates(conversations).length).toBe(
      0
    )
    expect(() =>
      reply(f, "status_update", { status: "refund_requested" })
    ).toThrow("Unsupported commerce status")
  })

  it("retains unsupported or ambiguous orders without admitting action authority", async () => {
    const f = fixture()
    for (const tags of [
      [...f.order.tags, ["amount", "201"]],
      f.order.tags.map((tag) =>
        tag[0] === "item"
          ? ["item", `30402:${f.buyerPubkey}:foreign`, "1"]
          : tag
      ),
      f.order.tags.map((tag) =>
        tag[0] === "item" ? ["item", f.product, "9007199254740992"] : tag
      ),
      [...f.order.tags, ["version", "99"]],
    ])
      await receive(f, { ...f.order, tags })
    expect(f.owner.getSnapshot().orderMessages.length).toBe(0)
    expect(f.owner.getSnapshot().externalRecords.length).toBe(4)
  })

  it("keeps kind-16 extensions disguised as kind-17 receipts outside order authority", async () => {
    const f = fixture()
    await receive(f, f.order)
    const preimage = generateSecretKey()
    const invoice = makeBolt11Fixture({
      hrp: "lnbc2000n",
      fields: [
        bolt11PaymentHashField(sha256(preimage)),
        bolt11PlainDescriptionField("Synthetic disguised receipt"),
      ],
    })
    const payment = ["payment", "lightning", invoice, bytesToHex(preimage)]
    const status = reply(f, "status_update", { status: "paid" })
    await receive(
      f,
      {
        ...status,
        kind: 17,
        tags: [...status.tags, ["amount", "200"], payment],
      },
      f.merchant
    )
    const order = f.owner
      .getSnapshot()
      .orderMessages.find((message) => message.type === "order")!
    if (order.type !== "order") throw new Error("Expected order")
    const payload = {
      ...order.payload,
      id: "external-order",
      items: order.payload.items.map((item) => ({
        ...item,
        priceAtPurchase: 100,
        format: "physical",
      })),
    }
    const disguisedOrder = {
      ...f.order,
      kind: 17,
      tags: [
        ...f.order.tags,
        payment,
        ["conduit", "1", "order", JSON.stringify(payload)],
      ],
    }
    await receive(f, disguisedOrder)
    await receive(f, {
      ...disguisedOrder,
      tags: [...disguisedOrder.tags, ["version", "99"]],
    })
    expect(f.owner.getSnapshot().orderMessages.length).toBe(1)
    expect(f.owner.getSnapshot().externalRecords.length).toBe(3)
    expect(
      extractOrderSummary(f.owner.getSnapshot().orderMessages).paymentConfirmed
    ).toBe(false)
  })

  it("flags conflicting terms instead of choosing the newest wrapped order", async () => {
    const f = fixture()
    await receive(f, f.order)
    const conversations = await receive(f, {
      ...f.order,
      created_at: f.order.created_at + 1,
      tags: f.order.tags.map((tag) =>
        tag[0] === "amount" ? ["amount", "250"] : tag
      ),
    })
    expect(conversations.length).toBe(1)
    expect(
      extractOrderSummary(conversations[0]!.messages!).conflictingTerms
    ).toBe(true)
    expect(getMerchantPaymentVerificationCandidates(conversations).length).toBe(
      0
    )
    expect(
      f.owner.getSnapshot().diagnostics.orderAdapter?.conflictingOrders
    ).toBe(1)
  })

  it("reprocesses retained wrappers after the decode rules change", async () => {
    const f = fixture()
    await receive(f, f.order)
    await f.database.commerceInboxRecords.clear()
    await f.database.commerceInboxWrappers
      .toCollection()
      .modify({ state: "unsupported", rulesVersion: 2 })
    f.owner.stop()
    const authorization = getProtectedReadAuthorization(f.pubkey)!
    const recovered = new CommerceInbox(
      authorization,
      f.signer,
      new CommerceInboxStore(authorization, f.database)
    )
    owners.push(recovered)
    await recovered.initialize()
    await recovered.waitForDecode()
    expect(
      projectCommerceInbox(recovered.getSnapshot(), f.pubkey).merchant.data
        .length
    ).toBe(1)
  })

  it("reclassifies a prior kind-17 order projection from its retained wrapper", async () => {
    const f = fixture()
    await receive(f, f.order)
    const status = reply(f, "status_update", { status: "paid" })
    const disguised = createPrivateMessageRumor({
      ...status,
      kind: 17,
      tags: [...status.tags, ["payment", "unsupported", "reference"]],
    })
    await receive(f, disguised, f.merchant)
    f.owner.stop()
    const previous = parseOrderMessageRumorEvent(status)
    if (previous.type !== "status_update") throw new Error("Expected status")
    await f.store.putProjection({
      kind: "order",
      message: {
        ...previous,
        id: disguised.id,
        orderId: "external-order",
        wireFormat: undefined,
        wireOrderId: undefined,
      },
    })
    await f.database.commerceInboxWrappers.toCollection().modify({
      state: "opened",
      rulesVersion: 3,
    })
    const originals = (await f.database.commerceInboxWrappers.toArray()).map(
      (row) => row.event
    )
    expect(
      (await f.store.projections()).filter(
        (row) => row.projection.kind === "order"
      ).length
    ).toBe(2)
    const recovered = new CommerceInbox(
      getProtectedReadAuthorization(f.pubkey)!,
      f.signer,
      new CommerceInboxStore(
        getProtectedReadAuthorization(f.pubkey)!,
        f.database
      )
    )
    owners.push(recovered)
    await recovered.initialize()
    await recovered.waitForDecode()
    expect(recovered.getSnapshot().orderMessages.length).toBe(1)
    expect(recovered.getSnapshot().externalRecords.length).toBe(1)
    const retained = await f.database.commerceInboxWrappers.toArray()
    expect(retained.every((row) => row.rulesVersion === 4)).toBe(true)
    expect(
      JSON.stringify(retained.map((row) => row.event)) ===
        JSON.stringify(originals)
    ).toBe(true)
  })
})
