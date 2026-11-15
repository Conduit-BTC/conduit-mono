import { expect, test } from "bun:test"
import {
  createPublicDeploymentManifest,
  resolveDeploymentProfile,
} from "../scripts/vite/deployment_profile"

for (const profile of ["production", "preview", "staging"] as const) {
  test(`${profile} disables local keys even with a stale enabling override`, () => {
    const resolved = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: profile,
      VITE_ENABLE_LOCAL_KEY_SIGNER: "true",
    })
    expect(resolved.publicFeatures.localKeySignerEnabled).toBe(false)
    for (const app of ["market", "merchant"]) {
      const manifest = createPublicDeploymentManifest({
        app,
        profile: resolved,
        commitSha: "containment-test",
        branch: "containment-test",
        buildTime: "2026-11-15T00:00:00.000Z",
        sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
      })
      expect(manifest.publicFeatures.localKeySignerEnabled).toBe(false)
    }
  })
}

for (const branch of ["main", "fix/disable-local-key-login"]) {
  test(`Cloudflare branch ${branch} selects a disabled managed profile`, () => {
    const resolved = resolveDeploymentProfile({
      CF_PAGES: "1",
      CF_PAGES_BRANCH: branch,
      VITE_ENABLE_LOCAL_KEY_SIGNER: "true",
    })
    expect(resolved.name).toBe(branch === "main" ? "production" : "preview")
    expect(resolved.publicFeatures.localKeySignerEnabled).toBe(false)
  })
}
