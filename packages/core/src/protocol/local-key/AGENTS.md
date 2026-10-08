# Security-critical account-key boundary

Only this directory and its storage may possess imported account secrets.
Read `docs/knowledge/local-signer-security-review.md` before editing.

- Use existing pinned `nostr-tools` primitives. No custom crypto or new runtime
  dependency without demonstrated need and explicit approval.
- No secret getters, exports, general serialization, logs, telemetry,
  diagnostics, network calls or unrelated UI/business logic.
- Clear accessible secret and derived buffers on completion/invalidation.
  Never claim forensic erasure or same-origin isolation.
- Preserve automatic restore and account/revision checks around async work.
  Explicit deletion must commit before removal succeeds.
- Run crypto/lifecycle/boundary tests, composed app tests, credential-history
  guards and relevant type/lint/build checks. Runtime disposable identities and
  public official vectors only; no key-bearing artifacts.
- Require focused maintainer review of this area and auth/input changes. Keep
  activation off pending physical-iPhone/PWA validation and release approval.
