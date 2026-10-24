import { boundedText } from "./bounded-text"

/** Provider metadata is authority; neither a hostname suffix nor a browser manifest is. */
export const PREVIEW_PROJECTS = {
  "conduit-market": "conduit-market-coo.pages.dev",
  "conduit-merchant": "conduit-merchant-33n.pages.dev",
} as const
export const PREVIEW_LIFETIME_SECONDS = 7 * 86400
export interface PreviewOriginEnv {
  TRUSTED_PREVIEWS_ENABLED?: string
  PAGES_ACCOUNT_ID?: string
  PAGES_READ_API_TOKEN?: string
  PREVIEW_DISCOVERY_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}
export type PreviewAdmission =
  "allowed" | "origin_forbidden" | "preview_expired" | "unavailable"
interface Deployment {
  url?: string
  aliases?: string[]
  environment?: string
  project_name?: string
  created_on?: string
  latest_stage?: { name?: string; status?: string }
  deployment_trigger?: {
    type?: string
    metadata?: { branch?: string; commit_hash?: string; commit_dirty?: boolean }
  }
  source?: {
    type?: string
    config?: { owner?: string; repo_name?: string; repo_id?: string }
  }
}
export function previewProject(
  origin: string
): keyof typeof PREVIEW_PROJECTS | undefined {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return
  }
  if (url.origin !== origin || url.protocol !== "https:" || url.port) return
  return (
    Object.keys(PREVIEW_PROJECTS) as (keyof typeof PREVIEW_PROJECTS)[]
  ).find((project) => {
    const suffix = `.${PREVIEW_PROJECTS[project]}`
    return (
      url.hostname.endsWith(suffix) &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        url.hostname.slice(0, -suffix.length)
      )
    )
  })
}
/** No persistent allowlist or authorization cache: expiry/deletion takes effect on the next call.
 * Bounded discovery fails closed. API payloads may contain deployment env vars and must never
 * be logged, persisted, returned to the browser, or included in exception messages.
 */
export async function admitPreviewOrigin(
  origin: string,
  env: PreviewOriginEnv,
  fetcher: typeof fetch,
  now: number
): Promise<PreviewAdmission> {
  const project = previewProject(origin)
  if (!project) return "origin_forbidden"
  if (
    env.TRUSTED_PREVIEWS_ENABLED !== "true" ||
    !/^[a-f0-9]{32}$/.test(env.PAGES_ACCOUNT_ID ?? "") ||
    !env.PAGES_READ_API_TOKEN
  )
    return "unavailable"
  try {
    // Bound anonymous readiness/preflight traffic before using the account API.
    if (
      !env.PREVIEW_DISCOVERY_RATE_LIMITER ||
      !(
        await env.PREVIEW_DISCOVERY_RATE_LIMITER.limit({
          key: "pages-discovery",
        })
      ).success
    )
      return "unavailable"
    for (let page = 1; page <= 3; page++) {
      const result = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${env.PAGES_ACCOUNT_ID}/pages/projects/${project}/deployments?env=preview&per_page=100&page=${page}`,
        {
          headers: { Authorization: `Bearer ${env.PAGES_READ_API_TOKEN}` },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        }
      )
      if (!result.ok) return "unavailable"
      const data = JSON.parse(await boundedText(result.body, 2_000_000)) as {
        success?: boolean
        result?: Deployment[]
        result_info?: { total_pages?: number }
      }
      if (data.success !== true || !Array.isArray(data.result))
        return "unavailable"
      const matched = data.result.filter(
        (d) => d.url === origin || d.aliases?.includes(origin)
      )
      // Ambiguous provider records cannot authorize a mutable branch alias.
      if (matched.length > 1) return "unavailable"
      const d = matched[0]
      if (d) {
        const source = d.source?.config
        if (
          d.project_name !== project ||
          d.environment !== "preview" ||
          d.source?.type !== "github" ||
          source?.owner !== "Conduit-BTC" ||
          source?.repo_name !== "conduit-mono" ||
          String(source?.repo_id) !== "1154829623" ||
          d.deployment_trigger?.type !== "github:push" ||
          d.deployment_trigger.metadata?.commit_dirty !== false ||
          !d.deployment_trigger.metadata.branch ||
          !/^[a-f0-9]{40}$/.test(
            d.deployment_trigger.metadata.commit_hash ?? ""
          ) ||
          d.latest_stage?.name !== "deploy" ||
          d.latest_stage.status !== "success"
        )
          return "origin_forbidden"
        const created = Date.parse(d.created_on ?? "") / 1000
        if (!Number.isFinite(created) || created > now + 60)
          return "unavailable"
        return now >= created + PREVIEW_LIFETIME_SECONDS
          ? "preview_expired"
          : "allowed"
      }
      if (
        data.result.length === 0 ||
        page >= (data.result_info?.total_pages ?? Infinity)
      )
        return "origin_forbidden"
    }
  } catch {
    return "unavailable"
  }
  return "unavailable"
}
