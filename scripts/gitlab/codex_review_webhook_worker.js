/**
 * Cloudflare Worker template: GitLab "Note Hook" -> trigger Codex review pipeline
 *
 * Setup (high level):
 * 1) In GitLab: Settings -> CI/CD -> Pipeline triggers -> create token
 * 2) Deploy this worker with:
 *    - GITLAB_TRIGGER_TOKEN
 *    - GITLAB_WEBHOOK_SECRET (optional but strongly recommended)
 *    - GITLAB_API_URL (default: https://gitlab.com/api/v4)
 * 3) In GitLab: Settings -> Webhooks
 *    - URL: worker URL
 *    - Secret token: GITLAB_WEBHOOK_SECRET
 *    - Trigger: "Note events"
 *
 * This worker triggers a pipeline when a MR comment contains "/codex review".
 *
 * Security:
 * - Validates X-Gitlab-Token against GITLAB_WEBHOOK_SECRET when set.
 */

const DEFAULT_API_URL = "https://gitlab.com/api/v4"
const DEFAULT_TRIGGER_TEXT = "/codex review"

async function readJson(req) {
  const text = await req.text()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 })

    const secret = env.GITLAB_WEBHOOK_SECRET
    if (secret) {
      const token = request.headers.get("X-Gitlab-Token")
      if (!token || token !== secret) return new Response("Unauthorized", { status: 401 })
    }

    const payload = await readJson(request)
    if (!payload) return new Response("Bad Request", { status: 400 })

    // GitLab "Note Hook" payload
    const objectKind = payload.object_kind
    const note = payload.object_attributes?.note || ""
    const noteableType = payload.object_attributes?.noteable_type

    if (objectKind !== "note" || noteableType !== "MergeRequest") {
      return new Response("Ignored", { status: 200 })
    }

    const triggerText = env.CODEX_REVIEW_TRIGGER_TEXT || DEFAULT_TRIGGER_TEXT
    if (!note.includes(triggerText)) return new Response("No trigger", { status: 200 })

    const projectId = payload.project?.id
    const mrIid = payload.merge_request?.iid
    const ref = payload.merge_request?.source_branch

    if (!projectId || !mrIid || !ref) return new Response("Missing MR context", { status: 400 })

    const apiUrl = env.GITLAB_API_URL || DEFAULT_API_URL
    const triggerToken = env.GITLAB_TRIGGER_TOKEN
    if (!triggerToken) return new Response("Missing GITLAB_TRIGGER_TOKEN", { status: 500 })

    const triggerUrl = `${apiUrl}/projects/${encodeURIComponent(projectId)}/ref/${encodeURIComponent(ref)}/trigger/pipeline`

    const form = new URLSearchParams()
    form.set("token", triggerToken)
    form.set("ref", ref)
    form.set("variables[CODEX_REVIEW_MR_IID]", String(mrIid))
    form.set("variables[CODEX_REVIEW_REQUIRE_TRIGGER]", "true")

    const res = await fetch(triggerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    })

    if (!res.ok) {
      const t = await res.text()
      return new Response(`Trigger failed: ${res.status} ${t.slice(0, 500)}`, { status: 500 })
    }

    return new Response("Triggered", { status: 200 })
  },
}

