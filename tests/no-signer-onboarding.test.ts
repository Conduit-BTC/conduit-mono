import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("no-signer onboarding", () => {
  it("keeps lightweight custody-safe setup guidance near signer connect surfaces", async () => {
    const sharedSigner = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )
    const merchantRoot = await readFile(
      "apps/merchant/src/routes/__root.tsx",
      "utf8"
    )

    expect(sharedSigner).toContain("Need a signer?")
    expect(sharedSigner).toContain("Start at")
    expect(sharedSigner).toContain("Set up the")
    expect(sharedSigner).toContain("Return to Conduit and connect.")
    expect(sharedSigner).not.toContain(
      "Conduit never creates, stores, or recovers them."
    )
    expect(sharedSigner).toContain("https://nstart.me")
    expect(sharedSigner).toContain("https://getalby.com/")
    expect(sharedSigner).toContain("https://grownostr.org/get-started")
    expect(sharedSigner).toContain("Learn more")
    expect(sharedSigner).toContain('target="_blank"')
    expect(sharedSigner).toContain('rel="noopener noreferrer"')
    expect(sharedSigner).toContain("<NoSignerSetupGuide />")
    expect(merchantRoot).toContain("<NoSignerSetupGuide")
  })
})
