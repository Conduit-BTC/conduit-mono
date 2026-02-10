type GitLabMrChangesResponse = {
  title?: string
  description?: string
  web_url?: string
  changes?: Array<{
    old_path: string
    new_path: string
    diff: string
    deleted_file: boolean
    renamed_file: boolean
    new_file: boolean
  }>
}

type GitLabMrNote = {
  id: number
  body?: string
  created_at?: string
  system?: boolean
}

function mustGetEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function getEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

async function gitlabRequest<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GitLab API ${method} ${url} failed: ${res.status} ${text.slice(0, 500)}`)
  }
  return JSON.parse(text) as T
}

async function openaiReview(model: string, apiKey: string, input: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
    }),
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = JSON.stringify(json ?? {}, null, 2).slice(0, 800)
    throw new Error(`OpenAI API failed: ${res.status} ${msg}`)
  }

  // Best-effort: Responses API typically provides output_text.
  const outputText = (json as { output_text?: string }).output_text
  if (typeof outputText === "string" && outputText.trim()) return outputText.trim()

  // Fallback: search for text in output array.
  const out = (json as any)?.output
  if (Array.isArray(out)) {
    const chunks: string[] = []
    for (const item of out) {
      const content = item?.content
      if (!Array.isArray(content)) continue
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") chunks.push(c.text)
      }
    }
    if (chunks.length) return chunks.join("\n").trim()
  }

  return "Codex review produced no text output."
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "\n\n[truncated]\n"
}

function buildPrompt(mr: GitLabMrChangesResponse, diffs: string): string {
  const title = mr.title ?? "(no title)"
  const desc = mr.description ?? ""
  const url = mr.web_url ?? ""

  return [
    "You are a senior engineer reviewing a GitLab merge request for the Conduit monorepo.",
    "",
    "Review goals:",
    "- Identify correctness bugs, security issues, behavioral regressions, missing tests.",
    "- Call out protocol risks and backward compatibility concerns.",
    "- Suggest concrete fixes with file paths.",
    "",
    "Project constraints:",
    "- TypeScript strict.",
    "- No Zustand. No Jotai. Auth is React Context only.",
    "- MVP auth: NIP-07 only. NIP-46 is post-MVP (Phase 6).",
    "- One-way checkout is intent+proof only; Conduit never touches funds.",
    "- Sensitive data must never go to logs/analytics.",
    "",
    `MR: ${title}`,
    url ? `URL: ${url}` : "",
    desc ? `Description:\n${truncate(desc, 4000)}` : "",
    "",
    "Diffs (unified):",
    diffs,
    "",
    "Output format:",
    "- Start with a 1-paragraph summary.",
    "- Then list findings ordered by severity. Each finding includes: file path, what's wrong, and a suggested fix.",
    "- If no findings, say so and list any recommended tests.",
  ]
    .filter(Boolean)
    .join("\n")
}

async function listMrNotes(apiUrl: string, projectId: string, mrIid: string, token: string): Promise<GitLabMrNote[]> {
  const url = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes?per_page=100&sort=desc&order_by=created_at`
  return gitlabRequest<GitLabMrNote[]>("GET", url, token)
}

function findTriggerNoteId(notes: GitLabMrNote[], triggerText: string): number | null {
  for (const n of notes) {
    const body = n.body ?? ""
    if (body.includes(triggerText)) return n.id
  }
  return null
}

function hasAlreadyRespondedToTrigger(notes: GitLabMrNote[], triggerNoteId: number): boolean {
  const marker = `codex:trigger_note_id=${triggerNoteId}`
  for (const n of notes) {
    const body = n.body ?? ""
    if (body.includes(marker)) return true
  }
  return false
}

async function main() {
  const apiUrl = getEnv("GITLAB_API_URL", "https://gitlab.com/api/v4")
  const projectId = process.env["CI_PROJECT_ID"] ?? mustGetEnv("CODEX_REVIEW_PROJECT_ID")
  const mrIid = process.env["CI_MERGE_REQUEST_IID"] ?? mustGetEnv("CODEX_REVIEW_MR_IID")

  const gitlabToken = mustGetEnv("GITLAB_BOT_TOKEN")
  const openaiKey = mustGetEnv("OPENAI_API_KEY")
  const model = getEnv("CODEX_REVIEW_MODEL", "gpt-5")

  const mrUrl = `${apiUrl}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}`
  const changesUrl = `${mrUrl}/changes`

  const requireTrigger = getEnv("CODEX_REVIEW_REQUIRE_TRIGGER", "false") === "true"
  const triggerText = getEnv("CODEX_REVIEW_TRIGGER_TEXT", "/codex review")
  const explicitTriggerNoteIdRaw = process.env["CODEX_REVIEW_TRIGGER_NOTE_ID"]
  const explicitTriggerNoteId = explicitTriggerNoteIdRaw ? Number(explicitTriggerNoteIdRaw) : null

  let triggerNoteId: number | null = null
  if (requireTrigger || explicitTriggerNoteId !== null) {
    const notes = await listMrNotes(apiUrl, projectId, mrIid, gitlabToken)
    triggerNoteId = explicitTriggerNoteId ?? findTriggerNoteId(notes, triggerText)

    if (triggerNoteId === null) {
      console.log("No trigger comment found; skipping Codex review.")
      return
    }

    if (hasAlreadyRespondedToTrigger(notes, triggerNoteId)) {
      console.log("Codex already responded to this trigger note; skipping.")
      return
    }
  }

  const mr = await gitlabRequest<GitLabMrChangesResponse>("GET", changesUrl, gitlabToken)

  const changes = mr.changes ?? []
  const diffs = changes
    .slice(0, 30)
    .map((c) => {
      const path = c.new_path || c.old_path
      const header = `--- ${path} ---`
      return `${header}\n${truncate(c.diff ?? "", 12000)}`
    })
    .join("\n\n")

  const prompt = buildPrompt(mr, truncate(diffs, 200000))
  const review = await openaiReview(model, openaiKey, prompt)

  const noteUrl = `${mrUrl}/notes`
  const body = [
    "## Codex MR Review",
    triggerNoteId ? `\n<!-- codex:trigger_note_id=${triggerNoteId} -->` : "",
    "",
    review,
  ].join("\n")

  await gitlabRequest("POST", noteUrl, gitlabToken, { body })
  // Keep logs minimal to avoid leaking anything.
  console.log("Posted Codex review note to MR.")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
