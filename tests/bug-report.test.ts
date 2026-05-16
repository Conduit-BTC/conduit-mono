import { describe, expect, it } from "bun:test"
import { buildBugReportUrl, type ConduitBuildInfo } from "@conduit/core"

const buildInfo: ConduitBuildInfo = {
  appVersion: "1.2.3",
  commitSha: "abcdef1234567890",
  shortCommitSha: "abcdef123456",
  branch: "feat/cnd-54-bug-report-forms",
  buildTime: "2026-05-13T00:00:00.000Z",
  sourceUrl: "https://github.com/Conduit-BTC/conduit-mono.git",
  releaseChannel: "preview",
}

describe("bug report helpers", () => {
  it("builds the GitHub issue-form URL with minimal app context", () => {
    const url = new URL(
      buildBugReportUrl({
        app: "market",
        route: "/products?tag=coffee",
        buildInfo,
      })
    )

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/Conduit-BTC/conduit-mono/issues/new"
    )
    expect(url.searchParams.get("template")).toBe("bug_report.yml")
    expect(url.searchParams.get("title")).toBe("[Bug]: Conduit Market")
    expect(url.searchParams.get("app")).toBe("Conduit Market")
    expect(url.searchParams.get("route")).toBe("/products?tag=coffee")
    expect(url.searchParams.get("version")).toBe("1.2.3")
    expect(url.searchParams.get("build")).toContain("commit abcdef123456")
    expect(url.searchParams.get("build")).toContain("channel preview")
    expect(url.searchParams.get("build")).toContain(
      "https://github.com/Conduit-BTC/conduit-mono/commit/abcdef1234567890"
    )
  })

  it("does not rely on URL labels or include browser identity", () => {
    const url = new URL(
      buildBugReportUrl({
        app: "merchant",
        route: null,
        buildInfo,
      })
    )

    expect(url.searchParams.has("labels")).toBe(false)
    expect(url.searchParams.has("userAgent")).toBe(false)
    expect(url.searchParams.has("browser")).toBe(false)
    expect(url.searchParams.get("app")).toBe("Conduit Merchant Portal")
    expect(url.searchParams.get("route")).toBe("Not provided")
  })
})
