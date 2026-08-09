export const PRODUCT_PRIVACY_PATH = "/privacy-policy" as const
export const PRODUCT_TERMS_PATH = "/terms-of-service" as const

export const PRODUCT_PRIVACY_CANONICAL_URL =
  "https://shop.conduit.market/privacy-policy" as const
export const PRODUCT_TERMS_CANONICAL_URL =
  "https://shop.conduit.market/terms-of-service" as const
export const WEBSITE_PRIVACY_URL =
  "https://conduit.market/privacy-policy" as const
export const WEBSITE_TERMS_URL =
  "https://conduit.market/terms-of-service" as const

export const PRODUCT_LEGAL_VERSION =
  "conduit-product-legal-v1.0-2026-08-09" as const
export const PRODUCT_LEGAL_EFFECTIVE_DATE = "2026-08-09" as const
export const PRODUCT_LEGAL_EFFECTIVE_DATE_LABEL = "August 9, 2026" as const
export const PRODUCT_LEGAL_LAST_UPDATED_DATE = "2026-08-09" as const
export const PRODUCT_LEGAL_LAST_UPDATED_DATE_LABEL = "August 9, 2026" as const

const PRODUCT_LEGAL_PATHS = new Set<string>([
  PRODUCT_PRIVACY_PATH,
  PRODUCT_TERMS_PATH,
])

const OFFICIAL_PRODUCT_HOSTS = new Set<string>([
  "shop.conduit.market",
  "sell.conduit.market",
])

const CONDUIT_PRODUCT_PREVIEW_PROJECT_HOSTS = new Set<string>([
  "conduit-market-coo.pages.dev",
  "conduit-merchant-33n.pages.dev",
  "conduit-market-signet.pages.dev",
  "conduit-merchant-signet.pages.dev",
])

export type ProductLegalHostMode = "official" | "review-preview" | "independent"

export const PRODUCT_LEGAL_VERSION_HISTORY = Object.freeze([
  Object.freeze({
    version: PRODUCT_LEGAL_VERSION,
    effectiveDate: PRODUCT_LEGAL_EFFECTIVE_DATE,
    lastUpdatedDate: PRODUCT_LEGAL_LAST_UPDATED_DATE,
    archivedSource:
      "packages/ui/src/legal/versions/product-legal-v1.0-2026-08-09.tsx",
  }),
])

export function isProductLegalPath(pathname: string): boolean {
  // TanStack Router's default `trailingSlash: "never"` treats trailing-slash
  // variants as the same route. Match that behavior before app startup so a
  // direct legal load cannot boot product providers while the router still
  // renders a legal document.
  const routerPathname =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  return PRODUCT_LEGAL_PATHS.has(routerPathname)
}

export function isOfficialProductHostname(hostname: string): boolean {
  return OFFICIAL_PRODUCT_HOSTS.has(hostname.trim().toLowerCase())
}

export function isConduitProductLegalPreviewHostname(
  hostname: string
): boolean {
  const normalizedHostname = hostname.trim().toLowerCase()

  for (const projectHostname of CONDUIT_PRODUCT_PREVIEW_PROJECT_HOSTS) {
    if (normalizedHostname === projectHostname) return true
    if (!normalizedHostname.endsWith(`.${projectHostname}`)) continue

    const deploymentLabel = normalizedHostname.slice(
      0,
      -(projectHostname.length + 1)
    )
    if (deploymentLabel && !deploymentLabel.includes(".")) return true
  }

  return false
}

export function getProductLegalHostMode(
  hostname: string,
  deploymentProfile: string
): ProductLegalHostMode {
  if (isOfficialProductHostname(hostname)) return "official"
  if (
    deploymentProfile.trim().toLowerCase() === "preview" &&
    isConduitProductLegalPreviewHostname(hostname)
  ) {
    return "review-preview"
  }
  return "independent"
}
