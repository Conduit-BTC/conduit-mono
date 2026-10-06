import { describe, expect, it } from "bun:test"
import { formatEventRelayReadCoverage } from "@conduit/ui"

describe("relay read coverage presentation", () => {
  it("describes the real planned set independently from actionability", () => {
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 4,
        completeRelayCount: 3,
        partialRelayCount: 1,
        failedRelayCount: 0,
      })
    ).toBe("3 of 4 planned relay reads completed; 1 was incomplete.")
  })

  it("omits coverage when no relay plan was attempted", () => {
    expect(formatEventRelayReadCoverage(undefined)).toBeNull()
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 0,
        completeRelayCount: 0,
      })
    ).toBeNull()
  })

  it("bounds reported completion to the actual planned set", () => {
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 2,
        completeRelayCount: 4,
      })
    ).toBe("2 of 2 planned relay reads completed.")
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 2,
        completeRelayCount: -1,
      })
    ).toBe("0 of 2 planned relay reads completed; 2 were incomplete.")
  })

  it("reports a complete planned read", () => {
    expect(
      formatEventRelayReadCoverage({
        attemptedRelayCount: 4,
        completeRelayCount: 4,
        partialRelayCount: 0,
        failedRelayCount: 0,
      })
    ).toBe("4 of 4 planned relay reads completed.")
  })
})
