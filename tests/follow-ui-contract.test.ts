import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

describe("Market follow session lifecycle", () => {
  it("discards stale follow results when the signer session changes", () => {
    const source = readFileSync(
      new URL("../apps/market/src/routes/store/$pubkey.tsx", import.meta.url),
      "utf8"
    )

    expect(source).toContain("const followAuthGeneration = authGeneration")
    expect(
      source.match(/authGenerationRef\.current !== followAuthGeneration/g)
    ).toHaveLength(2)
    expect(source).toContain('setFollowState("idle")')
  })

  it("links incomplete contact-list reads to write relay settings", () => {
    const source = readFileSync(
      new URL("../apps/market/src/routes/store/$pubkey.tsx", import.meta.url),
      "utf8"
    )

    expect(source).toContain('to="/network"')
    expect(source).toContain("Open Network settings")
    expect(source).toContain("Could not load the complete follow list")
  })
})
