import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"

import {
  boundedSmokeOwners,
  expandSmokeMatrix,
  parseChangedPaths,
  selectSmokeMatrix,
  selectSmokeShards,
  smokeNeedsInventory,
  type SmokeInventory,
} from "../scripts/ci/select_smoke_shards"
import {
  readSmokeFiles,
  smokeNeedsBothApps,
} from "../scripts/ci/playwright_smoke_files"
import {
  buildPlaywrightSmokeManifest,
  type PlaywrightJsonReport,
} from "../scripts/ci/validate_playwright_smoke_areas"

const baseline = [
  "e2e/not-found.playwright.ts",
  "e2e/shared-ui-surface-audit.playwright.ts",
]
const inventory: SmokeInventory = {
  tests: [
    ...baseline.flatMap((file) =>
      ["@market", "@merchant"].map((tag) => ({ file, tags: [tag] }))
    ),
    { file: "e2e/avatar-fallback.playwright.ts", tags: ["@market"] },
    { file: "e2e/merchant-shipping-tables.playwright.ts", tags: ["@merchant"] },
    { file: "e2e/about-page.playwright.ts", tags: ["@market"] },
    { file: "e2e/about-page.playwright.ts", tags: ["@merchant"] },
    {
      file: "e2e/event-market.playwright.ts",
      tags: ["@market", "@merchant", "@commerce"],
    },
  ],
}
const full = expandSmokeMatrix(["market", "merchant", "commerce"])

describe("bounded smoke ownership", () => {
  it("keeps docs and ordinary unit-only changes at the existing no-op floor", () => {
    expect(
      selectSmokeMatrix(["README.md", "tests/cart-model.test.ts"], inventory)
    ).toEqual(expandSmokeMatrix([]))
  })

  it("selects one unsharded app baseline and regression file for bounded source changes", () => {
    expect(
      selectSmokeMatrix(["apps/market/src/routes/about.tsx"], inventory)
    ).toEqual([
      {
        id: "market",
        area: "market",
        shard: "",
        files: ["e2e/about-page.playwright.ts", ...baseline],
      },
    ])
    expect(
      selectSmokeMatrix(
        ["scripts/vite/repository_contributors.generated.json"],
        inventory
      ).map((job) => job.area)
    ).toEqual(["market", "merchant"])
  })

  it("keeps test edits full even when current tags name only one owning area", () => {
    const selected = selectSmokeMatrix(
      ["e2e/avatar-fallback.playwright.ts"],
      inventory
    )
    expect(selected).toEqual(full)
    expect(
      selectSmokeMatrix(
        ["e2e/merchant-shipping-tables.playwright.ts"],
        inventory
      )
    ).toEqual(full)
  })

  it("does not lose former owning areas when a test is retagged or deleted", () => {
    for (const tests of [
      [{ file: "e2e/avatar-fallback.playwright.ts", tags: ["@merchant"] }],
      [],
    ]) {
      expect(
        selectSmokeMatrix(["e2e/avatar-fallback.playwright.ts"], { tests })
      ).toEqual(full)
    }
  })

  it("keeps mixed files conservative and commerce complete", () => {
    const selected = selectSmokeMatrix(
      ["e2e/event-market.playwright.ts"],
      inventory
    )
    expect(selected).toEqual(full)
  })

  it.each([
    "e2e/new.playwright.ts",
    "e2e/helpers/auth.ts",
    "tests/helpers/new.ts",
    "scripts/ci/new-selector-helper.ts",
    ".github/workflows/new-check.yml",
    "tests/support/new.ts",
    "scripts/ci/playwright_smoke_files.ts",
    "tests/smoke-selection.test.ts",
    "packages/core/src/protocol/products.ts",
    "packages/ui/src/theme/theme.ts",
    "playwright.config.ts",
    "bun.lock",
    "unknown.ts",
  ])("keeps %s on full coverage", (path) => {
    expect(selectSmokeMatrix([path], inventory)).toEqual(full)
  })

  it("broad and critical runtime changes override bounded groups in the affected areas", () => {
    const selected = selectSmokeMatrix(
      [
        "apps/market/src/routes/about.tsx",
        "apps/market/src/routes/checkout.tsx",
      ],
      inventory
    )
    expect(selected).toEqual(expandSmokeMatrix(["market", "commerce"]))
    expect(
      selectSmokeMatrix(["apps/merchant/src/routes/__root.tsx"], inventory)
    ).toEqual(expandSmokeMatrix(["merchant"]))
  })

  it("unions independent changes and keeps renames and deletions conservative", () => {
    const paths = parseChangedPaths(
      "R100\0e2e/avatar-fallback.playwright.ts\0e2e/new.playwright.ts\0D\0e2e/removed.playwright.ts\0"
    )
    expect(selectSmokeMatrix(paths, inventory)).toEqual(full)
    expect(
      selectSmokeMatrix(
        [
          "apps/market/src/routes/about.tsx",
          "apps/market/src/routes/terms-of-service.tsx",
        ],
        inventory
      )[0]!.files
    ).toEqual([
      "e2e/about-page.playwright.ts",
      "e2e/not-found.playwright.ts",
      "e2e/product-legal.playwright.ts",
      "e2e/shared-ui-surface-audit.playwright.ts",
    ])
  })

  it("falls back to full partitions when a bounded source group grows", () => {
    const large = {
      tests: Array.from({ length: 151 }, () => ({
        file: "e2e/about-page.playwright.ts",
        tags: ["@market"],
      })),
    }
    expect(
      selectSmokeMatrix(["apps/market/src/routes/about.tsx"], large)
    ).toEqual(expandSmokeMatrix(["market"]))
  })

  it("never collapses test edits into a serial runner, including mixed source edits", () => {
    expect(
      selectSmokeMatrix(
        [
          "apps/market/src/routes/about.tsx",
          "e2e/avatar-fallback.playwright.ts",
        ],
        inventory
      )
    ).toEqual(full)
  })

  it.each([
    [["README.md"], false],
    [["apps/market/src/routes/__root.tsx"], false],
    [["playwright.config.ts"], false],
    [["apps/market/src/routes/about.tsx"], true],
    [["e2e/avatar-fallback.playwright.ts"], false],
    [["e2e/new.playwright.ts"], false],
    [
      [
        "apps/market/src/routes/about.tsx",
        "apps/market/src/routes/checkout.tsx",
      ],
      false,
    ],
    [
      ["e2e/avatar-fallback.playwright.ts", "packages/core/src/index.ts"],
      false,
    ],
    [
      [
        "packages/ui/src/components/AboutPagePanel.tsx",
        "apps/market/src/routes/__root.tsx",
      ],
      true,
    ],
  ] as const)(
    "discovers ownership only when it can narrow %j",
    (paths, expected) => {
      expect(smokeNeedsInventory(paths)).toBe(expected)
      if (!expected) {
        expect(selectSmokeMatrix(paths, inventory)).toEqual(
          expandSmokeMatrix(selectSmokeShards(paths))
        )
      }
    }
  )

  it("rejects malformed, duplicated and path-like selections instead of hiding work", () => {
    for (const value of [
      "null",
      "{}",
      "[1]",
      '["../foo"]',
      '["e2e/*.playwright.ts"]',
      '["e2e/x.playwright.ts","e2e/x.playwright.ts"]',
      "not-json",
    ]) {
      expect(() => readSmokeFiles(value)).toThrow(
        "Invalid Playwright smoke file selection"
      )
    }
    expect(readSmokeFiles("[]")).toBeUndefined()
    expect(readSmokeFiles(undefined)).toBeUndefined()
  })

  it("retains both services for cross-app and unqualified test files", () => {
    expect(smokeNeedsBothApps(undefined)).toBe(true)
    expect(
      smokeNeedsBothApps(["e2e/wallet-cross-app.playwright.ts", ...baseline])
    ).toBe(true)
    expect(
      smokeNeedsBothApps(["e2e/about-page.playwright.ts", ...baseline])
    ).toBe(false)
  })
})

it("composes every bounded source owner with the actual full browser inventory", () => {
  function discover(area: string, files?: string[]): PlaywrightJsonReport {
    const result = spawnSync(
      "bunx",
      ["playwright", "test", "--list", "--reporter=json"],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_ENV: "development",
          PLAYWRIGHT_SMOKE_DISCOVERY: "true",
          PLAYWRIGHT_SMOKE_AREA: area,
          PLAYWRIGHT_SMOKE_FILES: JSON.stringify(files ?? []),
        },
      }
    )
    if (result.error || result.status !== 0)
      throw new Error("Composed smoke discovery failed")
    return JSON.parse(result.stdout) as PlaywrightJsonReport
  }
  const fullReport = discover("all")
  const manifest = buildPlaywrightSmokeManifest(fullReport, [
    "market",
    "merchant",
    "commerce",
  ])
  for (const owner of boundedSmokeOwners) {
    const selected = selectSmokeMatrix([owner.paths[0]], manifest)
    for (const job of selected) {
      if (job.area === "none")
        throw new Error("Bounded owner unexpectedly selected nothing")
      const expected = buildPlaywrightSmokeManifest(fullReport, [
        job.area,
      ]).tests.filter((test) => job.files!.includes(test.file))
      expect(new Set(expected.map((test) => test.file)).size).toBe(
        job.files!.length
      )
      const actual = buildPlaywrightSmokeManifest(
        discover(job.area, job.files),
        [job.area]
      )
      // Project, opaque case ID, tags, source and line all have to agree. This
      // catches project-level testMatch overrides accidentally widening scope.
      expect(actual.tests).toEqual(expected)
    }
  }
}, 60_000)
