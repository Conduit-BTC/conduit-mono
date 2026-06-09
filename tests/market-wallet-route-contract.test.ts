import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market wallet route contracts", () => {
  it("lets the shared NWC parser validate wallet connection strings", async () => {
    const content = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(content).toContain("parseNwcUri(trimmed)")
    expect(content).not.toContain('startsWith("nostr+walletconnect://")')
  })
})
