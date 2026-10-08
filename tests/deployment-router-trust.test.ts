import { describe, expect, it } from "bun:test"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { checkoutSparkPublicTrustDigest } from "../packages/core/src/checkout-spark-deployment-trust"
import { getCheckoutSparkPricingAuthorityPublicKey } from "../packages/core/src/protocol/checkout-spark-pricing-authority-server"
import { defineCheckoutSparkDeploymentTrust } from "../scripts/vite/build_info"
import {
  createPublicDeploymentManifest,
  loadPagesProfiles,
  resolveDeploymentProfile,
  parsePagesProfiles,
  type ResolvedDeploymentProfile,
} from "../scripts/vite/deployment_profile"

// Public disposable fixture verification keys, never deployment credentials.
const CURRENT = getCheckoutSparkPricingAuthorityPublicKey("0".repeat(63) + "6")!
const HISTORICAL = getCheckoutSparkPricingAuthorityPublicKey(
  "0".repeat(63) + "7"
)!

function retainedTrustProfile(name: "preview" | "production" = "preview") {
  const file = structuredClone(loadPagesProfiles())
  const policy = file.quantumRouterTrust[name]
  policy.pricingUrl = null
  policy.receiverContracts = [
    {
      schemaVersion: 1,
      contractId: "fixture-pending-v1",
      qualification: "pending",
      payRequestOrigins: ["https://receiver.router-fixture.com"],
      callbackOrigins: ["https://receiver.router-fixture.com"],
      verifyOrigins: ["https://receiver.router-fixture.com"],
      verifyPathPrefix: "/verify/",
      modes: ["private"],
      binding: "metadata_hash",
    },
  ]
  policy.pricingPublicKeys = [
    { keyId: "historical", publicKey: HISTORICAL },
    { keyId: "current", publicKey: CURRENT },
  ]
  return file
}

async function compiledCore(
  profile: ResolvedDeploymentProfile,
  app: "market" | "merchant" = "market"
) {
  const vitePath = createRequire(resolve(`apps/${app}/package.json`)).resolve(
    "vite"
  )
  const { build: buildVite } = (await import(
    vitePath
  )) as typeof import("../apps/market/node_modules/vite")
  const coreConfig = resolve("packages/core/src/config.ts")
  const pricingConfig = resolve(
    "packages/core/src/protocol/checkout-spark-pricing-config.ts"
  )
  const buildInfo = resolve("packages/core/src/build-info.ts")
  const probe = resolve("scripts/vite/checkout_spark_trust_probe.ts")
  const build = await buildVite({
    configFile: false,
    logLevel: "silent",
    define: {
      "import.meta.env": "{}",
      "import.meta.env.VITE_DEPLOYMENT_PROFILE": JSON.stringify(profile.name),
      "import.meta.env.VITE_LIGHTNING_NETWORK": JSON.stringify(
        profile.lightningNetwork
      ),
      "import.meta.env.VITE_QUANTUM_ROUTER_ENABLED": JSON.stringify(
        profile.publicFeatures.quantumRouterEnabled ? "true" : "false"
      ),
      "import.meta.env.VITE_QUANTUM_ROUTER_EXECUTION_ENABLED": JSON.stringify(
        profile.publicFeatures.quantumRouterExecutionEnabled ? "true" : "false"
      ),
      ...defineCheckoutSparkDeploymentTrust(profile),
    },
    plugins: [
      {
        name: "compiled-trust-fixture",
        resolveId(id) {
          return id.endsWith("fixture:checkout-trust")
            ? "\0checkout-trust"
            : null
        },
        load(id) {
          if (id !== "\0checkout-trust") return null
          return `export { config } from ${JSON.stringify(coreConfig)};
            export { conduitBuildInfo } from ${JSON.stringify(buildInfo)};
            export { getCheckoutSparkPricingConfiguration, getCheckoutSparkPricingAuthorityTrust } from ${JSON.stringify(pricingConfig)};
            export { readCompiledCheckoutSparkPublicTrust } from ${JSON.stringify(probe)};`
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: "fixture:checkout-trust", formats: ["cjs"] },
      rolldownOptions: { output: { exports: "named", codeSplitting: false } },
    },
  })
  const result = Array.isArray(build) ? build[0] : build
  if (!result || !("output" in result))
    throw new Error("Compiled public trust fixture failed.")
  const chunks = result.output.filter((output) => output.type === "chunk")
  if (chunks.length !== 1)
    throw new Error("Compiled public trust fixture failed.")
  const code = chunks[0]!.code
  const fixtureModule = { exports: {} }
  try {
    // Evaluate only this authored, locally compiled positive fixture in RAM.
    // Avoid data URLs: Windows module failures can echo the bundled contents.
    new Function("module", "exports", code)(
      fixtureModule,
      fixtureModule.exports
    )
  } catch {
    throw new Error("Compiled public trust fixture failed.")
  }
  return fixtureModule.exports as {
    config: {
      checkoutSparkReceiverContracts: string | null
      quantumRouterEnabled: boolean
      quantumRouterExecutionEnabled: boolean
    }
    conduitBuildInfo: {
      publicFeatures: {
        quantumRouterEnabled: boolean
        quantumRouterExecutionEnabled: boolean
      }
    }
    getCheckoutSparkPricingConfiguration: () => { url: string } | null
    getCheckoutSparkPricingAuthorityTrust: () => ReadonlyMap<
      string,
      string
    > | null
    readCompiledCheckoutSparkPublicTrust: () => ResolvedDeploymentProfile["quantumRouterTrust"]
  }
}

describe("managed router public trust configuration", () => {
  it("evaluates independent execution and admission in the actual compiled Core runtime and build metadata", async () => {
    const file = retainedTrustProfile()
    file.quantumRouterTrust.preview.receiverContracts[0] = {
      ...file.quantumRouterTrust.preview.receiverContracts[0]!,
      qualification: "accepted",
    }
    for (const [admission, execution] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      file.profiles.preview.publicFeatures.quantumRouterEnabled = admission
      file.profiles.preview.publicFeatures.quantumRouterExecutionEnabled =
        execution
      const profile = resolveDeploymentProfile(
        { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
        file
      )
      const runtime = await compiledCore(profile)
      expect(profile.publicFeatures.quantumRouterEnabled).toBe(
        admission && execution
      )
      expect(runtime.config.quantumRouterEnabled).toBe(admission && execution)
      expect(runtime.config.quantumRouterExecutionEnabled).toBe(execution)
      expect(runtime.conduitBuildInfo.publicFeatures.quantumRouterEnabled).toBe(
        admission && execution
      )
      expect(
        runtime.conduitBuildInfo.publicFeatures.quantumRouterExecutionEnabled
      ).toBe(execution)
    }
  })

  it("qualifies execution-only profiles independently and commits that choice to the public digest", () => {
    const file = retainedTrustProfile()
    file.profiles.preview.publicFeatures.quantumRouterExecutionEnabled = true
    expect(() => parsePagesProfiles(file)).toThrow(
      "without a qualified private receiver"
    )
    file.quantumRouterTrust.preview.receiverContracts[0] = {
      ...file.quantumRouterTrust.preview.receiverContracts[0]!,
      qualification: "accepted",
    }
    const execution = resolveDeploymentProfile(
      {
        CONDUIT_DEPLOYMENT_PROFILE: "preview",
        VITE_QUANTUM_ROUTER_EXECUTION_ENABLED: "false",
      },
      file
    )
    expect(execution.publicFeatures.quantumRouterEnabled).toBe(false)
    expect(execution.publicFeatures.quantumRouterExecutionEnabled).toBe(true)
    file.profiles.preview.publicFeatures.quantumRouterExecutionEnabled = false
    const stopped = resolveDeploymentProfile(
      {
        CONDUIT_DEPLOYMENT_PROFILE: "preview",
        VITE_QUANTUM_ROUTER_EXECUTION_ENABLED: "true",
      },
      file
    )
    expect(stopped.publicFeatures.quantumRouterExecutionEnabled).toBe(false)
    expect(stopped.configDigest).not.toBe(execution.configDigest)
    expect(stopped.quantumRouterTrustDigest).toBe(
      execution.quantumRouterTrustDigest
    )
    const manifest = createPublicDeploymentManifest({
      app: "market",
      profile: execution,
      commitSha: "fixture",
      branch: "fixture",
      buildTime: "2026-10-08T00:00:00.000Z",
      sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
    })
    expect(manifest.publicFeatures.quantumRouterEnabled).toBe(false)
    expect(manifest.publicFeatures.quantumRouterExecutionEnabled).toBe(true)
    expect(manifest.publicConfigDigest).toBe(execution.configDigest)
  })

  it("rejects global activation without an accepted ordinary receiver", () => {
    const file = retainedTrustProfile()
    file.profiles.preview.publicFeatures.quantumRouterEnabled = true
    expect(() => parsePagesProfiles(file)).toThrow(
      "without a qualified private receiver"
    )
    file.quantumRouterTrust.preview.receiverContracts[0] = {
      ...file.quantumRouterTrust.preview.receiverContracts[0]!,
      qualification: "accepted",
    }
    expect(
      parsePagesProfiles(file).profiles.preview.publicFeatures
        .quantumRouterEnabled
    ).toBe(true)
    file.profiles.production.publicFeatures.quantumRouterEnabled = true
    expect(() => parsePagesProfiles(file)).toThrow(
      "production cannot enable Quantum Router"
    )
  })
  it("keeps code-owned defaults explicitly inactive in every managed profile", () => {
    const file = loadPagesProfiles()
    expect(Object.keys(file.quantumRouterTrust).sort()).toEqual([
      "preview",
      "production",
    ])
    for (const name of ["preview", "production"] as const) {
      const policy = file.quantumRouterTrust[name]
      expect(policy.receiverContracts.length).toBe(0)
      expect(file.profiles[name].publicFeatures.quantumRouterEnabled).toBe(
        false
      )
      expect(
        file.profiles[name].publicFeatures.quantumRouterExecutionEnabled
      ).toBe(false)
      if (name === "preview") {
        expect(policy.pricingUrl).toBe(
          "https://conduit-checkout-pricing-preview.conduithodlings.workers.dev/api/checkout-spark-pricing"
        )
        expect(policy.pricingPublicKeys.map((entry) => entry.keyId)).toEqual([
          "preview-20261007-01",
        ])
      } else {
        expect(policy.pricingPublicKeys.length).toBe(0)
        expect(policy.pricingUrl === null).toBe(true)
      }
    }
    for (const name of ["preview", "production", "staging"] as const) {
      const profile = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
      })
      expect(profile.quantumRouterTrust.receiverContracts).toBe("")
      if (name !== "preview") {
        expect(
          Object.values(profile.quantumRouterTrust).every(
            (value) => value === ""
          )
        ).toBe(true)
      }
      expect(
        profile.quantumRouterTrustDigest ===
          checkoutSparkPublicTrustDigest(profile.quantumRouterTrust)
      ).toBe(true)
      expect(
        Object.keys(defineCheckoutSparkDeploymentTrust(profile)).length
      ).toBe(4)
    }
  })

  it("commits retained historical keys even with no active pricing service and keeps manifests digest-only", () => {
    const file = retainedTrustProfile()
    const baseline = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "preview",
    })
    const retained = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      file
    )
    expect(retained.quantumRouterTrust.pricingUrl === "").toBe(true)
    expect(
      retained.quantumRouterTrust.pricingPublicKeys.split(",").length
    ).toBe(2)
    expect(retained.configDigest !== baseline.configDigest).toBe(true)
    expect(
      retained.quantumRouterTrustDigest !== baseline.quantumRouterTrustDigest
    ).toBe(true)
    const manifest = createPublicDeploymentManifest({
      app: "market",
      profile: retained,
      commitSha: "fixture",
      branch: "fixture",
      buildTime: "2026-10-07T12:00:00Z",
      sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
    })
    expect(JSON.stringify(manifest).includes(CURRENT)).toBe(false)
    expect(JSON.stringify(manifest).includes(HISTORICAL)).toBe(false)
    expect(
      JSON.stringify(manifest).includes("receiver.router-fixture.com")
    ).toBe(false)
    expect(manifest.publicConfigDigest === retained.configDigest).toBe(true)
    const staging = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "staging" },
      file
    )
    expect(
      Object.values(staging.quantumRouterTrust).every((value) => value === "")
    ).toBe(true)
  })

  it("retains local explicit environment settings without managed definition overrides", () => {
    const local = resolveDeploymentProfile({
      VITE_CHECKOUT_SPARK_RECEIVER_CONTRACTS: "[]",
      VITE_CHECKOUT_SPARK_PRICING_PUBLIC_KEYS: `current:${CURRENT}`,
    })
    expect(local.name).toBe("local")
    expect(local.quantumRouterTrust.receiverContracts === "[]").toBe(true)
    expect(
      local.quantumRouterTrust.pricingPublicKeys === `current:${CURRENT}`
    ).toBe(true)
    expect(Object.keys(defineCheckoutSparkDeploymentTrust(local)).length).toBe(
      0
    )
  })

  it("evaluates actual compiled core getters for inactive defaults", async () => {
    const profile = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "production",
    })
    const compiled = await compiledCore(profile)
    expect(compiled.config.checkoutSparkReceiverContracts === null).toBe(true)
    expect(compiled.getCheckoutSparkPricingConfiguration() === null).toBe(true)
    expect(compiled.getCheckoutSparkPricingAuthorityTrust() === null).toBe(true)
    expect(
      JSON.stringify(compiled.readCompiledCheckoutSparkPublicTrust()) ===
        JSON.stringify(profile.quantumRouterTrust)
    ).toBe(true)
  })

  it("evaluates real compiled receiver and recovery-key getters without activating a service", async () => {
    const profile = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      retainedTrustProfile()
    )
    const compiled = await compiledCore(profile)
    expect(
      compiled.config.checkoutSparkReceiverContracts ===
        profile.quantumRouterTrust.receiverContracts
    ).toBe(true)
    expect(compiled.getCheckoutSparkPricingConfiguration() === null).toBe(true)
    const keys = compiled.getCheckoutSparkPricingAuthorityTrust()
    expect(keys?.size).toBe(2)
    expect(keys?.get("current") === CURRENT).toBe(true)
    expect(keys?.get("historical") === HISTORICAL).toBe(true)
    expect(
      JSON.stringify(compiled.readCompiledCheckoutSparkPublicTrust()) ===
        JSON.stringify(profile.quantumRouterTrust)
    ).toBe(true)
  })

  it("evaluates the actual compiled live getter using public fixture configuration only", async () => {
    const file = retainedTrustProfile()
    file.quantumRouterTrust.preview.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    const profile = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      file
    )
    const compiled = await compiledCore(profile)
    expect(
      compiled.getCheckoutSparkPricingConfiguration()?.url ===
        profile.quantumRouterTrust.pricingUrl
    ).toBe(true)
    expect(compiled.getCheckoutSparkPricingAuthorityTrust()?.size).toBe(2)
    expect(
      JSON.stringify(compiled.readCompiledCheckoutSparkPublicTrust()) ===
        JSON.stringify(profile.quantumRouterTrust)
    ).toBe(true)
  })

  it("canonicalizes legitimate pricing URL casing and default ports before digesting and compiling", async () => {
    const file = retainedTrustProfile()
    file.quantumRouterTrust.preview.pricingUrl =
      "https://PRICING.router-fixture.com:443/api/checkout-spark-pricing"
    const profile = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      file
    )
    const canonical = structuredClone(file)
    canonical.quantumRouterTrust.preview.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    const canonicalProfile = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      canonical
    )
    expect(
      profile.quantumRouterTrust.pricingUrl ===
        canonical.quantumRouterTrust.preview.pricingUrl
    ).toBe(true)
    expect(profile.configDigest === canonicalProfile.configDigest).toBe(true)
    expect(
      profile.quantumRouterTrustDigest ===
        canonicalProfile.quantumRouterTrustDigest
    ).toBe(true)
    const compiled = await compiledCore(profile)
    expect(
      JSON.stringify(compiled.readCompiledCheckoutSparkPublicTrust()) ===
        JSON.stringify(profile.quantumRouterTrust)
    ).toBe(true)
  })

  it("isolates configured preview trust from production and staging in both app profiles", () => {
    const file = retainedTrustProfile()
    // Accepted status applies only to this authored fixture, never a live endpoint.
    file.quantumRouterTrust.preview.receiverContracts =
      file.quantumRouterTrust.preview.receiverContracts.map((contract) => ({
        ...contract,
        qualification: "accepted",
      }))
    file.quantumRouterTrust.preview.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    for (const app of ["market", "merchant"] as const) {
      for (const name of ["preview", "production", "staging"] as const) {
        const appConfig = file.apps[app]!
        const cloudflareProject =
          name === "staging"
            ? appConfig.cloudflareStagingProject!
            : `${appConfig.cloudflareProject!}${app === "market" ? "-coo" : "-33n"}`
        const baseline = resolveDeploymentProfile({
          CONDUIT_DEPLOYMENT_PROFILE: name,
        })
        const profile = resolveDeploymentProfile(
          {
            CF_PAGES: "1",
            CF_PAGES_BRANCH: name === "production" ? "main" : "fixture",
            CF_PAGES_URL: `https://fixture.${cloudflareProject}.pages.dev`,
          },
          file
        )
        expect(profile.name).toBe(name)
        if (name === "preview") {
          expect(profile.quantumRouterTrust.pricingUrl).toBe(
            file.quantumRouterTrust.preview.pricingUrl!
          )
          expect(
            profile.quantumRouterTrust.pricingPublicKeys.split(",")
          ).toHaveLength(2)
          const contracts = JSON.parse(
            profile.quantumRouterTrust.receiverContracts
          )
          expect(contracts).toHaveLength(1)
          expect(contracts[0].qualification).toBe("accepted")
          expect(profile.quantumRouterTrustDigest).not.toBe(
            baseline.quantumRouterTrustDigest
          )
        } else {
          expect(profile.quantumRouterTrust).toEqual(
            baseline.quantumRouterTrust
          )
          expect(profile.quantumRouterTrustDigest).toBe(
            baseline.quantumRouterTrustDigest
          )
          expect(profile.configDigest).toBe(baseline.configDigest)
        }
        expect(profile.quantumRouterTreasury).toEqual(
          baseline.quantumRouterTreasury
        )
      }
    }
  })

  it("retains production historical keys independently from preview quote issuance", () => {
    const file = retainedTrustProfile()
    file.quantumRouterTrust.preview.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    file.quantumRouterTrust.production.pricingPublicKeys = [
      { keyId: "historical", publicKey: HISTORICAL },
    ]
    const preview = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      file
    )
    const production = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "production" },
      file
    )
    expect(
      preview.quantumRouterTrust.pricingPublicKeys.split(",")
    ).toHaveLength(2)
    expect(production.quantumRouterTrust).toEqual({
      receiverContracts: "",
      pricingUrl: "",
      pricingPublicKeys: `historical:${HISTORICAL}`,
    })
    const changedPreview = structuredClone(file)
    changedPreview.quantumRouterTrust.preview = {
      receiverContracts: [],
      pricingUrl: null,
      pricingPublicKeys: [],
    }
    const sameProduction = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "production" },
      changedPreview
    )
    expect(sameProduction.configDigest).toBe(production.configDigest)
    expect(sameProduction.quantumRouterTrustDigest).toBe(
      production.quantumRouterTrustDigest
    )
    const changedProduction = structuredClone(file)
    changedProduction.quantumRouterTrust.production = {
      receiverContracts: [],
      pricingUrl: null,
      pricingPublicKeys: [],
    }
    const samePreview = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      changedProduction
    )
    expect(samePreview.configDigest).toBe(preview.configDigest)
    expect(samePreview.quantumRouterTrustDigest).toBe(
      preview.quantumRouterTrustDigest
    )
  })

  it("compiles independent selected trust through both apps actual core getters", async () => {
    const file = retainedTrustProfile()
    file.quantumRouterTrust.preview.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    file.quantumRouterTrust.production.pricingPublicKeys = [
      { keyId: "historical", publicKey: HISTORICAL },
    ]
    for (const app of ["market", "merchant"] as const) {
      for (const name of ["preview", "production"] as const) {
        const profile = resolveDeploymentProfile(
          { CONDUIT_DEPLOYMENT_PROFILE: name },
          file
        )
        const compiled = await compiledCore(profile, app)
        expect(compiled.readCompiledCheckoutSparkPublicTrust()).toEqual(
          profile.quantumRouterTrust
        )
        const keys = compiled.getCheckoutSparkPricingAuthorityTrust()
        expect(keys?.get("historical")).toBe(HISTORICAL)
        if (name === "preview") {
          expect(keys?.size).toBe(2)
          expect(keys?.get("current")).toBe(CURRENT)
          expect(compiled.getCheckoutSparkPricingConfiguration()?.url).toBe(
            profile.quantumRouterTrust.pricingUrl
          )
          expect(compiled.config.checkoutSparkReceiverContracts).toBe(
            profile.quantumRouterTrust.receiverContracts
          )
        } else {
          expect(keys?.size).toBe(1)
          expect(compiled.getCheckoutSparkPricingConfiguration()).toBeNull()
          expect(compiled.config.checkoutSparkReceiverContracts).toBeNull()
        }
      }
    }
  })
})
