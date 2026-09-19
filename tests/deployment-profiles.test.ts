import { describe, expect, it } from "bun:test"
import {
  createPublicDeploymentManifest,
  loadPagesProfiles,
  parsePagesProfiles,
  resolveDeploymentProfile,
  selectDeploymentProfileName,
} from "../scripts/vite/deployment_profile"
import { resolveDmCompatibilityOrderRoutingEnabled } from "../packages/core/src/config"

describe("deployment profiles", () => {
  it("fails compatibility routing closed on official hosts outside production", () => {
    for (const runtimeHostname of [
      "shop.conduit.market",
      "sell.conduit.market",
    ]) {
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "preview",
          runtimeHostname,
        })
      ).toBe(false)
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "staging",
          runtimeHostname,
        })
      ).toBe(false)
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "production",
          runtimeHostname,
        })
      ).toBe(true)
    }

    expect(
      resolveDmCompatibilityOrderRoutingEnabled({
        profileEnabled: false,
        deploymentProfile: "production",
        runtimeHostname: "SHOP.CONDUIT.MARKET.",
      })
    ).toBe(false)
  })

  it("requires the staging profile on Signet Pages hosts", () => {
    for (const runtimeHostname of [
      "conduit-market-signet.pages.dev",
      "abc123.conduit-market-signet.pages.dev",
      "feat-rollout.conduit-merchant-signet.pages.dev",
    ]) {
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "staging",
          runtimeHostname,
        })
      ).toBe(true)
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "preview",
          runtimeHostname,
        })
      ).toBe(false)
      expect(
        resolveDmCompatibilityOrderRoutingEnabled({
          profileEnabled: true,
          deploymentProfile: "production",
          runtimeHostname,
        })
      ).toBe(false)
    }
  })

  it("keeps ordinary Pages previews compatible with their compiled profile", () => {
    expect(
      resolveDmCompatibilityOrderRoutingEnabled({
        profileEnabled: true,
        deploymentProfile: "preview",
        runtimeHostname: "abc123.conduit-market-coo.pages.dev",
      })
    ).toBe(true)
    expect(
      resolveDmCompatibilityOrderRoutingEnabled({
        profileEnabled: false,
        deploymentProfile: "preview",
        runtimeHostname: "abc123.conduit-market-coo.pages.dev",
      })
    ).toBe(false)
  })

  it("fails a staging-misclassified bundle closed on the production host", () => {
    const compiledProfile = selectDeploymentProfileName({
      CF_PAGES: "1",
      CF_PAGES_BRANCH: "main",
      CF_PAGES_URL: "https://conduit-market-signet.pages.dev",
    })

    expect(compiledProfile).toBe("staging")
    expect(
      resolveDmCompatibilityOrderRoutingEnabled({
        profileEnabled: true,
        deploymentProfile: compiledProfile,
        runtimeHostname: "shop.conduit.market",
      })
    ).toBe(false)
  })

  it("configures compatibility routing and live presence by profile", () => {
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
    expect(staging.publicFeatures.dmCompatibilityOrderRoutingEnabled).toBe(true)
    expect(preview.publicFeatures.livePresenceEnabled).toBe(true)
    expect(production.publicFeatures.livePresenceEnabled).toBe(true)
    expect(staging.publicFeatures.livePresenceEnabled).toBe(false)
  })

  it("selects mainnet Cloudflare preview and production without dashboard feature vars", () => {
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "feat/private-order-routing",
        CF_PAGES_URL: "https://abc123.conduit-market-coo.pages.dev",
        VITE_DM_BOOTSTRAP_WRITES: "false",
      })
    ).toBe("preview")
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "main",
        CF_PAGES_URL: "https://conduit-market-coo.pages.dev",
        VITE_DM_BOOTSTRAP_WRITES: "true",
      })
    ).toBe("production")
    expect(() =>
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "feat/private-order-routing",
        CF_PAGES_URL: "https://abc123.conduit-market-coo.pages.dev",
        CONDUIT_DEPLOYMENT_PROFILE: "production",
      })
    ).toThrow("Cloudflare branch requires preview")
  })

  it("selects staging only for the repo-owned Signet Pages projects", () => {
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "main",
        CF_PAGES_URL: "https://conduit-market-signet.pages.dev",
      })
    ).toBe("staging")
    expect(
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "feat/rollout-smoke",
        CF_PAGES_URL: "https://abc123.conduit-merchant-signet.pages.dev",
      })
    ).toBe("staging")
    expect(() =>
      selectDeploymentProfileName({
        CF_PAGES: "1",
        CF_PAGES_BRANCH: "main",
        CF_PAGES_URL: "https://conduit-market-signet.pages.dev",
        CONDUIT_DEPLOYMENT_PROFILE: "production",
      })
    ).toThrow("Cloudflare branch requires staging")
  })

  it("requires each preview feature value but accepts explicit false", () => {
    const profiles = loadPagesProfiles()
    const missing = structuredClone(profiles) as unknown as {
      profiles: { preview: { publicFeatures: Record<string, unknown> } }
    }
    delete missing.profiles.preview.publicFeatures
      .dmCompatibilityOrderRoutingEnabled
    expect(() => parsePagesProfiles(missing)).toThrow(
      "must explicitly set dmCompatibilityOrderRoutingEnabled"
    )

    const explicitFalse = structuredClone(profiles)
    explicitFalse.profiles.preview.publicFeatures.dmCompatibilityOrderRoutingEnabled = false
    expect(
      parsePagesProfiles(explicitFalse).profiles.preview.publicFeatures
        .dmCompatibilityOrderRoutingEnabled
    ).toBe(false)

    const missingPresence = structuredClone(profiles) as unknown as {
      profiles: { preview: { publicFeatures: Record<string, unknown> } }
    }
    delete missingPresence.profiles.preview.publicFeatures.livePresenceEnabled
    expect(() => parsePagesProfiles(missingPresence)).toThrow(
      "must explicitly set livePresenceEnabled"
    )
  })

  it("keeps local presence disabled unless explicitly enabled", () => {
    expect(
      resolveDeploymentProfile({}).publicFeatures.livePresenceEnabled
    ).toBe(false)
    expect(
      resolveDeploymentProfile({ VITE_LIVE_PRESENCE_ENABLED: "true" })
        .publicFeatures.livePresenceEnabled
    ).toBe(true)
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
    expect(manifest.publicFeatures.livePresenceEnabled).toBe(true)
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
      "manifest.publicFeatures?.livePresenceEnabled !== true"
    )
    expect(workflow).toContain("throw new Error(")
  })
})
