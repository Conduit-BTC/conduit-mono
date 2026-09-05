import { describe, expect, it } from "bun:test"
import {
  createPublicDeploymentManifest,
  loadPagesProfiles,
  parsePagesProfiles,
  resolveDeploymentProfile,
  selectDeploymentProfileName,
} from "../scripts/vite/deployment_profile"

describe("deployment profiles", () => {
  it("enables compatibility order routing in preview and keeps the relay prompt off", () => {
    const preview = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "preview",
    })
    const production = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "production",
    })
    const staging = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "staging",
    })

    expect(preview.publicFeatures.dmCompatibilityOrderRoutingEnabled).toBe(true)
    expect(production.publicFeatures.dmCompatibilityOrderRoutingEnabled).toBe(
      false
    )
    expect(staging.publicFeatures.dmCompatibilityOrderRoutingEnabled).toBe(
      false
    )
    expect(preview.publicFeatures.conduitRelayPromptEnabled).toBe(false)
    expect(production.publicFeatures.conduitRelayPromptEnabled).toBe(false)
    expect(staging.publicFeatures.conduitRelayPromptEnabled).toBe(false)

    const explicitLocal = resolveDeploymentProfile({
      VITE_CONDUIT_RELAY_PROMPT: "true",
    })
    expect(explicitLocal.publicFeatures.conduitRelayPromptEnabled).toBe(true)
  })

  it("selects Cloudflare preview and production without dashboard feature vars", () => {
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "feat/private-order-routing",
        VITE_DM_BOOTSTRAP_WRITES: "false",
      })
    ).toBe("preview")
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "main",
        VITE_DM_BOOTSTRAP_WRITES: "true",
      })
    ).toBe("production")
    expect(() =>
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "feat/private-order-routing",
        CONDUIT_DEPLOYMENT_PROFILE: "production",
      })
    ).toThrow("Cloudflare branch requires preview")
  })

  it("rejects a missing preview feature value but accepts explicit false", () => {
    const profiles = loadPagesProfiles()
    const missing = structuredClone(profiles) as unknown as {
      profiles: { preview: { publicFeatures: Record<string, unknown> } }
    }
    delete missing.profiles.preview.publicFeatures
      .dmCompatibilityOrderRoutingEnabled
    expect(() => parsePagesProfiles(missing)).toThrow(
      "must explicitly set dmCompatibilityOrderRoutingEnabled"
    )

    const missingPrompt = structuredClone(profiles) as unknown as {
      profiles: { preview: { publicFeatures: Record<string, unknown> } }
    }
    delete missingPrompt.profiles.preview.publicFeatures
      .conduitRelayPromptEnabled
    expect(() => parsePagesProfiles(missingPrompt)).toThrow(
      "must explicitly set conduitRelayPromptEnabled"
    )

    const explicitFalse = structuredClone(profiles)
    explicitFalse.profiles.preview.publicFeatures.dmCompatibilityOrderRoutingEnabled = false
    expect(
      parsePagesProfiles(explicitFalse).profiles.preview.publicFeatures
        .dmCompatibilityOrderRoutingEnabled
    ).toBe(false)
  })

  it("emits only whitelisted public build state and matches effective config", () => {
    const profile = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "preview",
    })
    const manifest = createPublicDeploymentManifest({
      app: "market",
      profile,
      commitSha: "abc123",
      branch: "feat/private-order-routing",
      buildTime: "2026-08-09T12:00:00.000Z",
      sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
    })

    expect(manifest.deploymentProfile).toBe("preview")
    expect(manifest.publicFeatures.dmCompatibilityOrderRoutingEnabled).toBe(
      true
    )
    expect(manifest.publicFeatures.conduitRelayPromptEnabled).toBe(false)
    expect(manifest.publicConfigDigest).toBe(profile.configDigest)
    expect(Object.keys(manifest).sort()).toEqual([
      "app",
      "branch",
      "buildTime",
      "commitSha",
      "deploymentProfile",
      "publicConfigDigest",
      "publicFeatures",
      "releaseChannel",
      "schemaVersion",
      "sourceUrl",
    ])
    expect(JSON.stringify(manifest).toLowerCase()).not.toMatch(
      /secret|private[_-]?key|nsec|token|invoice/
    )
  })

  it("makes the preview-link gate verify the deployed manifest contract", async () => {
    const workflow = await Bun.file(".github/workflows/ci.yml").text()

    expect(workflow).toContain("public-config-digest:")
    expect(workflow).toContain("/.well-known/conduit-deployment.json")
    expect(workflow).toContain('manifest.deploymentProfile !== "preview"')
    expect(workflow).toContain("manifest.commitSha !== headSha")
    expect(workflow).toContain(
      "manifest.publicConfigDigest !== expectedConfigDigest"
    )
    expect(workflow).toContain(
      "manifest.publicFeatures?.dmCompatibilityOrderRoutingEnabled !== true"
    )
    expect(workflow).toContain(
      "manifest.publicFeatures?.conduitRelayPromptEnabled !== false"
    )
    expect(workflow).toContain("throw new Error(")
  })
})
