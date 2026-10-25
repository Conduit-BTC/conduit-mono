import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { boundedText } from "../../apps/address-gateway/src/bounded-text"
import { validateGatewayDeployment } from "../../apps/address-gateway/src/deployment-config"

class ReleaseError extends Error {}

const REPOSITORY = "Conduit-BTC/conduit-mono"
const WORKER = "conduit-address-gateway"
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const REQUIRED_SECRETS = [
  "BREEZ_DOMAIN_API_KEY",
  "BREEZ_PROXY_SHARED_SECRET",
  "PAGES_READ_API_TOKEN",
  "TURNSTILE_SECRET_KEY",
]

export interface ReleaseRun {
  name: string
  path: string
  event: string
  status: string
  conclusion: string
  head_branch: string
  head_sha: string
  head_repository: { full_name: string }
}
export interface ReleasePull {
  merged: boolean
  merge_commit_sha: string
  merged_by: { type: string } | null
  base: { ref: string; repo: { full_name: string } }
}
interface Binding {
  name: string
  type: string
  text?: string
  id?: string
  database_id?: string
  namespace_id?: string | number
  simple?: { limit: number; period: number }
}
export interface GatewayVersion {
  id: string
  annotations?: Record<string, string>
  resources: {
    script_runtime: {
      compatibility_date: string
      compatibility_flags?: string[]
    }
    bindings: Binding[]
  }
}

/** A successful PR run or direct push is not a release authorization. */
export function assertApprovedMerge(
  run: ReleaseRun,
  latestMain: string,
  pulls: ReleasePull[]
): string {
  if (
    run.name !== "CI" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== REPOSITORY ||
    !SHA.test(run.head_sha) ||
    run.head_sha !== latestMain ||
    !pulls.some(
      (pull) =>
        pull.merged &&
        pull.merge_commit_sha === run.head_sha &&
        pull.merged_by?.type === "User" &&
        pull.base.ref === "main" &&
        pull.base.repo.full_name === REPOSITORY
    )
  )
    throw new ReleaseError(
      "Release requires successful current-main CI and a maintainer-merged PR."
    )
  return run.head_sha
}

export function activeVersion(
  deployments: { versions: { version_id: string; percentage: number }[] }[]
): string {
  const versions = deployments[0]?.versions
  if (
    versions?.length !== 1 ||
    versions[0].percentage !== 100 ||
    !UUID.test(versions[0].version_id)
  )
    throw new ReleaseError(
      "Release requires one active gateway version at 100%."
    )
  return versions[0].version_id
}

/** Bootstrap is explicit; later dashboard drift cannot silently become a baseline. */
export function previousRelease(
  version: GatewayVersion,
  bootstrap?: string
): string | null {
  const tag = version.annotations?.["workers/tag"] ?? ""
  if (tag.startsWith("main-") && SHA.test(tag.slice(5))) return tag.slice(5)
  if (bootstrap === version.id && UUID.test(bootstrap)) return null
  throw new ReleaseError(
    "Unrecognized live gateway; review and set the exact bootstrap version."
  )
}

export function affectsGateway(path: string): boolean {
  return (
    /^(apps\/address-gateway\/|packages\/core\/|scripts\/deploy\/address_gateway|scripts\/deploy\/check_address_gateway\.ts$|\.github\/workflows\/address-gateway-deploy\.yml$)/.test(
      path
    ) || ["bun.lock", "package.json", "tsconfig.json"].includes(path)
  )
}

export function sortedBindings(version: GatewayVersion): Binding[] {
  return [...version.resources.bindings].sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

/** Carry live settings into a no-bundle upload, rather than applying staged defaults. */
export function preserveLiveConfig(
  source: Record<string, unknown>,
  version: GatewayVersion,
  bundle: string
): Record<string, unknown> {
  if (source.name !== WORKER || !UUID.test(version.id))
    throw new ReleaseError("Unexpected gateway target.")
  const runtime = version.resources.script_runtime
  if (
    runtime.compatibility_date !== source.compatibility_date ||
    !isDeepStrictEqual(
      runtime.compatibility_flags ?? [],
      source.compatibility_flags ?? []
    )
  )
    throw new ReleaseError("Runtime drift requires explicit review.")
  const bindings = version.resources.bindings
  if (
    new Set(bindings.map((b) => b.name)).size !== bindings.length ||
    bindings.some(
      (b) => !["plain_text", "secret_text", "d1", "ratelimit"].includes(b.type)
    )
  )
    throw new ReleaseError("Unexpected live bindings require explicit review.")
  if (
    REQUIRED_SECRETS.some(
      (name) =>
        !bindings.some((b) => b.type === "secret_text" && b.name === name)
    )
  )
    throw new ReleaseError("Required server secret binding is absent.")
  const vars: Record<string, string> = {}
  for (const binding of bindings) {
    if (binding.type === "secret_text" && binding.text !== undefined)
      throw new ReleaseError(
        "Secret values must never enter release configuration."
      )
    if (binding.type === "plain_text") {
      if (typeof binding.text !== "string")
        throw new ReleaseError("Invalid live variable metadata.")
      vars[binding.name] = binding.text
    }
  }
  const config: Record<string, unknown> = {
    ...source,
    main: resolve(bundle),
    no_bundle: true,
    keep_vars: true,
    vars,
  }
  delete config.env
  delete config.$schema
  validateGatewayDeployment(config, "production")
  const databases = source.d1_databases as {
    binding: string
    database_id: string
  }[]
  const liveDatabases = bindings.filter((b) => b.type === "d1")
  if (
    liveDatabases.length !== databases.length ||
    databases.some(
      (db) =>
        !liveDatabases.some(
          (b) =>
            b.name === db.binding && (b.id ?? b.database_id) === db.database_id
        )
    )
  )
    throw new ReleaseError("Database drift requires explicit review.")
  const limits = source.ratelimits as {
    name: string
    namespace_id: string
    simple: unknown
  }[]
  const liveLimits = bindings.filter((b) => b.type === "ratelimit")
  if (
    liveLimits.length !== limits.length ||
    limits.some(
      (limit) =>
        !liveLimits.some(
          (b) =>
            b.name === limit.name &&
            String(b.namespace_id) === String(limit.namespace_id) &&
            isDeepStrictEqual(b.simple, limit.simple)
        )
    )
  )
    throw new ReleaseError("Rate-limit drift requires explicit review.")
  return config
}

async function api<T>(origin: string, path: string, token: string): Promise<T> {
  const response = await fetch(origin + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new ReleaseError("Release metadata lookup failed.")
  const body = await boundedText(response.body, 1_048_576)
  return JSON.parse(body) as T
}
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new ReleaseError(`Missing release setting: ${name}.`)
  return value
}
async function authorize(): Promise<string> {
  const token = required("GH_TOKEN")
  const runId = required("GATEWAY_CI_RUN_ID")
  if (!/^\d+$/.test(runId)) throw new ReleaseError("Invalid CI run identifier.")
  const gh = <T>(path: string) =>
    api<T>("https://api.github.com", `/repos/${REPOSITORY}${path}`, token)
  const run = await gh<ReleaseRun>(`/actions/runs/${runId}`)
  if (!SHA.test(run.head_sha)) throw new ReleaseError("Invalid CI revision.")
  const main = await gh<{ commit: { sha: string } }>("/branches/main")
  const associated = await gh<{ number: number }[]>(
    `/commits/${run.head_sha}/pulls?per_page=100`
  )
  if (associated.length > 20)
    throw new ReleaseError("Ambiguous merged PR evidence.")
  const pulls = await Promise.all(
    associated.map((pull) => gh<ReleasePull>(`/pulls/${pull.number}`))
  )
  return assertApprovedMerge(run, main.commit.sha, pulls)
}

async function publicProbe(origin: string): Promise<void> {
  const response = await fetch(
    "https://conduit.cash/api/name-requests/availability",
    {
      headers: { Origin: origin },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (
    response.status !== 200 ||
    response.headers.get("Access-Control-Allow-Origin") !== origin ||
    response.headers.get("Cache-Control") !== "no-store" ||
    (await response.json()).status !== "ready"
  )
    throw new ReleaseError("Production gateway readiness verification failed.")
}

async function release(): Promise<void> {
  const sha = await authorize()
  if (required("GATEWAY_SOURCE_SHA") !== sha)
    throw new ReleaseError("Release source changed.")
  const account = required("CLOUDFLARE_ACCOUNT_ID")
  if (!/^[a-f0-9]{32}$/.test(account))
    throw new ReleaseError("Invalid Cloudflare account setting.")
  const token = required("CLOUDFLARE_API_TOKEN")
  const cf = async <T>(path: string): Promise<T> => {
    const result = await api<{ success: boolean; result: T }>(
      "https://api.cloudflare.com/client/v4",
      `/accounts/${account}/workers/scripts/${WORKER}${path}`,
      token
    )
    if (!result.success)
      throw new ReleaseError("Gateway metadata lookup failed.")
    return result.result
  }
  const current = async () =>
    activeVersion(
      (
        await cf<{ deployments: Parameters<typeof activeVersion>[0] }>(
          "/deployments"
        )
      ).deployments
    )
  const baselineId = await current()
  const baseline = await cf<GatewayVersion>(`/versions/${baselineId}`)
  const prior = previousRelease(
    baseline,
    process.env.ADDRESS_GATEWAY_BOOTSTRAP_VERSION
  )
  // Compare against the last actual release, so an unrelated newer merge can
  // carry forward gateway changes from a superseded CI run.
  if (prior) {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", prior, sha, "--"],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
    if (!changed.some(affectsGateway)) {
      console.log(
        JSON.stringify({
          check: "address-gateway-release",
          status: "unchanged",
          revision: sha,
        })
      )
      return
    }
  }
  const configPath = resolve(required("GATEWAY_RELEASE_CONFIG"))
  const source = JSON.parse(
    readFileSync("apps/address-gateway/wrangler.json", "utf8")
  )
  const config = preserveLiveConfig(
    source,
    baseline,
    required("GATEWAY_BUNDLE")
  )
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
  const wrangler = resolve(required("WRANGLER_BIN"))
  const cli = (args: string[]) =>
    execFileSync("node", [wrangler, ...args, "--config", configPath], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2_097_152,
      stdio: ["ignore", "pipe", "pipe"],
    })
  const assertFresh = async () => {
    if ((await authorize()) !== sha || (await current()) !== baselineId)
      throw new ReleaseError(
        "Main or the live gateway changed; release stopped."
      )
  }
  await assertFresh()
  const output = cli([
    "versions",
    "upload",
    "--no-bundle",
    "--keep-vars",
    "--tag",
    `main-${sha}`,
    "--message",
    `Approved main ${sha}`,
  ])
  const uploadedId = /Worker Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1]
  if (!uploadedId || !UUID.test(uploadedId))
    throw new ReleaseError("Uploaded version could not be identified.")
  const uploaded = await cf<GatewayVersion>(`/versions/${uploadedId}`)
  if (
    uploaded.annotations?.["workers/tag"] !== `main-${sha}` ||
    !isDeepStrictEqual(sortedBindings(uploaded), sortedBindings(baseline)) ||
    !isDeepStrictEqual(
      uploaded.resources.script_runtime,
      baseline.resources.script_runtime
    )
  )
    throw new ReleaseError(
      "Uploaded gateway settings differ; traffic was not changed."
    )
  await assertFresh()
  cli([
    "versions",
    "deploy",
    `${uploadedId}@100%`,
    "--yes",
    "--message",
    `Approved main ${sha}`,
  ])
  if ((await current()) !== uploadedId)
    throw new ReleaseError("Gateway deployment readback failed.")
  console.log(
    JSON.stringify({
      check: "address-gateway-release",
      status: "activated",
      revision: sha,
      version: uploadedId,
      previousVersion: baselineId,
    })
  )
  await publicProbe("https://shop.conduit.market")
  await publicProbe("https://sell.conduit.market")
  const blocked = await fetch("https://conduit.cash/api/name-requests/status", {
    method: "OPTIONS",
    headers: {
      Origin: "https://unrelated.pages.dev",
      "Access-Control-Request-Method": "POST",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (
    blocked.status !== 403 ||
    blocked.headers.has("Access-Control-Allow-Origin")
  )
    throw new ReleaseError("Untrusted private preflight verification failed.")
  console.log(
    JSON.stringify({
      check: "address-gateway-release",
      status: "deployed",
      revision: sha,
      version: uploadedId,
      previousVersion: baselineId,
    })
  )
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "gate") {
      const sha = await authorize()
      appendFileSync(required("GITHUB_OUTPUT"), `revision=${sha}\n`)
      console.log(
        JSON.stringify({
          check: "address-gateway-release",
          status: "authorized",
          revision: sha,
        })
      )
    } else if (process.argv[2] === "release") await release()
    else throw new ReleaseError("Choose gate or release.")
  } catch (caught) {
    // API payloads, CLI stderr and credentials must never reach Actions logs.
    console.error(
      caught instanceof ReleaseError
        ? caught.message
        : "Address gateway release stopped unexpectedly; private API/CLI details withheld."
    )
    process.exitCode = 1
  }
}
