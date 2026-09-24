import { spawnSync } from "node:child_process"

import type { SmokeArea } from "../../e2e/helpers/smoke-areas"

export type PlaywrightE2eMode = "full" | "mobile" | "webkit"

const mobileFiles = [
  "e2e/mobile-safari-baseline.playwright.ts",
  "e2e/event-sign-preview-mobile.playwright.ts",
]
const allAreas: SmokeArea[] = ["market", "merchant", "commerce"]

export function planPlaywrightE2eRuns(
  mode: PlaywrightE2eMode,
  requestedArea?: string
): { areas: SmokeArea[]; args: string[]; discoveryArea: SmokeArea | "all" } {
  const profile =
    mode === "full"
      ? { areas: allAreas, args: [] }
      : {
          areas: allAreas.slice(0, 2),
          args: [
            ...mobileFiles,
            "--project=mobile-webkit",
            ...(mode === "mobile" ? ["--project=mobile-chromium"] : []),
          ],
        }

  if (!requestedArea || requestedArea === "all") {
    return { ...profile, discoveryArea: "all" }
  }
  if (!profile.areas.includes(requestedArea as SmokeArea)) {
    throw new Error(
      `Playwright area ${requestedArea} has no tests in the ${mode} profile.`
    )
  }
  return {
    areas: [requestedArea as SmokeArea],
    args: profile.args,
    discoveryArea: requestedArea as SmokeArea,
  }
}

type ListedSuite = {
  specs?: Array<{
    id?: string
    tests?: Array<{ projectName?: string }>
  }>
  suites?: ListedSuite[]
}

export function listedTestIds(report: { suites?: ListedSuite[] }): Set<string> {
  const ids = new Set<string>()
  function visit(suite: ListedSuite): void {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (!spec.id || !test.projectName) {
          throw new Error("Playwright discovery has a missing test identity.")
        }
        const id = JSON.stringify([spec.id, test.projectName])
        if (ids.has(id)) {
          throw new Error("Playwright discovery has a repeated test identity.")
        }
        ids.add(id)
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  return ids
}

export function assertPlaywrightAreaCoverage(
  full: ReadonlySet<string>,
  areas: readonly ReadonlySet<string>[]
): void {
  const covered = new Set<string>()
  for (const area of areas) {
    for (const id of area) {
      if (!full.has(id)) {
        throw new Error(
          "An area selected a test outside the full E2E selection."
        )
      }
      covered.add(id)
    }
  }
  if (full.size === 0 || covered.size !== full.size) {
    throw new Error("Area E2E runs omit tests from the full selection.")
  }
}

function discover(area: SmokeArea | "all", args: string[]): Set<string> {
  const result = spawnSync(
    "bunx",
    [
      "playwright",
      "test",
      ...args,
      "--list",
      "--reporter=json",
      "--pass-with-no-tests",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_AREA: area,
        PLAYWRIGHT_SMOKE_DISCOVERY: "true",
      },
      maxBuffer: 16 * 1024 * 1024,
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Playwright ${area} discovery failed: ${result.stderr.trim()}`
    )
  }
  return listedTestIds(JSON.parse(result.stdout) as { suites?: ListedSuite[] })
}

function run(mode: PlaywrightE2eMode, forwardedArgs: string[]): number {
  const plan = planPlaywrightE2eRuns(mode, process.env.PLAYWRIGHT_SMOKE_AREA)
  const args = [...plan.args, ...forwardedArgs]
  const full = discover(plan.discoveryArea, args)
  const selections = plan.areas.map((area) => ({
    area,
    ids: discover(area, args),
  }))
  assertPlaywrightAreaCoverage(
    full,
    selections.map((selection) => selection.ids)
  )

  process.stdout.write(
    `Playwright E2E selection: ${full.size} unique tests across ${selections
      .map(({ area, ids }) => `${area}=${ids.size}`)
      .join(", ")}.\n`
  )
  let failed = false
  for (const { area, ids } of selections) {
    if (ids.size === 0) continue
    process.stdout.write(`Running ${area} Playwright tests.\n`)
    const result = spawnSync("bunx", ["playwright", "test", ...args], {
      env: {
        ...process.env,
        PLAYWRIGHT_SMOKE_AREA: area,
        PLAYWRIGHT_SMOKE_DISCOVERY: "false",
      },
      stdio: "inherit",
    })
    if (result.error) throw result.error
    if (result.status !== 0) failed = true
  }
  return failed ? 1 : 0
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "full" && mode !== "mobile" && mode !== "webkit") {
    throw new Error("Expected E2E profile: full, mobile, or webkit.")
  }
  process.exitCode = run(mode, process.argv.slice(3))
}
