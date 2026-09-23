import { useCallback, useLayoutEffect, useMemo, useReducer } from "react"

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
  | { type: "fail_pending" }
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
    case "fail_pending":
      return messages.map((message) =>
        message.deliveryState === "pending"
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

export interface OptimisticConversationScope {
  ownerKey: string | null
  authorityKey: string
}

export interface ScopedOptimisticConversationState extends OptimisticConversationScope {
  messages: OptimisticConversationMessage[]
}

export type ScopedOptimisticConversationAction =
  | ({ type: "scope_changed" } & OptimisticConversationScope)
  | ({
      type: "message_action"
      action: OptimisticConversationMessageAction
    } & OptimisticConversationScope)

function scopesMatch(
  left: OptimisticConversationScope,
  right: OptimisticConversationScope
): boolean {
  return (
    left.ownerKey === right.ownerKey && left.authorityKey === right.authorityKey
  )
}

export function scopedOptimisticConversationReducer(
  state: ScopedOptimisticConversationState,
  action: ScopedOptimisticConversationAction
): ScopedOptimisticConversationState {
  if (action.type === "scope_changed") {
    if (state.ownerKey !== action.ownerKey) {
      return { ...action, messages: [] }
    }
    if (state.authorityKey !== action.authorityKey) {
      return {
        ...action,
        messages: optimisticConversationMessagesReducer(state.messages, {
          type: "fail_pending",
        }),
      }
    }
    return state
  }

  if (!scopesMatch(state, action)) return state
  return {
    ...state,
    messages: optimisticConversationMessagesReducer(
      state.messages,
      action.action
    ),
  }
}

export function projectOptimisticConversationMessages(
  state: ScopedOptimisticConversationState,
  scope: OptimisticConversationScope
): OptimisticConversationMessage[] {
  if (state.ownerKey !== scope.ownerKey) return []
  if (state.authorityKey === scope.authorityKey) return state.messages
  return optimisticConversationMessagesReducer(state.messages, {
    type: "fail_pending",
  })
}

export function useOptimisticConversationMessages(
  input: OptimisticConversationScope
) {
  const scope = useMemo(
    () => ({ ownerKey: input.ownerKey, authorityKey: input.authorityKey }),
    [input.authorityKey, input.ownerKey]
  )
  const [state, dispatch] = useReducer(scopedOptimisticConversationReducer, {
    ...scope,
    messages: [],
  })

  const messages = useMemo(
    () => projectOptimisticConversationMessages(state, scope),
    [scope, state]
  )

  useLayoutEffect(() => {
    dispatch({ type: "scope_changed", ...scope })
  }, [scope])

  const enqueue = useCallback(
    (
      capturedScope: OptimisticConversationScope,
      input: {
        conversationId: string
        content: string
        createdAt?: number
        eventId?: string
      }
    ): OptimisticConversationMessage => {
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
      dispatch({
        type: "message_action",
        ...capturedScope,
        action: { type: "enqueue", message },
      })
      return message
    },
    []
  )

  const markPending = useCallback(
    (capturedScope: OptimisticConversationScope, localId: string) => {
      dispatch({
        type: "message_action",
        ...capturedScope,
        action: { type: "mark_pending", localId },
      })
    },
    []
  )

  const markFailed = useCallback(
    (capturedScope: OptimisticConversationScope, localId: string) => {
      dispatch({
        type: "message_action",
        ...capturedScope,
        action: { type: "mark_failed", localId },
      })
    },
    []
  )

  const markPublished = useCallback(
    (capturedScope: OptimisticConversationScope, localId: string) => {
      dispatch({
        type: "message_action",
        ...capturedScope,
        action: { type: "mark_published", localId },
      })
    },
    []
  )

  const remove = useCallback(
    (capturedScope: OptimisticConversationScope, localId: string) => {
      dispatch({
        type: "message_action",
        ...capturedScope,
        action: { type: "remove", localId },
      })
    },
    []
  )

  const clear = useCallback((capturedScope: OptimisticConversationScope) => {
    dispatch({
      type: "message_action",
      ...capturedScope,
      action: { type: "clear" },
    })
  }, [])

  return {
    scope,
    messages,
    enqueue,
    markPending,
    markPublished,
    markFailed,
    remove,
    clear,
  }
}
