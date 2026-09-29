export const CONTRIBUTOR_REFRESH_BRANCH =
  "chore/refresh-repository-contributors"
export const CONTRIBUTOR_SNAPSHOT_PATH =
  "scripts/vite/repository_contributors.generated.json"

export function isContributorRefreshPullRequest(pr, repository) {
  return (
    pr?.user?.type === "Bot" &&
    pr.user.login === "conduit-sudden-agent[bot]" &&
    pr.head?.repo?.full_name === repository &&
    pr.head.ref === CONTRIBUTOR_REFRESH_BRANCH &&
    pr.base?.repo?.full_name === repository &&
    pr.base.ref === "main"
  )
}

export function assertContributorRefreshPullRequest(pr, files, repository) {
  if (
    !isContributorRefreshPullRequest(pr, repository) ||
    files.length !== 1 ||
    files[0].filename !== CONTRIBUTOR_SNAPSHOT_PATH ||
    files[0].status !== "modified"
  ) {
    throw new Error(
      "Contributor refresh must be an App-owned, same-repository PR changing only the existing snapshot."
    )
  }
}
