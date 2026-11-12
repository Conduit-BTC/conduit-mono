import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

describe("pricing issuance retirement", () => {
  it("does not ship the retired Worker workspace or signed client export", () => {
    expect(
      existsSync(resolve(root, "apps/checkout-pricing/package.json"))
    ).toBe(false)
    const core = JSON.parse(
      readFileSync(resolve(root, "packages/core/package.json"), "utf8")
    )
    expect(core.exports["./pricing/signed-rate-client"]).toBeUndefined()
  })

  it("keeps retired issuance endpoints and clients out of shipping sources", async () => {
    const obsolete =
      /conduit-checkout-pricing(?:-preview)?\.[a-z0-9.-]+\.workers\.dev|signed-rate-client|checkout-spark-authorized-pricing|checkout-spark-pricing-authority-server/
    const violations: string[] = []
    const scanned = new Set<string>()
    for (const pattern of [
      "apps/*/src/**/*.{ts,tsx,js,jsx}",
      "packages/*/src/**/*.{ts,tsx,js,jsx}",
    ]) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: root })) {
        scanned.add(path.replaceAll("\\", "/"))
        if (obsolete.test(readFileSync(resolve(root, path), "utf8"))) {
          violations.push(path.replaceAll("\\", "/"))
        }
      }
    }
    expect(scanned.has("apps/market/src/routes/checkout.tsx")).toBe(true)
    expect(scanned.has("packages/core/src/pricing/rates.ts")).toBe(true)
    expect(violations.sort()).toEqual([])
  })
})
