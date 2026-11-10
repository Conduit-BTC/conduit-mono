import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as inbox from "../src/protocol/commerce-inbox"
import type { CommerceInboxSnapshot } from "../src/protocol/commerce-inbox"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getDirectMessageThread,
  projectCommerceInbox,
} from "../src/protocol/commerce"
import type { ParsedDirectMessage } from "../src/protocol/messaging"
import type { ParsedOrderMessage } from "../src/protocol/orders"
import { extractOrderSummary } from "../src/protocol/order-summary"
import { getEffectiveMerchantOrderStatus } from "../src/protocol/order-status"

const buyer = "b".repeat(64)
const merchant = "a".repeat(64)
const other = "c".repeat(64)
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
let networkAttempts = 0
let clock = 123_000

function snapshot(
  overrides: Partial<CommerceInboxSnapshot> = {}
): CommerceInboxSnapshot {
  return {
    sourceRelays: [],
    decryptFailures: [],
    legacyDecryptFailures: [],
    directMessages: [],
    orderMessages: [],
    externalRecords: [],
    unreadIds: new Set(),
    pending: false,
    diagnostics: {
      states: {},
      transportStates: { nip17: {}, nip04: {} },
      sources: [],
      historyRanges: [],
      received: 0,
      observedAt: 1,
      coverage: "complete",
      authentication: null,
      historyUnresolved: 0,
      outgoingPending: 0,
      legacyReceived: 0,
      clientSealMetadataAccepted: 0,
      storageUnavailable: false,
    },
    ...overrides,
  }
}

function base(
  id: string,
  senderPubkey = buyer,
  recipientPubkey = merchant,
  createdAt = 1,
  orderId = "same-order"
) {
  return {
    id,
    senderPubkey,
    recipientPubkey,
    createdAt,
    orderId,
    rawContent: "",
  }
}

function order(
  id = "order",
  sender = buyer,
  recipient = merchant,
  orderId = "same-order"
): ParsedOrderMessage {
  return {
    ...base(id, sender, recipient, 1, orderId),
    type: "order",
    payload: {
      id: orderId,
      buyerPubkey: sender,
      merchantPubkey: recipient,
      createdAt: 1,
      items: [
        {
          productId: "fixture-product",
          format: "digital",
          quantity: 2,
          priceAtPurchase: 21,
          currency: "SATS",
        },
      ],
      subtotal: 42,
      currency: "SATS",
    },
  }
}

function reply(
  id: string,
  sender = buyer,
  recipient = merchant,
  createdAt = 2
): ParsedOrderMessage {
  return {
    ...base(id, sender, recipient, createdAt),
    type: "message",
    payload: { note: "Synthetic reply" },
  }
}

function direct(
  id: string,
  overrides: Partial<ParsedDirectMessage> = {}
): ParsedDirectMessage {
  return {
    id,
    senderPubkey: merchant,
    recipientPubkey: buyer,
    createdAt: 1,
    transport: "nip17",
    content: "Synthetic direct message",
    ...overrides,
  }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  networkAttempts = 0
  clock = 123_000
  __setCommerceTestOverrides({ now: () => clock })
  globalThis.fetch = (async () => {
    networkAttempts++
    throw new Error("Network forbidden in conversation fixtures")
  }) as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts++
      throw new Error("Network forbidden in conversation fixtures")
    }
  } as unknown as typeof WebSocket
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  __resetCommerceTestOverrides()
  expect(networkAttempts).toBe(0)
})

describe("committed order conversation projections through the commerce facade", () => {
  it("projects the same authenticated order for buyer and merchant and excludes unrelated principals", () => {
    const messages = [reply("reply", merchant, buyer), order()]
    const committed = snapshot({ orderMessages: messages })
    const buying = projectCommerceInbox(committed, buyer)
    const selling = projectCommerceInbox(committed, merchant)
    expect(buying.buyer.data).toHaveLength(1)
    expect(buying.merchant.data).toEqual([])
    expect(selling.merchant.data).toHaveLength(1)
    expect(selling.buyer.data).toEqual([])
    expect(selling.merchant.data[0]).toMatchObject({
      ...buying.buyer.data[0],
      buyerPubkey: buyer,
    })
    expect(buying.buyer.data[0]).toMatchObject({
      orderId: "same-order",
      merchantPubkey: merchant,
      context: "complete",
      messageCount: 2,
      latestType: "message",
      latestAt: 2,
      preview: "Synthetic reply",
      totalSummary: "42 SATS",
    })
    expect(projectCommerceInbox(committed, other).buyer.data).toEqual([])
    expect(projectCommerceInbox(committed, other).merchant.data).toEqual([])
    expect(messages.map((message) => message.id)).toEqual(["reply", "order"])
  })

  it("keeps equal raw order IDs with different participants distinct and preserves list ties", () => {
    const committed = snapshot({
      orderMessages: [order("first"), order("second", buyer, other)],
    })
    const rows = projectCommerceInbox(committed, buyer).buyer.data
    expect(rows.map((row) => row.merchantPubkey)).toEqual([merchant, other])
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(rows.map((row) => row.orderId)).toEqual(["same-order", "same-order"])
    expect(
      projectCommerceInbox(committed, merchant).merchant.data.map((row) =>
        row.messages?.map((message) => message.id)
      )
    ).toEqual([["first"]])
  })

  it("retains reversed original orders without assigning an ambiguous plain reply", () => {
    const rows = projectCommerceInbox(
      snapshot({
        orderMessages: [
          order("forward"),
          order("reverse", merchant, buyer),
          reply("ambiguous"),
        ],
      }),
      buyer
    )
    expect(
      rows.buyer.data.map((row) => row.messages?.map((message) => message.id))
    ).toEqual([["forward"]])
    expect(
      rows.merchant.data.map((row) =>
        row.messages?.map((message) => message.id)
      )
    ).toEqual([["reverse"]])
    const partial = snapshot({
      orderMessages: [
        { ...base("forward"), type: "payment_proof", payload: {} },
        {
          ...base("reverse", merchant, buyer),
          type: "payment_proof",
          payload: {},
        },
      ],
    })
    expect(projectCommerceInbox(partial, buyer).buyer.data).toEqual([])
    expect(projectCommerceInbox(partial, buyer).merchant.data).toEqual([])
  })

  it("does not infer roles from plain replies or self-addressed orders", () => {
    const views = projectCommerceInbox(
      snapshot({
        orderMessages: [reply("orphan"), order("self", buyer, buyer)],
      }),
      buyer
    )
    expect(views.buyer.data).toEqual([])
    expect(views.merchant.data).toEqual([])
  })

  it("marks typed partial history missing_order with no total", () => {
    const partial: ParsedOrderMessage = {
      ...base("invoice", merchant, buyer),
      type: "payment_request",
      payload: { invoice: "synthetic-unpaid-invoice" },
    }
    for (const row of [
      projectCommerceInbox(snapshot({ orderMessages: [partial] }), buyer).buyer
        .data[0],
      projectCommerceInbox(snapshot({ orderMessages: [partial] }), merchant)
        .merchant.data[0],
    ]) {
      expect(row).toMatchObject({
        context: "missing_order",
        totalSummary: null,
        messageCount: 1,
        preview: "Invoice sent",
      })
    }
  })

  it("delegates subtotal and cancellation/reopen status to their semantic owners", () => {
    const messages: ParsedOrderMessage[] = [
      order(),
      {
        ...base("accepted", merchant, buyer, 2),
        type: "status_update",
        payload: { status: "accepted" },
      },
      {
        ...base("d".repeat(64), merchant, buyer, 3),
        type: "status_update",
        payload: { status: "cancelled" },
      },
      {
        ...base("stale", merchant, buyer, 4),
        type: "status_update",
        payload: { status: "paid" },
      },
    ]
    const participants = { buyerPubkey: buyer, merchantPubkey: merchant }
    for (const principal of [buyer, merchant]) {
      const views = projectCommerceInbox(
        snapshot({ orderMessages: messages }),
        principal
      )
      const row = [...views.buyer.data, ...views.merchant.data][0]!
      const summary = extractOrderSummary(messages, participants)
      expect(row.status).toBe(
        getEffectiveMerchantOrderStatus(messages, participants).status
      )
      expect(row.status).toBe("cancelled")
      expect(row.totalSummary).toBe(`${summary.subtotal} ${summary.currency}`)
      expect(row.totalSummary).toBe("42 SATS")
      const reopened: ParsedOrderMessage[] = [
        ...messages,
        {
          ...base("reopened", merchant, buyer, 5),
          type: "status_update",
          payload: { status: "accepted", reopens: "d".repeat(64) },
        },
      ]
      const reopenedViews = projectCommerceInbox(
        snapshot({ orderMessages: reopened }),
        principal
      )
      const reopenedRow = [
        ...reopenedViews.buyer.data,
        ...reopenedViews.merchant.data,
      ][0]!
      expect(reopenedRow.status).toBe(
        getEffectiveMerchantOrderStatus(reopened, participants).status
      )
      expect(reopenedRow.status).toBe("accepted")
    }
  })

  it("uses ID ordering for equal order-message timestamps and sorts lists newest first", () => {
    for (const principal of [buyer, merchant]) {
      const messages = [
        reply("z", merchant, buyer, 10),
        reply("a", buyer, merchant, 10),
        order(),
        principal === buyer
          ? order("older", buyer, other)
          : order("older", other, merchant),
      ]
      const views = projectCommerceInbox(
        snapshot({ orderMessages: messages }),
        principal
      )
      const rows = principal === buyer ? views.buyer.data : views.merchant.data
      expect(rows.map((row) => row.latestAt)).toEqual([10, 1])
      expect(rows[0]!.messages?.map((message) => message.id)).toEqual([
        "order",
        "a",
        "z",
      ])
      expect(rows[0]).toMatchObject({
        preview: "Synthetic reply",
        messageCount: 3,
      })
    }
  })

  const previews: Array<[string, ParsedOrderMessage, string]> = [
    [
      "other order update",
      {
        ...base("latest", merchant, buyer, 2),
        type: "future_market_revoked",
        payload: {
          version: 2,
          type: "future_market_revoked",
          claimRef: "d".repeat(64),
          merchantPubkey: merchant,
          organizerPubkey: other,
          market: {
            coordinate: `30409:${other}:fixture`,
            eventId: "e".repeat(64),
            createdAt: 1,
          },
          calendar: {
            coordinate: `31922:${other}:fixture`,
            eventId: "f".repeat(64),
            createdAt: 1,
          },
          grant: { eventId: "d".repeat(64), createdAt: 1 },
          readyReceiptId: "e".repeat(64),
          issuedAt: 2,
        },
      },
      "Order update",
    ],
    ["order", order(), "Order for 42 SATS"],
    [
      "invoice fallback",
      {
        ...base("latest", merchant, buyer, 2),
        type: "payment_request",
        payload: { invoice: "synthetic" },
      },
      "Invoice sent",
    ],
    [
      "invoice note",
      {
        ...base("latest", merchant, buyer, 2),
        type: "payment_request",
        payload: { invoice: "synthetic", note: "Invoice note" },
      },
      "Invoice note",
    ],
    [
      "status fallback",
      {
        ...base("latest", merchant, buyer, 2),
        type: "status_update",
        payload: { status: "accepted" },
      },
      "Status updated to accepted",
    ],
    [
      "status note",
      {
        ...base("latest", merchant, buyer, 2),
        type: "status_update",
        payload: { status: "accepted", note: "Status note" },
      },
      "Status note",
    ],
    [
      "shipping fallback",
      {
        ...base("latest", merchant, buyer, 2),
        type: "shipping_update",
        payload: {},
      },
      "Shipping updated",
    ],
    [
      "shipping note",
      {
        ...base("latest", merchant, buyer, 2),
        type: "shipping_update",
        payload: { note: "Shipping note" },
      },
      "Shipping note",
    ],
    [
      "receipt fallback",
      { ...base("latest", merchant, buyer, 2), type: "receipt", payload: {} },
      "Payment received",
    ],
    [
      "receipt note",
      {
        ...base("latest", merchant, buyer, 2),
        type: "receipt",
        payload: { note: "Receipt note" },
      },
      "Receipt note",
    ],
    ["plain reply", reply("latest"), "Synthetic reply"],
    ["empty plain reply", { ...reply("latest"), payload: { note: "" } }, ""],
    [
      "proof",
      {
        ...base("latest", buyer, merchant, 2),
        type: "payment_proof",
        payload: {},
      },
      "Payment proof shared",
    ],
    [
      "empty note",
      {
        ...base("latest", merchant, buyer, 2),
        type: "receipt",
        payload: { note: "" },
      },
      "",
    ],
  ]
  for (const [label, latest, preview] of previews) {
    it(`preserves ${label} preview in both role views`, () => {
      const committed = snapshot({
        orderMessages: latest.type === "order" ? [latest] : [order(), latest],
      })
      expect(
        projectCommerceInbox(committed, buyer).buyer.data[0]?.preview
      ).toBe(preview)
      expect(
        projectCommerceInbox(committed, merchant).merchant.data[0]?.preview
      ).toBe(preview)
    })
  }
})

describe("committed direct conversation projections", () => {
  it("separates NIP-17 and legacy transport, preserves full content/participants, and counts only received unread messages", () => {
    const content = JSON.stringify({
      type: "legacy-envelope",
      note: "Synthetic long text ".repeat(30),
    })
    const participants = [buyer, merchant, other]
    const messages = [
      direct("received"),
      direct("sent", {
        senderPubkey: buyer,
        recipientPubkey: merchant,
        createdAt: 2,
        content,
        participants,
      }),
      direct("legacy", { transport: "nip04", createdAt: 3 }),
      direct("other", { senderPubkey: other, createdAt: 4 }),
    ]
    const rows = projectCommerceInbox(
      snapshot({
        directMessages: messages,
        unreadIds: new Set(["received", "sent", "legacy"]),
      }),
      buyer
    ).direct.data
    expect(rows.map((row) => row.id)).toEqual([
      `nip17:${other}`,
      `nip04:${merchant}`,
      `nip17:${merchant}`,
    ])
    expect(rows[2]).toMatchObject({
      preview: content,
      participants,
      messageCount: 2,
      unreadFromCounterparty: 1,
    })
    expect(rows[1]).toMatchObject({
      unreadFromCounterparty: 1,
      transport: "nip04",
    })
    expect(rows[0]?.unreadFromCounterparty).toBe(0)
    expect(rows[2]?.messages).toEqual(messages.slice(0, 2))
  })

  it("preserves input order for equal direct timestamps and conversation list ties", () => {
    const messages = [
      direct("z"),
      direct("a", { content: "Last in tied bucket" }),
      direct("other", { senderPubkey: other }),
    ]
    const rows = projectCommerceInbox(
      snapshot({ directMessages: messages }),
      buyer
    ).direct.data
    expect(rows.map((row) => row.counterpartyPubkey)).toEqual([merchant, other])
    expect(rows[0]?.messages?.map((message) => message.id)).toEqual(["z", "a"])
    expect(rows[0]?.preview).toBe("Last in tied bucket")
  })

  it("selects sent and received messages by counterparty and transport through getDirectMessageThread", async () => {
    const committed = snapshot({
      directMessages: [
        direct("received"),
        direct("sent", { senderPubkey: buyer, recipientPubkey: merchant }),
        direct("legacy", { transport: "nip04" }),
        direct("other", { senderPubkey: other }),
      ],
    })
    const initialized = spyOn({ run: async () => {} }, "run")
    const synced = spyOn({ run: async () => committed }, "run")
    const owner = {
      authorization: null,
      initialize: initialized,
      syncRecent: synced,
      getSnapshot: () => committed,
      assertCurrent: () => {},
    }
    const getOwner = spyOn(inbox, "getCommerceInbox").mockReturnValue(
      owner as unknown as inbox.CommerceInbox
    )
    __setCommerceTestOverrides({ resolveInboxRelayUrls: async () => [] })
    try {
      const result = await getDirectMessageThread({
        principalPubkey: buyer,
        counterpartyPubkey: merchant,
        transport: "nip17",
      })
      expect(result.data?.messages.map((message) => message.id)).toEqual([
        "received",
        "sent",
      ])
      expect(result.data).toMatchObject({
        counterpartyPubkey: merchant,
        transport: "nip17",
      })
      expect(initialized).toHaveBeenCalledTimes(1)
      expect(synced).toHaveBeenCalledTimes(1)
      expect(getOwner).toHaveBeenCalledWith(buyer)
      expect(
        (
          await getDirectMessageThread({
            principalPubkey: buyer,
            counterpartyPubkey: merchant,
            transport: "nip04",
          })
        ).data?.messages.map((message) => message.id)
      ).toEqual(["legacy"])
      expect(
        (
          await getDirectMessageThread({
            principalPubkey: buyer,
            counterpartyPubkey: buyer,
            transport: "nip17",
          })
        ).data
      ).toBeNull()
    } finally {
      getOwner.mockRestore()
      initialized.mockRestore()
      synced.mockRestore()
    }
  })
})

describe("committed snapshot metadata", () => {
  it("retains declared inbox and authentication metadata without degrading complete data", () => {
    const committed = snapshot({
      declaration: {
        pubkey: buyer,
        state: "declared",
        relayUrls: [],
        stale: false,
        fetchedAt: 1,
      },
    })
    const meta = projectCommerceInbox(committed, buyer).direct.meta
    expect(meta.inbox).toMatchObject({
      declarationState: "declared",
      readSource: "declared",
      coverage: "complete",
    })
    expect(meta.inbox?.authentication).toBeDefined()
    expect(meta.stale).toBe(false)
    expect(meta.degraded).toBe(false)
  })

  it("shares one metadata object across views and uses the facade clock", () => {
    const committed = snapshot()
    const views = projectCommerceInbox(committed, buyer)
    expect(Object.keys(views)).toEqual(["buyer", "merchant", "direct"])
    expect(views.buyer.meta).toBe(views.merchant.meta)
    expect(views.buyer.meta).toBe(views.direct.meta)
    expect(views.buyer.meta).toMatchObject({
      source: "commerce",
      fetchedAt: clock,
      stale: false,
      capped: false,
      degraded: false,
      inbox: {
        coverage: "complete",
        declarationState: "lookup_unavailable",
        readSource: "compatibility",
      },
    })
    expect(views.buyer.meta.decryptFailures).toBeUndefined()
    expect(views.buyer.meta.legacyDecryptFailures).toBeUndefined()
    clock += 10
    expect(projectCommerceInbox(committed, buyer).direct.meta.fetchedAt).toBe(
      clock
    )
  })

  const incomplete: Array<[string, (value: CommerceInboxSnapshot) => void]> = [
    [
      "partial coverage",
      (value) => {
        value.diagnostics.coverage = "partial"
      },
    ],
    [
      "unavailable coverage",
      (value) => {
        value.diagnostics.coverage = "unavailable"
      },
    ],
    [
      "queued",
      (value) => {
        value.diagnostics.states.queued = 1
      },
    ],
    [
      "waiting signer",
      (value) => {
        value.diagnostics.states.waiting_for_signer = 1
      },
    ],
    [
      "opening",
      (value) => {
        value.diagnostics.states.opening = 1
      },
    ],
    [
      "storage unavailable",
      (value) => {
        value.diagnostics.storageUnavailable = true
      },
    ],
    [
      "decrypt failure",
      (value) => {
        value.decryptFailures = [
          { wrapId: "synthetic-wrap", reason: "nip44_failed" },
        ]
      },
    ],
    [
      "legacy decrypt failure",
      (value) => {
        value.legacyDecryptFailures = [
          {
            eventId: "synthetic-legacy",
            reason: "decrypt_failed",
            retryable: true,
          },
        ]
      },
    ],
    ...(["capped", "unavailable", "partial"] as const).map(
      (status) =>
        [
          `${status} history`,
          (value: CommerceInboxSnapshot) => {
            value.diagnostics.historyRanges = [
              {
                sourceIndex: 0,
                transport: "nip17",
                status,
                observedAt: 1,
                observedCount: 0,
              },
            ]
          },
        ] as [string, (value: CommerceInboxSnapshot) => void]
    ),
  ]
  for (const [label, change] of incomplete) {
    it(`reports ${label} as incomplete without changing the source`, () => {
      const committed = snapshot({ orderMessages: [order()] })
      change(committed)
      const views = projectCommerceInbox(committed, buyer)
      expect(views.buyer.meta).toMatchObject({
        stale: true,
        degraded: true,
        source: "commerce",
        fetchedAt: clock,
        capped: false,
      })
      expect(views.direct.meta).toBe(views.buyer.meta)
      expect(views.buyer.data).toHaveLength(1)
      if (committed.decryptFailures.length)
        expect(views.buyer.meta.decryptFailures).toBe(committed.decryptFailures)
      if (committed.legacyDecryptFailures.length)
        expect(views.buyer.meta.legacyDecryptFailures).toBe(
          committed.legacyDecryptFailures
        )
    })
  }

  it("does not mistake an unattempted partial history range for missing committed coverage", () => {
    const committed = snapshot()
    committed.diagnostics.historyRanges = [
      {
        sourceIndex: 0,
        transport: "nip17",
        status: "partial",
        observedAt: 1,
        observedCount: 0,
        historyAttempted: false,
      },
    ]
    expect(projectCommerceInbox(committed, buyer).buyer.meta.stale).toBe(false)
    committed.diagnostics.historyRanges[0]!.admissionRejected = true
    expect(projectCommerceInbox(committed, buyer).buyer.meta.stale).toBe(true)
  })
})
