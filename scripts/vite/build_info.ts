import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

type PackageJson = {
  version?: string
}

function readPackageVersion(appDir: string): string {
  const packageJson = JSON.parse(
    readFileSync(resolve(appDir, "package.json"), "utf8")
  ) as PackageJson
  return packageJson.version?.trim() || "0.0.0"
}

function readGitValue(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function getCommitSha(): string {
  return (
    process.env.VITE_BUILD_COMMIT?.trim() ||
    process.env.CF_PAGES_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    readGitValue(["rev-parse", "HEAD"])
  )
}

function getBranchName(): string {
  return (
    process.env.VITE_BUILD_BRANCH?.trim() ||
    process.env.CF_PAGES_BRANCH?.trim() ||
    process.env.GITHUB_HEAD_REF?.trim() ||
    process.env.GITHUB_REF_NAME?.trim() ||
    readGitValue(["rev-parse", "--abbrev-ref", "HEAD"])
  )
}

function getSourceUrl(): string {
  const githubRepo = process.env.GITHUB_REPOSITORY?.trim()
  const githubServer = process.env.GITHUB_SERVER_URL?.trim()

  return (
    process.env.VITE_SOURCE_URL?.trim() ||
    (githubRepo
      ? `${githubServer || "https://github.com"}/${githubRepo}`
      : "https://github.com/Conduit-BTC/conduit-mono")
  )
}

function getReleaseChannel(branchName: string): string {
  const configuredChannel = process.env.VITE_RELEASE_CHANNEL?.trim()
  if (configuredChannel) {
    return configuredChannel
  }
  if (process.env.CF_PAGES === "1") {
    return branchName === "main" ? "production" : "preview"
  }
  return process.env.NODE_ENV === "production" ? "production" : "local"
}

export function defineConduitBuildEnv(appDir: string) {
  const branchName = getBranchName()
  const buildTime =
    process.env.VITE_BUILD_TIME?.trim() || new Date().toISOString()

  return {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      readPackageVersion(appDir)
    ),
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(getCommitSha()),
    "import.meta.env.VITE_BUILD_BRANCH": JSON.stringify(branchName),
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(buildTime),
    "import.meta.env.VITE_SOURCE_URL": JSON.stringify(getSourceUrl()),
    "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(
      getReleaseChannel(branchName)
    ),
  }
}
