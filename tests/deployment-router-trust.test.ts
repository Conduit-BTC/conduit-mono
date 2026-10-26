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

function disableTrustProfile(
  file: ReturnType<typeof loadPagesProfiles>,
  name: "preview" | "production"
) {
  file.profiles[name].publicFeatures.quantumRouterEnabled = false
  file.profiles[name].publicFeatures.quantumRouterExecutionEnabled = false
  file.quantumRouterTrust[name] = {
    receiverContracts: [],
    pricingUrl: null,
    pricingPublicKeys: [],
  }
}

function retainedTrustProfile(name: "preview" | "production" = "preview") {
  const file = structuredClone(loadPagesProfiles())
  disableTrustProfile(file, name)
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
    file.quantumRouterTrust.production.receiverContracts = []
    file.profiles.production.publicFeatures.quantumRouterEnabled = true
    expect(() => parsePagesProfiles(file)).toThrow(
      "production cannot enable Quantum Router"
    )
  })
  it("configures reviewed private receivers and independent pricing trust for preview and production", () => {
    const file = loadPagesProfiles()
    expect(Object.keys(file.quantumRouterTrust).sort()).toEqual([
      "preview",
      "production",
    ])
    for (const name of ["preview", "production"] as const) {
      const policy = file.quantumRouterTrust[name]
      expect(file.profiles[name].publicFeatures.quantumRouterEnabled).toBe(true)
      expect(
        file.profiles[name].publicFeatures.quantumRouterExecutionEnabled
      ).toBe(true)
      expect(policy.receiverContracts).toEqual([
        {
          schemaVersion: 1,
          contractId: "breez-tips-private-v1",
          qualification: "accepted",
          payRequestOrigins: ["https://breez.tips"],
          callbackOrigins: ["https://breez.tips"],
          verifyOrigins: ["https://breez.tips"],
          verifyPathPrefix: "/lnurlp/verify/",
          modes: ["private"],
          binding: "metadata_hash",
        },
        {
          schemaVersion: 1,
          contractId: "conduit-cash-private-v1",
          qualification: "accepted",
          payRequestOrigins: ["https://conduit.cash"],
          callbackOrigins: ["https://conduit.cash"],
          verifyOrigins: ["https://conduit.cash"],
          verifyPathPrefix: "/lnurlp/verify/",
          modes: ["private"],
          binding: "metadata_hash",
        },
      ])
      if (name === "preview") {
        expect(policy.pricingUrl).toBe(
          "https://conduit-checkout-pricing-preview.conduithodlings.workers.dev/api/checkout-spark-pricing"
        )
        expect(policy.pricingPublicKeys).toEqual([
          {
            keyId: "preview-20261007-01",
            publicKey:
              "7d67f2698711a7b54187b613b66acb301af9d749b98f752cc7e2099145cc0dc8",
          },
        ])
      } else {
        expect(policy.pricingUrl).toBe(
          "https://conduit-checkout-pricing.conduithodlings.workers.dev/api/checkout-spark-pricing"
        )
        expect(policy.pricingPublicKeys).toEqual([
          {
            keyId: "production-20261021-01",
            publicKey:
              "7baf813fa54b1288c51635db4935802883750b91a360d5c7016be9a0b5dae553",
          },
        ])
      }
    }
    for (const name of ["preview", "production", "staging"] as const) {
      const profile = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
      })
      if (name === "staging") {
        expect(profile.publicFeatures.quantumRouterEnabled).toBe(false)
        expect(profile.publicFeatures.quantumRouterExecutionEnabled).toBe(false)
        expect(
          Object.values(profile.quantumRouterTrust).every(
            (value) => value === ""
          )
        ).toBe(true)
      } else {
        expect(
          JSON.parse(profile.quantumRouterTrust.receiverContracts)
        ).toEqual(file.quantumRouterTrust[name].receiverContracts)
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

  it("rejects either active profile with missing, pending or public-only receiver qualification", () => {
    for (const name of ["preview", "production"] as const) {
      for (const receiverState of [
        "empty",
        "pending",
        "public-only",
      ] as const) {
        const file = structuredClone(loadPagesProfiles())
        if (receiverState === "empty") {
          file.quantumRouterTrust[name].receiverContracts = []
        } else {
          file.quantumRouterTrust[name].receiverContracts =
            file.quantumRouterTrust[name].receiverContracts.map((contract) => ({
              ...contract,
              ...(receiverState === "pending"
                ? { qualification: "pending" as const }
                : {
                    modes: ["public" as const],
                    binding: "verifier_recipient" as const,
                  }),
            }))
        }
        expect(() => parsePagesProfiles(file)).toThrow(
          "without a qualified private receiver"
        )
      }
    }
  })

  it("rejects missing selected policy and invalid configured pricing without borrowing the other profile's trust", () => {
    for (const name of ["preview", "production"] as const) {
      const missing = structuredClone(loadPagesProfiles()) as unknown as {
        quantumRouterTrust: Partial<Record<"preview" | "production", unknown>>
      }
      delete missing.quantumRouterTrust[name]
      expect(() => parsePagesProfiles(missing)).toThrow(
        "router trust profiles are invalid"
      )
      for (const invalidUrl of [
        "http://pricing.router-fixture.com/api/checkout-spark-pricing",
        "https://pricing.router-fixture.com/api/another-route",
        "https://pricing.router-fixture.com/api/checkout-spark-pricing?override=true",
      ]) {
        const file = structuredClone(loadPagesProfiles())
        file.quantumRouterTrust[name].pricingUrl = invalidUrl
        expect(() => parsePagesProfiles(file)).toThrow(
          "router trust configuration is invalid"
        )
      }
      for (const publicKeys of [
        [],
        [{ keyId: "invalid", publicKey: "not-a-public-key" }],
        [
          { keyId: "duplicate", publicKey: CURRENT },
          { keyId: "duplicate", publicKey: HISTORICAL },
        ],
      ]) {
        const file = structuredClone(loadPagesProfiles())
        file.quantumRouterTrust[name].pricingPublicKeys = publicKeys
        expect(() => parsePagesProfiles(file)).toThrow(
          "router trust configuration is invalid"
        )
      }
    }
  })

  it("ignores dashboard trust overrides for both managed mainnet profiles and staging", () => {
    for (const name of ["preview", "production", "staging"] as const) {
      const baseline = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
      })
      const overridden = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
        VITE_CHECKOUT_SPARK_RECEIVER_CONTRACTS: "[]",
        VITE_CHECKOUT_SPARK_PRICING_URL:
          "https://pricing.router-fixture.com/api/checkout-spark-pricing",
        VITE_CHECKOUT_SPARK_PRICING_PUBLIC_KEYS: `fixture:${CURRENT}`,
      })
      expect(overridden.quantumRouterTrust).toEqual(baseline.quantumRouterTrust)
      expect(overridden.quantumRouterTrustDigest).toBe(
        baseline.quantumRouterTrustDigest
      )
      expect(overridden.configDigest).toBe(baseline.configDigest)
    }
  })

  it("compiles each selected receiver, pricing policy and activation through both apps without fallback", async () => {
    for (const app of ["market", "merchant"] as const) {
      for (const name of ["preview", "production"] as const) {
        const profile = resolveDeploymentProfile({
          CONDUIT_DEPLOYMENT_PROFILE: name,
        })
        const compiled = await compiledCore(profile, app)
        expect(compiled.config.quantumRouterEnabled).toBe(true)
        expect(compiled.config.quantumRouterExecutionEnabled).toBe(true)
        expect(compiled.config.checkoutSparkReceiverContracts).toBe(
          profile.quantumRouterTrust.receiverContracts
        )
        expect(compiled.readCompiledCheckoutSparkPublicTrust()).toEqual(
          profile.quantumRouterTrust
        )
        expect(compiled.getCheckoutSparkPricingConfiguration()?.url).toBe(
          profile.quantumRouterTrust.pricingUrl
        )
        expect(
          Array.from(compiled.getCheckoutSparkPricingAuthorityTrust() ?? [])
        ).toEqual(
          loadPagesProfiles().quantumRouterTrust[name].pricingPublicKeys.map(
            ({ keyId, publicKey }) => [keyId, publicKey]
          )
        )
      }
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

  it("evaluates actual compiled core getters for explicitly inactive production trust", async () => {
    const file = loadPagesProfiles()
    disableTrustProfile(file, "production")
    const profile = resolveDeploymentProfile(
      {
        CONDUIT_DEPLOYMENT_PROFILE: "production",
      },
      file
    )
    for (const app of ["market", "merchant"] as const) {
      const compiled = await compiledCore(profile, app)
      expect(compiled.config.quantumRouterEnabled).toBe(false)
      expect(compiled.config.quantumRouterExecutionEnabled).toBe(false)
      expect(compiled.config.checkoutSparkReceiverContracts === null).toBe(true)
      expect(compiled.getCheckoutSparkPricingConfiguration() === null).toBe(
        true
      )
      expect(compiled.getCheckoutSparkPricingAuthorityTrust() === null).toBe(
        true
      )
      expect(
        JSON.stringify(compiled.readCompiledCheckoutSparkPublicTrust()) ===
          JSON.stringify(profile.quantumRouterTrust)
      ).toBe(true)
    }
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

  it("isolates changes to production trust from preview and staging", () => {
    const file = structuredClone(loadPagesProfiles())
    file.quantumRouterTrust.production.pricingUrl =
      "https://pricing.router-fixture.com/api/checkout-spark-pricing"
    file.quantumRouterTrust.production.pricingPublicKeys = [
      { keyId: "fixture-production", publicKey: CURRENT },
    ]
    for (const name of ["preview", "production", "staging"] as const) {
      const baseline = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
      })
      const changed = resolveDeploymentProfile(
        { CONDUIT_DEPLOYMENT_PROFILE: name },
        file
      )
      if (name === "production") {
        expect(changed.quantumRouterTrust.pricingUrl).toBe(
          file.quantumRouterTrust.production.pricingUrl!
        )
        expect(changed.quantumRouterTrust.pricingPublicKeys).toBe(
          `fixture-production:${CURRENT}`
        )
        expect(changed.configDigest).not.toBe(baseline.configDigest)
        expect(changed.quantumRouterTrustDigest).not.toBe(
          baseline.quantumRouterTrustDigest
        )
      } else {
        expect(changed.quantumRouterTrust).toEqual(baseline.quantumRouterTrust)
        expect(changed.configDigest).toBe(baseline.configDigest)
        expect(changed.quantumRouterTrustDigest).toBe(
          baseline.quantumRouterTrustDigest
        )
      }
      expect(changed.quantumRouterTreasury).toEqual(
        baseline.quantumRouterTreasury
      )
    }
  })

  it("retains production historical keys independently from preview quote issuance", () => {
    const file = retainedTrustProfile()
    disableTrustProfile(file, "production")
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
    disableTrustProfile(file, "production")
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
