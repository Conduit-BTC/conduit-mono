import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ConversationMessageBubble,
  getConversationMessageDisplayContent,
  optimisticConversationMessagesReducer,
  type OptimisticConversationMessage,
} from "@conduit/ui"

describe("getConversationMessageDisplayContent", () => {
  it("extracts the readable text from a legacy order-status DM", () => {
    const content = JSON.stringify({
      id: "2e2811f8-d38e-4929-a937-7b41e5fa6f2e",
      type: 2,
      message: "Your order has been declined.",
      paid: false,
      shipped: false,
      cancelled: true,
    })

    expect(getConversationMessageDisplayContent(content)).toBe(
      "Your order has been declined."
    )
  })

  it("preserves ordinary JSON sent as chat text", () => {
    const content = JSON.stringify({ message: "keep the full object" })

    expect(getConversationMessageDisplayContent(content)).toBe(content)
  })

  it("preserves non-JSON chat text", () => {
    expect(getConversationMessageDisplayContent("Hello from Market")).toBe(
      "Hello from Market"
    )
  })
})

describe("optimistic direct-message UI", () => {
  const queuedMessage: OptimisticConversationMessage = {
    localId: "optimistic:1",
    eventId: "event-1",
    conversationId: "nip17:merchant",
    content: "Is this available?",
    createdAt: 1,
    deliveryState: "pending",
  }

  it("keeps a message through pending, failed, retry, and published states", () => {
    const enqueued = optimisticConversationMessagesReducer([], {
      type: "enqueue",
      message: queuedMessage,
    })
    const failed = optimisticConversationMessagesReducer(enqueued, {
      type: "mark_failed",
      localId: queuedMessage.localId,
    })
    const retried = optimisticConversationMessagesReducer(failed, {
      type: "mark_pending",
      localId: queuedMessage.localId,
    })
    const published = optimisticConversationMessagesReducer(retried, {
      type: "mark_published",
      localId: queuedMessage.localId,
    })

    expect(failed[0]?.deliveryState).toBe("failed")
    expect(retried[0]?.deliveryState).toBe("pending")
    expect(published[0]).toMatchObject({
      content: queuedMessage.content,
      eventId: queuedMessage.eventId,
      deliveryState: "published",
    })
    expect(
      optimisticConversationMessagesReducer(published, {
        type: "remove",
        localId: queuedMessage.localId,
      })
    ).toEqual([])
    expect(
      optimisticConversationMessagesReducer(published, { type: "clear" })
    ).toEqual([])
  })

  it("renders an accessible loading icon until relay publication", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationMessageBubble, {
        content: queuedMessage.content,
        mine: true,
        deliveryState: "pending",
      })
    )

    expect(markup).toContain('data-delivery-state="pending"')
    expect(markup).toContain('aria-label="Publishing message"')
    expect(markup).toContain("animate-spin")
  })

  it("keeps failed text visible with a retry command", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationMessageBubble, {
        content: queuedMessage.content,
        mine: true,
        deliveryState: "failed",
        onRetry: () => {},
      })
    )

    expect(markup).toContain(queuedMessage.content)
    expect(markup).toContain('aria-label="Retry message"')
    expect(markup).toContain("Retry")
  })
})
