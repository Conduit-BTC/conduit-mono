import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  assertOrderMessagingReady,
  getOrderMessagingReadiness,
} from "../packages/core/src/protocol/order-messaging-readiness"
import { OrderMessagingReadinessNotice } from "../packages/ui/src/components/OrderMessagingReadinessNotice"

describe("order messaging preflight", () => {
  test("only established readiness allows committing a signed-in order", () => {
    expect(() => assertOrderMessagingReady("ready")).not.toThrow()
    for (const status of [
      "loading",
      "not_observed",
      "signed_empty",
      "malformed",
      "lookup_partial",
      "lookup_unavailable",
    ] as const) {
      expect(() => assertOrderMessagingReady(status)).toThrow()
    }
  })
  test("incomplete discovery offers retry without claiming setup is missing", () => {
    for (const status of ["lookup_partial", "lookup_unavailable"] as const) {
      const result = getOrderMessagingReadiness(status)
      expect(result.action).toBe("retry")
      expect(result.detail).toContain("does not mean your setup is missing")
    }
  })
  test("setup keeps the originating checkout or draft mounted", () => {
    const markup = renderToStaticMarkup(
      <OrderMessagingReadinessNotice
        status="not_observed"
        context="checkout"
        onRetry={() => {}}
      />
    )
    expect(markup).toContain('href="/network"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain("Your checkout stays here.")
    const reply = renderToStaticMarkup(
      <OrderMessagingReadinessNotice status="signed_empty" onRetry={() => {}} />
    )
    expect(reply).toContain("Your draft stays here.")
  })
  test("ready inbox needs no repair banner", () => {
    expect(
      renderToStaticMarkup(
        <OrderMessagingReadinessNotice status="ready" onRetry={() => {}} />
      )
    ).toBe("")
  })
})
