import { describe, expect, it } from "bun:test"

import {
  createStorefrontFollowState,
  deriveStorefrontFollowControl,
  storefrontFollowReducer,
  type StorefrontFollowScope,
} from "../apps/market/src/lib/storefront-follow-state"

const viewerA = "a".repeat(64)
const viewerB = "b".repeat(64)
const merchantA = "c".repeat(64)
const merchantB = "d".repeat(64)

function scope(
  viewerPubkey: string | null,
  merchantPubkey: string
): StorefrontFollowScope {
  return { viewerPubkey, merchantPubkey }
}

describe("storefront follow state", () => {
  it("keeps an ambiguous pending action available as an exact retry", () => {
    expect(
      deriveStorefrontFollowControl({
        override: null,
        observedFollowing: false,
        pendingFollowing: true,
      })
    ).toEqual({
      isFollowing: true,
      shouldFollowOnClick: true,
      isPendingRetry: true,
    })
    expect(
      deriveStorefrontFollowControl({
        override: null,
        observedFollowing: true,
        pendingFollowing: false,
      })
    ).toEqual({
      isFollowing: false,
      shouldFollowOnClick: false,
      isPendingRetry: true,
    })
  })

  it("lets a settled local result supersede stale pending query data", () => {
    expect(
      deriveStorefrontFollowControl({
        override: true,
        observedFollowing: false,
        pendingFollowing: false,
      })
    ).toEqual({
      isFollowing: true,
      shouldFollowOnClick: false,
      isPendingRetry: false,
    })
  })

  it("applies and settles the active scope's publish result", () => {
    const activeScope = scope(viewerA, merchantA)
    let state = createStorefrontFollowState(activeScope)

    state = storefrontFollowReducer(state, {
      type: "operation_started",
      scope: activeScope,
      operationId: 1,
      shouldFollow: true,
    })
    state = storefrontFollowReducer(state, {
      type: "publish_succeeded",
      scope: activeScope,
      operationId: 1,
      shouldFollow: true,
    })
    state = storefrontFollowReducer(state, {
      type: "operation_settled",
      scope: activeScope,
      operationId: 1,
    })

    expect(state).toEqual({
      ...createStorefrontFollowState(activeScope),
      override: true,
    })
  })

  it("ignores a stale publish success after the viewer and merchant change", () => {
    const originalScope = scope(viewerA, merchantA)
    const nextScope = scope(viewerB, merchantB)
    let state = createStorefrontFollowState(originalScope)

    state = storefrontFollowReducer(state, {
      type: "operation_started",
      scope: originalScope,
      operationId: 1,
      shouldFollow: true,
    })
    state = storefrontFollowReducer(state, {
      type: "scope_changed",
      scope: nextScope,
    })
    state = storefrontFollowReducer(state, {
      type: "publish_succeeded",
      scope: originalScope,
      operationId: 1,
      shouldFollow: true,
    })
    state = storefrontFollowReducer(state, {
      type: "operation_settled",
      scope: originalScope,
      operationId: 1,
    })

    expect(state).toEqual(createStorefrontFollowState(nextScope))
  })

  it("ignores a stale publish failure after the viewer disconnects", () => {
    const originalScope = scope(viewerA, merchantA)
    const disconnectedScope = scope(null, merchantA)
    let state = createStorefrontFollowState(originalScope)

    state = storefrontFollowReducer(state, {
      type: "operation_started",
      scope: originalScope,
      operationId: 2,
      shouldFollow: false,
    })
    state = storefrontFollowReducer(state, {
      type: "scope_changed",
      scope: disconnectedScope,
    })
    state = storefrontFollowReducer(state, {
      type: "operation_failed",
      scope: originalScope,
      operationId: 2,
      message: "The stale publish failed.",
    })

    expect(state).toEqual(createStorefrontFollowState(disconnectedScope))
  })
})
