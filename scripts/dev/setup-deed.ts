import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  archiveDigests,
  DEED_VERSION,
  deedBinary,
  deedDirectory,
  toolEnvironment,
  verifyArchive,
} from "./deed-tool"

let stage = "platform check"

async function main() {
  if (process.argv.length > 2)
    throw new Error("Usage: bun run nostr:debug:setup")
  const digest = archiveDigests[`${process.platform}-${process.arch}`]
  if (!digest) throw new Error("Deed supports macOS/Linux on x64/arm64 only.")
  const platform = process.platform === "darwin" ? "macos" : "linux"
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64"
  const archive = `deed-${DEED_VERSION}-${platform}-${architecture}.tar.gz`
  stage = "release download"
  const response = await fetch(
    `https://github.com/zig-nostr/deed/releases/download/v${DEED_VERSION}/${archive}`,
    { signal: AbortSignal.timeout(60_000) }
  )
  if (!response.ok)
    throw new Error(`Deed download failed (HTTP ${response.status}).`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  stage = "archive checksum verification"
  verifyArchive(bytes, digest)

  stage = "verified archive extraction"
  await mkdir(deedDirectory, { recursive: true })
  const staging = await mkdtemp(join(deedDirectory, ".install-"))
  try {
    const archivePath = join(staging, archive)
    await writeFile(archivePath, bytes, { mode: 0o600 })
    // Extract only the executable, after verifying the repository-pinned digest.
    const extracted = spawnSync(
      "tar",
      ["-xzf", archivePath, "-C", staging, "deed"],
      {
        timeout: 10_000,
        env: toolEnvironment(),
        stdio: "pipe",
      }
    )
    if (extracted.error || extracted.status !== 0) {
      throw new Error("Could not extract the verified Deed executable.")
    }
    const binary = join(staging, "deed")
    await chmod(binary, 0o700)
    stage = "executable version check"
    const version = spawnSync(binary, ["version"], {
      timeout: 5_000,
      env: toolEnvironment(),
      encoding: "utf8",
    })
    if (
      version.error ||
      version.status !== 0 ||
      version.stdout.trim() !== `deed ${DEED_VERSION}`
    ) {
      throw new Error(
        "The verified Deed executable could not report its pinned version."
      )
    }
    stage = "local installation"
    await rename(binary, deedBinary)
    console.log(
      `Installed Deed ${DEED_VERSION} in ignored context/tools/deed/.`
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

main().catch(() => {
  console.error(
    `Deed setup failed during ${stage}; any existing executable was preserved.`
  )
  process.exitCode = 1
})
