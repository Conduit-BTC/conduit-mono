import { useCallback, useReducer } from "react"

export type OptimisticMessageDeliveryState = "pending" | "published" | "failed"

export interface OptimisticConversationMessage {
  localId: string
  eventId?: string
  conversationId: string
  content: string
  createdAt: number
  deliveryState: OptimisticMessageDeliveryState
}

export type OptimisticConversationMessageAction =
  | { type: "enqueue"; message: OptimisticConversationMessage }
  | { type: "mark_pending"; localId: string }
  | { type: "mark_published"; localId: string }
  | { type: "mark_failed"; localId: string }
  | { type: "remove"; localId: string }
  | { type: "clear" }

export function optimisticConversationMessagesReducer(
  messages: OptimisticConversationMessage[],
  action: OptimisticConversationMessageAction
): OptimisticConversationMessage[] {
  switch (action.type) {
    case "enqueue":
      return [...messages, action.message]
    case "mark_pending":
      return messages.map((message) =>
        message.localId === action.localId
          ? { ...message, deliveryState: "pending" }
          : message
      )
    case "mark_published":
      return messages.map((message) =>
        message.localId === action.localId
          ? { ...message, deliveryState: "published" }
          : message
      )
    case "mark_failed":
      return messages.map((message) =>
        message.localId === action.localId
          ? { ...message, deliveryState: "failed" }
          : message
      )
    case "remove":
      return messages.filter((message) => message.localId !== action.localId)
    case "clear":
      return []
  }
}

let optimisticMessageSequence = 0

export function useOptimisticConversationMessages() {
  const [messages, dispatch] = useReducer(
    optimisticConversationMessagesReducer,
    []
  )

  const enqueue = useCallback(
    (input: {
      conversationId: string
      content: string
      createdAt?: number
      eventId?: string
    }): OptimisticConversationMessage => {
      optimisticMessageSequence += 1
      const createdAt = input.createdAt ?? Date.now()
      const message: OptimisticConversationMessage = {
        localId: `optimistic:${createdAt}:${optimisticMessageSequence}`,
        eventId: input.eventId,
        conversationId: input.conversationId,
        content: input.content,
        createdAt,
        deliveryState: "pending",
      }
      dispatch({ type: "enqueue", message })
      return message
    },
    []
  )

  const markPending = useCallback((localId: string) => {
    dispatch({ type: "mark_pending", localId })
  }, [])

  const markFailed = useCallback((localId: string) => {
    dispatch({ type: "mark_failed", localId })
  }, [])

  const markPublished = useCallback((localId: string) => {
    dispatch({ type: "mark_published", localId })
  }, [])

  const remove = useCallback((localId: string) => {
    dispatch({ type: "remove", localId })
  }, [])

  const clear = useCallback(() => {
    dispatch({ type: "clear" })
  }, [])

  return {
    messages,
    enqueue,
    markPending,
    markPublished,
    markFailed,
    remove,
    clear,
  }
}
