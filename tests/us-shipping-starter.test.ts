import { describe, expect, test } from "bun:test"
import { buildShippingPolicyEventDraft } from "../packages/core/src/protocol/shipping-policy"
import {
  applyUSShippingStarter,
  buildUSShippingStarter,
  getUSStarterArea,
  US_SHIPPING_STARTER,
} from "../apps/merchant/src/lib/usShippingStarter"
import {
  buildShippingPolicyFromDraft,
  createShippingPolicyDraft,
} from "../apps/merchant/src/lib/shippingPolicyForm"
import { getUSGroundAdvantageWarnings } from "../apps/merchant/src/lib/usGroundAdvantageWarnings"

describe("US shipping authoring starter", () => {
  test("matches independently checked nearby, distant, Alaska and Hawaii ZIP pairs", () => {
    expect(getUSStarterArea("94107", "94103")).toBe(0)
    expect(getUSStarterArea("94107", "10001")).toBe(2)
    expect(getUSStarterArea("94107", "96701")).toBe(2)
    expect(getUSStarterArea("96813", "96701")).toBe(0)
    expect(getUSStarterArea("99501", "99701")).toBe(0)
    expect(getUSStarterArea("96701", "96813")).toBe(0)
    expect(getUSStarterArea("96701", "10001")).toBe(2)
  })
  test("compiled postal areas preserve every supported prefix and every exclusion for all origins", () => {
    let largest = 0
    for (const originPrefix of Object.keys(US_SHIPPING_STARTER.originAreas)) {
      const origin = `${originPrefix}01`
      const policy = buildUSShippingStarter(origin)
      const rules = policy.domestic!.rules
      largest = Math.max(
        largest,
        JSON.stringify(buildShippingPolicyEventDraft({ policy })).length
      )
      expect(rules.length).toBeLessThanOrEqual(500)
      const rulesByPrefix = new Map(
        rules.map((rule) => [rule.postalPrefix!, rule])
      )
      const expected: string[] = []
      const actual: string[] = []
      for (let prefix = 0; prefix < 1000; prefix++) {
        const destination = `${String(prefix).padStart(3, "0")}01`
        const area = getUSStarterArea(origin, destination)
        expected.push(
          area === null
            ? ""
            : US_SHIPPING_STARTER.pricesDollars[area]!.map(
                (price) => price * 100
              ).join(",")
        )
        let match: (typeof rules)[number] | undefined
        for (let length = 5; length >= 1; length--) {
          match = rulesByPrefix.get(destination.slice(0, length))
          if (match) break
        }
        actual.push(match?.bands.map((band) => band.priceMinor).join(",") ?? "")
      }
      expect(actual).toEqual(expected)
      expect(rules.some((rule) => "96799".startsWith(rule.postalPrefix!))).toBe(
        false
      )
      expect(rules.some((rule) => "96798".startsWith(rule.postalPrefix!))).toBe(
        true
      )
    }
    expect(largest).toBeLessThan(110_000)
    console.info(`US starter: maximum signed-event draft ${largest} characters`)
  }, 60_000)
  test("source bands are conservative whole-dollar ceilings of the referenced seasonal retail envelope", () => {
    // Independent reference samples: highest zone in each suggested group, tier endpoints.
    const maxima = [
      [8.8, 11.1, 13.5, 16.6],
      [9.5, 12.1, 15.85, 21.0],
      [10.2, 13.65, 19.8, 27.45],
    ]
    expect(US_SHIPPING_STARTER.pricesDollars).toEqual(
      maxima.map((row) => row.map(Math.ceil))
    )
    expect(US_SHIPPING_STARTER.maxWeightGrams).toEqual(
      [8, 16, 32, 80].map((ounces) => Math.floor(ounces * 28.349523125))
    )
  })
  test("edits and international USD prices survive without storing the origin ZIP or changing existing policy terms", () => {
    const existing = createShippingPolicyDraft()
    existing.domestic.freeShippingThreshold = "100"
    existing.international = {
      enabled: true,
      freeShippingThreshold: "200",
      rules: [
        {
          id: "ca",
          country: "CA",
          subdivision: "",
          postalPrefix: "",
          bands: [{ id: "band", maxWeight: "1000", price: "20" }],
        },
      ],
    }
    const before = buildUSShippingStarter("94107")
    const edited = buildUSShippingStarter("94107", [
      [10, 13, 15, 18],
      ...US_SHIPPING_STARTER.pricesDollars.slice(1),
    ])
    const applied = applyUSShippingStarter(existing, edited)
    expect(applied.international).toEqual(existing.international)
    expect(
      buildShippingPolicyFromDraft(applied).domestic!.freeShippingThresholdMinor
    ).toBe(10_000)
    expect(JSON.stringify(before)).not.toContain("94107")
    expect(
      before
        .domestic!.rules.filter((rule) =>
          "94103".startsWith(rule.postalPrefix!)
        )
        .sort((a, b) => b.postalPrefix!.length - a.postalPrefix!.length)[0]!
        .bands[0]!.priceMinor
    ).toBe(900)
    expect(
      edited
        .domestic!.rules.filter((rule) =>
          "94103".startsWith(rule.postalPrefix!)
        )
        .sort((a, b) => b.postalPrefix!.length - a.postalPrefix!.length)[0]!
        .bands[0]!.priceMinor
    ).toBe(1000)
    expect(() =>
      applyUSShippingStarter({ ...existing, currency: "SATS" }, edited)
    ).toThrow("review international prices")
    expect(() => buildUSShippingStarter("96799")).toThrow()
    expect(() => buildUSShippingStarter("34001")).toThrow()
  })
  test("small single and multi-item packing examples stay in the referenced weight tier", () => {
    const tier = (grams: number) =>
      US_SHIPPING_STARTER.maxWeightGrams.findIndex((limit) => grams <= limit)
    for (const [weights, measuredPacking] of [
      [[60], 25],
      [[200, 200], 80],
      [[650], 100],
    ] as const) {
      const measured =
        weights.reduce((sum, weight) => sum + weight, 0) + measuredPacking
      const modeled =
        weights.reduce((sum, weight) => sum + weight, 0) + weights.length * 50
      expect(tier(modeled)).toBeGreaterThanOrEqual(tier(measured))
    }
    expect(tier(226)).toBe(0)
    expect(tier(227)).toBe(1)
    expect(tier(453)).toBe(1)
    expect(tier(454)).toBe(2)
    expect(tier(907)).toBe(2)
    expect(tier(908)).toBe(3)
    expect(tier(2268)).toBe(-1)
  })
  test("long, dimensional, oversized and out-of-service parcels get named advisory warnings", () => {
    expect(
      getUSGroundAdvantageWarnings({ length: 56, width: 10, height: 10 }).join()
    ).toContain("22")
    expect(
      getUSGroundAdvantageWarnings({ length: 77, width: 10, height: 10 }).join()
    ).toContain("30")
    expect(
      getUSGroundAdvantageWarnings({ length: 40, width: 40, height: 40 }).join()
    ).toContain("dimensional")
    expect(
      getUSGroundAdvantageWarnings({
        length: 120,
        width: 40,
        height: 40,
      }).join()
    ).toContain("oversized")
    expect(
      getUSGroundAdvantageWarnings({
        length: 140,
        width: 50,
        height: 50,
      }).join()
    ).toContain("exceeds")
    expect(
      getUSGroundAdvantageWarnings({ length: 20, width: 10, height: 5 })
    ).toEqual([])
  })
})
