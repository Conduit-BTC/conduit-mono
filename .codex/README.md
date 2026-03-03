# Codex Workflow Notes

This folder provides Codex-specific operational prompts and review checklists.

## Files

- `prompts/pr-review.md` - Standard prompt for consistent local PR hardening and review output.

## Review Standards

When using Codex for review in this repo, prioritize:
- correctness and regressions
- protocol/auth/privacy/payment guardrails
- tests and reproducibility

The assistant should produce findings first (with severity and file/line references), then a short summary.
