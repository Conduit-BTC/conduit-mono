import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  checkoutSparkPublicTrustDigest,
  type CheckoutSparkPublicTrustConfiguration,
} from "../../packages/core/src/checkout-spark-deployment-trust"
import {
  parseCheckoutSparkReceiverContracts,
  type CheckoutSparkReceiverContract,
} from "../../packages/core/src/protocol/checkout-spark-receiver-capability"
import { parseCheckoutSparkPricingConfiguration } from "../../packages/core/src/protocol/checkout-spark-pricing-config"
import { parseCheckoutSparkPricingAuthorityPublicKeys } from "../../packages/core/src/protocol/checkout-spark-pricing-authority"

export type DeploymentProfileName = "preview" | "production" | "staging"

export interface PublicDeploymentFeatures {
  dmCompatibilityOrderRoutingEnabled: boolean
  livePresenceEnabled: boolean
  quantumRouterEnabled: boolean
  quantumRouterExecutionEnabled: boolean
}

export interface PublicDeploymentProfile {
  releaseChannel: "preview" | "production" | "staging"
  lightningNetwork: "mainnet" | "signet" | "testnet"
  publicFeatures: PublicDeploymentFeatures
}

export interface PublicDeploymentTreasury {
  mainnetAddress: string
  regtestAddress: string
  retiredAddresses: string[]
}

interface ManagedRouterTrustPolicy {
  receiverContracts: CheckoutSparkReceiverContract[]
  pricingUrl: string | null
  pricingPublicKeys: Array<{ keyId: string; publicKey: string }>
}

interface PagesProfilesFile {
  schemaVersion: number
  quantumRouterTreasury: {
    mainnetAddress: string | null
    retiredMainnetAddresses: string[]
  }
  quantumRouterTrust: Record<"preview" | "production", ManagedRouterTrustPolicy>
  apps: Record<
    string,
    {
      package: string
      outputDirectory: string
      cloudflareProject: string | null
      cloudflareStagingProject: string | null
    }
  >
  profiles: Record<DeploymentProfileName, PublicDeploymentProfile>
}

export interface ResolvedDeploymentProfile {
  name: DeploymentProfileName | "local"
  releaseChannel: string
  lightningNetwork: string
  publicFeatures: PublicDeploymentFeatures
  quantumRouterTreasury: PublicDeploymentTreasury
  quantumRouterTrust: CheckoutSparkPublicTrustConfiguration
  quantumRouterTrustDigest: string
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

function assertTreasuryConfiguration(
  value: unknown
): asserts value is PagesProfilesFile["quantumRouterTreasury"] {
  // Bounded static-address syntax only. The pinned SDK checks checksum,
  // identity and canonical encoding offline in tests and before preparation.
  const isMainnetAddress = (address: unknown): address is string =>
    typeof address === "string" &&
    /^spark1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{62}$/.test(address)
  if (
    !isRecord(value) ||
    (value.mainnetAddress !== null &&
      !isMainnetAddress(value.mainnetAddress)) ||
    !Array.isArray(value.retiredMainnetAddresses) ||
    value.retiredMainnetAddresses.length > 16 ||
    !value.retiredMainnetAddresses.every(isMainnetAddress) ||
    new Set(value.retiredMainnetAddresses).size !==
      value.retiredMainnetAddresses.length ||
    value.retiredMainnetAddresses.includes(value.mainnetAddress)
  ) {
    throw new Error("Pages deployment treasury configuration is invalid.")
  }
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
  if (!isRecord(value.publicFeatures)) {
    throw new Error(
      `Deployment profile ${name} must define public feature flags.`
    )
  }
  if (
    typeof value.publicFeatures.dmCompatibilityOrderRoutingEnabled !== "boolean"
  ) {
    throw new Error(
      `Deployment profile ${name} must explicitly set dmCompatibilityOrderRoutingEnabled.`
    )
  }
  if (typeof value.publicFeatures.livePresenceEnabled !== "boolean") {
    throw new Error(
      `Deployment profile ${name} must explicitly set livePresenceEnabled.`
    )
  }
  if (typeof value.publicFeatures.quantumRouterEnabled !== "boolean") {
    throw new Error(
      `Deployment profile ${name} must explicitly set quantumRouterEnabled.`
    )
  }
  if (typeof value.publicFeatures.quantumRouterExecutionEnabled !== "boolean") {
    throw new Error(
      `Deployment profile ${name} must explicitly set quantumRouterExecutionEnabled.`
    )
  }
  if (
    (value.publicFeatures.quantumRouterEnabled ||
      value.publicFeatures.quantumRouterExecutionEnabled) &&
    value.lightningNetwork !== "mainnet"
  ) {
    throw new Error(
      `Deployment profile ${name} cannot enable Quantum Router on an unsupported network.`
    )
  }
}

function assertRouterTrustConfiguration(
  value: unknown
): asserts value is ManagedRouterTrustPolicy {
  const invalid = (): never => {
    throw new Error("Pages deployment router trust configuration is invalid.")
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Array.isArray(value.receiverContracts) ||
    (value.pricingUrl !== null && typeof value.pricingUrl !== "string") ||
    !Array.isArray(value.pricingPublicKeys) ||
    value.pricingPublicKeys.length > 16
  )
    invalid()
  try {
    parseCheckoutSparkReceiverContracts(value.receiverContracts)
    const ring = value.pricingPublicKeys
      .map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          Object.keys(entry).length !== 2 ||
          typeof entry.keyId !== "string" ||
          typeof entry.publicKey !== "string"
        )
          return invalid()
        return `${entry.keyId}:${entry.publicKey}`
      })
      .join(",")
    if (ring && !parseCheckoutSparkPricingAuthorityPublicKeys(ring)) invalid()
    if (
      value.pricingUrl !== null &&
      !parseCheckoutSparkPricingConfiguration({
        url: value.pricingUrl as string,
        publicKeys: ring,
      })
    )
      invalid()
  } catch {
    invalid()
  }
}

function assertRouterTrustProfiles(
  value: unknown
): asserts value is PagesProfilesFile["quantumRouterTrust"] {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error("Pages deployment router trust profiles are invalid.")
  }
  // Each release boundary is explicit. There is no shared-policy fallback.
  for (const name of ["preview", "production"] as const) {
    assertRouterTrustConfiguration(value[name])
  }
}

export function parsePagesProfiles(value: unknown): PagesProfilesFile {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported Pages deployment profile schema.")
  }
  if (!isRecord(value.apps) || !isRecord(value.profiles)) {
    throw new Error("Pages deployment profiles must define apps and profiles.")
  }
  assertTreasuryConfiguration(value.quantumRouterTreasury)
  assertRouterTrustProfiles(value.quantumRouterTrust)
  for (const [name, app] of Object.entries(value.apps)) {
    if (
      !isRecord(app) ||
      (app.cloudflareStagingProject !== null &&
        typeof app.cloudflareStagingProject !== "string")
    ) {
      throw new Error(
        `Pages app ${name} must define cloudflareStagingProject as a string or null.`
      )
    }
  }
  for (const name of ["preview", "production", "staging"] as const) {
    assertProfile(name, value.profiles[name])
  }
  for (const name of ["preview", "production"] as const) {
    const profile = value.profiles[name] as PublicDeploymentProfile
    const trust = (
      value.quantumRouterTrust as PagesProfilesFile["quantumRouterTrust"]
    )[name]
    if (
      (profile.publicFeatures.quantumRouterEnabled ||
        profile.publicFeatures.quantumRouterExecutionEnabled) &&
      !trust.receiverContracts.some(
        (contract) =>
          contract.qualification === "accepted" &&
          contract.modes.includes("private")
      )
    ) {
      throw new Error(
        `Deployment profile ${name} cannot enable Quantum Router without a qualified private receiver.`
      )
    }
  }
  return value as unknown as PagesProfilesFile
}

export function loadPagesProfiles(): PagesProfilesFile {
  return parsePagesProfiles(JSON.parse(readFileSync(profilesPath, "utf8")))
}

function cloudflareProjectFromDeploymentUrl(rawUrl: string | undefined) {
  if (!rawUrl) return null
  try {
    const labels = new URL(rawUrl).hostname.toLowerCase().split(".")
    if (
      labels.length < 3 ||
      labels.at(-2) !== "pages" ||
      labels.at(-1) !== "dev"
    ) {
      return null
    }
    return labels.at(-3) ?? null
  } catch {
    return null
  }
}

function isCloudflareStagingProject(env: Record<string, string | undefined>) {
  const project = cloudflareProjectFromDeploymentUrl(env.CF_PAGES_URL)
  if (!project) return false
  return Object.values(loadPagesProfiles().apps).some(
    (app) => app.cloudflareStagingProject === project
  )
}

export function selectDeploymentProfileName(
  env: Record<string, string | undefined>
): DeploymentProfileName | "local" {
  const explicit = env.CONDUIT_DEPLOYMENT_PROFILE?.trim()
  if (env.CF_PAGES === "1") {
    const cloudflareProfile = isCloudflareStagingProject(env)
      ? "staging"
      : env.CF_PAGES_BRANCH?.trim() === "main"
        ? "production"
        : "preview"
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
  env: Record<string, string | undefined> = process.env,
  pagesProfiles: PagesProfilesFile = loadPagesProfiles()
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
        livePresenceEnabled: ["1", "true", "on"].includes(
          env.VITE_LIVE_PRESENCE_ENABLED?.trim().toLowerCase() ?? ""
        ),
        quantumRouterEnabled: ["1", "true", "on"].includes(
          env.VITE_QUANTUM_ROUTER_ENABLED?.trim().toLowerCase() ?? ""
        ),
        quantumRouterExecutionEnabled:
          env.VITE_QUANTUM_ROUTER_EXECUTION_ENABLED?.trim()
            ? ["1", "true", "on"].includes(
                env.VITE_QUANTUM_ROUTER_EXECUTION_ENABLED.trim().toLowerCase()
              )
            : ["1", "true", "on"].includes(
                env.VITE_QUANTUM_ROUTER_ENABLED?.trim().toLowerCase() ?? ""
              ) ||
              (env.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY === "true" &&
                env.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL === "true"),
      },
      quantumRouterTreasury: {
        mainnetAddress: env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS?.trim() || "",
        regtestAddress:
          env.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS?.trim() || "",
        retiredAddresses:
          env.VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES?.split(",")
            .map((address) => address.trim())
            .filter(Boolean) ?? [],
      },
      quantumRouterTrust: {
        receiverContracts:
          env.VITE_CHECKOUT_SPARK_RECEIVER_CONTRACTS?.trim() || "",
        pricingUrl: env.VITE_CHECKOUT_SPARK_PRICING_URL?.trim() || "",
        pricingPublicKeys:
          env.VITE_CHECKOUT_SPARK_PRICING_PUBLIC_KEYS?.trim() || "",
      },
    }
    local.publicFeatures.quantumRouterEnabled &&=
      local.publicFeatures.quantumRouterExecutionEnabled
    return {
      name,
      ...local,
      quantumRouterTrustDigest: checkoutSparkPublicTrustDigest(
        local.quantumRouterTrust
      ),
      configDigest: digestPublicConfig(local),
    }
  }

  const configuration = parsePagesProfiles(pagesProfiles)
  const profile = configuration.profiles[name]
  // Staging never imports mainnet trust, even if its network changes later.
  const routerTrust =
    name !== "staging" && profile.lightningNetwork === "mainnet"
      ? configuration.quantumRouterTrust[name]
      : null
  const pricingPublicKeys = routerTrust
    ? [...routerTrust.pricingPublicKeys]
        .sort((a, b) => a.keyId.localeCompare(b.keyId))
        .map(({ keyId, publicKey }) => `${keyId}:${publicKey}`)
        .join(",")
    : ""
  const pricingUrl = routerTrust
    ? (parseCheckoutSparkPricingConfiguration({
        url: routerTrust.pricingUrl ?? undefined,
        publicKeys: pricingPublicKeys,
      })?.url ?? "")
    : ""
  const publicConfig = {
    releaseChannel: profile.releaseChannel,
    lightningNetwork: profile.lightningNetwork,
    publicFeatures: {
      ...profile.publicFeatures,
      quantumRouterEnabled:
        profile.publicFeatures.quantumRouterEnabled &&
        profile.publicFeatures.quantumRouterExecutionEnabled,
    },
    quantumRouterTreasury: {
      mainnetAddress:
        profile.lightningNetwork === "mainnet"
          ? (configuration.quantumRouterTreasury.mainnetAddress ?? "")
          : "",
      regtestAddress: "",
      retiredAddresses:
        profile.lightningNetwork === "mainnet"
          ? [...configuration.quantumRouterTreasury.retiredMainnetAddresses]
          : [],
    },
    quantumRouterTrust: {
      receiverContracts: routerTrust?.receiverContracts.length
        ? JSON.stringify(
            parseCheckoutSparkReceiverContracts(routerTrust.receiverContracts)
          )
        : "",
      pricingUrl,
      pricingPublicKeys,
    },
  }
  return {
    name,
    ...publicConfig,
    quantumRouterTrustDigest: checkoutSparkPublicTrustDigest(
      publicConfig.quantumRouterTrust
    ),
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
