import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { EventGuestReceiptDetails } from "../apps/market/src/components/EventGuestReceiptDetails"

test("guest checkout explains verified device saving without revealing a prepayment bearer receipt", () => {
  const markup = renderToStaticMarkup(
    <EventGuestReceiptDetails label="Guest" onLabelChange={() => {}} />
  )
  expect(markup.includes("saved on this device")).toBe(true)
  expect(markup.includes("after payment is verified")).toBe(true)
  expect(markup.includes("not proof of payment")).toBe(true)
  expect(markup.includes("I saved my private receipt")).toBe(false)
  expect(markup.includes("Save event receipt")).toBe(false)
  expect(markup.includes("Private receipt code")).toBe(false)
  expect(markup.includes("<svg")).toBe(false)
})
