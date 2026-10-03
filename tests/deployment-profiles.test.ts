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

  it("configures compatibility routing, presence and Quantum Router by profile", () => {
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
    expect(preview.publicFeatures.quantumRouterEnabled).toBe(true)
    expect(production.publicFeatures.quantumRouterEnabled).toBe(true)
    expect(staging.publicFeatures.quantumRouterEnabled).toBe(false)
    expect(preview.lightningNetwork).toBe("mainnet")
    expect(production.lightningNetwork).toBe("mainnet")
    expect(staging.lightningNetwork).toBe("signet")
  })

  it("ignores dashboard router overrides for managed public profiles", () => {
    for (const profile of ["preview", "production", "staging"] as const) {
      const expected = profile !== "staging"
      for (const override of ["true", "false"]) {
        expect(
          resolveDeploymentProfile({
            CONDUIT_DEPLOYMENT_PROFILE: profile,
            VITE_QUANTUM_ROUTER_ENABLED: override,
            VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY: "true",
            VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL: "true",
          }).publicFeatures.quantumRouterEnabled
        ).toBe(expected)
      }
    }
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

    const missingRouter = structuredClone(profiles) as unknown as {
      profiles: { preview: { publicFeatures: Record<string, unknown> } }
    }
    delete missingRouter.profiles.preview.publicFeatures.quantumRouterEnabled
    expect(() => parsePagesProfiles(missingRouter)).toThrow(
      "must explicitly set quantumRouterEnabled"
    )
    const disabledRouter = structuredClone(profiles)
    disabledRouter.profiles.preview.publicFeatures.quantumRouterEnabled = false
    expect(
      parsePagesProfiles(disabledRouter).profiles.preview.publicFeatures
        .quantumRouterEnabled
    ).toBe(false)
    const unsupportedNetwork = structuredClone(profiles)
    unsupportedNetwork.profiles.staging.publicFeatures.quantumRouterEnabled = true
    expect(() => parsePagesProfiles(unsupportedNetwork)).toThrow(
      "cannot enable Quantum Router on an unsupported network"
    )
  })

  it("keeps the local public capability disabled unless explicitly requested", () => {
    expect(
      resolveDeploymentProfile({}).publicFeatures.quantumRouterEnabled
    ).toBe(false)
    expect(
      resolveDeploymentProfile({ VITE_QUANTUM_ROUTER_ENABLED: "true" })
        .publicFeatures.quantumRouterEnabled
    ).toBe(true)
    expect(
      resolveDeploymentProfile({
        VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY: "true",
        VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL: "true",
      }).publicFeatures.quantumRouterEnabled
    ).toBe(false)
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
    expect(manifest.publicFeatures.quantumRouterEnabled).toBe(true)
    expect(Object.keys(manifest.publicFeatures).sort()).toEqual([
      "dmCompatibilityOrderRoutingEnabled",
      "livePresenceEnabled",
      "quantumRouterEnabled",
    ])
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
    expect(workflow).toContain(
      "manifest.publicFeatures?.quantumRouterEnabled !== true"
    )
    expect(workflow).toContain("throw new Error(")
  })

  it("compiles the managed capability rather than dashboard router flags", () => {
    for (const profile of ["preview", "production", "staging"] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { createConduitBuildContract } from "./scripts/vite/build_info.ts"; const { define } = createConduitBuildContract("apps/market"); console.log(JSON.stringify({ router: define["import.meta.env.VITE_QUANTUM_ROUTER_ENABLED"], network: define["import.meta.env.VITE_LIGHTNING_NETWORK"], profile: define["import.meta.env.VITE_DEPLOYMENT_PROFILE"] }));',
        ],
        env: {
          ...process.env,
          CF_PAGES: "",
          CONDUIT_DEPLOYMENT_PROFILE: profile,
          VITE_QUANTUM_ROUTER_ENABLED: profile === "staging" ? "true" : "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({
        router: JSON.stringify(profile !== "staging" ? "true" : "false"),
        network: JSON.stringify(profile === "staging" ? "signet" : "mainnet"),
        profile: JSON.stringify(profile),
      })
    }
  })
})
