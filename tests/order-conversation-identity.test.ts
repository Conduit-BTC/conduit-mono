import { describe, expect, it } from "bun:test"
import {
  findOrderConversation,
  getOrderConversationId,
  groupOrderConversationMessages,
  type BuyerConversationSummary,
  type OrderLifecycle,
  type ParsedOrderMessage,
} from "@conduit/core"
import { mergeBuyerOrderConversations } from "../apps/market/src/lib/orderConversations"
import { getMerchantOrderSelection } from "../apps/merchant/src/lib/order-phase"

function message(
  id: string,
  senderPubkey: string,
  recipientPubkey: string,
  type: ParsedOrderMessage["type"] = "order"
): ParsedOrderMessage {
  return {
    id,
    orderId: "shared-order",
    senderPubkey,
    recipientPubkey,
    type,
    createdAt: 1,
    rawContent: "",
    payload:
      type === "order"
        ? {
            id: "shared-order",
            buyerPubkey: senderPubkey,
            merchantPubkey: recipientPubkey,
            items: [],
            subtotal: 1,
            currency: "SATS",
            createdAt: 1,
          }
        : { note: id },
  } as ParsedOrderMessage
}

function conversation(merchantPubkey: string): BuyerConversationSummary {
  const identity = {
    orderId: "shared-order",
    buyerPubkey: "buyer",
    merchantPubkey,
  }
  return {
    id: getOrderConversationId(identity),
    orderId: identity.orderId,
    merchantPubkey,
    status: null,
    totalSummary: null,
    context: "complete",
    latestAt: 1,
    latestType: "order",
    preview: "Order placed",
    messageCount: 1,
    messages: [message(merchantPubkey, "buyer", merchantPubkey)],
  }
}

describe("participant-bound order conversation identity", () => {
  it("separates both buyer and merchant collisions before attaching replies", () => {
    for (const [principal, orders] of [
      [
        "buyer",
        [
          message("one", "buyer", "merchant-a"),
          message("two", "buyer", "merchant-b"),
        ],
      ],
      [
        "merchant",
        [
          message("one", "buyer-a", "merchant"),
          message("two", "buyer-b", "merchant"),
        ],
      ],
    ] as const) {
      const first = orders[0]!
      const replies = [
        message("reply", first.recipientPubkey, first.senderPubkey, "message"),
      ]
      const groups = groupOrderConversationMessages(
        [...replies, ...orders, message("unrelated", "x", "y")],
        principal
      )
      expect(groups).toHaveLength(2)
      expect(groups[0]?.messages.map((row) => row.id)).toEqual(["one", "reply"])
      expect(groups[1]?.messages.map((row) => row.id)).toEqual(["two"])
      expect(groups[0]?.id).not.toBe(groups[1]?.id)
      expect(groups.every((row) => row.orderId === "shared-order")).toBe(true)
    }
  })

  it("does not assign an ambiguous plain reply to reversed-role orders", () => {
    const groups = groupOrderConversationMessages(
      [
        message("buy", "dual", "peer"),
        message("sell", "peer", "dual"),
        message("ambiguous", "dual", "peer", "message"),
      ],
      "dual"
    )
    expect(groups.map((row) => row.messages.map((item) => item.id))).toEqual([
      ["buy"],
      ["sell"],
    ])
    expect(
      groupOrderConversationMessages(
        [message("alone", "dual", "peer", "message")],
        "dual"
      )
    ).toEqual([])
  })

  it("does not let contradictory partial history erase an authenticated original order", () => {
    const groups = groupOrderConversationMessages(
      [
        message("original", "buyer", "merchant"),
        message("wrong-direction", "buyer", "merchant", "status_update"),
      ],
      "buyer"
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages.map((row) => row.id)).toEqual(["original"])
  })

  it("uses an unambiguous tuple even when order IDs contain separators", () => {
    expect(
      getOrderConversationId({
        orderId: "a:b",
        buyerPubkey: "c",
        merchantPubkey: "d",
      })
    ).not.toBe(
      getOrderConversationId({
        orderId: "a",
        buyerPubkey: "b:c",
        merchantPubkey: "d",
      })
    )
  })

  it("joins local lifecycle evidence only to the matching buyer and merchant", () => {
    const lifecycle = {
      orderId: "shared-order",
      buyerPubkey: "buyer",
      merchantPubkey: "merchant-a",
    } as OrderLifecycle
    const rows = mergeBuyerOrderConversations(
      "buyer",
      [lifecycle, { ...lifecycle, buyerPubkey: "other" }],
      [conversation("merchant-a"), conversation("merchant-b")]
    )
    expect(rows).toHaveLength(2)
    expect(
      rows.find((row) => row.merchantPubkey === "merchant-a")?.lifecycle
    ).toBe(lifecycle)
    expect(
      rows.find((row) => row.merchantPubkey === "merchant-b")?.lifecycle
    ).toBeUndefined()
    expect(
      rows.every(
        (row) => row.conversation?.merchantPubkey === row.merchantPubkey
      )
    ).toBe(true)
  })

  it("does not select another conversation when a filter hides the qualified target", () => {
    const rows = [conversation("merchant-a"), conversation("merchant-b")]
    expect(
      getMerchantOrderSelection(
        [rows[0]!],
        rows[0]!.id,
        "shared-order",
        rows[1]!.id,
        rows
      )
    ).toBeNull()
  })

  it("requires a qualified link when the full list contains a collision, even across filters", () => {
    const rows = [conversation("merchant-a"), conversation("merchant-b")]
    expect(findOrderConversation(rows, "shared-order")).toBeNull()
    expect(findOrderConversation([rows[0]!], "shared-order")).toBe(rows[0]!)
    expect(findOrderConversation(rows, "shared-order", rows[1]!.id)).toBe(
      rows[1]!
    )
    expect(
      getMerchantOrderSelection(
        [rows[0]!],
        rows[0]!.id,
        "shared-order",
        undefined,
        rows
      )
    ).toBeNull()
    expect(
      getMerchantOrderSelection(rows, rows[0]!.id, "shared-order", rows[1]!.id)
    ).toBe(rows[1]!.id)
  })
})
