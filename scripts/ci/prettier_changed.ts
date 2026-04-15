import { spawnSync } from "node:child_process"
import { extname } from "node:path"

const supportedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yml",
  ".yaml",
])

const ignoredSegments = new Set([
  ".claude",
  ".codex",
  ".git",
  ".husky",
  "node_modules",
  "dist",
  "build",
  "coverage",
])

const ignoredFiles = new Set(["bun.lock"])

type Mode = "--check" | "--write"

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" })

  if (result.error) {
    throw result.error
  }

  return result
}

function parseArgs(argv: string[]) {
  let mode: Mode = "--check"
  let base: string | null = null
  let head: string | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if (value === "--write") {
      mode = "--write"
      continue
    }

    if (value === "--check") {
      mode = "--check"
      continue
    }

    if (value === "--base") {
      base = argv[index + 1] ?? null
      index += 1
      continue
    }

    if (value === "--head") {
      head = argv[index + 1] ?? null
      index += 1
    }
  }

  return { mode, base, head }
}

function resolveBase(head: string, base: string | null) {
  if (base) {
    return base
  }

  const mergeBase = run("git", ["merge-base", "origin/main", head])

  if (mergeBase.status === 0) {
    const resolved = mergeBase.stdout.trim()
    if (resolved) {
      return resolved
    }
  }

  const previousCommit = run("git", ["rev-parse", `${head}^`])

  if (previousCommit.status === 0) {
    const resolved = previousCommit.stdout.trim()
    if (resolved) {
      return resolved
    }
  }

  throw new Error("Unable to determine a base ref for changed-file formatting.")
}

function shouldFormat(file: string) {
  if (file === "context" || file.startsWith("context/")) {
    return false
  }

  if (!file || ignoredFiles.has(file)) {
    return false
  }

  if (file.endsWith(".gen.ts") || file.endsWith("routeTree.gen.ts")) {
    return false
  }

  const segments = file.split("/")
  if (segments.some((segment) => ignoredSegments.has(segment))) {
    return false
  }

  return supportedExtensions.has(extname(file))
}

function collectFiles(base: string, head: string | null) {
  const diffArgs = ["diff", "--name-only", "--diff-filter=ACMR", base]

  if (head) {
    diffArgs.push(head)
  }

  const diff = run("git", diffArgs)

  if (diff.status !== 0) {
    process.stderr.write(diff.stderr)
    process.exit(diff.status ?? 1)
  }

  const changedFiles = diff.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)

  if (head) {
    return changedFiles
  }

  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])

  if (untracked.status !== 0) {
    process.stderr.write(untracked.stderr)
    process.exit(untracked.status ?? 1)
  }

  const untrackedFiles = untracked.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)

  return [...new Set([...changedFiles, ...untrackedFiles])]
}

const { mode, base, head } = parseArgs(process.argv.slice(2))
const resolvedHead = head ?? null
const resolvedBase = resolveBase(resolvedHead ?? "HEAD", base)

const files = collectFiles(resolvedBase, resolvedHead).filter(shouldFormat)

if (files.length === 0) {
  console.log("No changed files require Prettier.")
  process.exit(0)
}

console.log(`Running Prettier ${mode} on ${files.length} changed file(s).`)

const prettier = spawnSync("bunx", ["prettier", mode, ...files], {
  stdio: "inherit",
})

if (prettier.error) {
  throw prettier.error
}

process.exit(prettier.status ?? 1)
