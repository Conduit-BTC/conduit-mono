import { spawnSync } from "node:child_process"

export type SmokeShard = "market" | "merchant" | "commerce"

const shardOrder: SmokeShard[] = ["market", "merchant", "commerce"]

const allShardSmokeInfrastructure = new Set([
  "scripts/ci/select_smoke_shards.ts",
  "scripts/ci/playwright_smoke_reporter.ts",
  "scripts/ci/validate_playwright_smoke_areas.ts",
  "scripts/dev/run_playwright_web_server.ts",
  "tests/agent-review-handoff.test.ts",
  "tests/playwright-smoke-areas.test.ts",
  "tests/pr-evidence-contract.test.ts",
  "tests/select-smoke-shards.test.ts",
])

const commerceOnlySmokeInfrastructure = new Set([
  "tests/support/bolt11-fixture.ts",
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
  return commerceCriticalPathTokens.some((token) => normalized.includes(token))
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
    path.startsWith("tests/") ||
    path.startsWith("scripts/ci/") ||
    path.startsWith("scripts/figma/")
  )
}

export function selectSmokeShards(paths: readonly string[]): SmokeShard[] {
  const selected = new Set<SmokeShard>()

  for (const rawPath of paths) {
    const path = rawPath.trim().replaceAll("\\", "/")
    if (!path) continue

    if (
      path === ".github/workflows/ci.yml" ||
      path === "playwright.config.ts" ||
      path === "package.json" ||
      path === "bun.lock" ||
      path === "tsconfig.json" ||
      allShardSmokeInfrastructure.has(path) ||
      path.startsWith("e2e/") ||
      path.startsWith("packages/core/") ||
      path.startsWith("packages/ui/")
    ) {
      selectAllShards(selected)
      continue
    }

    if (commerceOnlySmokeInfrastructure.has(path)) {
      selected.add("commerce")
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
      "--diff-filter=ACMRD",
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
  const base = readArgument("--base")
  const head = readArgument("--head") ?? "HEAD"
  if (!base) {
    throw new Error("Usage: select_smoke_shards.ts --base <sha> [--head <sha>]")
  }

  const shards = selectSmokeShards(collectChangedPaths(base, head))
  process.stdout.write(JSON.stringify(shards.length > 0 ? shards : ["none"]))
}
