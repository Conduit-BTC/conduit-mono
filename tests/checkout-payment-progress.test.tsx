import { expect, it, spyOn } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutPaymentProgress } from "../apps/market/src/components/CheckoutPaymentProgress"

it("starts independent mounts with randomized loading messages", () => {
  const random = spyOn(Math, "random").mockReturnValue(0)
  try {
    const first = renderToStaticMarkup(
      <CheckoutPaymentProgress pausing={false} />
    )
    random.mockReturnValue(0.999)
    const second = renderToStaticMarkup(
      <CheckoutPaymentProgress pausing={false} />
    )

    expect(first).not.toBe(second)
  } finally {
    random.mockRestore()
  }
})

it("shows one truthful, indeterminate payment status without exposing routing steps", () => {
  const markup = renderToStaticMarkup(
    <CheckoutPaymentProgress pausing={false} />
  )
  expect(markup).toContain("Completing your payment")
  expect(markup).toContain('role="status"')
  expect(markup).toContain('aria-live="polite"')
  expect(markup).toContain('role="progressbar"')
  expect(markup).toContain('aria-label="Completing your payment…"')
  expect(markup).not.toContain("aria-valuenow")
  expect(markup).not.toContain("next payment")
  expect(markup).not.toContain("payout")
  expect(markup).not.toContain("Payment verified")
  expect(markup).toContain('aria-hidden="true"')
  expect(markup).toContain(
    "Please keep this page open while we check your payment."
  )
  expect(markup).toContain("motion-reduce:animate-none")
})

it("replaces playful loading text with a clear safe-pause message", () => {
  const markup = renderToStaticMarkup(<CheckoutPaymentProgress pausing />)
  expect(markup).toContain("Pausing safely")
  expect(markup).toContain("Waiting for the current operation to finish")
  expect(markup).toContain("Please don&#x27;t pay again.")
  expect(markup).toContain('aria-label="Pausing safely…"')
  expect(markup).not.toContain("HODLing the door")
  expect(markup).not.toContain("Completing your payment")
  expect(markup).not.toContain("aria-valuenow")
})
