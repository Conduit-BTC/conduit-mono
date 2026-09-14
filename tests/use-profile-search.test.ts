import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { selectProfileSearchPhaseResult } from "../packages/core/src/hooks/useProfileSearch"
import type { ProfileSearchResult } from "../packages/core/src/protocol/profile-search"

const ALICE = "a".repeat(64)

function result(query: string): ProfileSearchResult {
  return {
    query,
    matches: [
      {
        pubkey: ALICE,
        profile: { pubkey: ALICE, name: query },
        isSeller: false,
        source: "local_cache",
        score: 0,
        frontier: {},
      },
    ],
    evidence: "not_queried",
    relaysPlanned: 0,
    relaysCompleted: 0,
    relaysDegraded: 0,
    verified: true,
  }
}

describe("useProfileSearch phase selection", () => {
  it("drops a phase result that answers a different query", () => {
    const previous = result("ali")
    expect(selectProfileSearchPhaseResult(previous, "alic")).toBeUndefined()
    expect(selectProfileSearchPhaseResult(undefined, "alic")).toBeUndefined()
  })

  it("accepts a phase result for the same normalized query", () => {
    const current = result("Alíc ")
    expect(selectProfileSearchPhaseResult(current, "alic")).toBe(current)
  })

  it("routes both phases through the query guard and keeps no previous data", async () => {
    const hook = await readFile(
      "packages/core/src/hooks/useProfileSearch.ts",
      "utf8"
    )
    expect(hook).not.toContain("keepPreviousData")
    expect(hook).toMatch(
      /selectProfileSearchPhaseResult\(\s*cachedQuery\.data,\s*normalized\s*\)/
    )
    expect(hook).toMatch(
      /selectProfileSearchPhaseResult\(\s*networkQuery\.data,\s*normalized\s*\)/
    )
  })
})
