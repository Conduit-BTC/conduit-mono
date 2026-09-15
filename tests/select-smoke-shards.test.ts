import { describe, expect, it } from "bun:test"

import {
  parseChangedPaths,
  selectSmokeShards,
} from "../scripts/ci/select_smoke_shards"

describe("path-aware smoke shard selection", () => {
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
      "scripts/vite/build_info.ts",
      "tests/agent-review-handoff.test.ts",
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

  it("runs deterministic wallet fixtures in the commerce shard", () => {
    expect(selectSmokeShards(["tests/support/bolt11-fixture.ts"])).toEqual([
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
