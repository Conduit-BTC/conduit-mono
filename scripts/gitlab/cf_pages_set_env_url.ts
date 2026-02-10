type CloudflarePagesDeployment = {
  id: string
  url?: string
  environment?: string
  created_on?: string
  // Cloudflare often returns these fields but they are not guaranteed.
  is_skipped?: boolean
  latest_stage?: {
    name?: string
    status?: string
  }
  deployment_trigger?: {
    metadata?: {
      branch?: string
      commit_hash?: string
    }
  }
}

type CloudflareListDeploymentsResponse = {
  success: boolean
  errors?: unknown[]
  result?: CloudflarePagesDeployment[]
}

type GitLabEnvironment = {
  id: number
  name: string
  external_url?: string | null
}

function mustGetEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function getEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

async function jsonRequest<T>(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${url} failed: ${res.status} ${text.slice(0, 500)}`)
  }
  return JSON.parse(text) as T
}

async function cloudflareListDeployments(
  accountId: string,
  project: string,
  apiToken: string
): Promise<CloudflarePagesDeployment[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=20`
  const res = await jsonRequest<CloudflareListDeploymentsResponse>("GET", url, {
    "Authorization": `Bearer ${apiToken}`,
  })
  if (!res.success) {
    throw new Error(`Cloudflare API returned success=false for deployments list`)
  }
  return res.result ?? []
}

function toCreatedOnMs(d: CloudflarePagesDeployment): number {
  if (!d.created_on) return 0
  const ms = Date.parse(d.created_on)
  return Number.isFinite(ms) ? ms : 0
}

function isSuccessfulPreviewDeployment(d: CloudflarePagesDeployment): boolean {
  if (d.environment !== "preview") return false
  if (d.is_skipped) return false
  // If Cloudflare gives us stage status, require success; otherwise allow.
  const st = d.latest_stage?.status
  if (!st) return true
  return st === "success"
}

function pickDeploymentUrl(opts: {
  deployments: CloudflarePagesDeployment[]
  branch?: string
  commitHash?: string
}): string | null {
  const { deployments, branch, commitHash } = opts
  // Normalize ordering: treat the newest deployment as first.
  const sorted = deployments
    .slice()
    .sort((a, b) => toCreatedOnMs(b) - toCreatedOnMs(a))

  const withUrl = sorted.filter((d) => typeof d.url === "string" && d.url)
  const preview = withUrl.filter(isSuccessfulPreviewDeployment)

  const byCommit = commitHash
    ? preview.find((d) => d.deployment_trigger?.metadata?.commit_hash === commitHash)
    : undefined
  if (byCommit?.url) return byCommit.url

  const byBranch = branch ? preview.find((d) => d.deployment_trigger?.metadata?.branch === branch) : undefined
  if (byBranch?.url) return byBranch.url

  // Fallback to most recent preview deployment.
  if (preview[0]?.url) return preview[0].url
  // As a last resort, take any environment.
  if (withUrl[0]?.url) return withUrl[0].url

  return null
}

async function gitlabListEnvironments(apiUrl: string, projectId: string, token: string, search: string): Promise<GitLabEnvironment[]> {
  const url = `${apiUrl}/projects/${encodeURIComponent(projectId)}/environments?per_page=50&search=${encodeURIComponent(search)}`
  return jsonRequest<GitLabEnvironment[]>("GET", url, { "PRIVATE-TOKEN": token })
}

async function gitlabCreateEnvironment(apiUrl: string, projectId: string, token: string, name: string, externalUrl: string): Promise<GitLabEnvironment> {
  const url = `${apiUrl}/projects/${encodeURIComponent(projectId)}/environments`
  return jsonRequest<GitLabEnvironment>("POST", url, { "PRIVATE-TOKEN": token }, { name, external_url: externalUrl })
}

async function gitlabUpdateEnvironment(apiUrl: string, projectId: string, token: string, envId: number, externalUrl: string): Promise<GitLabEnvironment> {
  const url = `${apiUrl}/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(String(envId))}`
  return jsonRequest<GitLabEnvironment>("PUT", url, { "PRIVATE-TOKEN": token }, { external_url: externalUrl })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  // Cloudflare
  const cfToken = process.env["CLOUDFLARE_API_TOKEN"]
  const cfAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"]
  const cfProject = process.env["CLOUDFLARE_PAGES_PROJECT"]

  // GitLab
  const gitlabToken = process.env["GITLAB_BOT_TOKEN"]
  const apiUrl = getEnv("GITLAB_API_URL", "https://gitlab.com/api/v4")
  const projectId = process.env["CI_PROJECT_ID"] ?? process.env["CODEX_REVIEW_PROJECT_ID"]
  const envName = process.env["CI_ENVIRONMENT_NAME"]

  const branch = process.env["CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"] ?? process.env["CI_COMMIT_REF_NAME"]
  const commitHash =
    process.env["CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"] ??
    process.env["CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"] ??
    process.env["CI_COMMIT_SHA"]

  if (!envName || !projectId || !gitlabToken) {
    console.log("Missing CI_ENVIRONMENT_NAME/CI_PROJECT_ID/GITLAB_BOT_TOKEN; skipping environment URL update.")
    return
  }

  if (!cfToken || !cfAccountId || !cfProject) {
    console.log("Missing Cloudflare env vars (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_PAGES_PROJECT); skipping.")
    return
  }

  // Poll briefly in case Cloudflare is still building this commit.
  let deployments: CloudflarePagesDeployment[] = []
  let pickedUrl: string | null = null
  for (let i = 0; i < 20; i++) {
    deployments = await cloudflareListDeployments(cfAccountId, cfProject, cfToken)
    pickedUrl = pickDeploymentUrl({ deployments, branch, commitHash })

    // If we matched by commit hash, we're done.
    const matchedByCommit =
      !!pickedUrl &&
      deployments.some((d) => d.url === pickedUrl && d.deployment_trigger?.metadata?.commit_hash === commitHash)
    if (matchedByCommit) break

    if (i < 19) await sleep(15000)
  }

  if (!pickedUrl) {
    console.log("Could not find a Cloudflare Pages deployment URL; leaving environment without external_url.")
    return
  }

  const existing = await gitlabListEnvironments(apiUrl, projectId, gitlabToken, envName)
  const exact = existing.find((e) => e.name === envName) ?? null

  if (!exact) {
    await gitlabCreateEnvironment(apiUrl, projectId, gitlabToken, envName, pickedUrl)
    console.log(`Created environment ${envName} -> ${pickedUrl}`)
    return
  }

  await gitlabUpdateEnvironment(apiUrl, projectId, gitlabToken, exact.id, pickedUrl)
  console.log(`Updated environment ${envName} -> ${pickedUrl}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
