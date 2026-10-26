import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("sign-in onboarding copy", () => {
  it("uses one identity setup link and plain-language benefits in both apps", async () => {
    const shared = await readFile(
      "packages/ui/src/components/SignerSwitch.tsx",
      "utf8"
    )
    expect(shared).toContain("Need a Secret Key?")
    expect(shared).toContain("Go to")
    expect(shared).toContain("https://nstart.me")
    expect(shared).not.toContain("https://getalby.com/")
    expect(shared).not.toContain("Keep your account backup safe.")
    expect(shared).not.toContain("Learn more")
    expect(shared).toContain('rel="noopener noreferrer"')
    for (const app of ["market", "merchant"]) {
      const source = await readFile(
        `apps/${app}/src/components/SignerSwitch.tsx`,
        "utf8"
      )
      expect(source).not.toContain("tied to your pubkey")
      expect(source).toContain("onPasteLocalKey={pasteLocalKey}")
    }
    const merchant = await readFile(
      "apps/merchant/src/routes/__root.tsx",
      "utf8"
    )
    expect(merchant).toContain('logoSrc="/images/logo/merchant-logo-full.svg"')
    expect(merchant).toContain("Open your merchant workspace.")
  })
})
