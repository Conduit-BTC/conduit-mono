# Public Nostr debugging with Deed

Deed is an optional native CLI for inspecting Nostr data independently of Market
and Merchant. The repository supplies a pinned installer, a read-only wrapper,
and a discoverable skill in `.agents/skills/deed-debug/SKILL.md`. It is not an
application dependency, relay service, or replacement for shared protocol code.
No download happens during dependency installation, app builds, or CI tests.

## Setup and commands

From the checkout root, with Bun and `tar` available:

```sh
bun run nostr:debug:setup
bun run nostr:debug doctor
bun run nostr:debug --help
bun run nostr:debug req --relay wss://relay.conduit.market --kind 30402 --limit 20
```

Setup downloads Deed 0.3.2 for macOS/Linux on arm64/x64, verifies the archive
against a SHA-256 pinned in `scripts/dev/deed-tool.ts`, extracts only `deed`,
checks its version, then installs into ignored `context/tools/deed/0.3.2/`.
A failed setup preserves any existing executable. No remote installer is run.
There is no PATH or environment override that silently selects another binary.

To investigate a known listing, add `--author <64-character-public-hex>` or
`--id <64-character-event-id>`. Each query has one explicit `wss://` hostname;
credentials, URL query strings, fragments, IP literals, and local-host forms
are refused. Relay hints from events or decoded references are not dialed
automatically. An explicit hostname is a selected target, not a trust claim.

The default limit is 20, capped at 100; the default Deed timeout is 10 seconds,
capped at 30 seconds. An outer process deadline also bounds connection/DNS waits,
and output is capped at 16 MiB. No live public relay is a required CI dependency.

Queries print only command, exit code, count, diagnostic presence, and
`coverage: not_established`. Exit 0 does not prove complete history or global
absence. A nonzero result or diagnostic flag needs investigation, even if some
events were received. Raw relay text is never forwarded to the console.

## Local inspection

```sh
bun run nostr:debug req --relay wss://relay.conduit.market --kind 30402 --limit 5 --save listings.jsonl
bun run nostr:debug verify context/nostr-debug/listings.jsonl
bun run nostr:debug decode <public-naddr>
```

`--save` explicitly captures raw public events under ignored
`context/nostr-debug/`, using private file permissions and refusing overwrites.
Choose a new filename for each observation. A failed query can leave a partial
capture; retain its exit code and diagnostic flag when interpreting it.
`decode` prints reference type and status only. Add `--save reference.json` to
capture public reference fields locally without printing identifiers.
Verification accepts a nonempty JSONL file up to 8 MiB and checks event integrity
with Deed; neither verification nor a saved capture establishes current listing
terms, commerce authorization, deletion completeness, or recipient delivery.

Do not attach captures to public reports or CI artifacts. Keep evidence
content-free: aggregate counts, status, timing, and the relevant code/check are
sufficient. Publicly visible data can still contain personal information.

Supported kinds are profiles (0), deletion requests (5), general relay lists
(10002), private-message relay declarations (10050, public routing metadata), and
product listings (30402). Private messages, orders, wallet events, secret-key
references, signing, publishing, key operations, and encryption are out of scope.
Use the existing `smoke:nip42` command for protected-read validation.

## Harness discovery and maintenance

Codex discovers the repo-local skill from `.agents/skills/`. Other harnesses
should follow the routing link in `AGENTS.md` and read the same skill when the
investigation calls for public Nostr inspection. The skill does not grant
additional authority or enforce restrictions; the wrapper enforces its command
boundary. Agents should check `doctor` before relying on the tool.

To update Deed, review the upstream release and source, replace the version and
all four archive digests together, rerun harness tests, and exercise setup,
decode, and valid/invalid verification against the actual binary. Repository
changes are reviewed normally; binaries and captured data remain untracked.

## Sources checked

- [Deed v0.3.2](https://github.com/zig-nostr/deed/releases/tag/v0.3.2)
- [Deed request implementation](https://github.com/zig-nostr/deed/blob/v0.3.2/src/cmd_req.zig)
- [Deed verification implementation](https://github.com/zig-nostr/deed/blob/v0.3.2/src/cmd_verify.zig)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md)
- [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md)
- [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md)
- [Decentralized network posture](decentralized-network-product-posture.md)
- [External Nostr references](external-nostr-references.md)
