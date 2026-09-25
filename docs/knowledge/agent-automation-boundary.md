# Agent Automation Boundary

Read this note for changes to agent intake, dispatch, review, or hardening
workflows. Ordinary coding sessions do not need it. This document describes
the public `conduit-mono` boundary, not a claim that production incidents
are detected and remediated automatically.

## Implemented public boundary

- Account-authenticated review and refresh workflows do not run in this public
  repository. A separately controlled reviewer can inspect eligible PRs and
  submit advisory inline review comments for the exact reviewed commit.
- Automated code changes, first-shot execution, and PR hardening are paused.
  Maintainer intent alone does not isolate credentials from candidate code.
  Restoring these modes requires a separately reviewed execution boundary.
- Protocol, auth, payment, privacy, security, broad architecture, and release
  work requires human-owned planning. Agents do not approve their own work.
- Public CI enforces telemetry policy and smoke-test contracts. These checks
  are evidence about a candidate, not production detection or release approval.

Intake, review, implementation, and release remain separate responsibilities.
An automated review does not prove that an incident became a ticket, an
implemented PR, an approved preview, or a release.

## Review requests

Automatic review applies to open, non-draft, same-repository PRs targeting
`main`, excluding dependency-bot PRs and PRs labeled `DO NOT MERGE`.
Each new head receives a correctness pass. A clean pass can start one automatic
Ponytail simplicity review per PR. New heads do not rearm that simplicity pass,
including after a failed attempt.

Maintainers can request an advisory rerun with an exact `/agent review` or
`/agent simplify` PR comment. Owners, members, and collaborators can use these
commands in conversation comments or inline review comments. The reviewer polls
for requests, so delivery is delayed and schedules can be delayed or dropped.
These commands do not change code, approve a PR, or determine mergeability.

The model receives immutable source snapshots and has no GitHub token. Trusted
delivery code validates changed-line anchors and rechecks the PR's base and
head before submitting a `COMMENT` review. Actionable findings appear only as
inline review conversations. Malformed or stale results cannot produce a clean
handoff. Model findings remain untrusted advice; human review is required.

These reviews are advisory. The former `agent-review-handoff` workflow context
is retired and must not become a required branch-protection check.

## Public and private data

Public workflows may contain sanitized gates, review instructions, test
contracts, and aggregate smoke results. Private prompts, tracker and
dashboard links, telemetry backend details, credentials, and release
coordination belong outside this public repository. Agent inputs, logs,
comments, artifacts, and telemetry must follow
[`docs/analytics/events.md`](../analytics/events.md). They must exclude
pubkeys, npubs, nsecs, invoices, payment hashes, NWC URIs, signer codes,
wallet recovery material, order and message contents, addresses, contact
details, IPs, fingerprints, and private dashboard exports.

## Human ownership

Humans own risk classification when the evidence is uncertain, high-risk
planning, code review, preview testing, merge, release, and production
interpretation. A workflow result or agent-authored PR never supplies those
approvals. Changes to workflow gates must be reviewed against the current
workflow code and the PR evidence rules in `CONTRIBUTING.md`.
