import { expect, test } from "bun:test"
import {
  createEventGuestReceipt,
  formatEventGuestReceipt,
  getEventGuestReceiptCommitment,
  parseEventGuestReceipt,
} from "@conduit/core"

test("readable receipt export preserves the exact private commitment", () => {
  const receipt = createEventGuestReceipt("a".repeat(64))
  const text = formatEventGuestReceipt(receipt)
  const parsed = parseEventGuestReceipt(text)
  expect(parsed !== null).toBe(true)
  expect(
    getEventGuestReceiptCommitment(parsed!) ===
      getEventGuestReceiptCommitment(receipt)
  ).toBe(true)
  expect(text.includes("not proof of payment")).toBe(true)
  expect(parseEventGuestReceipt(text.replaceAll("\n", "\r\n")) !== null).toBe(
    true
  )
})

test("original JSON receipt files remain readable", () => {
  const receipt = createEventGuestReceipt("a".repeat(64))
  const parsed = parseEventGuestReceipt(JSON.stringify(receipt))
  expect(parsed?.claimSecret === receipt.claimSecret).toBe(true)
  expect(
    parseEventGuestReceipt(JSON.stringify({ ...receipt, version: 2 })) === null
  ).toBe(true)
  expect(
    parseEventGuestReceipt(JSON.stringify({ ...receipt, extra: true })) === null
  ).toBe(true)
})

test("malformed, oversized and credential-like receipt content is rejected", () => {
  const receipt = createEventGuestReceipt("a".repeat(64))
  const text = formatEventGuestReceipt(receipt)
  expect(
    parseEventGuestReceipt(text.replace("Private receipt code: ", "Code: ")) ===
      null
  ).toBe(true)
  expect(
    parseEventGuestReceipt(
      text.replace(receipt.claimSecret, "not-a-receipt-code")
    ) === null
  ).toBe(true)
  expect(parseEventGuestReceipt(text + " ".repeat(4096)) === null).toBe(true)
  expect(parseEventGuestReceipt("{") === null).toBe(true)
})
