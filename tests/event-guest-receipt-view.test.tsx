import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createEventGuestReceipt } from "@conduit/core"
import { EventGuestReceiptDetails } from "../apps/market/src/components/EventGuestReceiptDetails"

test("guest can retain a visible pickup receipt without a forced JSON download", () => {
  const receipt = createEventGuestReceipt("a".repeat(64))
  const markup = renderToStaticMarkup(
    <EventGuestReceiptDetails
      merchantPubkey={receipt.merchantPubkey}
      scope="current"
      label="Guest"
      onLabelChange={() => {}}
      draft={{ receipt, scope: "current", saved: false }}
      onDraftChange={() => {}}
    />
  )
  expect(markup.includes("Private pickup receipt")).toBe(true)
  expect(markup.includes("screenshot")).toBe(true)
  expect(markup.includes("not proof of payment")).toBe(true)
  expect(markup.includes("I saved my private receipt")).toBe(true)
})
