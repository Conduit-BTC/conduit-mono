import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

export type SmokeShard = "market" | "merchant" | "commerce"
export type SmokeMatrixJob = {
  id: string
  area: SmokeShard | "none"
  shard: string
  files?: string[]
}

const shardOrder: SmokeShard[] = ["market", "merchant", "commerce"]

const allShardSmokeInfrastructure = new Set([
  "scripts/ci/select_smoke_shards.ts",
  "scripts/ci/playwright_smoke_files.ts",
  "tests/smoke-selection.test.ts",
  "scripts/ci/playwright_smoke_reporter.ts",
  "scripts/ci/validate_playwright_smoke_areas.ts",
  "scripts/dev/run_playwright_web_server.ts",
  "scripts/dev/run_playwright_e2e.ts",
  "tests/playwright-smoke-areas.test.ts",
  "tests/run-playwright-e2e.test.ts",
  "tests/pr-evidence-contract.test.ts",
  "tests/select-smoke-shards.test.ts",
  "tests/support/bolt11-fixture.ts",
])

const commerceCriticalAppPaths = new Set([
  "apps/market/src/routes/network.tsx",
  "apps/merchant/src/routes/network.tsx",
])

const commerceCriticalPathTokens = [
  "auth",
  "cart",
  "checkout",
  "commerce",
  "db",
  "delivery",
  "event",
  "handoff",
  "inbox",
  "invoice",
  "message",
  "nostr",
  "nwc",
  "order",
  "outbox",
  "payment",
  "pickup",
  "product",
  "proof",
  "receipt",
  "relay",
  "signer",
  "status",
  "store",
  "wallet",
] as const

function isCommerceCriticalAppPath(path: string): boolean {
  const normalized = path.toLowerCase()
  return (
    commerceCriticalAppPaths.has(normalized) ||
    commerceCriticalPathTokens.some((token) => normalized.includes(token))
  )
}

function selectAllShards(selected: Set<SmokeShard>): void {
  for (const shard of shardOrder) selected.add(shard)
}

function isPublicContextOnly(path: string): boolean {
  return (
    path === "AGENTS.md" ||
    path === "CONTRIBUTING.md" ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path.startsWith(".github/") ||
    /^tests\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    path.startsWith("scripts/figma/")
  )
}

export function selectSmokeShards(paths: readonly string[]): SmokeShard[] {
  const selected = new Set<SmokeShard>()

  for (const rawPath of paths) {
    const path = rawPath.trim().replaceAll("\\", "/")
    if (!path) continue

    if (
      path.startsWith(".github/workflows/") ||
      path.startsWith("scripts/ci/") ||
      path === "playwright.config.ts" ||
      path === "package.json" ||
      path === "bun.lock" ||
      path === "tsconfig.json" ||
      allShardSmokeInfrastructure.has(path) ||
      path.startsWith("e2e/") ||
      path.startsWith("tests/helpers/") ||
      path.startsWith("tests/support/") ||
      path.startsWith("packages/core/") ||
      path.startsWith("packages/ui/")
    ) {
      selectAllShards(selected)
      continue
    }

    if (
      path.startsWith("apps/market/") ||
      path.startsWith("apps/anon-zap-signer/") ||
      path.startsWith("functions/")
    ) {
      selected.add("market")
      if (isCommerceCriticalAppPath(path)) selected.add("commerce")
      continue
    }

    if (path.startsWith("apps/merchant/")) {
      selected.add("merchant")
      if (isCommerceCriticalAppPath(path)) selected.add("commerce")
      continue
    }

    if (path.startsWith("apps/store-builder/") || isPublicContextOnly(path)) {
      continue
    }

    // Unknown runtime or root configuration changes run every critical shard.
    selectAllShards(selected)
  }

  return shardOrder.filter((shard) => selected.has(shard))
}

// Exact ownership exceptions only. New helpers, shells and runtime paths keep
// the existing broad floor until their callers and regression coverage are known.
export const boundedSmokeOwners = [
  {
    paths: ["apps/market/src/routes/about.tsx"],
    areas: ["market"],
    files: ["e2e/about-page.playwright.ts"],
  },
  {
    paths: ["apps/merchant/src/routes/about.tsx"],
    areas: ["merchant"],
    files: ["e2e/about-page.playwright.ts"],
  },
  {
    paths: [
      "scripts/vite/repository_contributors.generated.json",
      "packages/ui/src/components/AboutPagePanel.tsx",
    ],
    areas: ["market", "merchant"],
    files: ["e2e/about-page.playwright.ts"],
  },
  {
    paths: [
      "apps/market/src/routes/privacy-policy.tsx",
      "apps/market/src/routes/terms-of-service.tsx",
    ],
    areas: ["market"],
    files: ["e2e/product-legal.playwright.ts"],
  },
  {
    paths: [
      "apps/merchant/src/routes/privacy-policy.tsx",
      "apps/merchant/src/routes/terms-of-service.tsx",
    ],
    areas: ["merchant"],
    files: ["e2e/product-legal.playwright.ts"],
  },
] as const

export type SmokeInventory = {
  tests: Array<{ file: string; tags: string[] }>
}

const baselineFiles = [
  "e2e/not-found.playwright.ts",
  "e2e/shared-ui-surface-audit.playwright.ts",
]

export function selectSmokeMatrix(
  paths: readonly string[],
  inventory: SmokeInventory
): SmokeMatrixJob[] {
  const full = new Set<SmokeShard>()
  const files = new Map<SmokeShard, Set<string>>()
  function addFiles(areas: readonly SmokeShard[], selected: readonly string[]) {
    for (const area of areas) {
      const owned = files.get(area) ?? new Set(baselineFiles)
      for (const file of selected) owned.add(file)
      files.set(area, owned)
    }
  }
  for (const rawPath of paths) {
    const path = rawPath.trim().replaceAll("\\", "/")
    if (!path) continue
    const owner = boundedSmokeOwners.find((entry) =>
      (entry.paths as readonly string[]).includes(path)
    )
    if (owner) {
      addFiles(owner.areas, owner.files)
      continue
    }
    // The full discovered manifest is the owner for test-only changes. Helpers,
    // new/deleted files and any missing ownership fall back to full coverage.
    if (/^e2e\/[\w-]+\.playwright\.ts$/.test(path)) {
      const tests = inventory.tests.filter((test) => test.file === path)
      const areas = shardOrder.filter((area) =>
        tests.some((test) => test.tags.includes(`@${area}`))
      )
      if (tests.length && areas.length) {
        // Commerce profiles remain complete, including the isolated router.
        if (areas.includes("commerce")) full.add("commerce")
        addFiles(
          areas.filter((area) => area !== "commerce"),
          [path]
        )
        continue
      }
    }
    for (const area of selectSmokeShards([path])) full.add(area)
  }
  const result = shardOrder.flatMap<SmokeMatrixJob>((area) => {
    const selected = files.get(area)
    // A large test-only edit must not turn a previously partitioned area into
    // one slower runner. Small scopes fit the measured route-audit envelope.
    const selectedCount = selected
      ? inventory.tests.filter(
          (test) => selected.has(test.file) && test.tags.includes(`@${area}`)
        ).length
      : 0
    if (full.has(area) || selectedCount > 150) return expandSmokeMatrix([area])
    return selected
      ? [{ id: area, area, shard: "", files: [...selected].sort() }]
      : []
  })
  return result.length ? result : expandSmokeMatrix([])
}

export function expandSmokeMatrix(
  shards: readonly SmokeShard[]
): SmokeMatrixJob[] {
  if (shards.length === 0) return [{ id: "none", area: "none", shard: "" }]
  return shards.flatMap<SmokeMatrixJob>((area) =>
    area === "market"
      ? [
          { id: "market-1", area, shard: "1/3" },
          { id: "market-2", area, shard: "2/3" },
          { id: "market-3", area, shard: "3/3" },
        ]
      : area === "merchant"
        ? [
            { id: "merchant-1", area, shard: "1/2" },
            { id: "merchant-2", area, shard: "2/2" },
          ]
        : [{ id: area, area, shard: "" }]
  )
}

function readArgument(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

export function parseChangedPaths(output: string): string[] {
  const fields = output.split("\0")
  const paths: string[] = []

  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) continue

    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = fields[index++]
      if (!path) {
        throw new Error(`Missing path for git diff status ${status}.`)
      }
      paths.push(path)
    }
  }

  return paths
}

function collectChangedPaths(base: string, head: string): string[] {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--diff-filter=ACMRDT",
      base,
      head,
    ],
    { encoding: "utf8" }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Unable to read changed paths.")
  }
  return parseChangedPaths(result.stdout)
}

if (import.meta.main) {
  const all = process.argv.includes("--all")
  const base = readArgument("--base")
  const head = readArgument("--head") ?? "HEAD"
  if (!all && !base) {
    throw new Error(
      "Usage: select_smoke_shards.ts --all | --base <sha> [--head <sha>]"
    )
  }

  const inventoryPath = readArgument("--inventory")
  const paths = all ? [] : collectChangedPaths(base!, head)
  const matrix = all
    ? expandSmokeMatrix(shardOrder)
    : inventoryPath
      ? selectSmokeMatrix(
          paths,
          JSON.parse(readFileSync(inventoryPath, "utf8"))
        )
      : expandSmokeMatrix(selectSmokeShards(paths))
  process.stdout.write(JSON.stringify(matrix))
}
