import { describe, expect, it } from "bun:test"

describe("merchant order action hierarchy", () => {
  it("renders the recommended next step before destructive alternatives", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const nextStepIndex = source.indexOf("Next step")
    const otherActionsIndex = source.indexOf("Other actions")

    expect(nextStepIndex).toBeGreaterThan(-1)
    expect(otherActionsIndex).toBeGreaterThan(nextStepIndex)
    expect(source).not.toContain(">Respond<")
    expect(source).toContain('variant="destructive"')
  })
})
