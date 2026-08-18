const DEFAULT_CLOUDFLARE_USERS = new Set([
  "cloudflare-workers-and-pages",
  "cloudflare-workers-and-pages[bot]",
  "cloudflare-pages[bot]",
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function labeledHref(body, label) {
  const labelPattern = label.trim().split(/\s+/).map(escapeRegExp).join("\\s+")
  const rowPattern = new RegExp(
    `<strong>\\s*${labelPattern}:?\\s*</strong>(?:(?!</tr>)[\\s\\S])*?<a\\s+[^>]*href\\s*=\\s*['"]([^'"]+)['"]`,
    "i"
  )

  return body.match(rowPattern)?.[1] || null
}

export function extractUrlsFromCommentBody(body) {
  return {
    commitUrl: labeledHref(body, "Preview URL"),
    branchUrl: labeledHref(body, "Branch Preview URL"),
  }
}

function commentMatchesHead(body, headSha) {
  const revisions = [headSha, headSha.slice(0, 7)]

  return revisions.some((revision) => {
    const pattern = new RegExp(
      `<code>\\s*${escapeRegExp(revision)}\\s*</code>`,
      "i"
    )
    return pattern.test(body)
  })
}

export function resolveProjectUrls({
  comments,
  projectName,
  headSha,
  cloudflareUsers = DEFAULT_CLOUDFLARE_USERS,
}) {
  const candidates = comments
    .filter((comment) => {
      const body = comment.body || ""
      return (
        cloudflareUsers.has(comment.user?.login || "") &&
        body.includes(`Deploying ${projectName}`) &&
        commentMatchesHead(body, headSha)
      )
    })
    .reverse()

  for (const comment of candidates) {
    const urls = extractUrlsFromCommentBody(comment.body || "")
    if (urls.commitUrl || urls.branchUrl) {
      return urls
    }
  }

  return { commitUrl: null, branchUrl: null }
}

export async function waitForProjectRows({
  listComments,
  projects,
  headSha,
  attempts = 90,
  intervalMs = 5_000,
  sleep = (duration) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, duration)),
}) {
  let comments = []
  let missingProjects = Object.values(projects).map(
    (project) => project.project
  )

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    comments = await listComments()
    const rows = Object.entries(projects).map(([app, project]) => {
      const urls = resolveProjectUrls({
        comments,
        projectName: project.project,
        headSha,
      })

      return {
        app,
        label: project.label,
        branchUrl: urls.branchUrl,
        commitUrl: urls.commitUrl,
      }
    })

    missingProjects = rows
      .filter((row) => !row.branchUrl)
      .map((row) => projects[row.app].project)

    if (missingProjects.length === 0) {
      return { comments, rows }
    }

    if (attempt < attempts) {
      await sleep(intervalMs)
    }
  }

  throw new Error(
    `Cloudflare did not publish branch preview URLs for ${missingProjects.join(
      ", "
    )} at ${headSha}; refusing to guess deployment aliases.`
  )
}
