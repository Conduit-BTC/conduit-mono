# AI MR Reviews (GitLab Duo + Codex)

This repo supports two automated MR review paths:

1. **GitLab Duo Code Review** (native GitLab feature)
2. **Codex MR review** (CI job that posts an MR note)

## GitLab Duo

Duo is enabled/configured in GitLab (group or project setting), not in this repo.

Repo-side instructions live at:
- `.gitlab/duo/mr-review-instructions.yaml`

Verification:
- Open a new MR with a small change and confirm a Duo review appears on the MR.

## Codex MR Review (CI)

CI job:
- `.gitlab-ci.yml` job `codex_review`

Script:
- `scripts/gitlab/codex_mr_review.ts`

Required GitLab CI/CD variables (project/group):
- `OPENAI_API_KEY` (masked)
- `CODEX_REVIEW_MODEL` (e.g. `gpt-5`)
- `GITLAB_API_URL` (e.g. `https://gitlab.com/api/v4`)
- `GITLAB_BOT_TOKEN` (masked)

Notes:
- The `codex_review` job is `allow_failure: true`, so it will not block merges if keys/config are missing.
- If the job runs but does not post a note, check job logs for auth errors (OpenAI or GitLab token scopes).

## Tracking

Open tracking issue:
- https://gitlab.com/conduit-btc/conduit-mono/-/issues/1
