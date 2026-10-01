---
name: deed-debug
description: Inspect public Conduit Nostr listings, profiles, relay declarations, and deletion events with the repo-local Deed harness when diagnosing relay observations, public references, or event signatures. Use the existing smoke tools for protected reads and signer or payment flows.
---

# Public Nostr debugging

Run from the checkout root. Start with `bun run nostr:debug doctor`. If the pinned
executable is missing, run `bun run nostr:debug:setup`; this downloads a release
into ignored `context/tools/deed/` and checks its repository-pinned SHA-256.
Nothing is installed globally or added to application dependencies.

Use `bun run nostr:debug --help` for supported commands. Choose the smallest
query that explains the symptom, with one explicit relay and a bounded limit.

```sh
bun run nostr:debug req --relay wss://relay.conduit.market --kind 30402 --limit 20
bun run nostr:debug req --relay wss://relay.conduit.market --kind 30402 --author <public-hex> --limit 5 --save listings.jsonl
bun run nostr:debug verify context/nostr-debug/listings.jsonl
bun run nostr:debug decode <public-naddr>
```

Queries return an aggregate observation. `--save` deliberately writes raw public
events to a new, private-permission file in ignored `context/nostr-debug/`; inspect
only the fields needed locally. Do not paste captures, public identifiers, event
content, or upstream diagnostics into CI artifacts, telemetry, or public reports.
The `decode` command reports reference type and status only; add
`--save reference.json` to capture its fields locally without printing identifiers.

Compare observations with the application's existing shared protocol helpers.
A matching valid signature proves event integrity, not commerce authorization,
current listing terms, delivery, or global absence. An empty result is only a
bounded observation; `coverage: not_established` is intentional even on exit 0.
If diagnostics are present, do not describe the result as a clean complete read.

The wrapper supports public kinds 0, 5, 10002, 10050, and 30402. It refuses secret
references, arbitrary flags, streams, authentication, key operations, signing,
encryption/decryption, and publication. Use `bun run smoke:nip42` for the existing
protected-read harness. This tool cannot diagnose NIP-50 queries or replace
external signers, application relay planning, or delivery recovery.

For setup, limits, sources, and pin updates, read
[the public debugging note](../../../docs/knowledge/deed-debugging.md).
