---
name: deed-debug
description: Inspect aggregate public Conduit Nostr relay observations with the repo-local Deed harness when diagnosing listing, profile, relay-declaration, or deletion discovery. Targeted identity and signature inspection is developer-only; use the existing smoke tools for protected reads and signer or payment flows.
---

# Aggregate public Nostr debugging

Run from the checkout root. Start with `bun run nostr:debug:agent doctor`. If the
pinned executable is missing, run `bun run nostr:debug:setup`; this downloads a
release into ignored `context/tools/deed/` and checks its repository-pinned
SHA-256. Nothing is installed globally or added to application dependencies.

Use only the aggregate agent entry point. Choose one known public relay origin,
one public kind, and a bounded limit. The relay hostname must not contain
personal data; paths, credentials, query strings, and fragments are refused.

```sh
bun run nostr:debug:agent --help
bun run nostr:debug:agent doctor
bun run nostr:debug:agent req --relay wss://relay.conduit.market --kind 30402 --limit 20
```

Keep public keys, encoded identities, event identifiers, raw events, and personal
data out of agent prompts, tool arguments, logs, comments, and artifacts. Output
redaction cannot remove an identifier already recorded in a tool invocation.
Do not ask the user to provide identifiers to an agent. If targeted inspection
is needed, have a developer perform it locally and supply only aggregate status
or counts. Do not execute the developer entry point, read capture/verification
files, or forward raw upstream diagnostics. The agent entry point accepts only
`doctor` and `req` with relay, kind, limit, and timeout options; it refuses
identity filters, decoding, file input, and captures.

Compare aggregate observations with the application's existing shared protocol
helpers. An empty result is only a bounded observation;
`coverage: not_established` is intentional even on exit 0. If diagnostics are
present, do not describe the result as a clean complete read. Aggregates do not
prove event integrity, commerce authorization, current listing terms, delivery,
or global absence.

The wrapper supports public kinds 0, 5, 10002, 10050, and 30402. It refuses
arbitrary flags, streams, authentication, key operations, signing,
encryption/decryption, and publication. Use `bun run smoke:nip42` for the existing
protected-read harness. This tool cannot diagnose NIP-50 queries or replace
external signers, application relay planning, or delivery recovery.

For setup, limits, sources, and pin updates, read
[the public debugging note](../../../docs/knowledge/deed-debugging.md). Its
Developer-only local inspection section is for human local use, not agent tools.
