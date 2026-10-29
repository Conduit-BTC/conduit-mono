const DEFAULT_CLOUDFLARE_USERS = new Set([
  "cloudflare-workers-and-pages",
  "cloudflare-workers-and-pages[bot]",
  "cloudflare-pages[bot]",
])

const CLOUDFLARE_APP_ID = 85455
const CLOUDFLARE_APP_SLUG = "cloudflare-workers-and-pages"
const PUBLIC_CHECKS_REPOSITORY = "Conduit-BTC/conduit-mono"

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

export function resolveProjectUrls({
  comments,
  projectName,
  previewHostname,
  headSha,
  cloudflareUsers = DEFAULT_CLOUDFLARE_USERS,
}) {
  const candidates = comments
    .filter((comment) => {
      const body = comment.body || ""
      return (
        cloudflareUsers.has(comment.user?.login || "") &&
        new RegExp(`Deploying ${escapeRegExp(projectName)}(?:\\s|$)`).test(
          body
        ) &&
        /^[a-f0-9]{40}$/.test(headSha) &&
        checkSummaryMatchesHead(body, headSha)
      )
    })
    .reverse()

  for (const comment of candidates) {
    const extracted = extractUrlsFromCommentBody(comment.body || "")
    const urls = {
      commitUrl: isProjectPreviewUrl(extracted.commitUrl, previewHostname, true)
        ? extracted.commitUrl
        : null,
      branchUrl: isProjectPreviewUrl(extracted.branchUrl, previewHostname)
        ? extracted.branchUrl
        : null,
    }
    if (urls.commitUrl || urls.branchUrl) {
      return urls
    }
  }

  return { commitUrl: null, branchUrl: null }
}

function checkSummaryMatchesHead(summary, headSha) {
  const revisionPattern = [headSha, headSha.slice(0, 7)]
    .map(escapeRegExp)
    .join("|")
  return new RegExp(
    `<strong>\\s*Latest\\s+commit:?\\s*</strong>(?:(?!</tr>)[\\s\\S])*?<code>\\s*(?:${revisionPattern})\\s*</code>`,
    "i"
  ).test(summary)
}

function isProjectPreviewUrl(value, previewHostname, commit = false) {
  if (
    typeof value !== "string" ||
    typeof previewHostname !== "string" ||
    !/^[a-z0-9-]+\.pages\.dev$/.test(previewHostname)
  )
    return false
  const label = commit ? "[a-f0-9]{8}" : "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
  return new RegExp(
    `^https://${label}\\.${escapeRegExp(previewHostname)}/?$`
  ).test(value)
}

export function resolveProjectUrlsFromChecks({
  checkRuns,
  projectName,
  previewHostname,
  headSha,
}) {
  const missing = { commitUrl: null, branchUrl: null }
  if (
    !/^[a-f0-9]{40}$/.test(headSha) ||
    typeof previewHostname !== "string" ||
    !/^[a-z0-9-]+\.pages\.dev$/.test(previewHostname)
  ) {
    return missing
  }

  // Check provenance comes from GitHub's fixed public API, never candidate text.
  // Select the latest trusted run before examining its outcome: an older success
  // must not hide a newer failure or an unfinished deployment of the same head.
  const candidates = checkRuns
    .filter(
      (check) =>
        check?.app?.id === CLOUDFLARE_APP_ID &&
        check.app.slug === CLOUDFLARE_APP_SLUG &&
        check.app.owner?.login === "cloudflare" &&
        check.name === `Cloudflare Pages: ${projectName}` &&
        check.head_sha === headSha &&
        Number.isSafeInteger(check.id) &&
        check.id > 0
    )
    .sort((left, right) => right.id - left.id)
  const check = candidates[0]
  const summary = check?.output?.summary
  if (
    !check ||
    (candidates[1] && candidates[1].id === check.id) ||
    check.status !== "completed" ||
    check.conclusion !== "success" ||
    typeof summary !== "string" ||
    !checkSummaryMatchesHead(summary, headSha)
  ) {
    return missing
  }

  const urls = extractUrlsFromCommentBody(summary)
  if (
    !isProjectPreviewUrl(urls.commitUrl, previewHostname, true) ||
    !isProjectPreviewUrl(urls.branchUrl, previewHostname)
  ) {
    return missing
  }
  return urls
}

export async function listPublicCloudflareCheckRuns({
  headSha,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    throw new Error("A full source commit is required for public checks.")
  }
  const endpoint = new globalThis.URL(
    `https://api.github.com/repos/${PUBLIC_CHECKS_REPOSITORY}/commits/${headSha}/check-runs`
  )
  endpoint.search = `app_id=${CLOUDFLARE_APP_ID}&per_page=100&filter=latest`
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: globalThis.AbortSignal.timeout(10_000),
    })
    if (response.status !== 200 || response.redirected) {
      throw new Error("Public check response was unavailable.")
    }
    const result = await response.json()
    if (
      !result ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count < 0 ||
      result.total_count > 100 ||
      !Array.isArray(result.check_runs) ||
      result.check_runs.length !== result.total_count
    ) {
      throw new Error("Public check response was incomplete.")
    }
    return result.check_runs
  } catch {
    // Do not expose remote bodies or request headers in candidate job output.
    throw new Error("Cloudflare public checks could not be read safely.")
  }
}

export async function waitForProjectRows({
  listComments,
  listChecks = null,
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
        previewHostname: project.previewHostname,
        headSha,
      })

      return {
        app,
        label: project.label,
        branchUrl: urls.branchUrl,
        commitUrl: urls.commitUrl,
      }
    })

    if (
      rows.some((row) => !row.branchUrl) &&
      listChecks &&
      (attempt === 1 || attempt === attempts)
    ) {
      // Public unauthenticated reads have a lower shared limit. Never turn this
      // fallback into another polling loop or follow an arbitrary pagination URL.
      let checkRuns = []
      try {
        const result = await listChecks()
        if (Array.isArray(result)) checkRuns = result
      } catch {
        // Unavailable checks prove nothing, but must not veto a later valid
        // authenticated comment within the existing comment polling window.
      }
      for (const row of rows) {
        if (row.branchUrl) continue
        const project = projects[row.app]
        const urls = resolveProjectUrlsFromChecks({
          checkRuns,
          projectName: project.project,
          previewHostname: project.previewHostname,
          headSha,
        })
        row.branchUrl = urls.branchUrl
        row.commitUrl = urls.commitUrl
      }
    }

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

export async function fetchPreviewManifest({
  branchUrl,
  previewHostname,
  headSha,
  attempt,
  fetchImpl = globalThis.fetch,
}) {
  // Recheck the destination at the I/O boundary, even for prepared rows.
  if (
    !isProjectPreviewUrl(branchUrl, previewHostname) ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    throw new Error("Invalid preview manifest request.")
  }
  const manifestUrl = new globalThis.URL(
    "/.well-known/conduit-deployment.json",
    branchUrl
  )
  manifestUrl.searchParams.set("commit", headSha)
  manifestUrl.searchParams.set("attempt", String(attempt))
  try {
    // Manifest identity checks do not authorize a different network destination.
    const response = await fetchImpl(manifestUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: globalThis.AbortSignal.timeout(10_000),
    })
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new Error("Preview manifest redirects are not allowed.")
    }
    return { response, manifestUrl }
  } catch {
    throw new Error("Preview manifest could not be read safely.")
  }
}
