# Ordinary settings conformance fixtures

Copied from Open Markets proposal #22 at commit
`3fff162811add519afc8cf2e3cfed27fe197eebb`:
https://github.com/OpenMarketsFoundation/specification/pull/22

The runtime parser suite checks every JSON fixture. Both published JSON Schemas
also pass all ten fixtures under Draft 2020-12. These fixtures contain synthetic
values only. Event signatures, NIP-44 encryption and synchronization are exercised
separately by the settings coordinator and Linux browser tests.
