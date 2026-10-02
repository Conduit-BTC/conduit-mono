import { expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { CheckoutPaymentProgress } from "../apps/market/src/components/CheckoutPaymentProgress"

it("shows one truthful, indeterminate payment status without exposing routing steps", () => {
  const markup = renderToStaticMarkup(
    <CheckoutPaymentProgress pausing={false} />
  )
  expect(markup).toContain("Completing your payment")
  expect(markup).toContain('role="status"')
  expect(markup).toContain('role="progressbar"')
  expect(markup).not.toContain("aria-valuenow")
  expect(markup).not.toContain("next payment")
  expect(markup).not.toContain("payout")
  expect(markup).not.toContain("Payment verified")
  expect(markup).toContain('aria-hidden="true"')
  expect(markup).toContain("HODLing the door")
  expect(markup).toContain("motion-reduce:animate-none")
})

it("replaces playful loading text with a clear safe-pause message", () => {
  const markup = renderToStaticMarkup(<CheckoutPaymentProgress pausing />)
  expect(markup).toContain("Pausing safely")
  expect(markup).toContain("Waiting for the current operation to finish")
  expect(markup).not.toContain("HODLing the door")
  expect(markup).not.toContain("Completing your payment")
  expect(markup).not.toContain("aria-valuenow")
})
