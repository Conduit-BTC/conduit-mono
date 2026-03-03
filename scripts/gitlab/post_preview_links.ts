/**
 * Prepends stable preview links to the MR description.
 * Idempotent: replaces existing preview block on subsequent runs.
 *
 * Cloudflare Pages preview URLs follow the pattern:
 *   https://<branch-slug>.<project-domain>.pages.dev
 *
 * Branch slugification: lowercase, replace non-alphanumeric with "-", collapse runs, trim dashes,
 * truncate to 28 chars (Cloudflare's limit).
 */

type GitLabMr = {
  description: string | null
}

function getEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

async function gitlabRequest<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 500)}`)
  return JSON.parse(text) as T
}

function slugifyBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28)
    .replace(/-$/, "")
}

const MARKER_START = "<!-- conduit:preview_links -->"
const MARKER_END = "<!-- /conduit:preview_links -->"

/**
 * Map from [app, network] to the Cloudflare Pages domain root.
 * Git-connected projects have a different domain suffix than the project name.
 */
const DOMAIN_MAP: Record<string, string> = {
  "market-signet": "conduit-market-signet",
  "market-mainnet": "conduit-market-arq",
  "merchant-signet": "conduit-merchant-signet",
  "merchant-mainnet": "conduit-merchant-arq",
}

const APPS = ["market", "merchant"] as const
const NETWORKS = ["signet", "mainnet"] as const

function buildPreviewBlock(slug: string): string {
  const rows = APPS.flatMap((app) =>
    NETWORKS.map((network) => {
      const domain = DOMAIN_MAP[`${app}-${network}`]
      const url = `https://${slug}.${domain}.pages.dev`
      const label = `${app.charAt(0).toUpperCase() + app.slice(1)} (${network})`
      return `| ${label} | ${url} |`
    }),
  )

  return [
    MARKER_START,
    "## Preview Links",
    "",
    "| App | URL |",
    "|-----|-----|",
    ...rows,
    "",
    MARKER_END,
  ].join("\n")
}

function stripExistingBlock(description: string): string {
  const re = new RegExp(
    `${MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`,
  )
  return description.replace(re, "").trimStart()
}

async function main() {
  const apiUrl = getEnv("GITLAB_API_URL", "https://gitlab.com/api/v4")
  const projectId = process.env["CI_PROJECT_ID"]
  const mrIid = process.env["CI_MERGE_REQUEST_IID"]
  const gitlabToken = process.env["GITLAB_BOT_TOKEN"]
  const branch = process.env["CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"] ?? process.env["CI_COMMIT_REF_NAME"]

  if (!projectId || !mrIid || !gitlabToken || !branch) {
    console.log("Missing CI vars; skipping preview links.")
    return
  }

  const slug = slugifyBranch(branch)
  const mrUrl = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}`

  // Fetch current MR description
  const mr = await gitlabRequest<GitLabMr>("GET", mrUrl, gitlabToken)
  const existing = mr.description ?? ""

  // Strip old preview block (if any), prepend new one
  const cleaned = stripExistingBlock(existing)
  const previewBlock = buildPreviewBlock(slug)
  const newDescription = `${previewBlock}\n\n${cleaned}`

  // Update MR description
  await gitlabRequest("PUT", mrUrl, gitlabToken, { description: newDescription })
  console.log(`Updated MR !${mrIid} description with preview links (slug: ${slug})`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
