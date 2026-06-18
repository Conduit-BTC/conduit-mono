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

const WARNING_RULES: ListingSafetyRule[] = [
  {
    id: "warning-adult",
    state: "flagged",
    code: "restricted_tag",
    label: "Adult content warning",
    detail:
      "This listing uses adult or explicit category language. It remains active in Conduit alpha, but may be limited by other marketplaces or future policy controls.",
    merchantAction:
      "Confirm the listing is legal and accurately categorized, or edit the tags and copy if this should be general-audience inventory.",
    tags: ["adult", "explicit", "nsfw", "pornography"],
    terms: [
      "adult content",
      "adult material",
      "explicit content",
      "nsfw",
      "pornographic",
    ],
  },
  {
    id: "warning-knives-tools",
    state: "flagged",
    code: "restricted_term",
    label: "Tools or blades warning",
    detail:
      "This listing uses knife, blade, or tool-adjacent language. It remains active in Conduit alpha, but may be limited by other marketplaces or future policy controls.",
    merchantAction:
      "Confirm the listing is legal and ordinary commerce inventory, or clarify the listing copy and tags.",
    tags: [
      "knife",
      "knives",
      "blade",
      "blades",
      "utility-knife",
      "pocket-knife",
      "multi-tool",
      "multitool",
    ],
    terms: [
      "knife",
      "knives",
      "blade",
      "blades",
      "utility knife",
      "pocket knife",
      "multi tool",
      "multitool",
    ],
  },
  {
    id: "warning-substance-adjacent",
    state: "flagged",
    code: "restricted_term",
    label: "Substance-adjacent warning",
    detail:
      "This listing uses lower-confidence substance-adjacent language. It remains active in Conduit alpha, but may be limited by other marketplaces or future policy controls.",
    merchantAction:
      "Confirm the listing is legal where sold and shipped, or clarify the listing copy and tags.",
    tags: ["cbd", "hemp", "supplement", "supplements", "kratom", "cannabis"],
    terms: ["cbd", "hemp", "supplement", "supplements", "kratom", "cannabis"],
  },
]

const BLOCKING_RULES: ListingSafetyRule[] = [
  {
    id: "blocked-csam",
    state: "blocked",
    code: "blocked_term",
    label: "Blocked illegal sexual exploitation category",
    detail:
      "This listing uses high-confidence child sexual abuse material category language that Conduit does not present as commerce inventory.",
    merchantAction:
      "Remove this content from Conduit-facing listings. Conduit will not present it as Market inventory.",
    tags: [
      "csam",
      "child-sexual-abuse-material",
      "child-exploitation-material",
    ],
    terms: [
      "csam",
      "child sexual abuse material",
      "child exploitation material",
      "child pornography",
    ],
  },
  {
    id: "blocked-weapons",
    state: "blocked",
    code: "blocked_term",
    label: "Blocked weapons category",
    detail:
      "This listing uses high-confidence firearms, ammunition, weapon, or explosive category language that Conduit does not present as commerce inventory in alpha.",
    merchantAction:
      "Remove weapons category language before publishing a Market-visible listing.",
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
      "ammo",
      "explosive",
      "explosives",
      "controlled weapon",
      "weapon sale",
      "weapons sale",
    ],
  },
  {
    id: "blocked-controlled-substances",
    state: "blocked",
    code: "blocked_term",
    label: "Blocked controlled-substance category",
    detail:
      "This listing uses high-confidence controlled-substance or illegal-drug category language that Conduit does not present as commerce inventory in alpha.",
    merchantAction:
      "Remove controlled-substance or illegal-drug category language before publishing a Market-visible listing.",
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
    tags: ["counterfeit", "counterfeit-goods", "stolen-goods"],
    terms: [
      "counterfeit goods",
      "counterfeit item",
      "counterfeit items",
      "stolen goods",
      "stolen item",
      "stolen items",
    ],
  },
]

const STATE_RANK: Record<ListingSafetyState, number> = {
  active: 0,
  flagged: 1,
  hidden: 2,
  pending_review: 3,
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

function isMarketVisibleState(state: ListingSafetyState): boolean {
  return state === "active" || state === "flagged"
}

function isPurchasableState(state: ListingSafetyState): boolean {
  return state === "active" || state === "flagged"
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
      marketVisible: isMarketVisibleState(decision.state),
      purchasable: isPurchasableState(decision.state),
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
      detail:
        "Variant listings are not supported in Conduit alpha checkout yet.",
      merchantAction:
        "Publish this as a simple listing or wait for variant listing support.",
      source: "client_rules",
    })
  }

  for (const rule of [...WARNING_RULES, ...BLOCKING_RULES]) {
    if (getRuleMatches(product, rule).length === 0) continue
    states.push(rule.state)
    reasons.push(reasonFromRule(rule))
  }

  const state = getMostSevereState(states)
  return {
    state,
    reasons,
    marketVisible: isMarketVisibleState(state),
    purchasable: isPurchasableState(state),
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

function getReasonState(
  reason: Pick<ListingSafetyReason, "code">
): ListingSafetyState | null {
  switch (reason.code) {
    case "merchant_hidden":
    case "missing_market_image":
      return "hidden"
    case "restricted_tag":
    case "restricted_term":
      return "flagged"
    case "blocked_term":
      return "blocked"
    case "unsupported_product_type":
      return "unsupported"
    case "pending_review":
      return "pending_review"
    case "external_decision":
      return null
  }
}

function getPrimaryDisplayReason(
  evaluation: Pick<ListingSafetyEvaluation, "state" | "reasons">
): ListingSafetyReason | undefined {
  return (
    evaluation.reasons.find(
      (reason) => getReasonState(reason) === evaluation.state
    ) ?? evaluation.reasons[0]
  )
}

export function getListingSafetyDisplay(
  evaluation: Pick<ListingSafetyEvaluation, "state" | "reasons">
): {
  label: string
  summary: string
  merchantAction: string
  tone: "success" | "warning" | "error" | "info" | "neutral"
} {
  const primaryReason = getPrimaryDisplayReason(evaluation)

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
        summary: primaryReason?.detail ?? "This listing is hidden from Market.",
        merchantAction:
          primaryReason?.merchantAction ??
          "Update the listing before publishing.",
        tone: "warning",
      }
    case "flagged":
      return {
        label: "Policy warning",
        summary:
          primaryReason?.detail ??
          "This listing is active, but it matches an alpha policy warning.",
        merchantAction:
          primaryReason?.merchantAction ??
          "Review the listing policy fit and edit it if needed.",
        tone: "warning",
      }
    case "blocked":
      return {
        label: "Blocked",
        summary:
          primaryReason?.detail ??
          "This listing is blocked from Market and checkout.",
        merchantAction:
          primaryReason?.merchantAction ??
          "Edit or remove the listing before it can be visible.",
        tone: "error",
      }
    case "unsupported":
      return {
        label: "Unsupported",
        summary:
          primaryReason?.detail ??
          "This listing cannot be safely interpreted by the current client.",
        merchantAction:
          primaryReason?.merchantAction ??
          "Update the listing to a supported format.",
        tone: "error",
      }
    case "pending_review":
      return {
        label: "Pending review",
        summary:
          primaryReason?.detail ??
          "A non-client review decision has marked this listing pending.",
        merchantAction:
          primaryReason?.merchantAction ??
          "Follow the external review process or edit the listing.",
        tone: "info",
      }
  }
}
