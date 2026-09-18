import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Plugin } from "vite"
import {
  createPublicDeploymentManifest,
  resolveDeploymentProfile,
} from "./deployment_profile.ts"

type PackageJson = {
  name?: string
  version?: string
}

function readPackageJson(appDir: string): PackageJson {
  return JSON.parse(
    readFileSync(resolve(appDir, "package.json"), "utf8")
  ) as PackageJson
}

function readPackageVersion(appDir: string): string {
  const packageJson = readPackageJson(appDir)
  return packageJson.version?.trim() || "0.0.0"
}

function readAppId(appDir: string): string {
  return readPackageJson(appDir).name?.replace(/^@conduit\//, "") || "unknown"
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

export function createConduitBuildContract(appDir: string): {
  define: Record<string, string>
  deploymentManifestPlugin: Plugin
} {
  const branchName = getBranchName()
  const buildTime =
    process.env.VITE_BUILD_TIME?.trim() || new Date().toISOString()
  const commitSha = getCommitSha()
  const sourceUrl = getSourceUrl()
  const profile = resolveDeploymentProfile()
  const app = readAppId(appDir)
  const deploymentManifest = createPublicDeploymentManifest({
    app,
    profile,
    commitSha,
    branch: branchName,
    buildTime,
    sourceUrl,
  })

  const define = {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      readPackageVersion(appDir)
    ),
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(commitSha),
    "import.meta.env.VITE_BUILD_BRANCH": JSON.stringify(branchName),
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(buildTime),
    "import.meta.env.VITE_SOURCE_URL": JSON.stringify(sourceUrl),
    "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(
      profile.releaseChannel
    ),
    "import.meta.env.VITE_DEPLOYMENT_PROFILE": JSON.stringify(profile.name),
    "import.meta.env.VITE_PUBLIC_CONFIG_DIGEST": JSON.stringify(
      profile.configDigest
    ),
    "import.meta.env.VITE_DM_BOOTSTRAP_WRITES": JSON.stringify(
      profile.publicFeatures.dmCompatibilityOrderRoutingEnabled
        ? "true"
        : "false"
    ),
    "import.meta.env.VITE_LIVE_PRESENCE_ENABLED": JSON.stringify(
      profile.publicFeatures.livePresenceEnabled ? "true" : "false"
    ),
    "import.meta.env.VITE_LIGHTNING_NETWORK": JSON.stringify(
      profile.lightningNetwork
    ),
  }

  const deploymentManifestPlugin: Plugin = {
    name: "conduit-deployment-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".well-known/conduit-deployment.json",
        source: `${JSON.stringify(deploymentManifest, null, 2)}\n`,
      })
    },
  }

  return { define, deploymentManifestPlugin }
}

export function defineConduitBuildEnv(appDir: string): Record<string, string> {
  return createConduitBuildContract(appDir).define
}
