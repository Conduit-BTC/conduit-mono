import {
  parseShippingPolicy,
  shippingMoneyToMinorUnits,
  type ShippingPolicy,
} from "@conduit/core"
import reference from "./us-shipping-starter.generated.json"
import {
  buildShippingPolicyFromDraft,
  shippingPolicyToDraft,
  type ShippingPolicyDraft,
} from "./shippingPolicyForm"

export const US_SHIPPING_STARTER = reference
export const US_STARTER_AREA_NAMES = [
  "Nearby",
  "Middle distance",
  "Farther",
] as const
export function getUSStarterArea(
  origin: string,
  destination: string
): number | null {
  if (!/^\d{5}$/.test(origin) || origin === "96799") return null
  const areas =
    reference.originAreas[
      origin.slice(0, 3) as keyof typeof reference.originAreas
    ]
  if (!areas || !/^\d{5}$/.test(destination) || destination === "96799")
    return null
  const area = Number(areas[Number(destination.slice(0, 3))])
  return area ? area - 1 : null
}

/** Compile covered postal defaults and longer overrides; excluded leaves stay absent. */
export function buildUSShippingStarter(
  origin: string,
  prices = reference.pricesDollars
): ShippingPolicy {
  if (getUSStarterArea(origin, origin) === null)
    throw new Error("Enter a supported US five-digit origin ZIP.")
  if (
    prices.length !== 3 ||
    prices.some((row) => row.length !== reference.maxWeightGrams.length)
  )
    throw new Error("Review all starter price bands.")
  const areas =
    reference.originAreas[
      origin.slice(0, 3) as keyof typeof reference.originAreas
    ]
  type Node = {
    prefix: string
    area: number | null
    covered: boolean
    children: Node[]
  }
  function tree(prefix: string): Node {
    if (prefix === "96799")
      return { prefix, area: 0, covered: false, children: [] }
    if (prefix.length >= 3 && !"96799".startsWith(prefix)) {
      const area = Number(areas[Number(prefix.slice(0, 3))])
      return { prefix, area, covered: area !== 0, children: [] }
    }
    const children = Array.from({ length: 10 }, (_, digit) =>
      tree(`${prefix}${digit}`)
    )
    const area = children.every((child) => child.area === children[0]!.area)
      ? children[0]!.area
      : null
    return {
      prefix,
      area,
      covered: children.every((child) => child.covered),
      children,
    }
  }
  type Area = { prefix: string; area: number }
  const memo = new Map<string, Area[]>()
  function plan(node: Node, inherited = 0): Area[] {
    const key = `${node.prefix}:${inherited}`
    const cached = memo.get(key)
    if (cached) return cached
    if (node.area !== null)
      return node.area === 0 || node.area === inherited
        ? []
        : [{ prefix: node.prefix, area: node.area }]
    let best = node.children.flatMap((child) => plan(child, inherited))
    // A broad price can be inherited only by a completely covered subtree.
    // Longer postal overrides keep the exact suggested result at each leaf.
    if (node.covered && node.prefix)
      for (let area = 1; area <= 3; area++) {
        if (area === inherited) continue
        const candidate = [
          { prefix: node.prefix, area },
          ...node.children.flatMap((child) => plan(child, area)),
        ]
        if (candidate.length < best.length) best = candidate
      }
    memo.set(key, best)
    return best
  }
  const groupBands = prices.map((row) =>
    reference.maxWeightGrams.map((maxWeightGrams, index) => ({
      maxWeightGrams,
      priceMinor: shippingMoneyToMinorUnits(row[index]!, "USD"),
    }))
  )
  const rules = plan(tree("")).map(({ prefix, area }) => ({
    country: "US",
    postalPrefix: prefix,
    bands: groupBands[area - 1]!,
  }))
  return parseShippingPolicy({
    version: 2,
    title: "US domestic shipping",
    originCountry: "US",
    currency: "USD",
    domestic: { rules },
    international: null,
  })
}

export function applyUSShippingStarter(
  current: ShippingPolicyDraft,
  policy: ShippingPolicy
): ShippingPolicyDraft {
  if (current.currency !== "USD" && current.international.enabled)
    throw new Error(
      "Set shipping currency to USD and review international prices before applying this starter."
    )
  const next = shippingPolicyToDraft(policy)
  const applied = {
    ...current,
    originCountry: "US",
    currency: "USD",
    domestic: {
      ...next.domestic,
      freeShippingThreshold:
        current.currency === "USD"
          ? current.domestic.freeShippingThreshold
          : "",
    },
  }
  buildShippingPolicyFromDraft(applied)
  return applied
}
