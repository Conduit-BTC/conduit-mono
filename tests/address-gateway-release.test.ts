import { describe, expect, test } from "bun:test"
import config from "../apps/address-gateway/wrangler.json"
import {
  activeVersion,
  affectsGateway,
  assertApprovedMerge,
  bindingFingerprint,
  preserveLiveConfig,
  previousRelease,
  type GatewayVersion,
  type ReleasePull,
  type ReleaseRun,
} from "../scripts/deploy/address_gateway_release"

const sha = "a".repeat(40)
const id = "12345678-1234-1234-1234-123456789abc"
const run: ReleaseRun = {
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: sha,
  head_repository: { full_name: "Conduit-BTC/conduit-mono" },
}
const pull: ReleasePull = {
  merged: true,
  merge_commit_sha: sha,
  merged_by: { type: "User" },
  base: { ref: "main", repo: { full_name: "Conduit-BTC/conduit-mono" } },
}
function version(): GatewayVersion {
  return {
    id,
    resources: {
      script_runtime: { compatibility_date: "2026-10-01" },
      bindings: [
        ...[
          "BREEZ_DOMAIN_API_KEY",
          "BREEZ_PROXY_SHARED_SECRET",
          "PAGES_READ_API_TOKEN",
          "TURNSTILE_SECRET_KEY",
        ].map((name) => ({ name, type: "secret_text" })),
        {
          name: "ALLOWED_ORIGINS",
          type: "plain_text",
          text: "https://shop.conduit.market,https://sell.conduit.market",
        },
        {
          name: "TURNSTILE_HOSTNAMES",
          type: "plain_text",
          text: "shop.conduit.market,sell.conduit.market",
        },
        { name: "PROVIDER_PROXY_QUALIFIED", type: "plain_text", text: "true" },
        { name: "TRUSTED_PREVIEWS_ENABLED", type: "plain_text", text: "true" },
        { name: "PAGES_ACCOUNT_ID", type: "plain_text", text: "a".repeat(32) },
        { name: "OPERATOR_MODE", type: "plain_text", text: "qualify" },
        ...config.d1_databases.map((db) => ({
          name: db.binding,
          type: "d1",
          id: db.database_id,
        })),
        ...config.ratelimits.map((limit) => ({ ...limit, type: "ratelimit" })),
      ],
    },
  }
}

describe("gateway release authorization", () => {
  test("accepts only a successful exact current-main CI push and human merge", () => {
    expect(assertApprovedMerge(run, sha, [pull])).toBe(sha)
    for (const patch of [
      { name: "Different CI" },
      { path: ".github/workflows/other.yml" },
      { event: "pull_request" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { head_branch: "feature" },
      { head_sha: "refs/heads/main" },
      { head_repository: { full_name: "untrusted/fork" } },
    ])
      expect(() =>
        assertApprovedMerge({ ...run, ...patch }, sha, [pull])
      ).toThrow()
    expect(() => assertApprovedMerge(run, "b".repeat(40), [pull])).toThrow()
    expect(() => assertApprovedMerge(run, sha, [])).toThrow()
    for (const patch of [
      { merged: false },
      { merge_commit_sha: "b".repeat(40) },
      { merged_by: { type: "Bot" } },
      { base: { ref: "feature", repo: pull.base.repo } },
      { base: { ref: "main", repo: { full_name: "untrusted/fork" } } },
    ])
      expect(() =>
        assertApprovedMerge(run, sha, [{ ...pull, ...patch }])
      ).toThrow()
  })
  test("does not overwrite a gradual rollout or an unknown dashboard change", () => {
    expect(
      activeVersion([{ versions: [{ version_id: id, percentage: 100 }] }])
    ).toBe(id)
    expect(() => activeVersion([])).toThrow()
    expect(() =>
      activeVersion([{ versions: [{ version_id: id, percentage: 50 }] }])
    ).toThrow()
    expect(() => previousRelease(version())).toThrow()
    expect(() => previousRelease(version(), "wrong")).toThrow()
    expect(previousRelease(version(), id)).toBeNull()
    expect(
      previousRelease({
        ...version(),
        annotations: { "workers/tag": `main-${sha}` },
      })
    ).toBe(sha)
  })
  test("includes shared dependencies and configuration in catch-up release scope", () => {
    for (const path of [
      "apps/address-gateway/approved-names.json",
      "packages/core/src/protocol/signature.ts",
      "bun.lock",
      "package.json",
      "scripts/deploy/address_gateway_release.ts",
      ".github/workflows/address-gateway-deploy.yml",
    ])
      expect(affectsGateway(path)).toBe(true)
    expect(affectsGateway("apps/market/src/routes/index.tsx")).toBe(false)
    expect(affectsGateway("docs/README.md")).toBe(false)
  })
})

describe("gateway live configuration preservation", () => {
  test("retains qualified provider, trusted previews and all live variables over staged defaults", () => {
    const candidate = preserveLiveConfig(
      config,
      version(),
      "/tmp/bundle/index.js"
    )
    expect(candidate.vars).toMatchObject({
      PROVIDER_PROXY_QUALIFIED: "true",
      TRUSTED_PREVIEWS_ENABLED: "true",
      OPERATOR_MODE: "qualify",
    })
    expect(candidate).toMatchObject({
      main: "/tmp/bundle/index.js",
      no_bundle: true,
      keep_vars: true,
      workers_dev: false,
      preview_urls: false,
    })
    expect(candidate.routes).toEqual(config.routes)
    expect(candidate.d1_databases).toEqual(config.d1_databases)
    expect(candidate.ratelimits).toEqual(config.ratelimits)
    expect(candidate.env).toBeUndefined()
    expect(JSON.stringify(candidate)).not.toContain("BREEZ_DOMAIN_API_KEY")
    expect(config.vars.PROVIDER_PROXY_QUALIFIED).toBe("false")
    const baseline = version()
    const reordered = structuredClone(baseline)
    reordered.resources.bindings.reverse()
    expect(bindingFingerprint(reordered)).toBe(bindingFingerprint(baseline))
    reordered.resources.bindings.find(
      (b) => b.name === "PROVIDER_PROXY_QUALIFIED"
    )!.text = "false"
    expect(bindingFingerprint(reordered)).not.toBe(bindingFingerprint(baseline))
  })
  test("preserves a disabled management boundary rather than enabling it", () => {
    const baseline = version()
    baseline.resources.bindings.find(
      (b) => b.name === "PROVIDER_PROXY_QUALIFIED"
    )!.text = "false"
    expect(
      preserveLiveConfig(config, baseline, "/tmp/index.js").vars
    ).toMatchObject({ PROVIDER_PROXY_QUALIFIED: "false" })
  })
  for (const fault of [
    "missing-secret",
    "secret-value",
    "database",
    "rate-limit",
    "new-binding",
    "runtime",
    "duplicate",
    "origin",
  ] as const) {
    test(`stops on ${fault} drift before an upload`, () => {
      const baseline = version()
      const bindings = baseline.resources.bindings
      if (fault === "missing-secret")
        baseline.resources.bindings = bindings.filter(
          (b) => b.name !== "PAGES_READ_API_TOKEN"
        )
      if (fault === "secret-value")
        bindings.find((b) => b.name === "PAGES_READ_API_TOKEN")!.text =
          "must-not-be-used"
      if (fault === "database")
        bindings.find((b) => b.type === "d1")!.id = "different"
      if (fault === "rate-limit")
        bindings.find((b) => b.type === "ratelimit")!.simple = {
          limit: 500,
          period: 60,
        }
      if (fault === "new-binding")
        bindings.push({ name: "UNEXPECTED", type: "kv_namespace" })
      if (fault === "runtime")
        baseline.resources.script_runtime.compatibility_date = "2026-10-02"
      if (fault === "duplicate") bindings.push(bindings[0])
      if (fault === "origin")
        bindings.find((b) => b.name === "ALLOWED_ORIGINS")!.text =
          "https://untrusted.example"
      expect(() =>
        preserveLiveConfig(config, baseline, "/tmp/index.js")
      ).toThrow()
    })
  }
})
