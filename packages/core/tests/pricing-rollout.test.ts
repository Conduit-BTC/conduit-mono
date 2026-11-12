import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "bun:test"
import {
  checkoutSparkPublicTrustDigest,
  resolveCheckoutSparkPricingPolicy,
  resolveCheckoutSparkPublicTrust,
} from "../src/checkout-spark-deployment-trust"
import { defineCheckoutSparkDeploymentTrust } from "../../../scripts/vite/build_info"
import {
  loadPagesProfiles,
  resolveDeploymentProfile,
} from "../../../scripts/vite/deployment_profile"

const legacyTrust = {
  receiverContracts: "[]",
  pricingUrl: "https://pricing.example.test/api/checkout-spark-pricing",
  pricingPublicKeys: "",
}

describe("pricing policy rollout", () => {
  it("keeps signed-v1 as the default and preserves its legacy trust digest", () => {
    const legacyDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "conduit-checkout-spark-public-trust-v1",
          legacyTrust.receiverContracts,
          legacyTrust.pricingUrl,
          legacyTrust.pricingPublicKeys,
        ])
      )
      .digest("hex")
    expect(resolveCheckoutSparkPricingPolicy(undefined)).toBe("signed-v1")
    expect(checkoutSparkPublicTrustDigest(legacyTrust)).toBe(legacyDigest)
    expect(
      checkoutSparkPublicTrustDigest({
        ...legacyTrust,
        pricingPolicy: "signed-v1",
      })
    ).toBe(legacyDigest)
    expect(
      resolveCheckoutSparkPublicTrust({
        deploymentProfile: "production",
        compiledDigest: legacyDigest,
        configuration: legacyTrust,
      }).pricingPolicy
    ).toBe("signed-v1")
  })

  it("binds an explicitly selected historical policy to managed trust", () => {
    const historicalTrust = {
      ...legacyTrust,
      pricingPolicy: "invoice-historical-1pct-v1",
    }
    const digest = checkoutSparkPublicTrustDigest(historicalTrust)
    expect(digest).not.toBe(checkoutSparkPublicTrustDigest(legacyTrust))
    expect(
      resolveCheckoutSparkPublicTrust({
        deploymentProfile: "preview",
        compiledDigest: digest,
        configuration: historicalTrust,
      })
    ).toEqual(historicalTrust)
  })

  it("selects historical pricing for mainnet releases while staging remains signed", () => {
    const preview = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "preview",
    })
    const production = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "production",
    })
    const staging = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "staging",
    })
    expect(preview.quantumRouterTrust.pricingPolicy).toBe(
      "invoice-historical-1pct-v1"
    )
    expect(production.quantumRouterTrust.pricingPolicy).toBe(
      "invoice-historical-1pct-v1"
    )
    expect(staging.quantumRouterTrust.pricingPolicy).toBe("signed-v1")
    for (const profile of [preview, production, staging]) {
      const definitions = defineCheckoutSparkDeploymentTrust(profile)
      expect(
        JSON.parse(
          definitions["import.meta.env.VITE_CHECKOUT_SPARK_PRICING_POLICY"]!
        )
      ).toBe(profile.quantumRouterTrust.pricingPolicy)
      expect(
        JSON.parse(
          definitions[
            "import.meta.env.VITE_CHECKOUT_SPARK_PUBLIC_TRUST_DIGEST"
          ]!
        )
      ).toBe(checkoutSparkPublicTrustDigest(profile.quantumRouterTrust))
    }
    expect(preview.quantumRouterTrust.pricingUrl).toBe("")
    expect(production.quantumRouterTrust.pricingUrl).toBe("")
    expect(production.quantumRouterTrust.pricingPublicKeys).not.toBe("")
  })

  it("retains verification keyrings without managed issuance endpoints", () => {
    const profiles = loadPagesProfiles()
    for (const name of ["preview", "production"] as const) {
      expect(profiles.quantumRouterTrust[name].pricingUrl).toBeNull()
      const profile = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
      })
      const definitions = defineCheckoutSparkDeploymentTrust(profile)
      expect(profile.quantumRouterTrust.pricingUrl).toBe("")
      expect(profile.quantumRouterTrust.pricingPolicy).toBe(
        "invoice-historical-1pct-v1"
      )
      expect(
        JSON.parse(
          definitions["import.meta.env.VITE_CHECKOUT_SPARK_PRICING_URL"]!
        )
      ).toBe("")
      expect(
        JSON.parse(
          definitions[
            "import.meta.env.VITE_CHECKOUT_SPARK_PRICING_PUBLIC_KEYS"
          ]!
        )
      ).toBe(profile.quantumRouterTrust.pricingPublicKeys)
      expect(profile.quantumRouterTrust.pricingPublicKeys).not.toBe("")
    }
  })

  for (const policy of ["signed-v1", "invoice-historical-1pct-v1"] as const) {
    it(`reports the explicit local ${policy} policy through the runtime probe`, () => {
      const local = resolveDeploymentProfile({
        VITE_CHECKOUT_SPARK_PRICING_POLICY: policy,
      })
      expect(local.quantumRouterTrust.pricingPolicy).toBe(policy)
      expect(defineCheckoutSparkDeploymentTrust(local)).toEqual({})
      const probeUrl = new URL(
        "../../../scripts/vite/checkout_spark_trust_probe.ts",
        import.meta.url
      ).href
      const child = spawnSync(
        process.execPath,
        [
          "--no-env-file",
          "--eval",
          `const { readCompiledCheckoutSparkPublicTrust } = await import(${JSON.stringify(probeUrl)}); console.log(JSON.stringify(readCompiledCheckoutSparkPublicTrust().pricingPolicy));`,
        ],
        {
          env: {
            ...process.env,
            VITE_DEPLOYMENT_PROFILE: "local",
            VITE_CHECKOUT_SPARK_PRICING_POLICY: policy,
          },
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        }
      )
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(0)
      expect(child.stderr).toBe("")
      expect(JSON.parse(child.stdout)).toBe(
        local.quantumRouterTrust.pricingPolicy
      )
    }, 15_000)
  }
})
