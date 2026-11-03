# Trusted name-request previews

Market and Merchant previews can use the production name-request gateway. These
are real requests, subject to the same approval and provider verification as
production. The form warns preview users before submission. The public readiness
endpoint contains no wallet or request data and lets the browser explain an
unauthorized, expired or unavailable preview before asking the signer to submit.

## Trust boundary

A Pages suffix alone grants no authority. The gateway queries Cloudflare's
account API using a server-only Pages read credential and accepts only:

- Canonical HTTPS origins directly beneath `conduit-market-coo.pages.dev` or
  `conduit-merchant-33n.pages.dev`, returned as a deployment URL or alias by the
  corresponding pinned `conduit-market` or `conduit-merchant` project.
- Successful preview deployments triggered by `github:push`, with clean commit
  metadata and a GitHub source identifying the pinned Conduit repository and ID.
- Deployments created within the last seven days.

Fork sources, other projects, manual uploads, deploy hooks, failed builds,
malformed metadata and unknown origins cannot submit, inspect private status or
perform address management. Native Pages Git integration builds repository
branches automatically and does not build fork pull requests. Candidate manifests
and client-supplied branch names are never authorization evidence. Repository
write access and Pages account administration are therefore inside this boundary.
Do not attach untrusted upload automation to these projects.

The gateway does not fetch a URL supplied by a caller. It consults only the two
pinned projects. Discovery verifies the project repository ID, then scans at most
twelve pages of 25 deployments under one five-second deadline. Every upstream call consumes the
anonymous API budget. Deployment records must independently match the repository
owner/name; their optional repository ID must agree when returned. The project
endpoint supplies the required ID because deployment records omit it in practice.
Missing credentials, rate limiting,
API failures or incomplete discovery fail closed with an unavailable response.
The production origin path does not depend on Pages API availability.

Authorization is recomputed without a persistent allowlist or positive cache.
Deleted deployments stop authorizing on the next successful lookup; older builds
expire even if their Pages URLs still exist. Expiry removes gateway authority,
not the request row, approved name or encrypted wallet record. Branch deletion by
itself is not immediate revocation: delete the Pages deployment to revoke it
before its seven-day deadline. Rebuilding a repository branch renews its preview.
Provider-reported aliases determine which deployment a mutable branch URL can use.

## Independent controls

Turnstile must cover the two project parent hostnames, alongside production.
Cloudflare automatically covers subdomains of a configured hostname; no wildcard
or `pages.dev` root is needed. A valid widget token still grants no gateway
origin authority. Siteverify must succeed with `address_name_request` and a
hostname exactly matching the admitted request origin. Tokens from a different
trusted host are rejected.

NIP-98 account proofs, wallet identity signatures, request rate limits, signed
original bytes, gateway approval and provider registration checks remain required.
Request and status URLs remain on the production gateway. The complete encrypted
Portable Wallet record retains the same signed payload and original proof across
preview and production; preview authorization never becomes wallet state or
approval evidence. A lost HTTP response still requires authenticated status lookup
before retry. Explicit challenge, rate-limit, identity and service failures are
shown separately from an ambiguous response. Each fresh security-token verification
uses a separate Siteverify idempotency key; the durable request ID still deduplicates
gateway storage. Challenge failures and expiry use explicit user retry rather
than automatic retry loops.

The checked-in gateway configuration stages preview admission disabled. Enabling
it, adding the server-only credential and Turnstile hostname changes require a
separately reviewed Cloudflare change. Gateway/provider qualification is an
independent deployed setting and must be preserved from verified live state.
No client deployment workflow receives the Pages read credential. Provider API
payloads can contain environment settings: never log or persist them, put them in
browser responses or include them in PR evidence.

## Evidence limits

Controlled gateway tests use SQLite, real request signatures and isolated
Siteverify/provider responses. Linux browser tests exercise the shared form and
workflow against a disposable local instance of the gateway. Complete-record
synchronization tests exercise real signatures and NIP-44 encryption across
independent stores. These do not prove production Turnstile admission, live
request creation, approval deployment or address activation. Those observations
require an approved deployment and separately authorized controlled real request.

## References

- [Pages preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
- [Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/)
- [Turnstile hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [Turnstile Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
