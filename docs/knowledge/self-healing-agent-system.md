# Self-Healing Agent System

This note describes the public-safe side of the Conduit agent automation model.
Private prompts, Linear/Slack/Cloudflare runbooks, telemetry backend details,
and release coordination live in the private `Conduit-BTC/conduit-agent-ops`
repository.

Tracking: CND-87.

## Public/Private Boundary

Public `conduit-mono` may contain:

- sanitized agent workflow gates
- PR review instructions
- telemetry allowlist and CI policy checks
- smoke-test artifact contracts
- public-safe bug report templates

Public `conduit-mono` must not contain:

- API tokens, Nostr secret keys, signer pairing codes, NWC URIs, or wallet
  credentials
- customer message, order, payment, shipping, address, or contact contents
- private telemetry payloads or dashboard exports
- private company planning notes or internal release coordination

## Observability Loop

Detection -> triage -> Linear ticket -> agent-ready gate -> PR ->
review/harden -> human preview test -> release.

Agents should create or update Linear tickets from sanitized evidence only. A
ticket should include the affected app/surface, observed symptom, redacted
evidence, suspected subsystem, reproduction path or failing check link,
acceptance criteria, and risk class.

## Product Feature Loop

Idea -> Linear ticket -> groom for SFD -> implementation agent -> same-PR
contract and implementation review/harden loop.

Feature work should be groomed before implementation. If product requirements,
protocol behavior, or shared expectations change, update the relevant public
contract in the implementation PR before merge. Use a separate decision PR only
for broad cross-PR architecture or external consensus that must be settled first.

## Linear Label Kickoff

Linear label-driven code-changing kickoff is split across private and public
surfaces:

- private agent ops intake verifies the Linear webhook and normalizes the issue
  label event
- public `conduit-mono` receives only a sanitized `repository_dispatch` payload
- `agent-ready` or `agent-fix` plus `risk:A` or `risk:B` can open an agent PR
  against `main`
- `risk:C` remains advisory-only and must not create a code-changing first-shot
  run without human-owned planning

`repository_dispatch` workflows run from the default branch, so new dispatch
workflow changes must be merged to `main` before Linear label events can use
them.

## Risk Classes

- `A`: low-risk docs, tests, copy, formatting, config, or isolated UI polish.
  Agents may draft PRs after creating a Linear ticket and notify the team when
  the PR is ready for human preview testing.
- `B`: normal product or app behavior changes. Requires maintainer intent, such
  as an `agent-ready` label, before an agent can push code.
- `C`: protocol, auth, payments, privacy, security, release policy, or broad
  architecture changes. Requires human-owned planning before an agent can
  implement code.

## Smoke Artifact Contract

Agent-readable smoke artifacts should be public-safe and redacted. They may
include:

- app, network, route, and check name
- pass/fail status
- aggregate relay counts
- latency bucket
- CI run, preview URL, or commit SHA
- sanitized console excerpts with secrets removed

They must not include pubkeys, npubs, nsecs, invoices, NWC URIs, signer pairing
codes, order contents, message contents, addresses, IP addresses, fingerprints,
or private dashboard exports.

## Human Gate

Humans remain responsible for merge, release, private dashboard interpretation,
policy/security decisions, and preview testing of user-facing product flows.
