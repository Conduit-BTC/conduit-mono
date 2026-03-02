/**
 * Posts a single MR comment with stable branch-level Cloudflare Pages preview URLs.
 * Only posts once per MR (deduplicates by marker comment).
 *
 * Deploys per MR: market (signet + mainnet) and merchant (signet + mainnet).
 *
 * Cloudflare Pages preview URLs follow the pattern:
 *   https://<branch-slug>.<project>.pages.dev
 *
 * Branch slugification: lowercase, replace non-alphanumeric with "-", collapse runs, trim dashes,
 * truncate to 28 chars (Cloudflare's limit).
 */

type GitLabMrNote = {
  id: number
  body?: string
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
  // Cloudflare Pages truncates branch slugs to 28 characters
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28)
    .replace(/-$/, "")
}

const MARKER = "<!-- conduit:preview_links -->"

const APPS = ["market", "merchant"] as const
const NETWORKS = ["signet", "mainnet"] as const

async function main() {
  const apiUrl = getEnv("GITLAB_API_URL", "https://gitlab.com/api/v4")
  const projectId = process.env["CI_PROJECT_ID"]
  const mrIid = process.env["CI_MERGE_REQUEST_IID"]
  const gitlabToken = process.env["GITLAB_BOT_TOKEN"]
  const branch = process.env["CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"] ?? process.env["CI_COMMIT_REF_NAME"]

  if (!projectId || !mrIid || !gitlabToken || !branch) {
    console.log("Missing CI vars; skipping preview link comment.")
    return
  }

  const slug = slugifyBranch(branch)

  // Check if we already posted
  const notesUrl = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes?per_page=100&sort=desc`
  const notes = await gitlabRequest<GitLabMrNote[]>("GET", notesUrl, gitlabToken)
  if (notes.some((n) => (n.body ?? "").includes(MARKER))) {
    console.log("Preview links already posted; skipping.")
    return
  }

  const rows = APPS.flatMap((app) =>
    NETWORKS.map((network) => {
      // Mainnet reuses existing projects; signet uses dedicated projects
      const project = network === "mainnet" ? `conduit-${app}` : `conduit-${app}-${network}`
      const url = `https://${slug}.${project}.pages.dev`
      const label = `${app.charAt(0).toUpperCase() + app.slice(1)} (${network})`
      return `| ${label} | ${url} |`
    }),
  )

  const body = [
    MARKER,
    "## Preview Links",
    "",
    "| App | URL |",
    "|-----|-----|",
    ...rows,
    "",
    `Branch: \`${branch}\` · Slug: \`${slug}\``,
    "",
    "*These URLs are stable for the lifetime of this branch. Each push updates the deployment automatically.*",
  ].join("\n")

  const postUrl = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes`
  await gitlabRequest("POST", postUrl, gitlabToken, { body })
  console.log(`Posted preview links for branch "${branch}" (${APPS.length * NETWORKS.length} URLs)`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
