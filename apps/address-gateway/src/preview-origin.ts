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
interface Project {
  name?: string
  subdomain?: string
  source?: Deployment["source"]
}
function trustedSource(source: Deployment["source"]): boolean {
  return (
    source?.type === "github" &&
    source.config?.owner === "Conduit-BTC" &&
    source.config.repo_name === "conduit-mono"
  )
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
    // Share one deadline and charge every upstream request against the API budget.
    const signal = AbortSignal.timeout(5000)
    const base = `https://api.cloudflare.com/client/v4/accounts/${env.PAGES_ACCOUNT_ID}/pages/projects/${project}`
    async function metadata(path: string): Promise<unknown> {
      if (
        !env.PREVIEW_DISCOVERY_RATE_LIMITER ||
        !(
          await env.PREVIEW_DISCOVERY_RATE_LIMITER.limit({
            key: "pages-discovery",
          })
        ).success
      )
        throw new Error("Preview discovery unavailable")
      const result = await fetcher(base + path, {
        headers: { Authorization: `Bearer ${env.PAGES_READ_API_TOKEN}` },
        // workerd supports manual/follow, not the browser's error mode.
        // Reject non-2xx responses below without forwarding credentials.
        redirect: "manual",
        cache: "no-store",
        signal,
      })
      if (!result.ok) throw new Error("Preview discovery unavailable")
      return JSON.parse(await boundedText(result.body, 2_000_000))
    }
    // Deployment records omit repo_id; the project endpoint supplies it.
    const details = (await metadata("")) as {
      success?: boolean
      result?: Project
    }
    if (
      details.success !== true ||
      !details.result ||
      typeof details.result !== "object" ||
      Array.isArray(details.result)
    )
      return "unavailable"
    if (
      details.result.name !== project ||
      details.result.subdomain !== PREVIEW_PROJECTS[project] ||
      !trustedSource(details.result.source) ||
      String(details.result.source?.config?.repo_id) !== "1154829623"
    )
      return "origin_forbidden"
    // Pages accepts at most 25 per page. Retain the 300-record discovery bound.
    for (let page = 1; page <= 12; page++) {
      const data = (await metadata(
        `/deployments?env=preview&per_page=25&page=${page}`
      )) as {
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
          !trustedSource(d.source) ||
          (source?.repo_id !== undefined &&
            String(source.repo_id) !== "1154829623") ||
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
