# Dependency execution boundary

Every direct Action and reusable workflow reference is pinned to a full commit.
Version comments retain updater context; the existing GitHub Actions Dependabot
configuration remains active. The unit gate rejects tag/branch/computed refs and
checkout credential persistence. Review new pins as executable code, including
nested actions in reusable workflows; a pinned wrapper alone cannot constrain
an unpinned transitive dependency. Pins do not prove a dependency is benign.

Bun installs use the lockfile and retain the three-day resolution delay. The
root `trustedDependencies` explicitly permits only `esbuild` and `workerd`
lifecycle scripts for their platform binary setup/verification. This replaces
Bun's wider built-in trust list. The root repository's own `prepare` script is
still repository-controlled executable code. Runtime imports, build plugins and
test code also execute regardless of lifecycle-script restrictions.

The seven former audit exceptions are removed: a zero-exemption audit of the
current graph on 2026-10-26 reported no vulnerabilities across 781 packages.
The recurring audit remains necessary because advisories change. Do not add a
new exception without recording affected versions, runtime/build reachability,
review owner and removal condition. No package versions change in this update.

Dependency audit installs inherit read-only repository permissions. Only the OSV
reporting jobs request `security-events: write`. Production deployment credentials
remain restricted to the existing release step after credential-free validation
and compilation. Account-backed review execution remains outside this repository.

Repository settings can still permit administrative bypass and unpinned actions;
source tests are not proof of administrative enforcement. Private operations
records must verify actual branch, environment, hosting and access controls.

Sources: [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use),
[Bun lifecycle scripts](https://bun.sh/docs/pm/lifecycle).
