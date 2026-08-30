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
})
