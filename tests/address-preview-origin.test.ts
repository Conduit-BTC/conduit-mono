import { expect, test } from "bun:test"
import {
  admitPreviewOrigin,
  previewProject,
  PREVIEW_LIFETIME_SECONDS,
} from "../apps/address-gateway/src/preview-origin"
const origin = "https://abc12345.conduit-market-coo.pages.dev"
const now = 1800000000
const env = {
  TRUSTED_PREVIEWS_ENABLED: "true",
  PAGES_ACCOUNT_ID: "a".repeat(32),
  PAGES_READ_API_TOKEN: "test-server-only",
  PREVIEW_DISCOVERY_RATE_LIMITER: { limit: async () => ({ success: true }) },
}
const deployment = () => ({
  url: origin,
  aliases: ["https://feat-names.conduit-market-coo.pages.dev"],
  project_name: "conduit-market",
  environment: "preview",
  created_on: new Date((now - 60) * 1000).toISOString(),
  latest_stage: { name: "deploy", status: "success" },
  deployment_trigger: {
    type: "github:push",
    metadata: {
      branch: "feat/names",
      commit_hash: "a".repeat(40),
      commit_dirty: false,
    },
  },
  source: {
    type: "github",
    config: {
      owner: "Conduit-BTC",
      repo_name: "conduit-mono",
      repo_id: "1154829623",
    },
  },
})
function provider(rows = [deployment()]) {
  return (async (url, init) => {
    expect(String(url)).toStartWith(
      "https://api.cloudflare.com/client/v4/accounts/"
    )
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${env.PAGES_READ_API_TOKEN}`
    )
    expect(init?.redirect).toBe("manual")
    if (!new URL(String(url)).pathname.endsWith("/deployments"))
      return Response.json({
        success: true,
        result: {
          name: "conduit-market",
          subdomain: "conduit-market-coo.pages.dev",
          source: deployment().source,
        },
      })
    expect(new URL(String(url)).searchParams.get("per_page")).toBe("25")
    return Response.json({
      success: true,
      result: rows,
      result_info: { total_pages: 1 },
    })
  }) as typeof fetch
}
test("native same-repository deployments automatically admit hash and current alias", async () => {
  for (const value of [origin, deployment().aliases[0]!])
    expect(await admitPreviewOrigin(value, env, provider(), now)).toBe(
      "allowed"
    )
})
test("project scope never admits unrelated sites, nested suffixes, ports or malformed origins", async () => {
  for (const value of [
    "https://evil.pages.dev",
    "https://x.conduit-market-coo.pages.dev.evil.test",
    "https://x.y.conduit-market-coo.pages.dev",
    "http://x.conduit-market-coo.pages.dev",
    origin + "/",
    origin + ":444",
    "null",
  ]) {
    expect(previewProject(value)).toBeUndefined()
    expect(
      await admitPreviewOrigin(
        value,
        env,
        (() => {
          throw new Error("must not fetch")
        }) as typeof fetch,
        now
      )
    ).toBe("origin_forbidden")
  }
})
test("forks, manual uploads, wrong project, dirty and unsuccessful builds fail closed", async () => {
  for (const change of [
    (d: ReturnType<typeof deployment>) => {
      d.source.config.owner = "fork-owner"
    },
    (d: ReturnType<typeof deployment>) => {
      d.source.config.repo_id = "123"
    },
    (d: ReturnType<typeof deployment>) => {
      d.project_name = "unrelated"
    },
    (d: ReturnType<typeof deployment>) => {
      d.deployment_trigger.type = "ad_hoc"
    },
    (d: ReturnType<typeof deployment>) => {
      d.deployment_trigger.type = "deploy_hook"
    },
    (d: ReturnType<typeof deployment>) => {
      d.deployment_trigger.metadata.commit_dirty = true
    },
    (d: ReturnType<typeof deployment>) => {
      d.latest_stage.status = "failure"
    },
    (d: ReturnType<typeof deployment>) => {
      d.environment = "production"
    },
  ]) {
    const d = deployment()
    change(d)
    expect(await admitPreviewOrigin(origin, env, provider([d]), now)).toBe(
      "origin_forbidden"
    )
  }
})
test("expiry and provider deletion revoke admission without retaining a registry", async () => {
  const d = deployment()
  d.created_on = new Date((now - PREVIEW_LIFETIME_SECONDS) * 1000).toISOString()
  expect(await admitPreviewOrigin(origin, env, provider([d]), now)).toBe(
    "preview_expired"
  )
  expect(await admitPreviewOrigin(origin, env, provider([]), now)).toBe(
    "origin_forbidden"
  )
  expect(await admitPreviewOrigin(origin, env, provider(), now)).toBe("allowed")
  expect(await admitPreviewOrigin(origin, env, provider([]), now)).toBe(
    "origin_forbidden"
  )
})
test("missing credentials, API failures, ambiguous aliases and discovery limits report unavailable", async () => {
  expect(await admitPreviewOrigin(origin, {}, provider(), now)).toBe(
    "unavailable"
  )
  expect(
    await admitPreviewOrigin(
      origin,
      env,
      (async () => new Response(null, { status: 403 })) as typeof fetch,
      now
    )
  ).toBe("unavailable")
  expect(
    await admitPreviewOrigin(
      origin,
      env,
      provider([deployment(), deployment()]),
      now
    )
  ).toBe("unavailable")
  let calls = 0
  expect(
    await admitPreviewOrigin(
      origin,
      env,
      (async (input) => {
        calls++
        if (!new URL(String(input)).pathname.endsWith("/deployments"))
          return Response.json({
            success: true,
            result: {
              name: "conduit-market",
              subdomain: "conduit-market-coo.pages.dev",
              source: deployment().source,
            },
          })
        return Response.json({
          success: true,
          result: [{ ...deployment(), url: "https://other.test", aliases: [] }],
          result_info: { total_pages: 13 },
        })
      }) as typeof fetch,
      now
    )
  ).toBe("unavailable")
  expect(calls).toBe(13)
})

test("anonymous preview discovery is rate limited before any provider fetch", async () => {
  let fetched = false
  const blocked = {
    ...env,
    PREVIEW_DISCOVERY_RATE_LIMITER: { limit: async () => ({ success: false }) },
  }
  expect(
    await admitPreviewOrigin(
      origin,
      blocked,
      (async () => {
        fetched = true
        throw new Error("must not fetch")
      }) as typeof fetch,
      now
    )
  ).toBe("unavailable")
  expect(fetched).toBe(false)
})

test("provider outages and malformed/oversized metadata never authorize or expose payloads", async () => {
  for (const body of [
    "not-json",
    JSON.stringify({ success: false, result: [] }),
    JSON.stringify({ success: true, result: [null] }),
    "x".repeat(2_000_001),
  ]) {
    expect(
      await admitPreviewOrigin(
        origin,
        env,
        (async () => new Response(body)) as typeof fetch,
        now
      )
    ).toBe("unavailable")
  }
  const d = deployment()
  d.created_on = new Date((now + 120) * 1000).toISOString()
  expect(await admitPreviewOrigin(origin, env, provider([d]), now)).toBe(
    "unavailable"
  )
})

test("Workers fetch uses supported redirect and page size with project-level repository identity", async () => {
  const d = deployment()
  const source = { ...d.source, config: { ...d.source.config } }
  delete (d.source.config as { repo_id?: string }).repo_id
  const paths: string[] = []
  const fetcher = (async (input, init) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    // Reproduce actual workerd behavior instead of accepting browser-only options.
    if (init?.redirect === "error")
      throw new TypeError("Unsupported redirect mode")
    expect(init?.redirect).toBe("manual")
    if (url.pathname.endsWith("/deployments")) {
      if (Number(url.searchParams.get("per_page")) > 25)
        return Response.json({ success: false }, { status: 400 })
      return Response.json({
        success: true,
        result: [d],
        result_info: { total_pages: 1 },
      })
    }
    return Response.json({
      success: true,
      result: {
        name: "conduit-market",
        subdomain: "conduit-market-coo.pages.dev",
        source,
      },
    })
  }) as typeof fetch
  expect(await admitPreviewOrigin(origin, env, fetcher, now)).toBe("allowed")
  expect(paths).toEqual([
    `/client/v4/accounts/${env.PAGES_ACCOUNT_ID}/pages/projects/conduit-market`,
    `/client/v4/accounts/${env.PAGES_ACCOUNT_ID}/pages/projects/conduit-market/deployments`,
  ])
})

test("project repository identity remains required when deployment records omit its ID", async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    return Response.json({
      success: true,
      result: {
        name: "conduit-market",
        subdomain: "conduit-market-coo.pages.dev",
        source: {
          ...deployment().source,
          config: { ...deployment().source.config, repo_id: "other" },
        },
      },
    })
  }) as typeof fetch
  expect(await admitPreviewOrigin(origin, env, fetcher, now)).toBe(
    "origin_forbidden"
  )
  expect(calls).toBe(1)
})
test("each metadata request consumes the upstream budget and redirects fail closed", async () => {
  let permits = 0,
    calls = 0
  const limited = {
    ...env,
    PREVIEW_DISCOVERY_RATE_LIMITER: {
      limit: async () => ({ success: ++permits < 2 }),
    },
  }
  const fetcher = (async (...args) => {
    calls++
    return provider()(...args)
  }) as typeof fetch
  expect(await admitPreviewOrigin(origin, limited, fetcher, now)).toBe(
    "unavailable"
  )
  expect(calls).toBe(1)
  expect(permits).toBe(2)
  expect(
    await admitPreviewOrigin(
      origin,
      env,
      (async (_input, init) => {
        expect(init?.redirect).toBe("manual")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://unrelated.test" },
        })
      }) as typeof fetch,
      now
    )
  ).toBe("unavailable")
})
