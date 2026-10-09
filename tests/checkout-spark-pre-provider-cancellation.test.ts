import { describe, expect, it } from "bun:test"
import { createCheckoutSparkPreProviderCancellationRegistry } from "../packages/core/src/protocol/checkout-spark-pre-provider-cancellation"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"

describe("internal process-local pre-provider cancellation registry", () => {
  it("keeps payment rails and repository processes separate", () => {
    const native = createCheckoutSparkPreProviderCancellationRegistry<object>()
    const outgoing =
      createCheckoutSparkPreProviderCancellationRegistry<object>()
    const scope = Object.freeze({})
    const state = nativeTreasuryFixture().state
    native.remember(scope, state, 3, "exact")
    const retained = native.load(scope, state, 3, "exact")!
    expect(retained).toBeDefined()
    expect(outgoing.authority(retained)).toBeUndefined()
    expect(outgoing.load(scope, state, 3, "exact")).toBeUndefined()
    expect(native.load({}, state, 3, "exact")).toBeUndefined()
    expect(native.load(scope, state, 3, "another-leg")).toBeUndefined()
  })

  it("revokes retained capabilities on forget, newer revision and replacement", () => {
    const ledger = createCheckoutSparkPreProviderCancellationRegistry<object>()
    const scope = Object.freeze({})
    const state = nativeTreasuryFixture().state
    for (const action of ["forget", "stale_revision", "replace"] as const) {
      ledger.remember(scope, state, 3, "exact")
      const retained = ledger.load(scope, state, 3, "exact")!
      if (action === "forget") ledger.forget(scope, "exact")
      if (action === "stale_revision")
        expect(ledger.load(scope, state, 4, "exact")).toBeUndefined()
      if (action === "replace") ledger.remember(scope, state, 3, "exact")
      expect(ledger.authority(retained)?.consumed).toBe(true)
      if (action === "replace") {
        const replacement = ledger.load(scope, state, 3, "exact")!
        expect(replacement).not.toBe(retained)
        ledger.consume(retained)
        expect(ledger.load(scope, state, 3, "exact")).toBe(replacement)
      } else expect(ledger.load(scope, state, 3, "exact")).toBeUndefined()
    }
  })

  it("does not revoke newer live authority when stale presentation hints inspect it", () => {
    const ledger = createCheckoutSparkPreProviderCancellationRegistry<object>()
    const scope = Object.freeze({})
    const state = nativeTreasuryFixture().state
    ledger.remember(scope, state, 4, "exact")
    const retained = ledger.load(scope, state, 4, "exact")!
    expect(ledger.load(scope, state, 2, "exact")).toBeUndefined()
    expect(
      ledger.load(
        scope,
        { ...state, updatedAt: state.updatedAt + 1 },
        4,
        "exact"
      )
    ).toBeUndefined()
    expect(ledger.authority(retained)?.consumed).toBe(false)
    expect(ledger.load(scope, state, 4, "exact")).toBe(retained)
  })

  it("bounds pending authority and revokes retained FIFO evictions", () => {
    const ledger = createCheckoutSparkPreProviderCancellationRegistry<object>()
    const scope = Object.freeze({})
    const state = nativeTreasuryFixture().state
    ledger.remember(scope, state, 3, "oldest")
    const retained = ledger.load(scope, state, 3, "oldest")!
    for (let index = 0; index < 128; index++)
      ledger.remember(scope, state, 3, `pending-${index}`)
    expect(ledger.authority(retained)?.consumed).toBe(true)
    expect(ledger.load(scope, state, 3, "oldest")).toBeUndefined()
    const newest = ledger.load(scope, state, 3, "pending-127")!
    expect(newest).toBeDefined()
    ledger.consume(newest)
    expect(ledger.authority(newest)?.consumed).toBe(true)
    expect(ledger.load(scope, state, 3, "pending-127")).toBeUndefined()
  })
})
