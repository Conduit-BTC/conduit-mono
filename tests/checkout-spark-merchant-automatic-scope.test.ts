import { describe, expect, it } from "bun:test"
import {
  createMerchantCheckoutSparkAutomaticSession,
  merchantCheckoutSparkAutomaticScopeIncludes,
  type MerchantCheckoutSparkAutomaticScope,
} from "../apps/merchant/src/lib/checkout-spark-automatic-session"
import { createMerchantCheckoutSparkPayoutReviewSelection } from "../apps/merchant/src/lib/checkout-spark-payout-review-selection"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

describe("Merchant selected-order automatic recovery", () => {
  it("pins per-order dispatch and delayed consent to the participant-qualified checkout", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    const exactKey = "buyer-a:checkout-a"
    selection.select("shared-order", exactKey)
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {},
      captureOrder: (orderId, selectionKey) =>
        selection.capture(orderId, selectionKey),
    })
    await session.change(true, {
      kind: "order",
      orderId: "shared-order",
      selectionKey: exactKey,
    })
    const assertCurrent = session.capture()
    expect(() => assertCurrent("shared-order", exactKey)).not.toThrow()
    expect(() => assertCurrent("shared-order", "buyer-b:checkout-b")).toThrow(
      "session changed"
    )
    let adapterCalls = 0
    selection.select("shared-order", "buyer-b:checkout-b")
    expect(session.getScope()).toBeNull()
    try {
      assertCurrent("shared-order", exactKey)
      adapterCalls += 1
    } catch {
      /* Revoked selection must never reach an adapter. */
    }
    expect(adapterCalls).toBe(0)
  })

  it("does not grant another funded order authority when continuing the selected order", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {},
      captureOrder: (orderId) => selection.capture(orderId),
    })
    expect(
      await session.change(true, { kind: "order", orderId: "selected-order" })
    ).toBe(true)
    const assertCurrent = session.capture()
    expect(() => assertCurrent("selected-order")).not.toThrow()
    expect(() => assertCurrent("another-funded-order")).toThrow(
      "session changed"
    )
    expect(
      ["selected-order", "another-funded-order"].filter((orderId) =>
        merchantCheckoutSparkAutomaticScopeIncludes(session.getScope(), orderId)
      )
    ).toEqual(["selected-order"])
  })

  it("preserves the separately approved all-orders activation across selected-card navigation", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {},
      captureOrder: (orderId) => selection.capture(orderId),
    })
    expect(await session.change(true)).toBe(true)
    const assertCurrent = session.capture()
    selection.select("another-funded-order")
    selection.select("another-funded-order", "different-participant-checkout")
    expect(session.getScope()).toEqual({ kind: "all" })
    expect(() => assertCurrent("selected-order")).not.toThrow()
    expect(() => assertCurrent("another-funded-order")).not.toThrow()
  })

  it("does not admit a held per-order Start after a same-ID participant change", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    const key = "buyer-a:checkout-a"
    selection.select("shared-order", key)
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
      captureOrder: (orderId, selectionKey) =>
        selection.capture(orderId, selectionKey),
    })
    const starting = session.change(true, {
      kind: "order",
      orderId: "shared-order",
      selectionKey: key,
    })
    selection.select("shared-order", "buyer-b:checkout-b")
    held.resolve()
    expect(await starting).toBe(false)
    expect(session.getScope()).toBeNull()
  })

  it("does not activate a selected order after selection changes during the worker drain", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
      captureOrder: (orderId) => selection.capture(orderId),
    })
    const starting = session.change(true, {
      kind: "order",
      orderId: "selected-order",
    })
    selection.select("another-funded-order")
    selection.select("selected-order")
    held.resolve()
    expect(await starting).toBe(false)
    expect(session.getScope()).toBeNull()
    expect(() => session.capture()("selected-order")).toThrow("session changed")
    expect(() => session.capture()("another-funded-order")).toThrow(
      "session changed"
    )
  })

  it("revokes a held selected-order boundary before a delayed result can admit another phase", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {},
      captureOrder: (orderId) => selection.capture(orderId),
    })
    await session.change(true, { kind: "order", orderId: "selected-order" })
    const assertCurrent = session.capture()
    const held = deferred()
    let subsequentPhases = 0
    const phase = (async () => {
      assertCurrent("selected-order")
      await held.promise
      assertCurrent("selected-order")
      subsequentPhases += 1
    })()
    void phase.catch(() => undefined)
    selection.select("another-funded-order")
    expect(session.getScope()).toBeNull()
    selection.select("selected-order")
    held.resolve()
    await expect(phase).rejects.toThrow("session changed")
    expect(subsequentPhases).toBe(0)
    expect(session.getScope()).toBeNull()
  })

  it("Pause revokes selected authority synchronously and drains before granting a later scope", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    let drain = Promise.resolve()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => drain,
      captureOrder: (orderId) => selection.capture(orderId),
    })
    await session.change(true, { kind: "order", orderId: "selected-order" })
    const assertHeldCurrent = session.capture()
    const held = deferred()
    drain = held.promise
    const pausing = session.change(false)
    expect(() => assertHeldCurrent("selected-order")).toThrow("session changed")
    expect(session.getScope()).toBeNull()
    selection.select("another-funded-order")
    const restarting = session.change(true, {
      kind: "order",
      orderId: "another-funded-order",
    })
    expect(session.getScope()).toBeNull()
    held.resolve()
    expect(await pausing).toBe(false)
    expect(await restarting).toBe(true)
    expect(() => session.capture()("selected-order")).toThrow("session changed")
    expect(() => session.capture()("another-funded-order")).not.toThrow()
    expect(() => assertHeldCurrent("selected-order")).toThrow("session changed")
  })

  it("freezes the clicked order before waiting and rejects missing selected-order evidence", async () => {
    const selection = createMerchantCheckoutSparkPayoutReviewSelection()
    selection.select("selected-order")
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
      captureOrder: (orderId) => selection.capture(orderId),
    })
    const scope: MerchantCheckoutSparkAutomaticScope = {
      kind: "order",
      orderId: "selected-order",
    }
    const starting = session.change(true, scope)
    Object.assign(scope, { orderId: "another-funded-order" })
    held.resolve()
    expect(await starting).toBe(true)
    expect(session.getScope()).toEqual({
      kind: "order",
      orderId: "selected-order",
    })
    expect(Object.isFrozen(session.getScope())).toBe(true)
    const unavailable = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {},
    })
    expect(
      await unavailable.change(true, {
        kind: "order",
        orderId: "selected-order",
      })
    ).toBe(false)
    expect(unavailable.getScope()).toBeNull()
  })
})
