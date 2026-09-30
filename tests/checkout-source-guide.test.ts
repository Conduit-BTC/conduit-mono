import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

describe("public partner activation instructions", () => {
  it("documents domain links, email request fields, manual activation and entitlement limits", () => {
    const guide = readFileSync(
      "docs/knowledge/checkout-with-conduit.md",
      "utf8"
    )
    for (const text of [
      "source=example.com",
      "browser-referrer fallback",
      "Request partner activation",
      "partnerships@conduit.market",
      "Project or business name",
      "Domain and website",
      "Integration URL",
      "business contact",
      "before approval",
      "reviewed manually",
      "domain control is verified",
      "maintainer explicitly",
      "activation state",
      "outside the public repository",
      "does not itself establish a commission agreement",
      "Preview checkout behavior",
      "measured checkout arrivals and outcomes",
    ])
      expect(guide.includes(text)).toBe(true)
    for (let index = 1; index <= 8; index++)
      expect(guide.includes(`SOURCE-0${index}`)).toBe(true)
  })
})
