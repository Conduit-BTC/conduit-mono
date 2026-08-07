export type StorefrontFollowSaveState =
  "idle" | "saving_follow" | "saving_unfollow"

export type StorefrontFollowScope = {
  merchantPubkey: string
  viewerPubkey: string | null
}

export type StorefrontFollowState = {
  scope: StorefrontFollowScope
  saveState: StorefrontFollowSaveState
  override: boolean | null
  error: string | null
  activeOperationId: number | null
}

export type StorefrontFollowAction =
  | { type: "scope_changed"; scope: StorefrontFollowScope }
  | {
      type: "operation_started"
      scope: StorefrontFollowScope
      operationId: number
      shouldFollow: boolean
    }
  | {
      type: "publish_succeeded"
      scope: StorefrontFollowScope
      operationId: number
      shouldFollow: boolean
    }
  | {
      type: "operation_settled"
      scope: StorefrontFollowScope
      operationId: number
    }
  | {
      type: "operation_failed"
      scope: StorefrontFollowScope
      operationId: number
      message: string
    }

export function isStorefrontFollowScopeEqual(
  left: StorefrontFollowScope,
  right: StorefrontFollowScope
): boolean {
  return (
    left.merchantPubkey === right.merchantPubkey &&
    left.viewerPubkey === right.viewerPubkey
  )
}

export function createStorefrontFollowState(
  scope: StorefrontFollowScope
): StorefrontFollowState {
  return {
    scope,
    saveState: "idle",
    override: null,
    error: null,
    activeOperationId: null,
  }
}

function isCurrentOperation(
  state: StorefrontFollowState,
  action: {
    scope: StorefrontFollowScope
    operationId: number
  }
): boolean {
  return (
    isStorefrontFollowScopeEqual(state.scope, action.scope) &&
    state.activeOperationId === action.operationId
  )
}

export function storefrontFollowReducer(
  state: StorefrontFollowState,
  action: StorefrontFollowAction
): StorefrontFollowState {
  switch (action.type) {
    case "scope_changed":
      return isStorefrontFollowScopeEqual(state.scope, action.scope)
        ? state
        : createStorefrontFollowState(action.scope)
    case "operation_started":
      if (!isStorefrontFollowScopeEqual(state.scope, action.scope)) return state
      return {
        ...state,
        saveState: action.shouldFollow ? "saving_follow" : "saving_unfollow",
        error: null,
        activeOperationId: action.operationId,
      }
    case "publish_succeeded":
      if (!isCurrentOperation(state, action)) return state
      return { ...state, override: action.shouldFollow }
    case "operation_settled":
      if (!isCurrentOperation(state, action)) return state
      return { ...state, saveState: "idle", activeOperationId: null }
    case "operation_failed":
      if (!isCurrentOperation(state, action)) return state
      return {
        ...state,
        saveState: "idle",
        override: null,
        error: action.message,
        activeOperationId: null,
      }
  }
}
