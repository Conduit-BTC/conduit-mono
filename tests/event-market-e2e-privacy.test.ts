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
    const source = await Bun.file("e2e/event-market.playwright.ts").text()
    const start = source.indexOf(
      'for (const retention of ["screen", "file"] as const)'
    )
    const end = source.indexOf(
      'test("organizer fee edits use saved addresses',
      start
    )
    expect(start >= 0 && end > start).toBe(true)
    const journey = source.slice(start, end)
    const compact = journey.replace(/\s+/g, " ")
    const stages = journey.match(/let receiptStage:([\s\S]*?)= "setup"/)
    expect(
      stages?.[1]?.match(/"[a-z-]+"/g)?.join(",") ===
        [
          "setup",
          "phone-normalization",
          "receipt-required",
          "receipt-display",
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
    expect(
      /\} catch \{ throw new Error\(\s*`Guest receipt journey failed at \$\{receiptStage\}\.`\s*\) \} \}\) \}/.test(
        compact
      )
    ).toBe(true)
    expect(journey.includes(".toHaveLength(")).toBe(false)
    for (const assertion of [
      'expect(order.buyerIdentityKind === "guest_ephemeral").toBe(true)',
      "expect(order.guestContact === undefined).toBe(true)",
      'expect(order.contactFreePickup.label === "Soap fan").toBe(true)',
      'download.suggestedFilename() === "conduit-event-receipt.txt"',
    ])
      expect(compact.includes(assertion)).toBe(true)
    expect(journey.includes(".fill(receiptCode)")).toBe(true)
    expect(
      journey.match(/getByText\(\/Receipt matches this order/g)?.length
    ).toBe(3)
    expect(
      journey.includes("This receipt does not match this order and merchant.")
    ).toBe(true)
  })
})
