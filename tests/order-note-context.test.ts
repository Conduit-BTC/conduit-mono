import { describe, expect, it } from "bun:test"
import {
  resolveOrderNoteContexts,
  readDirectMessageReferences,
} from "../packages/core/src/protocol/order-note-context"
import type { ParsedDirectMessage } from "../packages/core/src/protocol/messaging"

const buyer = "a".repeat(64)
const merchant = "b".repeat(64)
const stranger = "c".repeat(64)
const orders = [
  { wireOrderId: "order-1", buyerPubkey: buyer, merchantPubkey: merchant },
]
const note = (
  id: string,
  fields: Partial<ParsedDirectMessage> = {}
): ParsedDirectMessage => ({
  id,
  senderPubkey: buyer,
  recipientPubkey: merchant,
  participants: [buyer, merchant],
  createdAt: 1,
  content: "note",
  transport: "nip17",
  ...fields,
})

describe("authenticated order-note ancestry", () => {
  it("recovers replies without repeated subjects, independent of arrival order", () => {
    const messages = [
      note("reply-2", { replyTo: "reply-1" }),
      note("reply-1", {
        replyTo: "root",
        senderPubkey: merchant,
        recipientPubkey: buyer,
      }),
      note("root", { subject: "order-1" }),
    ]
    const contexts = resolveOrderNoteContexts(messages, orders)
    expect(contexts.get("reply-2")?.wireOrderId).toBe("order-1")
    expect(contexts.get("reply-1")).toEqual(contexts.get("root"))
  })
  it("does not inherit a room topic or unrelated order context", () => {
    const messages = [
      note("root", { subject: "order-1" }),
      note("unrelated"),
      note("new-topic", { replyTo: "root", subject: "Something else" }),
    ]
    const contexts = resolveOrderNoteContexts(messages, orders)
    expect(contexts.has("root")).toBe(true)
    expect(contexts.has("unrelated")).toBe(false)
    expect(contexts.has("new-topic")).toBe(false)
    expect(
      resolveOrderNoteContexts([note("root", { subject: "order-1" })], []).size
    ).toBe(0)
  })
  it("rejects cross-party, group, legacy, conflicting, cyclic and ambiguous contexts", () => {
    const messages = [
      note("root", { subject: "order-1" }),
      note("stranger", {
        replyTo: "root",
        senderPubkey: stranger,
        participants: [stranger, merchant],
      }),
      note("group", {
        replyTo: "root",
        participants: [buyer, merchant, stranger],
      }),
      note("legacy", { replyTo: "root", transport: "nip04" }),
      note("wrong-order", { replyTo: "root", orderReference: "other" }),
      note("conflict", { replyTo: "root", orderReference: "order-2" }),
      note("malformed", { replyTo: "root", orderReference: null }),
      note("cycle-1", { replyTo: "cycle-2", orderReference: "order-1" }),
      note("cycle-2", { replyTo: "cycle-1" }),
      note("self-cycle", { replyTo: "self-cycle", orderReference: "order-1" }),
    ]
    expect([
      ...resolveOrderNoteContexts(messages, [
        ...orders,
        { ...orders[0]!, wireOrderId: "order-2" },
      ]).keys(),
    ]).toEqual(["root"])
    expect(
      resolveOrderNoteContexts(
        [messages[0]!],
        [
          ...orders,
          {
            wireOrderId: "order-1",
            buyerPubkey: merchant,
            merchantPubkey: buyer,
          },
        ]
      ).size
    ).toBe(0)
  })
  it("retains explicit order references and refuses malformed singleton references", () => {
    expect(
      readDirectMessageReferences([
        ["order", "order-1"],
        ["subject", "order-1"],
        ["e", "parent", "", "reply"],
      ])
    ).toEqual({
      orderReference: "order-1",
      subject: "order-1",
      replyTo: "parent",
    })
    expect(
      readDirectMessageReferences([
        ["order", "order-1"],
        ["order", "other"],
        ["e", "parent"],
      ]).orderReference
    ).toBeNull()
    expect(
      readDirectMessageReferences([
        ["subject", "order-1"],
        ["subject", "other"],
      ]).orderReference
    ).toBeNull()
    expect(
      readDirectMessageReferences([
        ["e", "parent"],
        ["e", "other"],
      ]).orderReference
    ).toBeNull()
  })
})
