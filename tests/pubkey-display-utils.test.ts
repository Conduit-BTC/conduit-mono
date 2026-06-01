import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { formatNpub, normalizePubkey, pubkeyToNpub } from "@conduit/core"

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}

const ZERO_HEX =
  "0000000000000000000000000000000000000000000000000000000000000000"
const ZERO_NPUB =
  "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme"
const ZERO_NPROFILE =
  "nprofile1qyfhwumn8ghj7un9d3shjtn90psk6urvv5qzqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqahf29h"

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) return collectTsxFiles(path)
    return path.endsWith(".tsx") ? [path] : []
  })
}

describe("pubkey display helpers", () => {
  test("converts hex pubkeys to npub", () => {
    expect(pubkeyToNpub(ZERO_HEX)).toBe(ZERO_NPUB)
    expect(formatNpub(ZERO_HEX, 8)).toBe("npub1qqqqqqqq...qqzqujme")
  })

  test("keeps npub display values stable", () => {
    expect(pubkeyToNpub(ZERO_NPUB)).toBe(ZERO_NPUB)
    expect(normalizePubkey(ZERO_NPUB)).toBe(ZERO_HEX)
  })

  test("normalizes nprofile references to hex pubkeys", () => {
    expect(normalizePubkey(ZERO_NPROFILE)).toBe(ZERO_HEX)
  })

  test("falls back defensively for invalid pubkey display values", () => {
    expect(pubkeyToNpub("not-a-pubkey")).toBe("not-a-pubkey")
    expect(formatNpub("not-a-pubkey", 8)).toBe("not-a-pubkey")
    expect(normalizePubkey("not-a-pubkey")).toBe(null)
  })
})

test("app TSX does not format identity pubkeys as hex", () => {
  const repoRoot = process.cwd()
  const files = [
    ...collectTsxFiles(join(repoRoot, "apps/market/src")),
    ...collectTsxFiles(join(repoRoot, "apps/merchant/src")),
    ...collectTsxFiles(join(repoRoot, "packages/ui/src")),
  ].filter((file) => !file.endsWith("routeTree.gen.tsx"))

  const offenders = files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const formatIndex = line.indexOf("formatPubkey(")
        if (formatIndex === -1) return []
        const argument = line
          .slice(formatIndex + "formatPubkey(".length)
          .split(/[),]/)[0]
        if (
          !/\b(pubkey|merchantPubkey|buyerPubkey|walletPubkey)\b/.test(argument)
        ) {
          return []
        }

        return [`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`]
      })
  )

  expect(offenders).toEqual([])
})
