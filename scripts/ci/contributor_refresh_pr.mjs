export const CONTRIBUTOR_REFRESH_BRANCH =
  "chore/refresh-repository-contributors"
export const CONTRIBUTOR_SNAPSHOT_PATH =
  "scripts/vite/repository_contributors.generated.json"

const BOT_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\[bot\]$/

function isContributorRefreshBotLogin(login) {
  return (
    typeof login === "string" &&
    login.trim() === login &&
    BOT_LOGIN_PATTERN.test(login)
  )
}

export function assertContributorRefreshBotLogin(login) {
  if (!isContributorRefreshBotLogin(login)) {
    throw new Error("Configure a valid contributor refresh App bot login.")
  }
  return login
}

export function isContributorRefreshPullRequest(pr, repository, botLogin) {
  return (
    isContributorRefreshBotLogin(botLogin) &&
    pr?.user?.type === "Bot" &&
    pr.user.login === botLogin &&
    pr.head?.repo?.full_name === repository &&
    pr.head.ref === CONTRIBUTOR_REFRESH_BRANCH &&
    pr.base?.repo?.full_name === repository &&
    pr.base.ref === "main"
  )
}

export function assertContributorRefreshPullRequest(
  pr,
  files,
  repository,
  botLogin
) {
  if (
    !isContributorRefreshPullRequest(pr, repository, botLogin) ||
    files.length !== 1 ||
    files[0].filename !== CONTRIBUTOR_SNAPSHOT_PATH ||
    files[0].status !== "modified"
  ) {
    throw new Error(
      "Contributor refresh must be an App-owned, same-repository PR changing only the existing snapshot."
    )
  }
}
