import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market checkout public zap note contract", () => {
  it("offers a bounded, mobile-safe, described multiline note field", async () => {
    const route = await readFile("apps/market/src/routes/checkout.tsx", "utf8")
    const fieldStart = route.indexOf('htmlFor="zap-content"')
    const fieldEnd = route.indexOf(
      "</div>",
      route.indexOf('id="zap-content-count"')
    )
    const field = route.slice(fieldStart, fieldEnd)

    expect(fieldStart).toBeGreaterThanOrEqual(0)
    expect(fieldEnd).toBeGreaterThan(fieldStart)
    expect(field).toContain("Public zap note (optional)")
    expect(field).toContain(
      'aria-describedby="zap-content-help zap-content-count"'
    )
    expect(field).toContain("rows={3}")
    expect(field).toContain("min-h-24")
    expect(field).toContain("text-base")
    expect(field).toContain("truncatePublicZapNoteDraft")
    expect(field).toContain("zapNoteCodePointCount")
    expect(field).toContain("zapNoteMaxCodePoints")
    expect(field).toContain('aria-live="polite"')
    expect(field).toContain("Public zap note limit reached")
    expect(field).not.toContain("maxLength={280}")
  })

  it("explains the product-link and multi-product privacy boundary", async () => {
    const route = await readFile("apps/market/src/routes/checkout.tsx", "utf8")

    expect(route).toMatch(/product link to the merchant&apos;s\s+Lightning/)
    expect(route).toMatch(/payment completes, a zap receipt\s+can publish/)
    expect(route).toContain("Multi-product checkout notes do not identify")
    expect(route).toContain("getCheckoutZapTargetAddress")
    expect(route).toContain("zapTargetAddress: effectiveZapTargetAddress")
  })
})
