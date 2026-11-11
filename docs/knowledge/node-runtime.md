# Node.js build runtime

Use Node.js 24.22.3 from the repository-root `.node-version` for local tooling,
CI builds and the address-gateway deployment CLI. Bun remains the application
package manager and test runner. The supported Node release lines start at
22.23.5, 24.22.3 and 26.13.1, the November 11, 2026 security releases.

Cloudflare Pages builds for `conduit-market` and `conduit-merchant` must use
`NODE_VERSION=24.22.3` in both Preview and Production. A dashboard environment
variable overrides the repository version file. Changing this file does not
update an existing dashboard override or rebuild an existing deployment.
Account settings and production deployments require separate authorization.

The gateway runs on Cloudflare Workers; Node.js is used by its deployment CLI,
not as the deployed request-serving runtime. Keep the Node pin aligned across
CI, Pages and local development when applying subsequent security updates.

Reference: https://nodejs.org/en/blog/vulnerability/november-2026-security-releases
