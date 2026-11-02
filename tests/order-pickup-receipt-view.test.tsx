import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  createEventGuestReceipt,
  getEventGuestReceiptCommitment,
} from "@conduit/core/protocol/event-guest-checkout"
import type { SavedEventPickupReceipt } from "@conduit/core/protocol/event-pickup-receipt-storage"
import { PickupReceiptContent } from "../apps/market/src/components/OrderPickupReceipt"
import { EventGuestReceiptVerifier } from "../packages/ui/src/components/EventGuestReceiptVerifier"
import { orderSchema } from "@conduit/core/schemas"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

function savedReceipt(): SavedEventPickupReceipt {
  const receipt = createEventGuestReceipt("a".repeat(64))
  const occurrenceEnd = 1_900_000_000_000
  return {
    schemaVersion: 1,
    receipt,
    orderId: receipt.orderId,
    merchantPubkey: receipt.merchantPubkey,
    owner: "guest",
    occurrenceCoordinate: `31923:${"b".repeat(64)}:selected-date`,
    occurrenceEnd,
    createdAt: occurrenceEnd - 1_000,
    expiresAt: occurrenceEnd + 24 * 60 * 60 * 1_000,
  }
}

test("the Organizer pickup QR displays only the opaque claim code, not v1 identity or private seller receipt", () => {
  const saved = savedReceipt()
  const markup = renderToStaticMarkup(
    <PickupReceiptContent
      saved={saved}
      organizerClaimCode="ABCD-EF01-2345"
      onExport={() => {}}
      onDelete={() => {}}
    />
  )
  expect(markup.includes("ABCD-EF01-2345")).toBe(true)
  expect(markup.includes("<svg")).toBe(true)
  expect(markup.includes(saved.orderId)).toBe(false)
  expect(markup.includes(saved.receipt.claimSecret)).toBe(false)
  expect(markup.includes("not proof of payment")).toBe(true)
  expect(markup.includes("Save event receipt")).toBe(true)
})

test("Merchant pickup can display the private code after the external reveal gate", () => {
  const saved = savedReceipt()
  const markup = renderToStaticMarkup(
    <PickupReceiptContent
      saved={saved}
      onExport={() => {}}
      onDelete={() => {}}
    />
  )
  expect(markup.includes("Private receipt code")).toBe(true)
  expect(markup.includes(saved.receipt.claimSecret)).toBe(true)
  expect(markup.includes(saved.orderId)).toBe(false)
})

test("receipt-only recovery after guest expiry has no QR, paid claim or payment action", () => {
  const saved = savedReceipt()
  const markup = renderToStaticMarkup(
    <PickupReceiptContent
      saved={saved}
      recoveryOnly
      onExport={() => {}}
      onDelete={() => {}}
    />
  )
  expect(markup.includes("Payment status is unavailable")).toBe(true)
  expect(markup.includes("not a restored order session")).toBe(true)
  expect(markup.includes("<svg")).toBe(false)
  expect(markup.includes("Resume payment")).toBe(false)
  expect(markup.includes("Pay for order")).toBe(false)
  expect(markup.includes("Delete from this device")).toBe(true)
})

test("the Merchant possession verifier supports signed-in Event receipts without guest-only fields", () => {
  const event = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const receipt = createEventGuestReceipt(event.merchant)
  const order = orderSchema.parse({
    ...event.order,
    id: receipt.orderId,
    buyerIdentityKind: "signed_in",
    pickupReceiptCommitment: getEventGuestReceiptCommitment(receipt),
  })
  const markup = renderToStaticMarkup(
    <EventGuestReceiptVerifier order={order} merchantPubkey={event.merchant} />
  )
  expect(markup.includes("Event pickup receipt")).toBe(true)
  expect(markup.includes("Verify receipt code")).toBe(true)
  expect(markup.includes("authorize handout")).toBe(true)
  expect(markup.includes("Handoff name:")).toBe(false)
})
