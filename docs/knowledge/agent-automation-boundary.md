# Agent Automation Boundary

Read this note for changes to agent intake, dispatch, review, or hardening
workflows. Ordinary coding sessions do not need it. This document describes
the public `conduit-mono` boundary, not a claim that production incidents
are detected and remediated automatically.

## Implemented public boundary

- Sanitized `repository_dispatch` can start a first-shot workflow after
  intake checks. Code-changing runs require an `agent-ready` or `agent-fix`
  maintainer label and an allowed risk class. The workflow also supports
  dry-run investigation without a PR.
- Review and manually invoked hardening workflows can inspect or revise a PR.
  They do not approve their own work. Risk C protocol, auth, payment, privacy,
  security, broad architecture, and release work requires human-owned planning.
- Public CI enforces telemetry policy and smoke-test contracts. These checks
  are evidence about a candidate, not production detection or release approval.

Intake, review, and hardening are separate workflows. Their existence does
not prove that a production signal became a ticket, then an implemented PR,
then a reviewed preview, then a release. A successful dry run proves only
the stages it actually executed.

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
