import { describe, expect, it } from "bun:test"
import { getCommitUrl, normalizeRepositoryUrl } from "@conduit/core"

describe("build provenance helpers", () => {
  it("normalizes repository urls for commit links", () => {
    expect(
      normalizeRepositoryUrl("https://github.com/Conduit-BTC/conduit-mono.git")
    ).toBe("https://github.com/Conduit-BTC/conduit-mono")
    expect(
      normalizeRepositoryUrl("https://github.com/Conduit-BTC/conduit-mono/")
    ).toBe("https://github.com/Conduit-BTC/conduit-mono")
  })

  it("builds commit links when the build commit is known", () => {
    expect(
      getCommitUrl({
        commitSha: "abc123",
        sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
      })
    ).toBe("https://github.com/Conduit-BTC/conduit-mono/commit/abc123")
  })

  it("returns null when the build commit is unavailable", () => {
    expect(
      getCommitUrl({
        commitSha: null,
        sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
      })
    ).toBeNull()
  })
})
