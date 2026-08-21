import { spawnSync } from "node:child_process"

import { smokeAreaTags, type SmokeArea } from "../../e2e/helpers/smoke-areas"

type PlaywrightJsonSpec = {
  file?: string
  line?: number
  tags?: string[]
  title?: string
}

type PlaywrightJsonSuite = {
  specs?: PlaywrightJsonSpec[]
  suites?: PlaywrightJsonSuite[]
}

export type PlaywrightJsonReport = {
  suites?: PlaywrightJsonSuite[]
}

const smokeAreas = Object.keys(smokeAreaTags) as SmokeArea[]

function collectSpecs(
  suites: readonly PlaywrightJsonSuite[]
): PlaywrightJsonSpec[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...collectSpecs(suite.suites ?? []),
  ])
}

function formatSpec(spec: PlaywrightJsonSpec): string {
  const location = spec.file
    ? `${spec.file}${spec.line ? `:${spec.line}` : ""}`
    : "unknown location"
  return `${location} (${spec.title ?? "untitled test"})`
}

export function validatePlaywrightSmokeAreas(
  report: PlaywrightJsonReport,
  selectedAreas: readonly SmokeArea[] = smokeAreas
): Record<SmokeArea, number> {
  const specs = collectSpecs(report.suites ?? [])
  const counts: Record<SmokeArea, number> = { market: 0, merchant: 0 }
  const orphaned: PlaywrightJsonSpec[] = []

  for (const spec of specs) {
    const tags = new Set(
      (spec.tags ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`))
    )
    const assignedAreas = smokeAreas.filter(
      (area) =>
        tags.has(smokeAreaTags[area]) ||
        new RegExp(`(?:^|\\s)${smokeAreaTags[area]}(?:\\s|$)`).test(
          spec.title ?? ""
        )
    )

    if (assignedAreas.length === 0) {
      orphaned.push(spec)
      continue
    }

    for (const area of assignedAreas) counts[area] += 1
  }

  const errors: string[] = []
  if (specs.length === 0) errors.push("Playwright discovered zero smoke tests.")
  if (orphaned.length > 0) {
    errors.push(
      `Playwright discovered smoke tests without @market or @merchant tags:\n${orphaned
        .map((spec) => `- ${formatSpec(spec)}`)
        .join("\n")}`
    )
  }

  for (const area of selectedAreas) {
    if (counts[area] === 0) {
      errors.push(`The selected ${area} smoke area contains zero tests.`)
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"))
  return counts
}

function readSelectedAreas(): SmokeArea[] {
  const areaIndex = process.argv.indexOf("--area")
  const requestedArea =
    areaIndex >= 0 ? (process.argv[areaIndex + 1] ?? "") : "all"

  if (requestedArea === "all") return smokeAreas
  if (requestedArea === "market" || requestedArea === "merchant") {
    return [requestedArea]
  }
  throw new Error(
    `Unknown Playwright smoke area '${requestedArea}'. Expected all, market, or merchant.`
  )
}

function discoverPlaywrightTests(): PlaywrightJsonReport {
  const result = spawnSync(
    "bunx",
    ["playwright", "test", "--list", "--reporter=json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_AREA: "all",
      },
    }
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Playwright test discovery failed."
    )
  }

  try {
    return JSON.parse(result.stdout) as PlaywrightJsonReport
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Playwright returned invalid JSON: ${message}`, {
      cause: error,
    })
  }
}

if (import.meta.main) {
  const selectedAreas = readSelectedAreas()
  const counts = validatePlaywrightSmokeAreas(
    discoverPlaywrightTests(),
    selectedAreas
  )
  process.stdout.write(
    `Validated Playwright smoke areas: market=${counts.market}, merchant=${counts.merchant}\n`
  )
}
