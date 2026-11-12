import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const runner = fileURLToPath(
  new URL("./support/checkout-spark-settlement-cold-import.ts", import.meta.url)
)

describe("settlement entrypoints in a fresh process", () => {
  for (const first of [
    "settled-router",
    "settled-outgoing",
    "settled-outgoing-history",
    "settled-returned",
    "treasury-finalization",
    "merchant-settlement",
    "invoice-origin",
    "invoice-recipient",
    "settled-plan",
    "settled-validation",
    "treasury-model",
    "merchant-settlement-model",
  ]) {
    it(`constructs, restores and verifies proofs after importing ${first} first`, () => {
      const child = spawnSync(process.execPath, [runner, first], {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      })
      expect(child.error).toBeUndefined()
      expect(child.stderr).toBe("")
      expect(child.status).toBe(0)
      expect(child.stdout.trim()).toBe(`cold settlement: ${first}`)
    }, 25_000)
  }
})
