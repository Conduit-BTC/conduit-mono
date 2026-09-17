import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  getProfileSearchQueryKey,
  getProfileSearchRepairKey,
  isRepairedProfileSearchQuery,
  selectProfileSearchPhaseResult,
} from "../packages/core/src/hooks/useProfileSearch"
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
    device: {
      profileCache: "read",
      sellerFlags: "read",
      cachedFrontiers: "not_read",
    },
    superseded: [],
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

describe("profile search query keys", () => {
  const ACCOUNT = "f".repeat(64)

  it("separates guest and account plans and both phases", async () => {
    expect(getProfileSearchQueryKey("Ali", 5, "network", ACCOUNT)).toEqual([
      "profile-search",
      "network",
      "ali",
      5,
      ACCOUNT,
    ])
    expect(getProfileSearchQueryKey("Ali", 5, "network")).toEqual([
      "profile-search",
      "network",
      "ali",
      5,
      "guest",
    ])
    expect(getProfileSearchQueryKey("Ali", 5, "cached", ACCOUNT)).not.toEqual(
      getProfileSearchQueryKey("Ali", 5, "network", ACCOUNT)
    )

    const hook = await readFile(
      "packages/core/src/hooks/useProfileSearch.ts",
      "utf8"
    )
    expect(hook).toContain("authenticatedPubkey: accountPubkey")
  })
})

describe("short query handling", () => {
  it("keeps the relay phase disabled and settled for one-character queries", async () => {
    const hook = await readFile(
      "packages/core/src/hooks/useProfileSearch.ts",
      "utf8"
    )
    expect(hook).toContain(
      "normalized.length >= PROFILE_SEARCH_MIN_NETWORK_QUERY_LENGTH"
    )
    expect(hook).toContain(
      "enabled: networkEligible && settledQuery.length > 0"
    )
    expect(hook).toMatch(
      /const networkDone =\s*!networkEligible \|\| networkData !== undefined \|\| networkQuery\.isError/
    )
    expect(hook).toContain(
      "const isNetworkFetching = networkEligible && (isSettling || !networkDone)"
    )
    expect(hook).toContain(
      "const isDeviceFetching = eligible && cachedQuery.isFetching"
    )
  })
})

describe("late seller flags", () => {
  const repairKeyFor = (query: string) =>
    getProfileSearchRepairKey(getProfileSearchQueryKey(query, 5, "cached"))

  /** Mirrors the hook callback: one repair read per query, keyed by query. */
  function repairRunner() {
    let repaired: string | null = null
    const reads: string[] = []
    return {
      reads,
      budgetFor: (key: string) =>
        isRepairedProfileSearchQuery(repaired, key) ? Infinity : undefined,
      settle: (key: string) => {
        if (isRepairedProfileSearchQuery(repaired, key)) return
        repaired = key
        reads.push(key)
      },
    }
  }

  it("lets the current query repair even after an abandoned query settles first", () => {
    const first = repairKeyFor("ali")
    const second = repairKeyFor("alic")
    const runner = repairRunner()

    // Both lookups outran the budget; the abandoned query answers first.
    runner.settle(first)
    runner.settle(second)
    expect(runner.reads).toEqual([first, second])
    expect(runner.budgetFor(second)).toBe(Infinity)
  })

  it("repairs a query once so a repair read cannot loop", () => {
    const key = repairKeyFor("ali")
    const runner = repairRunner()

    runner.settle(key)
    runner.settle(key)
    expect(runner.reads).toEqual([key])
  })

  it("rebuilds the cached result once a settled seller lookup arrives", async () => {
    const hook = await readFile(
      "packages/core/src/hooks/useProfileSearch.ts",
      "utf8"
    )
    expect(hook).toContain("onSellerLookupSettled")
    expect(hook).toContain("repairedQueryRef.current = cachedKeyId")
    expect(hook).toContain("queryClient.refetchQueries({")
  })
})
