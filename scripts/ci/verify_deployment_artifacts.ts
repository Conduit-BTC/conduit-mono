import { appendFileSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  loadPagesProfiles,
  resolveDeploymentProfile,
  type PublicDeploymentManifest,
} from "../vite/deployment_profile"

const expectedProfile = process.argv[2]
if (!expectedProfile) {
  throw new Error("Usage: verify_deployment_artifacts.ts <profile>")
}

const resolvedProfile = resolveDeploymentProfile({
  CONDUIT_DEPLOYMENT_PROFILE: expectedProfile,
})
const profiles = loadPagesProfiles()
const expectedCommit = process.env.VITE_BUILD_COMMIT?.trim() || null

for (const [app, appConfig] of Object.entries(profiles.apps)) {
  const manifestPath = resolve(
    appConfig.outputDirectory,
    ".well-known/conduit-deployment.json"
  )
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) as PublicDeploymentManifest

  if (manifest.app !== app) {
    throw new Error(`${manifestPath} identifies the wrong app.`)
  }
  if (manifest.deploymentProfile !== expectedProfile) {
    throw new Error(`${manifestPath} has the wrong deployment profile.`)
  }
  if (manifest.publicConfigDigest !== resolvedProfile.configDigest) {
    throw new Error(`${manifestPath} has a mismatched public config digest.`)
  }
  if (
    manifest.publicFeatures.dmCompatibilityOrderRoutingEnabled !==
    resolvedProfile.publicFeatures.dmCompatibilityOrderRoutingEnabled
  ) {
    throw new Error(`${manifestPath} has mismatched compiled feature flags.`)
  }
  if (expectedCommit && manifest.commitSha !== expectedCommit) {
    throw new Error(`${manifestPath} has the wrong source commit.`)
  }

  if (appConfig.cloudflareProject) {
    const assetsDirectory = resolve(appConfig.outputDirectory, "assets")
    const compiledJavaScript = readdirSync(assetsDirectory)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(resolve(assetsDirectory, name), "utf8"))
      .join("\n")
    if (!compiledJavaScript.includes(manifest.publicConfigDigest)) {
      throw new Error(
        `${manifestPath} public config digest is not present in the compiled runtime.`
      )
    }
  }
}

console.log(
  `Verified ${Object.keys(profiles.apps).length} ${expectedProfile} deployment artifacts (${resolvedProfile.configDigest}).`
)

const githubOutput = process.env.GITHUB_OUTPUT?.trim()
if (githubOutput) {
  appendFileSync(
    githubOutput,
    `public-config-digest=${resolvedProfile.configDigest}\n`,
    "utf8"
  )
}
