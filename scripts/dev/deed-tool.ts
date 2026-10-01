import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

export const DEED_VERSION = "0.3.2"
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url))
export const deedDirectory = join(
  repoRoot,
  "context",
  "tools",
  "deed",
  DEED_VERSION
)
export const deedBinary = join(deedDirectory, "deed")

// GitHub release asset digests for v0.3.2, reviewed before pinning.
export const archiveDigests: Record<string, string> = {
  "darwin-arm64":
    "7af4e779e606491104e064b2b2ea246d4f2e0289de85c010ddb61283e4db8fa1",
  "darwin-x64":
    "992dc9cdcfa78378475471edf5c48e66a84ea1dca737c9f5dcbc416fda81d3b3",
  "linux-arm64":
    "85a7ab4b06c7bdf45b73cf6b397cf6607c400c7bb72801f3f396313dd4470597",
  "linux-x64":
    "94164d4e06039a7e41531bf5f470aede1e3875924a70d8c985c47864fd1039ef",
}

export function verifyArchive(bytes: Uint8Array, expected: string): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error("Deed archive checksum mismatch; nothing was installed.")
  }
}

export function toolEnvironment(): NodeJS.ProcessEnv {
  // Read-only commands need no account keys, wallet credentials, or API tokens.
  return { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }
}
