import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

const ALLOWED_FILE = "packages/ui/src/styles/theme.css"

const SCAN_INCLUDE = "{apps,packages}/**/*.{ts,tsx,js,jsx,css}"
const RGBA_PATTERN = /rgba?\s*\(/g
const HEX_PATTERN = /#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g
const ALLOWED_LINE_PATTERNS = [/Order\s+#\d+/]
const IGNORED_PATH_SEGMENTS = ["/dist/"]

type Match = {
  file: string
  line: number
  kind: "rgba" | "hex"
  snippet: string
}

async function listSourceFiles(): Promise<string[]> {
  const files: string[] = []
  const glob = new Bun.Glob(SCAN_INCLUDE)

  for await (const file of glob.scan({
    cwd: process.cwd(),
    onlyFiles: true,
    absolute: false,
    dot: false,
    followSymlinks: false,
    throwErrorOnBrokenSymlink: false,
  })) {
    if (file === ALLOWED_FILE) continue
    if (IGNORED_PATH_SEGMENTS.some((segment) => file.includes(segment))) {
      continue
    }
    files.push(file)
  }

  return files.sort((a, b) => a.localeCompare(b))
}

async function findHardcodedColorMatches(): Promise<Match[]> {
  const files = await listSourceFiles()
  const matches: Match[] = []

  for (const file of files) {
    const content = await readFile(file, "utf8")
    const lines = content.split("\n")

    lines.forEach((line, index) => {
      if (ALLOWED_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
        return
      }

      if (RGBA_PATTERN.test(line)) {
        matches.push({
          file,
          line: index + 1,
          kind: "rgba",
          snippet: line.trim(),
        })
      }
      RGBA_PATTERN.lastIndex = 0

      if (HEX_PATTERN.test(line)) {
        matches.push({
          file,
          line: index + 1,
          kind: "hex",
          snippet: line.trim(),
        })
      }
      HEX_PATTERN.lastIndex = 0
    })
  }

  return matches
}

describe("design token color policy", () => {
  it("allows raw rgba/hex only in theme.css", async () => {
    const matches = await findHardcodedColorMatches()

    const details = matches
      .map((m) => `${m.file}:${m.line} [${m.kind}] ${m.snippet}`)
      .join("\n")

    expect(
      matches,
      matches.length === 0
        ? undefined
        : `Found hardcoded color literals outside ${ALLOWED_FILE}:\n${details}`
    ).toHaveLength(0)
  })
})
