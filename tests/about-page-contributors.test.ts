import { describe, expect, it } from "bun:test"
import {
  fetchRepositoryContributorSnapshot,
  loadRepositoryContributorSnapshot,
} from "../scripts/vite/repository_contributors"

const SOURCE_REVISION = "a".repeat(40)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function commit(oid: string, parentCount = 1) {
  return {
    commit: {
      oid,
      parents: { totalCount: parentCount },
    },
  }
}

function repositoryPage({
  pullRequests,
  hasNextPage = false,
  endCursor = null,
}: {
  pullRequests: unknown[]
  hasNextPage?: boolean
  endCursor?: string | null
}) {
  return {
    data: {
      repository: {
        defaultBranchRef: { target: { oid: SOURCE_REVISION } },
        pullRequests: {
          nodes: pullRequests,
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  }
}

const alice = {
  __typename: "User",
  login: "alice",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  url: "https://github.com/alice",
}

const generatedFallback = {
  status: "available",
  methodology: "merged-pr-activity-v1",
  generatedAt: "2026-08-26T01:00:00.000Z",
  sourceRevision: SOURCE_REVISION,
  contributors: [
    {
      login: "alice",
      mergedPullRequests: 2,
      commits: 3,
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      profileUrl: "https://github.com/alice",
    },
  ],
}

describe("About page contributor build data", () => {
  it("credits merged PR authors and counts unique non-merge commits", async () => {
    let observedSignal: AbortSignal | null | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedSignal = init?.signal
      return jsonResponse(
        repositoryPage({
          pullRequests: [
            {
              number: 10,
              author: alice,
              commits: {
                nodes: [commit("commit-a"), commit("merge-a", 2)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            {
              number: 11,
              author: alice,
              commits: {
                nodes: [commit("commit-a"), commit("commit-b")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            {
              number: 12,
              author: {
                __typename: "Bot",
                login: "dependabot[bot]",
                avatarUrl: "https://avatars.githubusercontent.com/in/29110?v=4",
                url: "https://github.com/apps/dependabot",
              },
              commits: {
                nodes: [commit("bot-commit")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          ],
        })
      )
    }

    const snapshot = await fetchRepositoryContributorSnapshot({
      fetchImpl,
      generatedAt: "2026-08-26T01:00:00.000Z",
      token: "test-token",
    })

    expect(snapshot).toEqual({
      status: "available",
      methodology: "merged-pr-activity-v1",
      generatedAt: "2026-08-26T01:00:00.000Z",
      sourceRevision: SOURCE_REVISION,
      contributors: [
        {
          login: "alice",
          mergedPullRequests: 2,
          commits: 2,
          avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
          profileUrl: "https://github.com/alice",
        },
      ],
    })
    expect(observedSignal).toBeInstanceOf(AbortSignal)
    expect(observedSignal?.aborted).toBe(false)
  })

  it("paginates commit histories instead of silently truncating large PRs", async () => {
    let requests = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests += 1
      const request = JSON.parse(String(init?.body)) as {
        variables: { cursor?: string | null }
      }

      if (requests === 1) {
        expect(request.variables.cursor).toBeNull()
        return jsonResponse(
          repositoryPage({
            pullRequests: [
              {
                number: 20,
                author: alice,
                commits: {
                  nodes: [commit("commit-a")],
                  pageInfo: { hasNextPage: true, endCursor: "commit-cursor" },
                },
              },
            ],
          })
        )
      }

      expect(request.variables.cursor).toBe("commit-cursor")
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [commit("commit-b")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })
    }

    const snapshot = await fetchRepositoryContributorSnapshot({
      fetchImpl,
      token: "test-token",
    })

    expect(requests).toBe(2)
    expect(snapshot.contributors[0]?.commits).toBe(2)
  })

  it("uses a recent generated snapshot when no build token is available", async () => {
    const snapshot = await loadRepositoryContributorSnapshot({
      token: null,
      fallbackSnapshot: generatedFallback,
      now: new Date("2026-08-30T01:00:00.000Z"),
    })

    expect(snapshot).toEqual(generatedFallback)
  })

  it("falls back after a refresh failure and rejects a stale snapshot", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ message: "rate limited" }, 403)

    const recent = await loadRepositoryContributorSnapshot({
      fetchImpl,
      token: "test-token",
      fallbackSnapshot: generatedFallback,
      now: new Date("2026-08-30T01:00:00.000Z"),
    })
    expect(recent).toEqual(generatedFallback)

    const stale = await loadRepositoryContributorSnapshot({
      fetchImpl,
      token: "test-token",
      fallbackSnapshot: generatedFallback,
      now: new Date("2026-09-20T01:00:00.000Z"),
    })
    expect(stale).toEqual({
      status: "unavailable",
      methodology: "merged-pr-activity-v1",
      generatedAt: null,
      sourceRevision: null,
      contributors: [],
    })
  })
})
