export interface ConduitBuildInfo {
  appVersion: string
  commitSha: string | null
  shortCommitSha: string | null
  branch: string | null
  buildTime: string | null
  sourceUrl: string
  releaseChannel: string
}

function clean(value: string | undefined): string | null {
  const next = value?.trim()
  return next ? next : null
}

export function normalizeRepositoryUrl(sourceUrl: string): string {
  return sourceUrl.replace(/\.git$/, "").replace(/\/$/, "")
}

export function getCommitUrl(
  info: Pick<ConduitBuildInfo, "commitSha" | "sourceUrl">
): string | null {
  if (!info.commitSha) return null
  return `${normalizeRepositoryUrl(info.sourceUrl)}/commit/${info.commitSha}`
}

export const conduitBuildInfo: ConduitBuildInfo = Object.freeze({
  appVersion: clean(import.meta.env.VITE_APP_VERSION) ?? "0.0.0",
  commitSha: clean(import.meta.env.VITE_BUILD_COMMIT),
  shortCommitSha:
    clean(import.meta.env.VITE_BUILD_COMMIT)?.slice(0, 12) ?? null,
  branch: clean(import.meta.env.VITE_BUILD_BRANCH),
  buildTime: clean(import.meta.env.VITE_BUILD_TIME),
  sourceUrl:
    clean(import.meta.env.VITE_SOURCE_URL) ??
    "https://github.com/Conduit-BTC/conduit-mono",
  releaseChannel: clean(import.meta.env.VITE_RELEASE_CHANNEL) ?? "unknown",
})
