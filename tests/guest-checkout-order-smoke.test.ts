import "fake-indexeddb/auto"

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import { disconnectNdk, getNdk } from "@conduit/core"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
} from "../packages/core/src/protocol/protected-read-authorization"

import {
  buildGuestCheckoutOrderRumor,
  formatGuestCheckoutOrderSmokeFailure,
  getGuestCheckoutOrderSmokeFailureEvidence,
  parseGuestCheckoutOrderSmokeConfig,
  runGuestCheckoutOrderSmoke,
} from "../scripts/smoke/guest_checkout_order_runner"
import {
  buildGuestCheckoutOrderSmokeArtifact,
  NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
  parseGuestCheckoutOrderSmokeArtifact,
  serializeGuestCheckoutOrderSmokeArtifact,
  UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
} from "../scripts/smoke/guest_checkout_order_evidence"
import {
  applyGuestCheckoutOrderSmokeCleanupOutcome,
  parseGuestCheckoutOrderSmokeEvidenceContext,
} from "../scripts/smoke/guest_checkout_order"
import type { ReadyCheckoutPricing } from "../apps/market/src/lib/checkout-order"
import { CHECKOUT_QUOTE_MAX_AGE_MS } from "../apps/market/src/lib/checkout-payment"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 7])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const GUEST_SIGNER = new NDKPrivateKeySigner(
  nip19.nsecEncode(Uint8Array.from([...new Uint8Array(31), 8]))
)

function environment(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC: nip19.nsecEncode(MERCHANT_SECRET),
    GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: MERCHANT_PUBKEY,
    GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${MERCHANT_PUBKEY}:fixture`,
    GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY: "US",
    GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE: "00000",
    ...overrides,
  }
}

function pricing(
  format: "physical" | "digital" = "digital"
): ReadyCheckoutPricing {
  return {
    status: "ok",
    itemSubtotalSats: 10,
    totalSats: format === "physical" ? 12 : 10,
    totalMsats: format === "physical" ? 12_000 : 10_000,
    shippingCost: {
      status: format === "physical" ? "priced" : "not_required",
      totalSats: format === "physical" ? 2 : 0,
      missingProductIds: [],
    },
    items: [
      {
        productId: `30402:${MERCHANT_PUBKEY}:fixture`,
        title: "Fixture product",
        format,
        quantity: 1,
        priceAtPurchase: 10,
        currency: "SATS",
        shippingCostSats: format === "physical" ? 2 : undefined,
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        sourceShippingCost:
          format === "physical"
            ? {
                amount: 0.2,
                currency: "USD",
                normalizedCurrency: "USD",
              }
            : undefined,
        shippingOptionId:
          format === "physical"
            ? `30406:${MERCHANT_PUBKEY}:shipping`
            : undefined,
        shippingOptionDTag: format === "physical" ? "shipping" : undefined,
        shippingCountries: format === "physical" ? ["US"] : [],
        shippingCountryRules:
          format === "physical"
            ? [
                {
                  code: "US",
                  name: "United States",
                  restrictTo: [],
                  exclude: [],
                },
              ]
            : [],
      },
    ],
    quote: {
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    },
    approximate: true,
  }
}

function identity(orderId = "smoke-order") {
  return {
    kind: "guest_ephemeral" as const,
    orderId,
    merchantPubkey: MERCHANT_PUBKEY,
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_086_400_000,
    pubkey: GUEST_SIGNER.pubkey,
    signer: GUEST_SIGNER,
  }
}

function productRead(
  overrides: {
    source?: "commerce" | "public" | "local_cache"
    stale?: boolean
    degraded?: boolean
    capped?: boolean
    canonicalFreshness?: boolean
    addressId?: string
    product?: Record<string, unknown>
  } = {}
) {
  return {
    data: {
      addressId: overrides.addressId ?? `30402:${MERCHANT_PUBKEY}:fixture`,
      product: {
        pubkey: MERCHANT_PUBKEY,
        title: "Fixture product",
        price: 1,
        currency: "USD",
        sourcePrice: {
          amount: 1,
          currency: "USD",
          normalizedCurrency: "USD",
        },
        type: "simple",
        format: "digital",
        stock: 1,
        shippingCountryRules: [],
        shippingCountries: [],
        ...overrides.product,
      },
    },
    meta: {
      source: overrides.source ?? "commerce",
      stale: overrides.stale ?? false,
      degraded: overrides.degraded ?? false,
      capped: overrides.capped ?? false,
      capabilities: {
        sortModes: ["newest", "price_asc", "price_desc", "updated_at_desc"],
        textSearch: true,
        protectedSummaries: false,
        canonicalFreshness: overrides.canonicalFreshness ?? false,
        cursorPagination: false,
      },
      fetchedAt: 1_700_000_000_000,
    },
  } as never
}

function merchantShippingOptions() {
  return [
    {
      id: `30406:${MERCHANT_PUBKEY}:shipping`,
      pubkey: MERCHANT_PUBKEY,
      dTag: "shipping",
      title: "Standard shipping",
      currency: "USD",
      price: 0,
      countries: ["US"],
      countryRules: [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: [],
        },
      ],
      service: "standard",
      createdAt: 1_700_000_000_000,
    },
  ]
}

function shippingOptionsRead(
  options = merchantShippingOptions(),
  coverage: "complete" | "partial" | "unavailable" = "complete"
) {
  return { options, coverage }
}

function recoveredOrderRead(
  published: { content: string },
  meta: {
    source: "commerce" | "local_cache"
    stale: boolean
    degraded: boolean
    inbox: {
      declarationState: "declared" | "lookup_unavailable"
      coverage: "complete" | "partial" | "unavailable"
      readSource: "declared" | "mixed" | "cache"
    }
  },
  transformPayload: (payload: Record<string, unknown>) => unknown = (payload) =>
    payload
) {
  const payload = transformPayload(JSON.parse(published.content))
  return {
    data: [
      {
        id: "smoke-order",
        orderId: "smoke-order",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: GUEST_SIGNER.pubkey,
        latestAt: 1_700_000_000_000,
        latestType: "order",
        status: null,
        totalSummary: "10 SATS",
        preview: "Order for 10 SATS",
        messageCount: 1,
        messages: [
          {
            id: "rumor-id",
            orderId: "smoke-order",
            type: "order",
            createdAt: 1_700_000_000,
            senderPubkey: GUEST_SIGNER.pubkey,
            recipientPubkey: MERCHANT_PUBKEY,
            rawContent: published.content,
            payload,
          },
        ],
      },
    ],
    meta: {
      plan: "protected_conversation_list",
      fetchedAt: 1_700_000_000_000,
      ...meta,
      capabilities: [],
    },
  } as never
}

describe("guest checkout order smoke", () => {
  afterEach(() => {
    __resetProtectedReadSigner()
    disconnectNdk()
  })

  it("validates that the protected signer owns the product fixture", () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    expect(config.merchantPubkey).toBe(MERCHANT_PUBKEY)
    expect(config.productAddress).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(config.shippingCountry).toBe("US")
  })

  it("uses shipping defaults for blank GitHub environment variables", () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY: " ",
        GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE: "",
      })
    )

    expect(config.shippingCountry).toBe("US")
    expect(config.shippingPostalCode).toBe("00000")
  })

  it("fails invalid dispatches and scopes every fixture value to the smoke step", async () => {
    const workflow = await Bun.file(
      ".github/workflows/guest-checkout-order-smoke.yml"
    ).text()
    const protectedJobStart = workflow.indexOf("create-and-recover-order:")
    const dispatchJob = workflow.slice(0, protectedJobStart)
    expect(workflow).toContain("timeout-minutes: 10")
    expect(dispatchJob).toContain("validate-dispatch:")
    expect(dispatchJob).toContain('"$CONFIRM_ORDER_CREATION" != "true"')
    expect(dispatchJob).toContain('"$DISPATCH_REF" != "refs/heads/main"')
    expect(dispatchJob).toContain("^[0-9a-f]{40}$")
    const runMarker = "        run: |\n"
    const gateStart = dispatchJob.indexOf(runMarker)
    expect(gateStart).toBeGreaterThan(-1)
    const gateScript = dispatchJob
      .slice(gateStart + runMarker.length)
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(/^ {10}/, ""))
      .join("\n")
    for (const testCase of [
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        exitCode: 0,
      },
      {
        confirmation: "false",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/feature",
        sha: "a".repeat(40),
        exitCode: 1,
      },
      {
        confirmation: "true",
        ref: "refs/heads/main",
        sha: "not-a-sha",
        exitCode: 1,
      },
    ]) {
      const gate = Bun.spawnSync({
        cmd: ["bash", "-euo", "pipefail", "-c", gateScript],
        env: {
          PATH: process.env.PATH ?? "",
          CONFIRM_ORDER_CREATION: testCase.confirmation,
          DISPATCH_REF: testCase.ref,
          CANDIDATE_SHA: testCase.sha,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(gate.exitCode).toBe(testCase.exitCode)
    }
    expect(workflow).toContain("needs: validate-dispatch")
    expect(workflow).not.toContain("if: inputs.confirm_order_creation")
    expect(workflow).toContain("ref: ${{ github.sha }}")
    expect(workflow).toContain("fetch-depth: 1")
    expect(workflow).toContain("persist-credentials: false")
    expect(workflow).toContain('actual_sha="$(git rev-parse HEAD)"')
    const smokeStepStart = workflow.indexOf(
      "- name: Create and recover encrypted guest order"
    )
    const evidenceStepStart = workflow.indexOf(
      "- name: Validate redacted smoke evidence"
    )
    expect(smokeStepStart).toBeGreaterThan(-1)
    expect(evidenceStepStart).toBeGreaterThan(smokeStepStart)
    const setupSteps = workflow.slice(0, smokeStepStart)
    const smokeStep = workflow.slice(smokeStepStart, evidenceStepStart)
    const fixtureNames = [
      "GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY",
      "GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS",
      "GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY",
      "GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE",
      "GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS",
      "GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS",
      "GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC",
    ]

    for (const name of fixtureNames) {
      expect(setupSteps).not.toContain(name)
      expect(smokeStep).toContain(name)
    }
    for (const name of [
      "GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA",
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID",
      "GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT",
      "GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH",
    ]) {
      expect(setupSteps).not.toContain(name)
      expect(smokeStep).toContain(name)
    }
    expect(dispatchJob).not.toContain("GUEST_CHECKOUT_SMOKE_")
    expect(smokeStep).toContain(
      "${{ vars.GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS }}"
    )
    expect(smokeStep).toContain(
      "${{ vars.GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS }}"
    )
    expect(workflow).toContain("id: validate_evidence")
    expect(workflow).toContain("if: always()")
    expect(workflow).toContain("EXPECTED_SHA: ${{ github.sha }}")
    expect(workflow).toContain("EXPECTED_RUN_ID: ${{ github.run_id }}")
    expect(workflow).toContain(
      "EXPECTED_RUN_ATTEMPT: ${{ github.run_attempt }}"
    )
    expect(workflow).toContain(
      '"$EVIDENCE_PATH" "$EXPECTED_SHA" "$EXPECTED_RUN_ID"'
    )
    expect(workflow).toContain(
      "if: always() && steps.validate_evidence.outcome == 'success'"
    )
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    )
    expect(workflow).toContain("name: guest-checkout-order-evidence")
    expect(workflow).toContain(
      "path: ${{ runner.temp }}/guest-checkout-order-evidence.json"
    )
    expect(workflow).toContain("if-no-files-found: error")
    expect(workflow).toContain("retention-days: 7")

    const actionReferences = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)]
    expect(actionReferences.length).toBeGreaterThan(0)
    for (const reference of actionReferences) {
      expect(reference[1]).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("rejects signer and product ownership mismatches", () => {
    for (const overrides of [
      { GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY: "d".repeat(64) },
      {
        GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS: `30402:${"e".repeat(64)}:fixture`,
      },
    ]) {
      expect(() =>
        parseGuestCheckoutOrderSmokeConfig(environment(overrides))
      ).toThrow()
    }
  })

  it("builds a recognizable, schema-valid ephemeral guest order", () => {
    const rumor = buildGuestCheckoutOrderRumor({
      orderId: "smoke-order",
      identity: identity(),
      merchantPubkey: MERCHANT_PUBKEY,
      pricing: pricing("physical"),
      shippingCountry: "US",
      shippingPostalCode: "00000",
      rumorCreatedAt: 1_700_000_123_000,
    })
    const payload = JSON.parse(rumor.content)

    expect(rumor.kind).toBe(16)
    expect(rumor.created_at).toBe(1_700_000_123)
    expect(rumor.tags).toContainEqual(["type", "order"])
    expect(payload.createdAt).toBe(identity().createdAt)
    expect(payload.buyerIdentityKind).toBe("guest_ephemeral")
    expect(payload.guestContact.email).toEndWith(".invalid")
    expect(payload.note).toContain("do not fulfill")
    expect(payload.items[0].productId).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.items[0].sourceShippingCost).toEqual({
      amount: 0.2,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
  })

  it("preserves manual-shipping undefined item costs", () => {
    const manualPricing = pricing("physical")
    manualPricing.totalSats = 10
    manualPricing.totalMsats = 10_000
    manualPricing.shippingCost = {
      status: "manual",
      totalSats: 0,
      missingProductIds: [manualPricing.items[0]!.productId],
    }
    manualPricing.items[0]!.shippingCostSats = undefined
    manualPricing.items[0]!.sourceShippingCost = undefined

    const rumor = buildGuestCheckoutOrderRumor({
      orderId: "smoke-order",
      identity: identity(),
      merchantPubkey: MERCHANT_PUBKEY,
      pricing: manualPricing,
      shippingCountry: "US",
      shippingPostalCode: "00000",
      rumorCreatedAt: 1_700_000_123_000,
    })
    const payload = JSON.parse(rumor.content)

    expect(payload.shippingCostStatus).toBe("manual")
    expect(payload).not.toHaveProperty("shippingCostSats")
    expect(payload.items[0]).not.toHaveProperty("shippingCostSats")
    expect(payload.items[0]).not.toHaveProperty("sourceShippingCost")
  })

  it("fails closed when the exact listing read falls back to cached product data", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            source: "local_cache",
            stale: true,
            degraded: true,
            canonicalFreshness: false,
          }),
        publishOrder: async () => {
          published = true
          throw new Error("Cached product data must not reach publication.")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "product_read",
      summary: "Guest checkout order smoke inconclusive at product_read.",
    })
    expect(published).toBe(false)
  })

  it("fails closed when the exact listing read has incomplete deletion coverage", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            degraded: true,
            canonicalFreshness: false,
          }),
        publishOrder: async () => {
          published = true
          throw new Error("Partial product data must not reach publication.")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke inconclusive at product_read."
    )
    expect(published).toBe(false)
  })

  it("revalidates exact product terms immediately before publication", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    for (const testCase of [
      {
        secondRead: productRead({
          product: {
            price: 2,
            sourcePrice: {
              amount: 2,
              currency: "USD",
              normalizedCurrency: "USD",
            },
          },
        }),
        status: "failed",
      },
      {
        secondRead: productRead({ product: { stock: 0 } }),
        status: "failed",
      },
      {
        secondRead: productRead({ degraded: true }),
        status: "inconclusive",
      },
      {
        secondRead: productRead({
          product: {
            specifications: [{ key: "color", value: "blue" }],
          },
        }),
        status: "failed",
      },
    ] as const) {
      let productReads = 0
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => {
            productReads += 1
            return productReads === 1 ? productRead() : testCase.secondRead
          },
          getPricingRate: async () => ({
            rate: 100_000,
            fetchedAt: 1_700_000_000_000,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }),
          createOrderId: () => "smoke-order",
          createGuestIdentity: () => identity(),
          publishOrder: async () => {
            published = true
            throw new Error("Changed product terms must not be published.")
          },
          nowMs: () => 1_700_000_000_000,
        })
      } catch (error) {
        failure = error
      }

      expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
        status: testCase.status,
        stage: "product_read",
        summary: `Guest checkout order smoke ${testCase.status} at product_read.`,
      })
      expect(productReads).toBe(2)
      expect(published).toBe(false)
    }
  })

  it("evaluates a delayed pricing quote with the post-fetch clock", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const quoteFetchedAt = 1_700_000_000_000
    let now = quoteFetchedAt
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => {
          now = quoteFetchedAt + CHECKOUT_QUOTE_MAX_AGE_MS + 1
          return {
            rate: 100_000,
            fetchedAt: quoteFetchedAt,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }
        },
        publishOrder: async () => {
          published = true
          throw new Error("A stale quote must not be published.")
        },
        nowMs: () => now,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "product_read",
      summary: "Guest checkout order smoke failed at product_read.",
    })
    expect(published).toBe(false)
  })

  it("rejects unsupported and excluded physical shipping destinations", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    for (const shippingCountryRules of [
      [
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
      [
        {
          code: "US",
          name: "United States",
          restrictTo: [],
          exclude: ["00000"],
        },
      ],
    ]) {
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () =>
            productRead({
              product: {
                format: "physical",
                shippingCostSats: 2,
                shippingCountries: shippingCountryRules.map(
                  (rule) => rule.code
                ),
                shippingCountryRules,
              },
            }),
          publishOrder: async () => {
            published = true
            throw new Error("An ineligible order must not be published.")
          },
        })
      } catch (error) {
        failure = error
      }

      expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
        "Guest checkout order smoke failed at product_read."
      )
      expect(published).toBe(false)
    }
  })

  it("uses merchant kind 30406 rules for a physical listing without an embedded snapshot", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let shippingQuery: string | null = null
    let strictShippingRead = false
    let shippingReads = 0
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            product: {
              format: "physical",
              shippingCostSats: 2,
              shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
              shippingOptionDTag: "shipping",
              shippingCountries: [],
              shippingCountryRules: [],
            },
          }),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        getShippingOptions: async (merchantPubkey, options) => {
          shippingReads += 1
          shippingQuery = merchantPubkey
          strictShippingRead = options.strict === true
          return shippingOptionsRead()
        },
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async () => {
          published = true
          throw new Error("Stop after shipping validation.")
        },
        nowMs: () => 1_700_000_123_000,
      })
    } catch (error) {
      failure = error
    }

    expect(shippingQuery).toBe(MERCHANT_PUBKEY)
    expect(strictShippingRead).toBe(true)
    expect(shippingReads).toBe(2)
    expect(published).toBe(true)
    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at order_publish."
    )
  })

  it("revalidates referenced shipping evidence immediately before publication", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const initialShippingRead = shippingOptionsRead()
    const changedShippingRead = shippingOptionsRead([
      {
        ...merchantShippingOptions()[0]!,
        price: 1,
        createdAt: 1_700_000_001_000,
      },
    ])

    for (const testCase of [
      { secondRead: changedShippingRead, status: "failed" },
      {
        secondRead: shippingOptionsRead([], "complete"),
        status: "inconclusive",
      },
      {
        secondRead: shippingOptionsRead(merchantShippingOptions(), "partial"),
        status: "inconclusive",
      },
    ] as const) {
      let shippingReads = 0
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () =>
            productRead({
              product: {
                format: "physical",
                shippingCostSats: 2,
                shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
                shippingOptionDTag: "shipping",
                shippingCountries: [],
                shippingCountryRules: [],
              },
            }),
          getPricingRate: async () => ({
            rate: 100_000,
            fetchedAt: 1_700_000_000_000,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }),
          getShippingOptions: async () => {
            shippingReads += 1
            return shippingReads === 1
              ? initialShippingRead
              : testCase.secondRead
          },
          createOrderId: () => "smoke-order",
          createGuestIdentity: () => identity(),
          publishOrder: async () => {
            published = true
            throw new Error("Stale shipping evidence must not publish.")
          },
          nowMs: () => 1_700_000_123_000,
        })
      } catch (error) {
        failure = error
      }

      expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
        status: testCase.status,
        stage: "product_read",
        summary: `Guest checkout order smoke ${testCase.status} at product_read.`,
      })
      expect(shippingReads).toBe(2)
      expect(published).toBe(false)
    }
  })

  it("rejects a pricing quote that expires during final shipping revalidation", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const quoteFetchedAt = 1_700_000_000_000
    let now = quoteFetchedAt
    let shippingReads = 0
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            product: {
              format: "physical",
              shippingCostSats: 2,
              shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
              shippingOptionDTag: "shipping",
              shippingCountries: [],
              shippingCountryRules: [],
            },
          }),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: quoteFetchedAt,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        getShippingOptions: async () => {
          shippingReads += 1
          if (shippingReads === 2) {
            now = quoteFetchedAt + CHECKOUT_QUOTE_MAX_AGE_MS + 1
          }
          return shippingOptionsRead()
        },
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async () => {
          published = true
          throw new Error("An expired quote must not publish.")
        },
        nowMs: () => now,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "product_read",
      summary: "Guest checkout order smoke failed at product_read.",
    })
    expect(shippingReads).toBe(2)
    expect(published).toBe(false)
  })

  it("rejects referenced shipping that production guest checkout leaves manual", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let shippingReads = 0
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            product: {
              format: "physical",
              shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
              shippingOptionDTag: "shipping",
              shippingCountries: [],
              shippingCountryRules: [],
            },
          }),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        getShippingOptions: async () => {
          shippingReads += 1
          return shippingOptionsRead([
            { ...merchantShippingOptions()[0]!, price: 0.2 },
          ])
        },
        publishOrder: async () => {
          published = true
          throw new Error("Manual guest shipping must not publish.")
        },
        nowMs: () => 1_700_000_000_000,
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "failed",
      stage: "product_read",
      summary: "Guest checkout order smoke failed at product_read.",
    })
    expect(shippingReads).toBe(1)
    expect(published).toBe(false)
  })

  it("does not let an unrelated merchant shipping zone authorize the fixture", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const referencedOption = {
      ...merchantShippingOptions()[0]!,
      countries: ["CA"],
      countryRules: [
        {
          code: "CA",
          name: "Canada",
          restrictTo: [],
          exclude: [],
        },
      ],
    }
    const unrelatedOption = {
      ...merchantShippingOptions()[0]!,
      id: `30406:${MERCHANT_PUBKEY}:unrelated`,
      dTag: "unrelated",
    }
    let published = false
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () =>
          productRead({
            product: {
              format: "physical",
              shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
              shippingOptionDTag: "shipping",
              shippingCountries: [],
              shippingCountryRules: [],
            },
          }),
        getShippingOptions: async () =>
          shippingOptionsRead([referencedOption, unrelatedOption]),
        publishOrder: async () => {
          published = true
          throw new Error("An unrelated shipping zone must not authorize.")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at product_read."
    )
    expect(published).toBe(false)
  })

  it("reports incomplete, missing, or ambiguous merchant shipping evidence as inconclusive", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())

    for (const getShippingOptions of [
      async () => shippingOptionsRead([], "complete"),
      async () =>
        shippingOptionsRead([
          merchantShippingOptions()[0]!,
          { ...merchantShippingOptions()[0]! },
        ]),
      async () => shippingOptionsRead(merchantShippingOptions(), "partial"),
      async () => shippingOptionsRead(merchantShippingOptions(), "unavailable"),
      async () => {
        throw new Error("Shipping relay lookup failed.")
      },
    ]) {
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () =>
            productRead({
              product: {
                format: "physical",
                shippingOptionId: `30406:${MERCHANT_PUBKEY}:shipping`,
                shippingOptionDTag: "shipping",
                shippingCountries: [],
                shippingCountryRules: [],
              },
            }),
          getShippingOptions,
          publishOrder: async () => {
            published = true
            throw new Error("Missing shipping evidence must not publish.")
          },
        })
      } catch (error) {
        failure = error
      }

      expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
        status: "inconclusive",
        stage: "product_read",
        summary: "Guest checkout order smoke inconclusive at product_read.",
      })
      expect(published).toBe(false)
    }
  })

  it("rejects every non-simple fixture before pricing or publish", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const nonSimpleReads = [
      productRead({ product: { type: "variable" } }),
      productRead({ product: { type: "variation" } }),
      productRead({
        addressId: `30402:${MERCHANT_PUBKEY}:projected-parent`,
        product: { type: "variable" },
      }),
    ]

    for (const read of nonSimpleReads) {
      let pricingRequested = false
      let published = false
      let failure: unknown

      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => read,
          getPricingRate: async () => {
            pricingRequested = true
            throw new Error("Non-simple fixtures must not request pricing.")
          },
          publishOrder: async () => {
            published = true
            throw new Error("Non-simple fixtures must not be published.")
          },
        })
      } catch (error) {
        failure = error
      }

      expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
        "Guest checkout order smoke failed at product_read."
      )
      expect(pricingRequested).toBe(false)
      expect(published).toBe(false)
    }
  })

  it("classifies order id and guest identity failures as order_build", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    const constructionFailures = [
      {
        createOrderId: () => {
          throw new Error("Order id generation failed")
        },
      },
      {
        createGuestIdentity: () => {
          throw new Error("Guest identity generation failed")
        },
      },
    ]

    for (const constructionFailure of constructionFailures) {
      let failure: unknown
      try {
        await runGuestCheckoutOrderSmoke(config, {
          getProduct: async () => productRead(),
          getPricingRate: async () => ({
            rate: 100_000,
            fetchedAt: 1_700_000_000_000,
            source: "mempool",
            fiatUsdRates: {},
            fiatSource: "frankfurter",
          }),
          nowMs: () => 1_700_000_000_000,
          ...constructionFailure,
        })
      } catch (error) {
        failure = error
      }

      expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
        "Guest checkout order smoke failed at order_build."
      )
    }
  })

  it("requires exact product and complete merchant inbox reads", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(environment())
    let productQuery: {
      productId: string
      revalidateCanonical?: boolean
    } | null = null
    let published:
      | Parameters<
          NonNullable<
            Parameters<typeof runGuestCheckoutOrderSmoke>[1]
          >["publishOrder"]
        >[0]
      | null = null
    let recoveryAuthorizationMethod: string | null = null
    let recoveryCalls = 0
    let productReads = 0
    let relayEvidence: unknown

    const result = await runGuestCheckoutOrderSmoke(config, {
      getProduct: async (query) => {
        productReads += 1
        productQuery = query
        return productRead({
          product: {
            specifications: [
              { key: "color", value: "blue" },
              { key: "size", value: "small" },
            ],
          },
        })
      },
      getPricingRate: async () => ({
        rate: 100_000,
        fetchedAt: 1_700_000_000_000,
        source: "mempool",
        fiatUsdRates: {},
        fiatSource: "frankfurter",
      }),
      createOrderId: () => "smoke-order",
      createGuestIdentity: () => identity(),
      publishOrder: async (rumor) => {
        published = rumor
        return {
          buyerSelfCopyError: null,
          localCacheError: null,
          deliveryRoute: "declared_inbox",
          orderRelayDelivery: {
            relayDelivery: [
              {
                relayUrl: "wss://acked.example",
                status: "acked",
                attemptCount: 1,
              },
              {
                relayUrl: "wss://retry.example",
                status: "timed_out",
                attemptCount: 2,
              },
            ],
          },
        } as never
      },
      onRelayEvidence: (evidence) => {
        relayEvidence = evidence
      },
      getMerchantOrders: async () => {
        recoveryCalls += 1
        recoveryAuthorizationMethod =
          getProtectedReadAuthorization(MERCHANT_PUBKEY)?.signer.authMethod ??
          null
        if (!published) throw new Error("Order was not published")
        const recoveryMeta: Parameters<typeof recoveredOrderRead>[1] = [
          {
            source: "local_cache",
            stale: true,
            degraded: true,
            inbox: {
              declarationState: "lookup_unavailable",
              coverage: "unavailable",
              readSource: "cache",
            },
          },
          {
            source: "commerce",
            stale: false,
            degraded: true,
            inbox: {
              declarationState: "declared",
              coverage: "partial",
              readSource: "mixed",
            },
          },
          {
            source: "commerce",
            stale: false,
            degraded: false,
            inbox: {
              declarationState: "declared",
              coverage: "complete",
              readSource: "declared",
            },
          },
        ][Math.min(recoveryCalls - 1, 2)]!
        return recoveredOrderRead(published, recoveryMeta)
      },
      nowMs: () => 1_700_000_000_000,
      sleep: async () => {},
    })

    expect(result).toEqual({ status: "passed" })
    expect(productQuery).toEqual({
      productId: `30402:${MERCHANT_PUBKEY}:fixture`,
    })
    expect(productReads).toBe(2)
    expect(relayEvidence).toEqual({
      relayAttemptCount: 3,
      relayAcknowledgementCount: 1,
      relayObservation: "available",
    })
    expect(JSON.stringify(relayEvidence)).not.toContain("relayUrl")
    expect(recoveryCalls).toBe(3)
    expect(published).not.toBeNull()
    const payload = JSON.parse(published!.content)
    expect(payload.items[0].priceAtPurchase).toBe(1_000)
    expect(payload.items[0].sourcePrice).toEqual({
      amount: 1,
      currency: "USD",
      normalizedCurrency: "USD",
    })
    expect(payload.items[0].selectedSpecifications).toEqual([
      { key: "color", value: "blue" },
      { key: "size", value: "small" },
    ])
    expect(payload.pricingQuote).toEqual({
      rate: 100_000,
      fetchedAt: 1_700_000_000_000,
      source: "mempool",
      fiatSource: "frankfurter",
    })
    expect(recoveryAuthorizationMethod).toBe("nip07")
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("reports inconclusive when partial merchant inbox evidence exhausts", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "2",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let published: { content: string } | null = null
    let recoveryCalls = 0
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          recoveryCalls += 1
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(published, {
            source: "commerce",
            stale: false,
            degraded: true,
            inbox: {
              declarationState: "declared",
              coverage: "partial",
              readSource: "mixed",
            },
          })
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(getGuestCheckoutOrderSmokeFailureEvidence(failure)).toEqual({
      status: "inconclusive",
      stage: "merchant_recovery",
      summary: "Guest checkout order smoke inconclusive at merchant_recovery.",
    })
    expect(recoveryCalls).toBe(2)
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("rejects a recovered order when its parsed payload drifts", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "1",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let published: { content: string } | null = null
    let failure: unknown

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async (rumor) => {
          published = rumor
          return { buyerSelfCopyError: null, localCacheError: null }
        },
        getMerchantOrders: async () => {
          if (!published) throw new Error("Order was not published")
          return recoveredOrderRead(
            published,
            {
              source: "commerce",
              stale: false,
              degraded: false,
              inbox: {
                declarationState: "declared",
                coverage: "complete",
                readSource: "declared",
              },
            },
            (payload) => ({
              ...payload,
              note: "Mutated after recovery.",
            })
          )
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at merchant_recovery."
    )
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("releases the protected merchant signer when recovery fails", async () => {
    const config = parseGuestCheckoutOrderSmokeConfig(
      environment({
        GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS: "1",
        GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS: "1",
      })
    )
    let now = 1_700_000_000_000
    let failure: unknown
    let sawProtectedReadAuthorization = false

    try {
      await runGuestCheckoutOrderSmoke(config, {
        getProduct: async () => productRead(),
        getPricingRate: async () => ({
          rate: 100_000,
          fetchedAt: 1_700_000_000_000,
          source: "mempool",
          fiatUsdRates: {},
          fiatSource: "frankfurter",
        }),
        createOrderId: () => "smoke-order",
        createGuestIdentity: () => identity(),
        publishOrder: async () => ({
          buyerSelfCopyError: null,
          localCacheError: null,
        }),
        getMerchantOrders: async () => {
          sawProtectedReadAuthorization ||=
            getProtectedReadAuthorization(MERCHANT_PUBKEY) !== null
          return {
            data: [],
            meta: {
              plan: "protected_conversation_list",
              source: "commerce",
              fetchedAt: now,
              stale: false,
              degraded: false,
              inbox: {
                declarationState: "declared",
                coverage: "complete",
                readSource: "declared",
              },
              capabilities: [],
            },
          } as never
        },
        nowMs: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })
    } catch (error) {
      failure = error
    }

    expect(formatGuestCheckoutOrderSmokeFailure(failure)).toBe(
      "Guest checkout order smoke failed at merchant_recovery."
    )
    expect(sawProtectedReadAuthorization).toBe(true)
    expect(getProtectedReadAuthorization(MERCHANT_PUBKEY)).toBeNull()
    expect(getNdk().signer).toBeUndefined()
  })

  it("formats only a fixed failure stage without credential details", async () => {
    const merchantSecret = environment().GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC!
    let error: unknown
    try {
      parseGuestCheckoutOrderSmokeConfig(
        environment({ GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC: "private-invalid" })
      )
    } catch (caught) {
      error = caught
    }
    const formatted = formatGuestCheckoutOrderSmokeFailure(error)

    expect(formatted).toBe(
      "Guest checkout order smoke failed at configuration."
    )
    expect(formatted).not.toContain(merchantSecret)
    expect(formatted).not.toContain("private-invalid")
  })

  it("builds only fixed-schema, candidate-bound smoke evidence", () => {
    const artifacts = [
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "a".repeat(40),
        workflowRunId: "123",
        workflowRunAttempt: "1",
        outcome: { status: "passed", stage: "complete" },
        relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
        durationMs: 29_999,
      }),
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "b".repeat(40),
        workflowRunId: "124",
        workflowRunAttempt: "2",
        outcome: { status: "failed", stage: "order_publish" },
        relayEvidence: UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
        durationMs: 60_000,
      }),
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "c".repeat(40),
        workflowRunId: "125",
        workflowRunAttempt: "3",
        outcome: { status: "inconclusive", stage: "merchant_recovery" },
        relayEvidence: {
          relayAttemptCount: 3,
          relayAcknowledgementCount: 1,
          relayObservation: "available",
        },
        durationMs: 240_000,
      }),
    ]

    expect(artifacts.map((artifact) => artifact.status)).toEqual([
      "passed",
      "failed",
      "inconclusive",
    ])
    expect(artifacts.map((artifact) => artifact.failureCode)).toEqual([
      null,
      "failed_order_publish",
      "inconclusive_merchant_recovery",
    ])
    expect(artifacts.map((artifact) => artifact.durationBucket)).toEqual([
      "under_30_seconds",
      "60_to_119_seconds",
      "240_seconds_or_more",
    ])
    expect(artifacts[1]).toMatchObject({
      relayAttemptCount: null,
      relayAcknowledgementCount: null,
      relayObservation: "unavailable",
    })

    for (const artifact of artifacts) {
      const serialized = serializeGuestCheckoutOrderSmokeArtifact(artifact)
      expect(parseGuestCheckoutOrderSmokeArtifact(serialized)).toEqual(artifact)
      expect(serialized).not.toContain(MERCHANT_PUBKEY)
      expect(serialized).not.toMatch(
        /nsec|npub|relayUrl|orderId|productId|email|phone|invoice/i
      )
    }
  })

  it("validates evidence context before the smoke runner can start", () => {
    expect(() => parseGuestCheckoutOrderSmokeEvidenceContext({})).toThrow(
      "Smoke evidence configuration is unavailable."
    )
    expect(() =>
      parseGuestCheckoutOrderSmokeEvidenceContext({
        GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "a".repeat(40),
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "invalid",
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
        GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: "/workspace/evidence.json",
      })
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(
      parseGuestCheckoutOrderSmokeEvidenceContext({
        GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "a".repeat(40),
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "123",
        GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
        GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: "/workspace/evidence.json",
      })
    ).toEqual({
      candidateCommitSha: "a".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      evidencePath: "/workspace/evidence.json",
    })
  })

  it("converts a cleanup failure into failed evidence", () => {
    expect(
      applyGuestCheckoutOrderSmokeCleanupOutcome(
        { status: "passed", stage: "complete" },
        true
      )
    ).toEqual({ status: "failed", stage: "cleanup" })
    expect(
      applyGuestCheckoutOrderSmokeCleanupOutcome(
        { status: "inconclusive", stage: "product_read" },
        true
      )
    ).toEqual({ status: "inconclusive", stage: "product_read" })
  })

  it("rejects unsafe or non-allowlisted smoke evidence", () => {
    const artifact = buildGuestCheckoutOrderSmokeArtifact({
      candidateCommitSha: "d".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: "1",
      outcome: { status: "passed", stage: "complete" },
      relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
      durationMs: 1,
    })
    const serialized = serializeGuestCheckoutOrderSmokeArtifact(artifact)

    for (const unsafe of [
      "https://relay.example",
      "wss://relay.example",
      "bunker://connection",
      "nostrconnect://connection",
      "operator@example.invalid",
      "127.0.0.1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      `nsec1${"q".repeat(58)}`,
      `lnbc${"q".repeat(20)}`,
      `nwc:${"q".repeat(20)}`,
      "e".repeat(64),
    ]) {
      expect(() =>
        parseGuestCheckoutOrderSmokeArtifact(
          serialized.replace("guest-checkout-order-evidence", unsafe)
        )
      ).toThrow("Guest checkout order smoke evidence is invalid.")
    }
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(
        JSON.stringify({ ...artifact, unexpected: "unsafe" })
      )
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(() =>
      parseGuestCheckoutOrderSmokeArtifact(
        JSON.stringify({ ...artifact, workflowRunId: 123 })
      )
    ).toThrow("Guest checkout order smoke evidence is invalid.")
    expect(() =>
      buildGuestCheckoutOrderSmokeArtifact({
        candidateCommitSha: "e".repeat(40),
        workflowRunId: "0",
        workflowRunAttempt: "1",
        outcome: { status: "passed", stage: "complete" },
        relayEvidence: NO_GUEST_CHECKOUT_ORDER_RELAY_ATTEMPT,
        durationMs: 1,
      })
    ).toThrow("Guest checkout order smoke evidence is invalid.")
  })

  it("writes redacted failed evidence before the smoke exits nonzero", async () => {
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), "conduit-guest-smoke-evidence-")
    )
    const evidencePath = join(evidenceDirectory, "evidence.json")
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "scripts/smoke/guest_checkout_order.ts"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          GUEST_CHECKOUT_SMOKE_CANDIDATE_SHA: "f".repeat(40),
          GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ID: "123",
          GUEST_CHECKOUT_SMOKE_WORKFLOW_RUN_ATTEMPT: "1",
          GUEST_CHECKOUT_SMOKE_EVIDENCE_PATH: evidencePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(result.exitCode).toBe(1)
      expect(new TextDecoder().decode(result.stderr)).toBe(
        "Guest checkout order smoke failed at configuration.\n"
      )
      const artifact = parseGuestCheckoutOrderSmokeArtifact(
        await Bun.file(evidencePath).text()
      )
      expect(artifact).toMatchObject({
        status: "failed",
        stage: "configuration",
        failureCode: "failed_configuration",
        candidateCommitSha: "f".repeat(40),
        relayAttemptCount: 0,
        relayAcknowledgementCount: 0,
        relayObservation: "available",
      })

      const validEvidence = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/ci/validate_guest_checkout_order_evidence.ts",
          evidencePath,
          "f".repeat(40),
          "123",
          "1",
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(validEvidence.exitCode).toBe(0)

      const misboundEvidence = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/ci/validate_guest_checkout_order_evidence.ts",
          evidencePath,
          "0".repeat(40),
          "123",
          "1",
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(misboundEvidence.exitCode).toBe(1)
      expect(new TextDecoder().decode(misboundEvidence.stderr)).toBe(
        "Guest checkout order smoke evidence is invalid.\n"
      )
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  })

  it("fails evidence preflight before loading fixture configuration", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "scripts/smoke/guest_checkout_order.ts"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toBe(
      "Guest checkout order smoke failed at evidence_configuration.\n"
    )
  })
})
