import { describe, expect, it } from "bun:test"

describe("event-market browser artifact privacy", () => {
  it("keeps protocol-bearing browser evidence out of CI artifacts", async () => {
    const source = await Bun.file("e2e/event-market.playwright.ts").text()

    expect(source).toContain('trace: "off"')
    expect(source).toContain('video: "off"')
    expect(source).toContain('screenshot: "off"')
    expect(source).not.toContain("testInfo.attach")
    expect(source).not.toContain("testInfo.outputPath")
    expect(source).not.toContain("page.screenshot")
    expect(source).not.toContain("JSON.stringify(relay.requests")
  })

  it("models replaceable relay frontiers per filter with Core's tie-break", async () => {
    const source = await Bun.file("e2e/event-market.playwright.ts").text()

    expect(source).toContain("for (const filter of filters)")
    expect(source).toContain("right.created_at - left.created_at")
    expect(source).toContain("left.id.localeCompare(right.id)")
    expect(source).not.toContain("right.id.localeCompare(left.id)")
  })

  it("keeps guest receipt failures content-free without dropping receipt checks", async () => {
    const source = (
      await Bun.file("e2e/event-market.playwright.ts").text()
    ).replace(/\r\n/g, "\n")
    const start = source.indexOf(
      'for (const retention of ["screen", "file"] as const)'
    )
    const end = source.indexOf("\n}\n", start)
    expect(start >= 0 && end > start).toBe(true)
    const journey = source.slice(start, end + 2)
    const compact = journey.replace(/\s+/g, " ")
    const stages = journey.match(/let receiptStage:([\s\S]*?)= "setup"/)
    expect(
      stages?.[1]?.match(/"[a-z-]+"/g)?.join(",") ===
        [
          "setup",
          "event-navigation",
          "event-product",
          "cart-ready",
          "checkout-navigation",
          "phone-normalization",
          "receipt-before-order",
          "receipt-display",
          "receipt-recovery",
          "receipt-export",
          "order-submission",
          "code-verification",
          "text-verification",
          "legacy-file-verification",
          "mismatch-rejection",
        ]
          .map((stage) => `"${stage}"`)
          .join(",")
    ).toBe(true)
    expect(compact.includes('= "setup" try { const relay =')).toBe(true)
    const failure = journey.slice(journey.lastIndexOf("} catch {"))
    expect(failure.includes('let boundary = "unclassified"')).toBe(true)
    expect(
      failure
        .match(/[?:]\s*"([a-z-]+)"/g)
        ?.map((value) => value.match(/"([a-z-]+)"/)?.[1])
    ).toEqual([
      "record-unavailable",
      "record-check-failed",
      "record-pending",
      "product-heading-contract",
      "event-without-product",
      "vite-overlay",
      "empty-root",
      "unexpected-shell",
    ])
    expect(
      failure.match(/new Error\([\s\S]*?\)/g)?.length === 1 &&
        failure.includes(
          "`Guest receipt journey failed at ${receiptStage} (${boundary}).`"
        )
    ).toBe(true)
    for (const privateOutput of [
      "JSON.stringify",
      "console.",
      "${text}",
      "${receiptCode}",
      "${order.",
      "{ cause",
    ])
      expect(failure.includes(privateOutput)).toBe(false)
    expect(journey.includes(".toHaveLength(")).toBe(false)
    for (const assertion of [
      'expect(order.buyerIdentityKind === "guest_ephemeral").toBe(true)',
      "expect(order.guestContact === undefined).toBe(true)",
      'expect(order.contactFreePickup.label === "Soap fan").toBe(true)',
      'download.suggestedFilename() === "conduit-event-receipt.txt"',
      "expect(automaticDownloads).toBe(0)",
      "order.pickupReceiptCommitment === order.contactFreePickup.receiptCommitment",
      'expect(orders()[0]!.rumor.content.includes("claimSecret")).toBe(false)',
      "order.createdAt + 24 * 60 * 60 * 1_000 + 1",
    ])
      expect(compact.includes(assertion)).toBe(true)
    const beforeSubmit = journey.slice(
      journey.indexOf('receiptStage = "receipt-before-order"'),
      journey.indexOf('receiptStage = "order-submission"')
    )
    expect(beforeSubmit.match(/\.toHaveCount\(0\)/g)?.length === 5).toBe(true)
    expect(beforeSubmit.includes("I saved my private receipt")).toBe(true)
    expect(beforeSubmit.includes("Private receipt code")).toBe(true)
    expect(beforeSubmit.includes("Save event receipt")).toBe(true)
    expect(journey.includes(".fill(receiptCode)")).toBe(true)
    expect(
      journey.match(/getByText\(\/Receipt matches this order/g)?.length
    ).toBe(3)
    expect(
      journey.includes("This receipt does not match this order and merchant.")
    ).toBe(true)
  })
})
