import type { Product } from "../types"

export type ListingSafetyState =
  | "active"
  | "hidden"
  | "flagged"
  | "blocked"
  | "unsupported"
  | "pending_review"

export type ListingSafetyReasonCode =
  | "merchant_hidden"
  | "missing_market_image"
  | "restricted_tag"
  | "restricted_term"
  | "blocked_term"
  | "unsupported_product_type"
  | "pending_review"
  | "external_decision"

export type ListingSafetyDecisionSource =
  | "client_rules"
  | "merchant_visibility"
  | "human_review"
  | "external_decision"

export interface ListingSafetyReason {
  code: ListingSafetyReasonCode
  label: string
  detail: string
  merchantAction: string
  source: ListingSafetyDecisionSource
}

export interface ListingSafetyEvaluation {
  state: ListingSafetyState
  reasons: ListingSafetyReason[]
  marketVisible: boolean
  purchasable: boolean
  source: ListingSafetyDecisionSource
  evaluatedAt: number
}

export interface ListingSafetyDecision {
  state: Exclude<ListingSafetyState, "active">
  reasons: ListingSafetyReason[]
  source: Exclude<ListingSafetyDecisionSource, "client_rules">
  evaluatedAt?: number
}

type ListingSafetyRule = {
  id: string
  state: "flagged" | "blocked"
  code: "restricted_tag" | "restricted_term" | "blocked_term"
  label: string
  detail: string
  merchantAction: string
  tags: string[]
  terms: string[]
}

const TAG_ONLY_RULES: ListingSafetyRule[] = [
  {
    id: "restricted-adult",
    state: "flagged",
    code: "restricted_tag",
    label: "Restricted adult category",
    detail:
      "This listing uses an adult or explicit category tag that is suppressed during the beta launch.",
    merchantAction:
      "Remove the restricted category tag or edit the listing for a general audience.",
    tags: ["adult", "explicit", "nsfw", "pornography"],
    terms: [],
  },
]

const LAUNCH_SAFETY_RULES: ListingSafetyRule[] = [
  {
    id: "restricted-weapons",
    state: "flagged",
    code: "restricted_term",
    label: "Restricted goods term",
    detail:
      "This listing includes a restricted goods term that is suppressed during the beta launch.",
    merchantAction:
      "Edit the title, description, or tags so the listing clearly avoids restricted goods.",
    tags: [
      "weapon",
      "weapons",
      "firearm",
      "firearms",
      "ammunition",
      "ammo",
      "explosive",
      "explosives",
    ],
    terms: [
      "firearm",
      "firearms",
      "ammunition",
      "explosive",
      "explosives",
      "controlled weapon",
    ],
  },
  {
    id: "restricted-substances",
    state: "flagged",
    code: "restricted_term",
    label: "Restricted substance term",
    detail:
      "This listing includes a controlled-substance term that is suppressed during the beta launch.",
    merchantAction:
      "Edit the title, description, or tags so the listing clearly avoids controlled substances.",
    tags: [
      "controlled-substance",
      "controlled-substances",
      "narcotic",
      "narcotics",
      "illegal-drugs",
    ],
    terms: [
      "controlled substance",
      "controlled substances",
      "narcotic",
      "narcotics",
      "illegal drug",
      "illegal drugs",
    ],
  },
  {
    id: "blocked-counterfeit-stolen",
    state: "blocked",
    code: "blocked_term",
    label: "Blocked listing term",
    detail:
      "This listing includes counterfeit or stolen-goods language that is blocked in Conduit surfaces.",
    merchantAction:
      "Remove counterfeit or stolen-goods language before publishing a Market-visible listing.",
    tags: ["counterfeit", "stolen"],
    terms: ["counterfeit", "stolen goods", "stolen item", "stolen items"],
  },
]

const STATE_RANK: Record<ListingSafetyState, number> = {
  active: 0,
  hidden: 1,
  pending_review: 2,
  flagged: 3,
  unsupported: 4,
  blocked: 5,
}

function isValidMarketImageUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

export function hasMarketVisibleListingImage(
  product: Pick<Product, "images">
): boolean {
  return product.images.some((image) => isValidMarketImageUrl(image.url))
}

function normalizeRuleText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function textIncludesTerm(text: string, term: string): boolean {
  const normalizedText = ` ${normalizeRuleText(text)} `
  const normalizedTerm = normalizeRuleText(term)
  return normalizedTerm ? normalizedText.includes(` ${normalizedTerm} `) : false
}

function getRuleMatches(product: Product, rule: ListingSafetyRule): string[] {
  const normalizedTags = new Set(
    product.tags.map((tag) => normalizeRuleText(tag)).filter(Boolean)
  )
  const matchedTags = rule.tags.filter((tag) =>
    normalizedTags.has(normalizeRuleText(tag))
  )
  const haystack = `${product.title}\n${product.summary ?? ""}`
  const matchedTerms = rule.terms.filter((term) =>
    textIncludesTerm(haystack, term)
  )
  return [...matchedTags, ...matchedTerms]
}

function reasonFromRule(rule: ListingSafetyRule): ListingSafetyReason {
  return {
    code: rule.code,
    label: rule.label,
    detail: rule.detail,
    merchantAction: rule.merchantAction,
    source: "client_rules",
  }
}

function getMostSevereState(states: ListingSafetyState[]): ListingSafetyState {
  return states.reduce<ListingSafetyState>(
    (highest, state) =>
      STATE_RANK[state] > STATE_RANK[highest] ? state : highest,
    "active"
  )
}

export function evaluateListingSafety(
  product: Product,
  decision?: ListingSafetyDecision | null
): ListingSafetyEvaluation {
  const evaluatedAt = Date.now()

  if (decision) {
    return {
      state: decision.state,
      reasons: decision.reasons,
      marketVisible: false,
      purchasable: false,
      source: decision.source,
      evaluatedAt: decision.evaluatedAt ?? evaluatedAt,
    }
  }

  const reasons: ListingSafetyReason[] = []
  const states: ListingSafetyState[] = []

  if (product.visibility !== "public") {
    states.push("hidden")
    reasons.push({
      code: "merchant_hidden",
      label: "Hidden by merchant",
      detail: "This listing is not marked public by the merchant.",
      merchantAction:
        "Publish the listing as public when it should appear in Market.",
      source: "merchant_visibility",
    })
  }

  if (!hasMarketVisibleListingImage(product)) {
    states.push("hidden")
    reasons.push({
      code: "missing_market_image",
      label: "Missing Market image",
      detail: "Market listings need at least one http or https image URL.",
      merchantAction:
        "Add a valid image URL before this listing can appear in Market.",
      source: "client_rules",
    })
  }

  if (product.type !== "simple") {
    states.push("unsupported")
    reasons.push({
      code: "unsupported_product_type",
      label: "Unsupported listing type",
      detail: "This client currently supports simple product listings only.",
      merchantAction:
        "Publish this as a simple listing or wait for variable listing support.",
      source: "client_rules",
    })
  }

  for (const rule of [...TAG_ONLY_RULES, ...LAUNCH_SAFETY_RULES]) {
    if (getRuleMatches(product, rule).length === 0) continue
    states.push(rule.state)
    reasons.push(reasonFromRule(rule))
  }

  const state = getMostSevereState(states)
  return {
    state,
    reasons,
    marketVisible: state === "active",
    purchasable: state === "active",
    source: "client_rules",
    evaluatedAt,
  }
}

export function isListingMarketVisible(
  evaluation: Pick<ListingSafetyEvaluation, "marketVisible">
): boolean {
  return evaluation.marketVisible
}

export function isListingPurchasable(
  evaluation: Pick<ListingSafetyEvaluation, "purchasable">
): boolean {
  return evaluation.purchasable
}

export function getListingSafetyDisplay(
  evaluation: Pick<ListingSafetyEvaluation, "state" | "reasons">
): {
  label: string
  summary: string
  merchantAction: string
  tone: "success" | "warning" | "error" | "info" | "neutral"
} {
  const firstReason = evaluation.reasons[0]

  switch (evaluation.state) {
    case "active":
      return {
        label: "Active",
        summary: "Visible in Market and available for checkout.",
        merchantAction: "No action needed.",
        tone: "success",
      }
    case "hidden":
      return {
        label: "Hidden",
        summary: firstReason?.detail ?? "This listing is hidden from Market.",
        merchantAction:
          firstReason?.merchantAction ??
          "Update the listing before publishing.",
        tone: "warning",
      }
    case "flagged":
      return {
        label: "Flagged",
        summary:
          firstReason?.detail ??
          "This listing is suppressed from Market during review.",
        merchantAction:
          firstReason?.merchantAction ??
          "Edit the listing to resolve the flagged content.",
        tone: "warning",
      }
    case "blocked":
      return {
        label: "Blocked",
        summary:
          firstReason?.detail ??
          "This listing is blocked from Market and checkout.",
        merchantAction:
          firstReason?.merchantAction ??
          "Edit or remove the listing before it can be visible.",
        tone: "error",
      }
    case "unsupported":
      return {
        label: "Unsupported",
        summary:
          firstReason?.detail ??
          "This listing cannot be safely interpreted by the current client.",
        merchantAction:
          firstReason?.merchantAction ??
          "Update the listing to a supported format.",
        tone: "error",
      }
    case "pending_review":
      return {
        label: "Pending review",
        summary:
          firstReason?.detail ??
          "This listing is waiting for review before it appears in Market.",
        merchantAction:
          firstReason?.merchantAction ?? "Wait for review or edit the listing.",
        tone: "info",
      }
  }
}
