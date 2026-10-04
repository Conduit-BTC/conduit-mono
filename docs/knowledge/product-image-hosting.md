# Product image hosting and recovery

Product listings remain NIP-99 plus the Open Markets working specification for
`kind:30402`. The editor accepts up to 24 ordered images, whether they come from
uploads or URL entry. The first image is the cover. Public request projection is
bounded separately from retaining original signed listing evidence.

## Runtime defaults and personal preferences

App relays use `wss://relay.conduit.market`. The visible order is Conduit, Ditto,
Plebeian Market, Damus, and nos.lol. Purpose flags remain explicit: moving
Plebeian does not make it a protected inbox, and Damus serves public writes.
Conduit and Ditto remain the app-owned protected-inbox defaults. Existing signed
personal relay preferences retain their original URLs.

The media default list and hosting guidance live in
`packages/core/src/protocol/product-image-upload.ts`. Defaults are runtime
choices. They never create or publish a personal `kind:10063` preference.
Existing signed server lists keep their order and take precedence. Upload plans
use the first ten safe servers to bound requests without rewriting the preference
record or blocking its preferred host. Incomplete
reads do not authorize replacing unknown preferences with defaults. A local
mirror is usable only while it matches the verified signed revision and list.

The current default is `https://blossom.ditto.pub`. Adding another shared public
provider requires both technical validation and permission for the intended
merchant workflow. In particular, nostr.build's published terms restrict free
business use and commercial exploitation without a paid account. A server URL
does not establish paid status or permission. Merchants can consciously configure
servers through Network settings. The note beside default uploads links to
nostr.build's plan comparison and that settings surface without blocking uploads
or promising permanence.

## Verified copies and partial failure

Each image is validated, decoded, resized, stripped of metadata, and prepared
once. The same prepared bytes are sent sequentially to each selected provider.
Each provider receives its own current, server-scoped external-signer upload
authorization. Existing signature, authority, size, MIME, descriptor, redirect,
response-body, and SHA-256 checks remain required before adopting a URL.

One verified copy makes the image usable immediately. A failed additional copy
keeps the successful work and offers retry. While the editor remains open, retry
reuses the exact prepared bytes and skips already verified providers. Closing or
reloading retains adopted URLs in the product draft; unfinished file data and
retry authorization are not persisted. File retry state does not survive reopening; adopted URLs remain usable.

Ordered Open Markets `image` tags remain canonical. Optional NIP-92 `imeta`
metadata adds the image hash and verified `fallback` URLs. Recovery accepts only
public URLs with the same hash. Shared product cards, Merchant previews, and
Market detail images try these sources in order on load failure. A changed URL
clears the old copy metadata. URL-only images have no asserted backup.

A successful request is evidence at verification time, not a durability promise.
The UI describes a backup only when additional copies were verified. It never
infers permanence or paid entitlement from a hostname.

## Validation and release boundary

Focused tests cover identical upload bytes, scoped signatures, first-provider
and backup failures, corrupted responses, retries, and authority changes.
Browser coverage composes upload, order and cover changes, draft recovery,
publication, editing, and alternate-host display with intercepted providers.
That coverage does not prove a physical external signer's behavior or live
provider durability.

A bounded live probe should use synthetic images and a disposable test identity,
verify returned bytes, and remove its own test uploads afterward. Keep aggregate
status and timing evidence; do not log signer secrets or merchant content.
Changing defaults is an implementation change. Maintainers still own provider
eligibility, external-signer QA, code review, and deployment approval.

## Public references

- [Open Markets](https://github.com/OpenMarketsFoundation/specification)
- [NIP-92](https://github.com/nostr-protocol/nips/blob/master/92.md)
- [Blossom upload](https://github.com/hzrd149/blossom/blob/master/buds/02.md)
- [Blossom server lists](https://github.com/hzrd149/blossom/blob/master/buds/03.md)
- [Blossom authorization scope](https://github.com/hzrd149/blossom/blob/master/buds/11.md)
- [nostr.build terms](https://account.nostr.build/tos)
