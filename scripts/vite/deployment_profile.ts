import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export type DeploymentProfileName = "preview" | "production" | "staging"

export interface PublicDeploymentFeatures {
  dmCompatibilityOrderRoutingEnabled: boolean
}

export interface PublicDeploymentProfile {
  releaseChannel: "preview" | "production" | "staging"
  lightningNetwork: "mainnet" | "signet" | "testnet"
  publicFeatures: PublicDeploymentFeatures
}

interface PagesProfilesFile {
  schemaVersion: number
  apps: Record<
    string,
    {
      package: string
      outputDirectory: string
      cloudflareProject: string | null
    }
  >
  profiles: Record<DeploymentProfileName, PublicDeploymentProfile>
}

export interface ResolvedDeploymentProfile {
  name: DeploymentProfileName | "local"
  releaseChannel: string
  lightningNetwork: string
  publicFeatures: PublicDeploymentFeatures
  configDigest: string
}

export interface PublicDeploymentManifest {
  schemaVersion: 1
  app: string
  deploymentProfile: string
  releaseChannel: string
  commitSha: string | null
  branch: string | null
  buildTime: string
  publicFeatures: PublicDeploymentFeatures
  publicConfigDigest: string
  sourceUrl: string
}

const profilesPath = fileURLToPath(
  new URL("../../deploy/pages-profiles.json", import.meta.url)
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assertProfile(
  name: string,
  value: unknown
): asserts value is PublicDeploymentProfile {
  if (!isRecord(value))
    throw new Error(`Deployment profile ${name} is missing.`)
  if (
    value.releaseChannel !== "preview" &&
    value.releaseChannel !== "production" &&
    value.releaseChannel !== "staging"
  ) {
    throw new Error(`Deployment profile ${name} has an invalid releaseChannel.`)
  }
  if (
    value.lightningNetwork !== "mainnet" &&
    value.lightningNetwork !== "signet" &&
    value.lightningNetwork !== "testnet"
  ) {
    throw new Error(
      `Deployment profile ${name} has an invalid lightningNetwork.`
    )
  }
  if (
    !isRecord(value.publicFeatures) ||
    typeof value.publicFeatures.dmCompatibilityOrderRoutingEnabled !== "boolean"
  ) {
    throw new Error(
      `Deployment profile ${name} must explicitly set dmCompatibilityOrderRoutingEnabled.`
    )
  }
}

export function parsePagesProfiles(value: unknown): PagesProfilesFile {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported Pages deployment profile schema.")
  }
  if (!isRecord(value.apps) || !isRecord(value.profiles)) {
    throw new Error("Pages deployment profiles must define apps and profiles.")
  }
  for (const name of ["preview", "production", "staging"] as const) {
    assertProfile(name, value.profiles[name])
  }
  return value as unknown as PagesProfilesFile
}

export function loadPagesProfiles(): PagesProfilesFile {
  return parsePagesProfiles(JSON.parse(readFileSync(profilesPath, "utf8")))
}

export function selectDeploymentProfileName(
  env: Record<string, string | undefined>
): DeploymentProfileName | "local" {
  const explicit = env.CONDUIT_DEPLOYMENT_PROFILE?.trim()
  if (env.CF_PAGES === "1") {
    const cloudflareProfile =
      env.CF_PAGES_BRANCH?.trim() === "main" ? "production" : "preview"
    if (explicit && explicit !== cloudflareProfile) {
      throw new Error(
        `Cloudflare branch requires ${cloudflareProfile}, not ${explicit}.`
      )
    }
    return cloudflareProfile
  }
  if (explicit) {
    if (
      explicit === "preview" ||
      explicit === "production" ||
      explicit === "staging"
    ) {
      return explicit
    }
    throw new Error(`Unknown deployment profile: ${explicit}`)
  }
  return "local"
}

function digestPublicConfig(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function resolveDeploymentProfile(
  env: Record<string, string | undefined> = process.env
): ResolvedDeploymentProfile {
  const name = selectDeploymentProfileName(env)
  if (name === "local") {
    const local = {
      releaseChannel: "local",
      lightningNetwork: env.VITE_LIGHTNING_NETWORK?.trim() || "mainnet",
      publicFeatures: {
        dmCompatibilityOrderRoutingEnabled: ["1", "true", "on"].includes(
          env.VITE_DM_BOOTSTRAP_WRITES?.trim().toLowerCase() ?? ""
        ),
      },
    }
    return { name, ...local, configDigest: digestPublicConfig(local) }
  }

  const profile = loadPagesProfiles().profiles[name]
  const publicConfig = {
    releaseChannel: profile.releaseChannel,
    lightningNetwork: profile.lightningNetwork,
    publicFeatures: profile.publicFeatures,
  }
  return {
    name,
    ...publicConfig,
    configDigest: digestPublicConfig(publicConfig),
  }
}

export function createPublicDeploymentManifest(input: {
  app: string
  profile: ResolvedDeploymentProfile
  commitSha: string
  branch: string
  buildTime: string
  sourceUrl: string
}): PublicDeploymentManifest {
  return {
    schemaVersion: 1,
    app: input.app,
    deploymentProfile: input.profile.name,
    releaseChannel: input.profile.releaseChannel,
    commitSha: input.commitSha || null,
    branch: input.branch || null,
    buildTime: input.buildTime,
    publicFeatures: { ...input.profile.publicFeatures },
    publicConfigDigest: input.profile.configDigest,
    sourceUrl: input.sourceUrl,
  }
}
