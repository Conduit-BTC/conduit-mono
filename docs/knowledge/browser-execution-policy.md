# Browser execution policy

Market and Merchant emit a shared Content Security Policy in their built
Cloudflare Pages `_headers`. The wildcard covers entry HTML, `/about`, static
assets and SPA fallbacks. The existing Market `/api` Functions return JSON;
Pages Functions do not inherit `_headers`. Any new document-producing Function
must explicitly provide the same policy and receive browser coverage.

The policy allows first-party scripts and the exact theme bootstrap hash.
It rejects additional entry HTML scripts at build time, JavaScript eval,
inline handlers, objects, base-URL changes, and framing the apps. NDK's installed
`tseep` dependency uses its documented no-eval entry point in application builds.
The existing Spark wallet requires `wasm-unsafe-eval`; this does not enable
JavaScript string evaluation. Inline styles remain permitted for the existing UI.

## Executable dependencies

| Source                                               | Purpose                                                | Update and review boundary                                                           |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| First-party built modules and worker                 | Application, bundled PostHog, protocol and wallet code | Reviewed source, frozen lockfile, build and release controls                         |
| Hashed inline theme bootstrap                        | Apply saved theme before rendering                     | Shared theme source; build rejects other inline code                                 |
| `challenges.cloudflare.com`                          | Turnstile address-request challenge                    | Vendor-managed mutable code; explicit script/frame allowance, no permanent SRI claim |
| Exact configured `https://plausible.io/js/*.js` file | Optional legacy telemetry on nonofficial hosts         | Only allowed when configured at build; arbitrary source overrides fail the build     |

Official Shop/Sell already disable Plausible. PostHog remains bundled, with
remote dependency loading and session recording disabled. Hosting-injected
scripts are not automatically trusted. New script providers require explicit
source and policy review. Restricting scripts cannot protect against a malicious
allowed bundle or an administrator who changes both content and headers.

User-selected relays, media, uploads and wallet services retain their network
capabilities. `connect-src` permits HTTP(S)/WS(S); it is not an exfiltration
barrier. Existing untrusted-content rendering stays behind React escaping and
the shared Markdown/URL restrictions. The explicit-sink regression check is a
review alarm, not proof that every possible XSS pattern is detected.

## Validation and delivery

The required `build-mainnet` job runs `playwright.security.config.ts` in the
pinned Linux browser image after building and verifying deployment manifests.
Chromium and WebKit exercise both apps' built responses: inline/script-URL
injection, unapproved remote scripts, base changes, generated and fallback
routes, modules, workers and WebAssembly. The local fixture serves the emitted
headers; it does not emulate Cloudflare Functions or prove deployed policy.

Before production activation, verify enforcing headers on the exact preview
commit and exercise signer import/restore/removal, NIP-07/NIP-46, NIP-44,
checkout/wallets, uploads, Turnstile, lazy routes and custom relays. A synthetic
WASM module is not proof of a complete wallet transaction. Physical installed-app
checks remain separate. Never make `unsafe-inline` or `unsafe-eval` script
exceptions to obtain a pass.

Do not collect raw CSP violation reports, script samples, URLs or query strings.
Synthetic browser evidence contains no account credentials. Rollback of code
cannot revoke an identity key that was already stolen. Private response and
release procedures remain outside this repository.

Sources: [Pages headers](https://developers.cloudflare.com/pages/configuration/headers/),
[Turnstile CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/),
[tseep no-eval entry](https://github.com/Morglod/tseep#use-no-eval-version).
