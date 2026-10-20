import { spawnSync } from "node:child_process"

import {
  buildPlaywrightSmokeManifest,
  type PlaywrightJsonReport,
  type PlaywrightSmokeEvidenceContext,
  validatePlaywrightSmokeAreas,
  validatePlaywrightSmokeShardPartition,
} from "./validate_playwright_smoke_areas"

const profiles = ["all", "ordinary", "event"] as const
type NativeProfile = (typeof profiles)[number]

export function validateRouterSmokePartition(
  reports: Record<NativeProfile, PlaywrightJsonReport>,
  evidence: PlaywrightSmokeEvidenceContext | null = null
) {
  const manifests = profiles.map((profile) => {
    const report = reports[profile]
    if ((report.errors ?? []).length > 0) {
      throw new Error("Router partition discovery reported errors.")
    }
    validatePlaywrightSmokeAreas(report, ["commerce"])
    if (
      evidence &&
      JSON.stringify(report.config?.metadata?.smokeEvidence) !==
        JSON.stringify(evidence)
    ) {
      throw new Error(
        "Router partition discovery does not bind the expected SHAs."
      )
    }
    return buildPlaywrightSmokeManifest(report, ["commerce"], evidence)
  })
  const [all, ordinary, event] = manifests
  validatePlaywrightSmokeShardPartition(all!, [ordinary!, event!])
  return { all: all!, ordinary: ordinary!, event: event! }
}

export function discoverRouterSmokePartition(
  environment: Record<string, string | undefined> = process.env
) {
  const evidence = {
    baseSha: environment.PLAYWRIGHT_SMOKE_BASE_SHA ?? "",
    sourceHeadSha: environment.PLAYWRIGHT_SMOKE_SOURCE_HEAD_SHA ?? "",
    testedSha: environment.PLAYWRIGHT_SMOKE_TESTED_SHA ?? "",
  }
  const hasEvidence = Object.values(evidence).some(Boolean)
  if (
    (environment.CI || hasEvidence) &&
    !Object.values(evidence).every((value) => /^[0-9a-f]{40}$/.test(value))
  ) {
    throw new Error("Router partition discovery requires valid evidence SHAs.")
  }
  const reports = Object.fromEntries(
    profiles.map((profile) => {
      const result = spawnSync(
        "bunx",
        [
          "playwright",
          "test",
          "--config",
          "playwright.router.config.ts",
          "--list",
          "--reporter=json",
        ],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...environment,
            PLAYWRIGHT_SMOKE_DISCOVERY: "true",
            PLAYWRIGHT_SMOKE_AREA: "commerce",
            PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE: "false",
            PLAYWRIGHT_ROUTER_NATIVE_PROFILE: profile,
          },
        }
      )
      if (result.error || result.status !== 0) {
        throw new Error("Router partition discovery failed.")
      }
      try {
        return [profile, JSON.parse(result.stdout) as PlaywrightJsonReport]
      } catch {
        throw new Error("Router partition discovery returned invalid JSON.")
      }
    })
  ) as Record<NativeProfile, PlaywrightJsonReport>
  return validateRouterSmokePartition(reports, hasEvidence ? evidence : null)
}

if (import.meta.main) {
  const manifests = discoverRouterSmokePartition()
  process.stdout.write(
    `Verified native router partition: all=${manifests.all.selectedTestCount} ordinary=${manifests.ordinary.selectedTestCount} event=${manifests.event.selectedTestCount}.\n`
  )
}
