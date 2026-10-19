import { describe, expect, it } from "bun:test"
import {
  extractUrlsFromCommentBody,
  listPublicCloudflareCheckRuns,
  resolveProjectUrls,
  resolveProjectUrlsFromChecks,
  waitForProjectRows,
} from "../scripts/ci/preview_links.mjs"

const HEAD_SHA = "75ede52c8cc6120b807b55de0bc81ecef00dfeed"

function cloudflareComment({
  project,
  revision = HEAD_SHA.slice(0, 7),
  branchSuffix,
}: {
  project: "conduit-market" | "conduit-merchant"
  revision?: string
  branchSuffix: string
}) {
  return {
    user: { login: "cloudflare-workers-and-pages[bot]" },
    body: `## Deploying ${project}

<table><tr><td><strong>Latest commit:</strong></td><td>
<code>${revision}</code>
</td></tr>
<tr><td><strong>Preview URL:</strong></td><td>
<a href='https://${revision}.${project}.pages.dev'>commit</a>
</td></tr>
<tr><td><strong>Branch Preview URL:</strong></td><td>
<a href='https://dependabot-${branchSuffix}.${project}.pages.dev'>branch</a>
</td></tr></table>`,
  }
}

const PROJECTS = {
  market: {
    label: "Market",
    project: "conduit-market",
    previewHostname: "conduit-market-coo.pages.dev",
  },
  merchant: {
    label: "Merchant",
    project: "conduit-merchant",
    previewHostname: "conduit-merchant-33n.pages.dev",
  },
}

function cloudflareCheck(app: keyof typeof PROJECTS, id = 1) {
  const project = PROJECTS[app]
  const commitUrl = `https://1234abcd.${project.previewHostname}`
  const branchUrl = `https://feature-preview.${project.previewHostname}`
  return {
    id,
    app: {
      id: 85455,
      slug: "cloudflare-workers-and-pages",
      owner: { login: "cloudflare" },
    },
    name: `Cloudflare Pages: ${project.project}`,
    head_sha: HEAD_SHA,
    status: "completed",
    conclusion: "success",
    output: {
      summary: `<table><tr><td><strong>Latest commit:</strong></td><td><code>${HEAD_SHA.slice(0, 7)}</code></td></tr>
<tr><td><strong>Preview URL:</strong></td><td><a href='${commitUrl}'>commit</a></td></tr>
<tr><td><strong>Branch Preview URL:</strong></td><td><a href='${branchUrl}'>branch</a></td></tr></table>`,
    },
  }
}

function resolveChecks(checkRuns: unknown[], headSha = HEAD_SHA) {
  return resolveProjectUrlsFromChecks({
    checkRuns,
    projectName: PROJECTS.market.project,
    previewHostname: PROJECTS.market.previewHostname,
    headSha,
  })
}

const MISSING_URLS = { commitUrl: null, branchUrl: null }

describe("preview link resolution", () => {
  it("extracts URLs when Cloudflare places labels and anchors on separate lines", () => {
    const comment = cloudflareComment({
      project: "conduit-market",
      branchSuffix: "market-y7u6",
    })

    expect(extractUrlsFromCommentBody(comment.body)).toEqual({
      commitUrl: "https://75ede52.conduit-market.pages.dev",
      branchUrl: "https://dependabot-market-y7u6.conduit-market.pages.dev",
    })
  })

  it("ignores successful comments for a stale head", () => {
    const comment = cloudflareComment({
      project: "conduit-market",
      revision: "deadbee",
      branchSuffix: "stale",
    })

    expect(
      resolveProjectUrls({
        comments: [comment],
        projectName: "conduit-market",
        headSha: HEAD_SHA,
      })
    ).toEqual({ commitUrl: null, branchUrl: null })
  })

  it("waits for independently delayed Market and Merchant aliases", async () => {
    const market = cloudflareComment({
      project: "conduit-market",
      branchSuffix: "market-y7u6",
    })
    const merchant = cloudflareComment({
      project: "conduit-merchant",
      branchSuffix: "merchant-lknh",
    })
    const snapshots = [[], [market], [market, merchant]]
    let calls = 0

    const result = await waitForProjectRows({
      projects: PROJECTS,
      headSha: HEAD_SHA,
      attempts: snapshots.length,
      intervalMs: 0,
      sleep: async () => {},
      listComments: async () => snapshots[calls++] || snapshots.at(-1)!,
    })

    expect(calls).toBe(3)
    expect(result.rows.map((row) => row.branchUrl)).toEqual([
      "https://dependabot-market-y7u6.conduit-market.pages.dev",
      "https://dependabot-merchant-lknh.conduit-merchant.pages.dev",
    ])
  })

  it("times out without synthesizing an unverified branch URL", async () => {
    await expect(
      waitForProjectRows({
        projects: PROJECTS,
        headSha: HEAD_SHA,
        attempts: 2,
        intervalMs: 0,
        sleep: async () => {},
        listComments: async () => [],
      })
    ).rejects.toThrow("refusing to guess deployment aliases")
  })

  it.each(["stale", "absent"])(
    "uses authenticated current-head checks when comments are %s",
    async (commentState) => {
      const comments =
        commentState === "stale"
          ? [
              cloudflareComment({
                project: "conduit-market",
                revision: "deadbee",
                branchSuffix: "stale",
              }),
            ]
          : []
      let checkReads = 0
      const result = await waitForProjectRows({
        projects: PROJECTS,
        headSha: HEAD_SHA,
        attempts: 2,
        sleep: async () => {},
        listComments: async () => comments,
        listChecks: async () => {
          checkReads += 1
          return [cloudflareCheck("market"), cloudflareCheck("merchant")]
        },
      })

      expect(checkReads).toBe(1)
      expect(result.rows.map((row) => row.branchUrl)).toEqual([
        "https://feature-preview.conduit-market-coo.pages.dev",
        "https://feature-preview.conduit-merchant-33n.pages.dev",
      ])
      expect(result.rows.map((row) => row.commitUrl)).toEqual([
        "https://1234abcd.conduit-market-coo.pages.dev",
        "https://1234abcd.conduit-merchant-33n.pages.dev",
      ])
    }
  )

  it("only reads public checks on the first and final missing-comment iterations", async () => {
    let commentReads = 0
    let checkReads = 0
    let sleeps = 0
    const result = await waitForProjectRows({
      projects: PROJECTS,
      headSha: HEAD_SHA,
      attempts: 5,
      listComments: async () => {
        commentReads += 1
        return []
      },
      listChecks: async () => {
        checkReads += 1
        return checkReads === 1
          ? [cloudflareCheck("market")]
          : [cloudflareCheck("market"), cloudflareCheck("merchant")]
      },
      sleep: async () => {
        sleeps += 1
      },
    })
    expect(commentReads).toBe(5)
    expect(checkReads).toBe(2)
    expect(sleeps).toBe(4)
    expect(result.rows.every((row) => row.branchUrl)).toBe(true)
  })

  it("does not read checks when both current comments are available", async () => {
    let checkReads = 0
    await waitForProjectRows({
      projects: PROJECTS,
      headSha: HEAD_SHA,
      listComments: async () =>
        Object.values(PROJECTS).map((project) =>
          cloudflareComment({
            project: project.project as "conduit-market" | "conduit-merchant",
            branchSuffix: "current",
          })
        ),
      listChecks: async () => {
        checkReads += 1
        throw new Error("Unexpected check read")
      },
    })
    expect(checkReads).toBe(0)
  })

  it("makes only one check read when the first attempt is also the final attempt", async () => {
    let checkReads = 0
    await expect(
      waitForProjectRows({
        projects: PROJECTS,
        headSha: HEAD_SHA,
        attempts: 1,
        listComments: async () => [],
        listChecks: async () => {
          checkReads += 1
          return []
        },
      })
    ).rejects.toThrow("refusing to guess deployment aliases")
    expect(checkReads).toBe(1)
  })

  it("retains comment polling after a failed optional public check read", async () => {
    let commentReads = 0
    let checkReads = 0
    let sleeps = 0
    const result = await waitForProjectRows({
      projects: PROJECTS,
      headSha: HEAD_SHA,
      attempts: 3,
      listComments: async () => {
        commentReads += 1
        return commentReads === 1
          ? []
          : Object.values(PROJECTS).map((project) =>
              cloudflareComment({
                project: project.project as
                  "conduit-market" | "conduit-merchant",
                branchSuffix: "current",
              })
            )
      },
      listChecks: async () => {
        checkReads += 1
        throw new Error("Public checks unavailable")
      },
      sleep: async () => {
        sleeps += 1
      },
    })
    expect(result.rows.every((row) => row.branchUrl)).toBe(true)
    expect(commentReads).toBe(2)
    expect(checkReads).toBe(1)
    expect(sleeps).toBe(1)
  })

  it("still fails at the existing deadline when comments and checks provide no proof", async () => {
    let checkReads = 0
    let sleeps = 0
    await expect(
      waitForProjectRows({
        projects: PROJECTS,
        headSha: HEAD_SHA,
        attempts: 3,
        listComments: async () => [],
        listChecks: async () => {
          checkReads += 1
          throw new Error("Public checks unavailable")
        },
        sleep: async () => {
          sleeps += 1
        },
      })
    ).rejects.toThrow("refusing to guess deployment aliases")
    expect(checkReads).toBe(2)
    expect(sleeps).toBe(2)
  })
})

describe("authenticated Cloudflare check provenance", () => {
  it("accepts the full summary revision and rejects a missing configured host", () => {
    const check = cloudflareCheck("market")
    check.output.summary = check.output.summary.replace(
      HEAD_SHA.slice(0, 7),
      HEAD_SHA
    )
    expect(resolveChecks([check]).branchUrl).toBe(
      "https://feature-preview.conduit-market-coo.pages.dev"
    )
    expect(
      resolveProjectUrlsFromChecks({
        checkRuns: [check],
        projectName: PROJECTS.market.project,
        previewHostname: undefined,
        headSha: HEAD_SHA,
      })
    ).toEqual(MISSING_URLS)
  })

  const invalidChecks: Array<
    [string, (check: ReturnType<typeof cloudflareCheck>) => void]
  > = [
    ["different App ID", (check) => (check.app.id = 1)],
    ["different App slug", (check) => (check.app.slug = "candidate-app")],
    ["different App owner", (check) => (check.app.owner.login = "candidate")],
    [
      "other project",
      (check) => (check.name = "Cloudflare Pages: conduit-market-signet"),
    ],
    ["other head", (check) => (check.head_sha = "0".repeat(40))],
    ["unfinished check", (check) => (check.status = "in_progress")],
    ["failed check", (check) => (check.conclusion = "failure")],
    ["neutral check", (check) => (check.conclusion = "neutral")],
    ["invalid run ID", (check) => (check.id = 0)],
    ["missing publication", (check) => (check.output.summary = "")],
    [
      "stale summary revision",
      (check) => {
        check.output.summary = check.output.summary.replace(
          HEAD_SHA.slice(0, 7),
          "deadbee"
        )
      },
    ],
    [
      "unrelated current-revision code tag",
      (check) => {
        check.output.summary =
          check.output.summary.replace(HEAD_SHA.slice(0, 7), "deadbee") +
          `<code>${HEAD_SHA}</code>`
      },
    ],
  ]
  it.each(invalidChecks)("rejects %s", (_label, mutate) => {
    const check = cloudflareCheck("market")
    mutate(check)
    expect(resolveChecks([check])).toEqual(MISSING_URLS)
  })

  it("does not use an older success behind a newer pending or failed trusted run", () => {
    for (const state of ["pending", "failure"]) {
      const older = cloudflareCheck("market", 1)
      const newer = cloudflareCheck("market", 2)
      if (state === "pending") newer.status = "in_progress"
      else newer.conclusion = "failure"
      expect(resolveChecks([newer, older])).toEqual(MISSING_URLS)
      expect(resolveChecks([older, newer])).toEqual(MISSING_URLS)
    }
  })

  it("ignores another App's newer text but rejects duplicate trusted run IDs", () => {
    const trusted = cloudflareCheck("market", 1)
    const other = cloudflareCheck("market", 2)
    other.app.id = 1
    expect(resolveChecks([other, trusted]).branchUrl).toBeTruthy()
    expect(resolveChecks([trusted, { ...trusted }])).toEqual(MISSING_URLS)
  })

  it("requires a full exact source SHA and does not infer missing URLs", () => {
    const check = cloudflareCheck("market")
    expect(resolveChecks([check], HEAD_SHA.slice(0, 7))).toEqual(MISSING_URLS)
    check.output.summary = check.output.summary.replace(
      "Branch Preview URL:",
      "Unavailable:"
    )
    expect(resolveChecks([check])).toEqual(MISSING_URLS)
  })

  const validBranch = "https://feature-preview.conduit-market-coo.pages.dev"
  const invalidUrls = [
    ["wrong scheme", validBranch.replace("https:", "http:")],
    ["other project host", validBranch.replace("market-coo", "merchant-33n")],
    ["unapproved project alias", validBranch.replace("market-coo", "market")],
    ["hostname suffix", `${validBranch}.example.invalid`],
    [
      "nested host label",
      validBranch.replace("feature-preview.", "nested.feature-preview."),
    ],
    ["explicit port", `${validBranch}:443`],
    ["path", `${validBranch}/other`],
    ["query", `${validBranch}?other=1`],
    ["fragment", `${validBranch}#other`],
    ["protocol-relative URL", validBranch.replace("https:", "")],
  ]
  it.each(invalidUrls)("rejects a published URL with %s", (_label, invalid) => {
    const check = cloudflareCheck("market")
    check.output.summary = check.output.summary.replace(validBranch, invalid!)
    expect(resolveChecks([check])).toEqual(MISSING_URLS)
  })

  it("rejects URL user information and non-deployment commit labels", () => {
    const check = cloudflareCheck("market")
    const url = new URL(validBranch)
    url.username = "fixture-user"
    check.output.summary = check.output.summary.replace(validBranch, url.href)
    expect(resolveChecks([check])).toEqual(MISSING_URLS)
    const badCommit = cloudflareCheck("market")
    badCommit.output.summary = badCommit.output.summary.replace(
      "1234abcd.",
      "not-a-deployment."
    )
    expect(resolveChecks([badCommit])).toEqual(MISSING_URLS)
  })
})

describe("fixed public Cloudflare check read", () => {
  it("uses the fixed same-repository endpoint without credentials or redirects", async () => {
    let reads = 0
    const checks = [cloudflareCheck("market"), cloudflareCheck("merchant")]
    const result = await listPublicCloudflareCheckRuns({
      headSha: HEAD_SHA,
      fetchImpl: (async (input, options) => {
        reads += 1
        const url = new URL(String(input))
        expect(url.origin).toBe("https://api.github.com")
        expect(url.pathname).toBe(
          `/repos/Conduit-BTC/conduit-mono/commits/${HEAD_SHA}/check-runs`
        )
        expect(Object.fromEntries(url.searchParams)).toEqual({
          app_id: "85455",
          per_page: "100",
          filter: "latest",
        })
        expect(options?.headers).toEqual({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        })
        expect(options?.method).toBe("GET")
        expect(options?.credentials).toBe("omit")
        expect(options?.redirect).toBe("error")
        expect(options?.cache).toBe("no-store")
        expect(options?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({ total_count: checks.length, check_runs: checks })
      }) as typeof fetch,
    })
    expect(reads).toBe(1)
    expect(result).toEqual(checks)
  })

  it.each([302, 403, 429, 500])(
    "fails closed on HTTP %s without retrying",
    async (status) => {
      let reads = 0
      await expect(
        listPublicCloudflareCheckRuns({
          headSha: HEAD_SHA,
          fetchImpl: (async () => {
            reads += 1
            return new Response("", { status })
          }) as typeof fetch,
        })
      ).rejects.toThrow("Cloudflare public checks could not be read safely")
      expect(reads).toBe(1)
    }
  )

  it.each([
    null,
    { total_count: -1, check_runs: [] },
    { total_count: 101, check_runs: [] },
    { total_count: 1, check_runs: [] },
    { total_count: 0, check_runs: {} },
  ])("rejects malformed or incomplete public results %#", async (body) => {
    await expect(
      listPublicCloudflareCheckRuns({
        headSha: HEAD_SHA,
        fetchImpl: (async () => Response.json(body)) as typeof fetch,
      })
    ).rejects.toThrow("Cloudflare public checks could not be read safely")
  })

  it("sanitizes invalid JSON and network failures and rejects short heads before I/O", async () => {
    for (const fetchImpl of [
      async () => new Response("{"),
      async () => {
        throw new Error("Remote details must not enter output")
      },
    ]) {
      await expect(
        listPublicCloudflareCheckRuns({
          headSha: HEAD_SHA,
          fetchImpl: fetchImpl as typeof fetch,
        })
      ).rejects.toThrow("Cloudflare public checks could not be read safely")
    }
    let reads = 0
    await expect(
      listPublicCloudflareCheckRuns({
        headSha: "short",
        fetchImpl: (async () => {
          reads += 1
          return Response.json({})
        }) as typeof fetch,
      })
    ).rejects.toThrow("A full source commit is required")
    expect(reads).toBe(0)
  })

  it("keeps the workflow read-only and retains validated-manifest verification", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(".github/workflows/ci.yml").text()
    ) as {
      jobs: Record<
        string,
        {
          permissions: Record<string, string>
          needs: string[]
          steps: Array<{ name?: string; with?: { script?: string } }>
        }
      >
    }
    const job = workflow.jobs["preview-links"]!
    expect(job.permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    })
    expect(job.needs).toEqual(["build-mainnet"])
    const script = job.steps.find(
      (step) => step.name === "Verify mainnet preview links"
    )!.with!.script!
    expect(script).toContain("listPublicCloudflareCheckRuns({ headSha })")
    for (const field of [
      "manifest.commitSha !== headSha",
      "manifest.app !== row.app",
      'manifest.deploymentProfile !== "preview"',
      "manifest.publicConfigDigest !== expectedConfigDigest",
      "dmCompatibilityOrderRoutingEnabled",
      "livePresenceEnabled",
      "quantumRouterEnabled",
      "quantumRouterExecutionEnabled",
      "breezLightningAddressEnabled",
    ]) {
      expect(script).toContain(field)
    }
    expect(script).toContain("core.summary.addRaw(previewSummary).write()")
    expect(script).not.toContain("createComment")
    expect(script).not.toContain("updateComment")
  })
})
