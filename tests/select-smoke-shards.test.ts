import { describe, expect, it } from "bun:test"

import {
  parseChangedPaths,
  selectSmokeShards,
} from "../scripts/ci/select_smoke_shards"

describe("path-aware smoke shard selection", () => {
  it("selects only the changed app for app-local runtime changes", () => {
    expect(selectSmokeShards(["apps/market/src/routes/checkout.tsx"])).toEqual([
      "market",
    ])
    expect(
      selectSmokeShards(["apps/merchant/src/routes/products.tsx"])
    ).toEqual(["merchant"])
  })

  it("selects both apps for shared runtime and test-infrastructure changes", () => {
    for (const path of [
      "packages/core/src/protocol/products.ts",
      "packages/ui/src/components/button.tsx",
      "e2e/helpers/auth.ts",
      "playwright.config.ts",
      ".github/workflows/ci.yml",
      "bun.lock",
      "scripts/vite/build_info.ts",
    ]) {
      expect(selectSmokeShards([path])).toEqual(["market", "merchant"])
    }
  })

  it("combines app-local changes in stable shard order", () => {
    expect(
      selectSmokeShards([
        "apps/merchant/src/routes/products.tsx",
        "apps/market/src/routes/checkout.tsx",
      ])
    ).toEqual(["market", "merchant"])
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
