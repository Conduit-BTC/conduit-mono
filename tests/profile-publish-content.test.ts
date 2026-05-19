import { describe, expect, it } from "bun:test"
import {
  buildNip01ProfileContent,
  shouldEnforceNip01ProfileMinimumFields,
} from "@conduit/core"

describe("profile publish content", () => {
  it("omits cleared profile fields from the NIP-01 content", () => {
    expect(
      buildNip01ProfileContent({
        name: "Conduit Shop",
        displayName: undefined,
        about: undefined,
        picture: "https://example.com/avatar.png",
        banner: undefined,
        nip05: undefined,
        lud16: undefined,
        website: undefined,
      })
    ).toEqual({
      name: "Conduit Shop",
      picture: "https://example.com/avatar.png",
    })
  })

  it("keeps empty profile replacements guarded even after a prior profile loaded", () => {
    expect(
      shouldEnforceNip01ProfileMinimumFields({
        content: {},
        latestContent: {
          name: "Conduit Shop",
          about: "A merchant profile",
        },
      })
    ).toBe(true)
  })

  it("allows one-field edits when a prior profile has enough context", () => {
    expect(
      shouldEnforceNip01ProfileMinimumFields({
        content: {
          name: "Conduit Shop",
        },
        latestContent: {
          name: "Conduit Shop",
          about: "A merchant profile",
        },
      })
    ).toBe(false)
  })
})
