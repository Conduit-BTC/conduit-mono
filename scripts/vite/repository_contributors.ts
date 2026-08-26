import generatedSnapshot from "./repository_contributors.generated.json" with { type: "json" }
import type { Plugin } from "vite"

const CONTRIBUTOR_MODULE_ID = "virtual:conduit-repository-contributors"
const RESOLVED_CONTRIBUTOR_MODULE_ID = `\0${CONTRIBUTOR_MODULE_ID}`
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
const CONTRIBUTOR_REFRESH_TIMEOUT_MS = 15_000
const PULL_REQUESTS_PER_PAGE = 50
const COMMITS_PER_PAGE = 100
const GENERATED_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const GENERATED_SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000

export const REPOSITORY_ACTIVITY_METHODOLOGY = "merged-pr-activity-v1"

export interface RepositoryContributor {
  login: string
  mergedPullRequests: number
  commits: number
  avatarUrl: string
  profileUrl: string
}

export interface RepositoryContributorSnapshot {
  status: "available" | "unavailable"
  methodology: typeof REPOSITORY_ACTIVITY_METHODOLOGY
  generatedAt: string | null
  sourceRevision: string | null
  contributors: RepositoryContributor[]
}

type GitHubActor = {
  __typename?: unknown
  login?: unknown
  avatarUrl?: unknown
  url?: unknown
}

type GitHubCommitNode = {
  commit?: {
    oid?: unknown
    parents?: {
      totalCount?: unknown
    }
  }
}

type GitHubCommitConnection = {
  nodes?: unknown
  pageInfo?: unknown
}

type GitHubPullRequest = {
  number?: unknown
  author?: GitHubActor | null
  commits?: GitHubCommitConnection
}

type PageInfo = {
  hasNextPage: boolean
  endCursor: string | null
}

type MutableContributor = Omit<RepositoryContributor, "commits"> & {
  commitIds: Set<string>
}

export type ContributorFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

interface LoadRepositoryContributorSnapshotOptions {
  owner?: string
  repo?: string
  fetchImpl?: ContributorFetch
  generatedAt?: string
  token?: string | null
  fallbackSnapshot?: unknown
  now?: Date
}

interface GraphQlRepositoryData {
  defaultBranchRef?: {
    target?: {
      oid?: unknown
    }
  } | null
  pullRequests?: {
    nodes?: unknown
    pageInfo?: unknown
  }
  pullRequest?: {
    commits?: GitHubCommitConnection
  } | null
}

const PULL_REQUEST_ACTIVITY_QUERY = `
  query RepositoryPullRequestActivity(
    $owner: String!
    $repo: String!
    $cursor: String
    $pullRequestsPerPage: Int!
    $commitsPerPage: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef {
        target {
          ... on Commit {
            oid
          }
        }
      }
      pullRequests(
        first: $pullRequestsPerPage
        after: $cursor
        states: MERGED
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes {
          number
          author {
            __typename
            login
            avatarUrl
            url
          }
          commits(first: $commitsPerPage) {
            nodes {
              commit {
                oid
                parents(first: 2) {
                  totalCount
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

const PULL_REQUEST_COMMITS_QUERY = `
  query RepositoryPullRequestCommits(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String
    $commitsPerPage: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        commits(first: $commitsPerPage, after: $cursor) {
          nodes {
            commit {
              oid
              parents(first: 2) {
                totalCount
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHttpsUrlForHost(value: string, hostname: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === hostname
  } catch {
    return false
  }
}

function parsePageInfo(value: unknown): PageInfo {
  if (!isRecord(value) || typeof value.hasNextPage !== "boolean") {
    throw new Error("GitHub returned invalid pagination data")
  }

  if (
    value.endCursor !== null &&
    value.endCursor !== undefined &&
    typeof value.endCursor !== "string"
  ) {
    throw new Error("GitHub returned an invalid pagination cursor")
  }

  const endCursor = typeof value.endCursor === "string" ? value.endCursor : null
  if (value.hasNextPage && !endCursor) {
    throw new Error("GitHub omitted a required pagination cursor")
  }

  return { hasNextPage: value.hasNextPage, endCursor }
}

function normalizeActor(
  actor: GitHubActor | null | undefined
): Omit<RepositoryContributor, "mergedPullRequests" | "commits"> | null {
  if (
    !actor ||
    typeof actor.login !== "string" ||
    typeof actor.avatarUrl !== "string" ||
    typeof actor.url !== "string"
  ) {
    return null
  }

  if (actor.__typename === "Bot" || /\[bot\]$/i.test(actor.login)) return null
  if (!isHttpsUrlForHost(actor.avatarUrl, "avatars.githubusercontent.com")) {
    return null
  }
  if (!isHttpsUrlForHost(actor.url, "github.com")) return null

  return {
    login: actor.login,
    avatarUrl: actor.avatarUrl,
    profileUrl: actor.url,
  }
}

function addNonMergeCommits(
  contributor: MutableContributor,
  connection: GitHubCommitConnection
): PageInfo {
  if (!Array.isArray(connection.nodes)) {
    throw new Error("GitHub returned invalid pull request commit data")
  }

  for (const value of connection.nodes as GitHubCommitNode[]) {
    const commit = value?.commit
    if (
      !commit ||
      typeof commit.oid !== "string" ||
      !commit.parents ||
      typeof commit.parents.totalCount !== "number"
    ) {
      throw new Error("GitHub returned an invalid pull request commit")
    }

    if (commit.parents.totalCount < 2) contributor.commitIds.add(commit.oid)
  }

  return parsePageInfo(connection.pageInfo)
}

async function requestGraphQl(
  fetchImpl: ContributorFetch,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<GraphQlRepositoryData> {
  const response = await fetchImpl(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "Conduit-build",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(CONTRIBUTOR_REFRESH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request returned ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (
    !isRecord(payload) ||
    (Array.isArray(payload.errors) && payload.errors.length > 0)
  ) {
    throw new Error("GitHub GraphQL returned an error")
  }

  const data = payload.data
  if (!isRecord(data) || !isRecord(data.repository)) {
    throw new Error("GitHub GraphQL omitted repository data")
  }

  return data.repository as GraphQlRepositoryData
}

async function loadRemainingPullRequestCommits({
  owner,
  repo,
  pullRequestNumber,
  cursor,
  contributor,
  fetchImpl,
  token,
}: {
  owner: string
  repo: string
  pullRequestNumber: number
  cursor: string
  contributor: MutableContributor
  fetchImpl: ContributorFetch
  token: string
}): Promise<void> {
  let nextCursor: string | null = cursor

  while (nextCursor) {
    const repository = await requestGraphQl(
      fetchImpl,
      token,
      PULL_REQUEST_COMMITS_QUERY,
      {
        owner,
        repo,
        number: pullRequestNumber,
        cursor: nextCursor,
        commitsPerPage: COMMITS_PER_PAGE,
      }
    )
    const connection = repository.pullRequest?.commits
    if (!connection) {
      throw new Error("GitHub omitted pull request commit data")
    }

    const pageInfo = addNonMergeCommits(contributor, connection)
    nextCursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  }
}

function finalizeContributors(
  contributors: Map<string, MutableContributor>
): RepositoryContributor[] {
  return [...contributors.values()]
    .map(({ commitIds, ...contributor }) => ({
      ...contributor,
      commits: commitIds.size,
    }))
    .sort(
      (left, right) =>
        right.mergedPullRequests - left.mergedPullRequests ||
        right.commits - left.commits ||
        left.login.localeCompare(right.login)
    )
}

export async function fetchRepositoryContributorSnapshot({
  owner = "Conduit-BTC",
  repo = "conduit-mono",
  fetchImpl = fetch,
  generatedAt = new Date().toISOString(),
  token,
}: Required<Pick<LoadRepositoryContributorSnapshotOptions, "token">> &
  Omit<
    LoadRepositoryContributorSnapshotOptions,
    "token" | "fallbackSnapshot" | "now"
  >): Promise<RepositoryContributorSnapshot> {
  if (!token) {
    throw new Error(
      "A GitHub token is required to refresh contributor activity"
    )
  }

  const contributors = new Map<string, MutableContributor>()
  let cursor: string | null = null
  let sourceRevision: string | null = null

  do {
    const repository = await requestGraphQl(
      fetchImpl,
      token,
      PULL_REQUEST_ACTIVITY_QUERY,
      {
        owner,
        repo,
        cursor,
        pullRequestsPerPage: PULL_REQUESTS_PER_PAGE,
        commitsPerPage: COMMITS_PER_PAGE,
      }
    )

    const revision = repository.defaultBranchRef?.target?.oid
    if (typeof revision !== "string" || !/^[0-9a-f]{40}$/i.test(revision)) {
      throw new Error("GitHub omitted the default branch revision")
    }
    sourceRevision ??= revision
    if (sourceRevision !== revision) {
      throw new Error("The default branch changed during contributor refresh")
    }

    const pullRequests = repository.pullRequests
    if (!pullRequests || !Array.isArray(pullRequests.nodes)) {
      throw new Error("GitHub returned invalid pull request data")
    }

    for (const pullRequest of pullRequests.nodes as GitHubPullRequest[]) {
      const actor = normalizeActor(pullRequest.author)
      if (!actor) continue
      if (!Number.isInteger(pullRequest.number) || !pullRequest.commits) {
        throw new Error("GitHub returned an invalid pull request")
      }

      const contributor = contributors.get(actor.login) ?? {
        ...actor,
        mergedPullRequests: 0,
        commitIds: new Set<string>(),
      }
      contributor.mergedPullRequests += 1
      contributors.set(actor.login, contributor)

      const commitPage = addNonMergeCommits(contributor, pullRequest.commits)
      if (commitPage.hasNextPage && commitPage.endCursor) {
        await loadRemainingPullRequestCommits({
          owner,
          repo,
          pullRequestNumber: pullRequest.number as number,
          cursor: commitPage.endCursor,
          contributor,
          fetchImpl,
          token,
        })
      }
    }

    const pageInfo = parsePageInfo(pullRequests.pageInfo)
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (cursor)

  return {
    status: "available",
    methodology: REPOSITORY_ACTIVITY_METHODOLOGY,
    generatedAt,
    sourceRevision,
    contributors: finalizeContributors(contributors),
  }
}

function normalizeGeneratedSnapshot(
  value: unknown
): RepositoryContributorSnapshot | null {
  if (!isRecord(value)) return null
  if (
    value.status !== "available" ||
    value.methodology !== REPOSITORY_ACTIVITY_METHODOLOGY ||
    typeof value.generatedAt !== "string" ||
    typeof value.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value.sourceRevision) ||
    !Array.isArray(value.contributors)
  ) {
    return null
  }

  const contributors: RepositoryContributor[] = []
  const logins = new Set<string>()
  for (const candidate of value.contributors) {
    if (
      !isRecord(candidate) ||
      typeof candidate.login !== "string" ||
      /\[bot\]$/i.test(candidate.login) ||
      logins.has(candidate.login) ||
      !Number.isInteger(candidate.mergedPullRequests) ||
      (candidate.mergedPullRequests as number) < 1 ||
      !Number.isInteger(candidate.commits) ||
      (candidate.commits as number) < 0 ||
      typeof candidate.avatarUrl !== "string" ||
      !isHttpsUrlForHost(
        candidate.avatarUrl,
        "avatars.githubusercontent.com"
      ) ||
      typeof candidate.profileUrl !== "string" ||
      !isHttpsUrlForHost(candidate.profileUrl, "github.com")
    ) {
      return null
    }

    logins.add(candidate.login)
    contributors.push({
      login: candidate.login,
      mergedPullRequests: candidate.mergedPullRequests as number,
      commits: candidate.commits as number,
      avatarUrl: candidate.avatarUrl,
      profileUrl: candidate.profileUrl,
    })
  }

  return {
    status: "available",
    methodology: REPOSITORY_ACTIVITY_METHODOLOGY,
    generatedAt: value.generatedAt,
    sourceRevision: value.sourceRevision,
    contributors,
  }
}

function isFreshSnapshot(
  snapshot: RepositoryContributorSnapshot,
  now: Date
): boolean {
  if (!snapshot.generatedAt) return false
  const generatedAt = new Date(snapshot.generatedAt).getTime()
  if (!Number.isFinite(generatedAt)) return false
  const age = now.getTime() - generatedAt
  return (
    age >= -GENERATED_SNAPSHOT_FUTURE_TOLERANCE_MS &&
    age <= GENERATED_SNAPSHOT_MAX_AGE_MS
  )
}

function unavailableSnapshot(): RepositoryContributorSnapshot {
  return {
    status: "unavailable",
    methodology: REPOSITORY_ACTIVITY_METHODOLOGY,
    generatedAt: null,
    sourceRevision: null,
    contributors: [],
  }
}

export async function loadRepositoryContributorSnapshot({
  owner = "Conduit-BTC",
  repo = "conduit-mono",
  fetchImpl = fetch,
  generatedAt = new Date().toISOString(),
  token = process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    null,
  fallbackSnapshot = generatedSnapshot,
  now = new Date(),
}: LoadRepositoryContributorSnapshotOptions = {}): Promise<RepositoryContributorSnapshot> {
  if (token) {
    try {
      return await fetchRepositoryContributorSnapshot({
        owner,
        repo,
        fetchImpl,
        generatedAt,
        token,
      })
    } catch {
      // Continue to the bounded generated fallback.
    }
  }

  const fallback = normalizeGeneratedSnapshot(fallbackSnapshot)
  return fallback && isFreshSnapshot(fallback, now)
    ? fallback
    : unavailableSnapshot()
}

export function createRepositoryContributorsPlugin(): Plugin {
  let snapshotPromise: Promise<RepositoryContributorSnapshot> | null = null

  return {
    name: "conduit-repository-contributors",
    resolveId(id) {
      if (id === CONTRIBUTOR_MODULE_ID) return RESOLVED_CONTRIBUTOR_MODULE_ID
      return null
    },
    async load(id) {
      if (id !== RESOLVED_CONTRIBUTOR_MODULE_ID) return null

      snapshotPromise ??= loadRepositoryContributorSnapshot()
      const snapshot = await snapshotPromise
      if (snapshot.status === "unavailable") {
        this.warn(
          "Repository contributor activity could not be refreshed and the generated fallback is stale or invalid; the About page will show an unavailable state."
        )
      }

      return `export const repositoryContributorSnapshot = Object.freeze(${JSON.stringify(snapshot)});`
    },
  }
}
