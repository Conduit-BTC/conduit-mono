import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"

import {
  expandSmokeMatrix,
  parseChangedPaths,
  selectSmokeShards,
} from "../scripts/ci/select_smoke_shards"
import {
  buildPlaywrightSmokeDiscoveryArgs,
  buildPlaywrightSmokeManifest,
  type PlaywrightJsonReport,
  validatePlaywrightSmokeAreas,
  validatePlaywrightSmokeShardPartition,
} from "../scripts/ci/validate_playwright_smoke_areas"

describe("path-aware smoke shard selection", () => {
  it("splits Market and Merchant into required jobs without changing area selection", () => {
    expect(expandSmokeMatrix(["market", "merchant", "commerce"])).toEqual([
      { id: "market-1", area: "market", shard: "1/5" },
      { id: "market-2", area: "market", shard: "2/5" },
      { id: "market-3", area: "market", shard: "3/5" },
      { id: "market-4", area: "market", shard: "4/5" },
      { id: "market-5", area: "market", shard: "5/5" },
      { id: "merchant-1", area: "merchant", shard: "1/4" },
      { id: "merchant-2", area: "merchant", shard: "2/4" },
      { id: "merchant-3", area: "merchant", shard: "3/4" },
      { id: "merchant-4", area: "merchant", shard: "4/4" },
      { id: "commerce", area: "commerce", shard: "" },
    ])
    expect(expandSmokeMatrix([])).toEqual([
      { id: "none", area: "none", shard: "" },
    ])
    expect(expandSmokeMatrix(["merchant"])).toEqual([
      { id: "merchant-1", area: "merchant", shard: "1/4" },
      { id: "merchant-2", area: "merchant", shard: "2/4" },
      { id: "merchant-3", area: "merchant", shard: "3/4" },
      { id: "merchant-4", area: "merchant", shard: "4/4" },
    ])
  })
  it("selects only the changed app for app-local runtime changes", () => {
    expect(selectSmokeShards(["apps/market/src/routes/profile.tsx"])).toEqual([
      "market",
    ])
    expect(selectSmokeShards(["apps/merchant/src/routes/profile.tsx"])).toEqual(
      ["merchant"]
    )
  })

  it("adds commerce for app-local paths that affect the cross-app flow", () => {
    expect(selectSmokeShards(["apps/market/src/routes/checkout.tsx"])).toEqual([
      "market",
      "commerce",
    ])
    expect(
      selectSmokeShards(["apps/merchant/src/routes/products.tsx"])
    ).toEqual(["merchant", "commerce"])
    expect(
      selectSmokeShards(["apps/merchant/src/lib/merchant-invoice.ts"])
    ).toEqual(["merchant", "commerce"])
    expect(
      selectSmokeShards(["apps/market/src/routes/store/$pubkey.tsx"])
    ).toEqual(["market", "commerce"])
  })

  it("adds commerce for app Network routes that own private inbox setup", () => {
    expect(selectSmokeShards(["apps/market/src/routes/network.tsx"])).toEqual([
      "market",
      "commerce",
    ])
    expect(selectSmokeShards(["apps/merchant/src/routes/network.tsx"])).toEqual(
      ["merchant", "commerce"]
    )
  })

  it("selects every shard for shared runtime and test infrastructure", () => {
    for (const path of [
      "packages/core/src/protocol/products.ts",
      "packages/ui/src/components/button.tsx",
      "e2e/helpers/auth.ts",
      "playwright.config.ts",
      ".github/workflows/ci.yml",
      "bun.lock",
      "scripts/ci/playwright_smoke_reporter.ts",
      "scripts/ci/select_smoke_shards.ts",
      "scripts/ci/validate_playwright_smoke_areas.ts",
      "scripts/dev/run_playwright_web_server.ts",
      "scripts/dev/run_playwright_e2e.ts",
      "tests/run-playwright-e2e.test.ts",
      "scripts/vite/build_info.ts",
      "tests/playwright-smoke-areas.test.ts",
      "tests/pr-evidence-contract.test.ts",
      "tests/select-smoke-shards.test.ts",
    ]) {
      expect(selectSmokeShards([path])).toEqual([
        "market",
        "merchant",
        "commerce",
      ])
    }
  })

  it("runs every shard that imports the deterministic wallet fixture", () => {
    expect(selectSmokeShards(["tests/support/bolt11-fixture.ts"])).toEqual([
      "market",
      "merchant",
      "commerce",
    ])
  })

  it("combines critical app-local changes in stable shard order", () => {
    expect(
      selectSmokeShards([
        "apps/merchant/src/routes/products.tsx",
        "apps/market/src/routes/checkout.tsx",
      ])
    ).toEqual(["market", "merchant", "commerce"])
  })

  it("does not install browsers for public context or unit-test-only changes", () => {
    expect(
      selectSmokeShards([
        "AGENTS.md",
        "docs/knowledge/testing.md",
        ".github/pull_request_template.md",
        "tests/cart-model.test.ts",
      ])
    ).toEqual([])
  })

  it("keeps unknown runtime changes conservative", () => {
    expect(selectSmokeShards(["vite.config.ts"])).toEqual([
      "market",
      "merchant",
      "commerce",
    ])
  })

  it("keeps deleted and renamed paths in the affected shard input", () => {
    const paths = parseChangedPaths(
      "D\0apps/market/src/removed.ts\0R100\0apps/merchant/src/old.ts\0docs/new.md\0"
    )

    expect(paths).toEqual([
      "apps/market/src/removed.ts",
      "apps/merchant/src/old.ts",
      "docs/new.md",
    ])
    expect(selectSmokeShards(paths)).toEqual(["market", "merchant"])
  })
})

for (const [area, partCount] of [
  ["market", 5],
  ["merchant", 4],
] as const)
  it(`partitions actual ${area} discovery into ${partCount} nonempty project-aware jobs`, () => {
    const jobs = expandSmokeMatrix([area])
    expect(jobs).toHaveLength(partCount)
    const evidence = {
      baseSha: "b".repeat(40),
      sourceHeadSha: "a".repeat(40),
      testedSha: "c".repeat(40),
    }
    function discover(shard?: string) {
      const result = spawnSync(
        "bunx",
        buildPlaywrightSmokeDiscoveryArgs(shard),
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            CI: "true",
            NODE_ENV: "development",
            PLAYWRIGHT_SMOKE_DISCOVERY: "true",
            PLAYWRIGHT_SMOKE_AREA: area,
            PLAYWRIGHT_SMOKE_FILES: "[]",
            PLAYWRIGHT_SMOKE_BASE_SHA: evidence.baseSha,
            PLAYWRIGHT_SMOKE_SOURCE_HEAD_SHA: evidence.sourceHeadSha,
            PLAYWRIGHT_SMOKE_TESTED_SHA: evidence.testedSha,
          },
        }
      )
      if (result.error || result.status !== 0)
        throw new Error(`${area} partition discovery failed.`)
      let report: PlaywrightJsonReport
      try {
        report = JSON.parse(result.stdout) as PlaywrightJsonReport
      } catch {
        throw new Error(`${area} partition discovery returned invalid JSON.`)
      }
      expect((report.errors ?? []).length).toBe(0)
      expect(report.config?.metadata?.smokeEvidence).toEqual(evidence)
      validatePlaywrightSmokeAreas(report, [area])
      return buildPlaywrightSmokeManifest(report, [area], evidence)
    }
    const full = discover()
    expect([...new Set(full.tests.map((test) => test.project))].sort()).toEqual(
      ["chromium", "mobile-chromium", "mobile-webkit"]
    )
    const parts = jobs.map((job) => discover(job.shard))
    for (const part of parts) {
      expect(part.selectedTestCount).toBeGreaterThan(0)
      expect(part.evidence).toEqual(evidence)
    }
    validatePlaywrightSmokeShardPartition(full, parts)
    expect(
      parts.reduce((count, part) => count + part.selectedTestCount, 0)
    ).toBe(full.selectedTestCount)
  }, 60_000)
