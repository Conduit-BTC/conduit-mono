# Node.js build runtime

Use Node.js 24.22.3 from the repository-root `.node-version` for local tooling,
CI builds and the address-gateway deployment CLI. Bun remains the application
package manager and test runner. The supported Node release lines start at
22.23.5, 24.22.3 and 26.13.1, the November 11, 2026 security releases.

Cloudflare Pages updates for `conduit-market` and `conduit-merchant` are pending.
Before setting `NODE_VERSION=24.22.3` in Preview and Production, verify that a
native Cloudflare preview can install that version and complete its build.
The November 11 Landing preview failed with `node-build: definition not found:
24.22.3`, so do not change the dashboard overrides until installer support is
confirmed. A dashboard environment variable overrides the repository version
file; changing this file does not update that override or rebuild a deployment.
Account settings and production deployments require separate authorization.

The gateway runs on Cloudflare Workers; Node.js is used by its deployment CLI,
not as the deployed request-serving runtime. Merging gateway-affecting changes
(including `package.json` or the deployment workflow) triggers its production
release after main CI passes. Treat such a merge as a production release and
monitor the deployment workflow. Keep the Node pin aligned across
CI, Pages and local development when applying subsequent security updates.

Reference: https://nodejs.org/en/blog/vulnerability/november-2026-security-releases
