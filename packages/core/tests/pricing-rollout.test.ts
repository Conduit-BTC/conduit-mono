import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"
import {
  checkoutSparkPublicTrustDigest,
  resolveCheckoutSparkPricingPolicy,
  resolveCheckoutSparkPublicTrust,
} from "../src/checkout-spark-deployment-trust"
import { config } from "../src/config"
import { defineCheckoutSparkDeploymentTrust } from "../../../scripts/vite/build_info"
import { readCompiledCheckoutSparkPublicTrust } from "../../../scripts/vite/checkout_spark_trust_probe"
import { resolveDeploymentProfile } from "../../../scripts/vite/deployment_profile"

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

  it("qualifies preview explicitly while production and staging remain signed", () => {
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
    expect(production.quantumRouterTrust.pricingPolicy).toBe("signed-v1")
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
    expect(preview.quantumRouterTrust.pricingUrl).not.toBe("")
    expect(production.quantumRouterTrust.pricingPublicKeys).not.toBe("")
  })

  it("retains explicit local choice and reports the resolved runtime policy", () => {
    const local = resolveDeploymentProfile({
      VITE_CHECKOUT_SPARK_PRICING_POLICY: "invoice-historical-1pct-v1",
    })
    expect(local.quantumRouterTrust.pricingPolicy).toBe(
      "invoice-historical-1pct-v1"
    )
    expect(defineCheckoutSparkDeploymentTrust(local)).toEqual({})
    expect(readCompiledCheckoutSparkPublicTrust().pricingPolicy).toBe(
      config.checkoutSparkPricingPolicy
    )
  })
})
