import {
  conduitBuildInfo,
  getCommitUrl,
  normalizeRepositoryUrl,
  type ConduitBuildInfo,
} from "./build-info"

export type BugReportAppId = "market" | "merchant" | "store-builder"

export interface BugReportUrlInput {
  app: BugReportAppId
  route?: string | null
  buildInfo?: ConduitBuildInfo
}

const appLabels: Record<BugReportAppId, string> = {
  market: "Conduit Market",
  merchant: "Conduit Merchant Portal",
  "store-builder": "Conduit Store Builder",
}

export function getBugReportAppLabel(app: BugReportAppId): string {
  return appLabels[app]
}

export function buildBugReportUrl({
  app,
  route,
  buildInfo = conduitBuildInfo,
}: BugReportUrlInput): string {
  const sourceUrl = normalizeRepositoryUrl(buildInfo.sourceUrl)
  const url = new URL(`${sourceUrl}/issues/new`)
  const commitUrl = getCommitUrl(buildInfo)

  url.searchParams.set("template", "bug_report.yml")
  url.searchParams.set("title", `[Bug]: ${appLabels[app]}`)
  url.searchParams.set("app", appLabels[app])
  url.searchParams.set("route", route || "Not provided")
  url.searchParams.set("version", buildInfo.appVersion)
  url.searchParams.set(
    "build",
    [
      buildInfo.shortCommitSha ? `commit ${buildInfo.shortCommitSha}` : null,
      buildInfo.branch ? `branch ${buildInfo.branch}` : null,
      buildInfo.releaseChannel ? `channel ${buildInfo.releaseChannel}` : null,
      commitUrl,
    ]
      .filter(Boolean)
      .join(" / ") || "Unknown"
  )

  return url.toString()
}
