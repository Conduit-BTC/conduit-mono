type GitLabMrChangesResponse = {
  title?: string
  description?: string
  web_url?: string
  diff_refs?: {
    base_sha?: string
    head_sha?: string
    start_sha?: string
  }
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

type GitLabMrVersion = {
  id: number
  head_commit_sha: string
  base_commit_sha: string
  start_commit_sha: string
}

type ReviewFinding = {
  file: string
  line: number | null
  severity: "critical" | "warning" | "suggestion"
  comment: string
  suggested_fix: string | null
}

type ReviewOutput = {
  summary: string
  findings: ReviewFinding[]
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
      text: {
        format: {
          type: "json_schema",
          name: "code_review",
          strict: true,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "1-paragraph review summary" },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string", description: "File path from the diff (new_path)" },
                    line: { type: ["integer", "null"], description: "Line number in the new file (from the + side of the diff). null if not line-specific." },
                    severity: { type: "string", enum: ["critical", "warning", "suggestion"] },
                    comment: { type: "string", description: "What is wrong and why" },
                    suggested_fix: { type: ["string", "null"], description: "Concrete code fix or null" },
                  },
                  required: ["file", "line", "severity", "comment", "suggested_fix"],
                  additionalProperties: false,
                },
              },
            },
            required: ["summary", "findings"],
            additionalProperties: false,
          },
        },
      },
    }),
  })

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = JSON.stringify(json ?? {}, null, 2).slice(0, 800)
    throw new Error(`OpenAI API failed: ${res.status} ${msg}`)
  }

  const outputText = (json as { output_text?: string }).output_text
  if (typeof outputText === "string" && outputText.trim()) return outputText.trim()

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

  return JSON.stringify({ summary: "Codex review produced no text output.", findings: [] })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "\n\n[truncated]\n"
}

/**
 * Parse unified diff to extract the set of valid new-side line numbers per file.
 * These are lines that appear with a "+" prefix (additions) or unchanged lines
 * in the new file, so we can safely attach inline comments to them.
 */
function parseNewLineNumbers(changes: GitLabMrChangesResponse["changes"]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  for (const change of changes ?? []) {
    const lines = new Set<number>()
    let newLine = 0
    for (const raw of (change.diff ?? "").split("\n")) {
      // Hunk header: @@ -a,b +c,d @@
      const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1], 10)
        continue
      }
      if (raw.startsWith("-")) {
        // Removed line — no new line number
        continue
      }
      if (raw.startsWith("+") || raw.startsWith(" ")) {
        lines.add(newLine)
        newLine++
        continue
      }
      // Anything else (e.g. "\ No newline at end of file") — skip
    }
    map.set(change.new_path, lines)
  }
  return map
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
    "- Suggest concrete fixes with file paths and line numbers.",
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
    "IMPORTANT output rules:",
    "- Respond with valid JSON matching the schema.",
    "- `file` must exactly match a file path from the diffs above (new_path).",
    "- `line` must be a line number from the NEW side of the diff (lines starting with '+' or ' '). Use null for file-level findings.",
    "- For each finding, provide a concrete `suggested_fix` (a code snippet) or null if not applicable.",
    "- Order findings by severity: critical first, then warning, then suggestion.",
    "- Be concise. Each comment should be 1-3 sentences max.",
    "- If no findings, return an empty findings array.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseReviewOutput(raw: string): ReviewOutput {
  try {
    const parsed = JSON.parse(raw)
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "No summary provided.",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    }
  } catch {
    // Fallback: treat the whole response as a summary with no inline findings
    return { summary: raw, findings: [] }
  }
}

function formatFindingBody(finding: ReviewFinding): string {
  const icon = finding.severity === "critical" ? ":red_circle:" : finding.severity === "warning" ? ":warning:" : ":information_source:"
  const parts = [`${icon} **${finding.severity}**: ${finding.comment}`]
  if (finding.suggested_fix) {
    parts.push("", "```suggestion", finding.suggested_fix, "```")
  }
  return parts.join("\n")
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

  // Fetch MR changes (includes diff_refs with SHAs)
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
  const rawReview = await openaiReview(model, openaiKey, prompt)
  const review = parseReviewOutput(rawReview)

  // Get diff refs for inline positioning
  const baseSha = mr.diff_refs?.base_sha
  const headSha = mr.diff_refs?.head_sha
  const startSha = mr.diff_refs?.start_sha
  const canInline = !!(baseSha && headSha && startSha)

  if (!canInline) {
    console.log("diff_refs not available on MR response; falling back to versions endpoint.")
  }

  // If diff_refs missing from changes response, try versions endpoint
  let finalBaseSha = baseSha
  let finalHeadSha = headSha
  let finalStartSha = startSha
  if (!canInline) {
    try {
      const versionsUrl = `${mrUrl}/versions`
      const versions = await gitlabRequest<GitLabMrVersion[]>("GET", versionsUrl, gitlabToken)
      if (versions.length > 0) {
        finalBaseSha = versions[0].base_commit_sha
        finalHeadSha = versions[0].head_commit_sha
        finalStartSha = versions[0].start_commit_sha
      }
    } catch (err) {
      console.log(`Failed to fetch MR versions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const hasRefs = !!(finalBaseSha && finalHeadSha && finalStartSha)
  const validNewLines = hasRefs ? parseNewLineNumbers(changes) : new Map<string, Set<number>>()

  // Build a set of diff file paths for validation
  const diffFiles = new Set(changes.map((c) => c.new_path))

  // Post inline findings as discussion threads
  let inlineCount = 0
  let fallbackFindings: ReviewFinding[] = []

  for (const finding of review.findings) {
    const fileValid = diffFiles.has(finding.file)
    const fileLines = validNewLines.get(finding.file)
    const lineValid = finding.line != null && fileLines?.has(finding.line)

    if (hasRefs && fileValid && lineValid && finding.line != null) {
      // Post as inline discussion thread
      const discussionUrl = `${mrUrl}/discussions`
      const body = formatFindingBody(finding)

      // Find old_path for this file (may differ on renames)
      const change = changes.find((c) => c.new_path === finding.file)
      const oldPath = change?.old_path ?? finding.file

      try {
        await gitlabRequest("POST", discussionUrl, gitlabToken, {
          body,
          position: {
            position_type: "text",
            base_sha: finalBaseSha,
            head_sha: finalHeadSha,
            start_sha: finalStartSha,
            new_path: finding.file,
            old_path: oldPath,
            new_line: finding.line,
          },
        })
        inlineCount++
      } catch (err) {
        // If inline fails (e.g. line mismatch), fall back to summary
        console.log(`Inline comment failed for ${finding.file}:${finding.line}: ${err instanceof Error ? err.message : String(err)}`)
        fallbackFindings.push(finding)
      }
    } else {
      // Can't post inline — collect for summary note
      fallbackFindings.push(finding)
    }
  }

  // Post summary note (always, with any non-inline findings appended)
  const summaryParts = [
    "## Codex MR Review",
    triggerNoteId ? `\n<!-- codex:trigger_note_id=${triggerNoteId} -->` : "",
    "",
    review.summary,
  ]

  if (fallbackFindings.length > 0) {
    summaryParts.push("", "### Findings", "")
    for (const f of fallbackFindings) {
      const icon = f.severity === "critical" ? ":red_circle:" : f.severity === "warning" ? ":warning:" : ":information_source:"
      const loc = f.line != null ? `${f.file}:${f.line}` : f.file
      summaryParts.push(`- ${icon} **${f.severity}** \`${loc}\`: ${f.comment}`)
      if (f.suggested_fix) {
        summaryParts.push("  ```", `  ${f.suggested_fix.split("\n").join("\n  ")}`, "  ```")
      }
    }
  }

  if (inlineCount > 0) {
    summaryParts.push("", `*${inlineCount} additional finding(s) posted as inline diff comments.*`)
  }

  const noteUrl = `${mrUrl}/notes`
  await gitlabRequest("POST", noteUrl, gitlabToken, { body: summaryParts.join("\n") })

  console.log(`Posted Codex review: ${inlineCount} inline, ${fallbackFindings.length} in summary, ${review.findings.length} total findings.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
