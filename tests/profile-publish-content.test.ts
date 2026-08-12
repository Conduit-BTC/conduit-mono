import { describe, expect, it } from "bun:test"
import {
  buildNip01ProfileContent,
  buildNip01ProfilePublishContent,
  parseProfileEvent,
  shouldEnforceNip01ProfileMinimumFields,
} from "@conduit/core"

describe("profile publish content", () => {
  it("drops unsafe or malformed media from untrusted kind-0 content", () => {
    const profile = parseProfileEvent({
      pubkey: "a".repeat(64),
      content: JSON.stringify({
        name: "Mallory",
        picture: "http://127.0.0.1/avatar.png",
        banner: "https://cdn.example.com/banner.png",
        about: { unexpected: true },
      }),
    })

    expect(profile).toEqual({
      pubkey: "a".repeat(64),
      name: "Mallory",
      displayName: undefined,
      about: undefined,
      picture: undefined,
      banner: "https://cdn.example.com/banner.png",
      nip05: undefined,
      lud16: undefined,
      website: undefined,
    })
  })

  it("handles non-object kind-0 JSON as an empty profile", () => {
    expect(
      parseProfileEvent({ pubkey: "a".repeat(64), content: "null" })
    ).toEqual({
      pubkey: "a".repeat(64),
      name: undefined,
      displayName: undefined,
      about: undefined,
      picture: undefined,
      banner: undefined,
      nip05: undefined,
      lud16: undefined,
      website: undefined,
    })
  })

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

  it("merges one-field edits onto loaded NIP-01 profile content", () => {
    const content = buildNip01ProfilePublishContent({
      profile: {
        displayName: "Updated Shop",
      },
      latestProfile: {
        pubkey: "a".repeat(64),
        displayName: "Conduit Shop",
        about: "A merchant profile",
        picture: "https://example.com/avatar.png",
      },
    })

    expect(content).toEqual({
      display_name: "Updated Shop",
      about: "A merchant profile",
      picture: "https://example.com/avatar.png",
    })
    expect(shouldEnforceNip01ProfileMinimumFields({ content })).toBe(false)
  })

  it("uses explicit undefined fields to clear loaded NIP-01 profile content", () => {
    expect(
      buildNip01ProfilePublishContent({
        profile: {
          about: undefined,
        },
        latestProfile: {
          pubkey: "a".repeat(64),
          displayName: "Conduit Shop",
          about: "A merchant profile",
          picture: "https://example.com/avatar.png",
        },
      })
    ).toEqual({
      display_name: "Conduit Shop",
      picture: "https://example.com/avatar.png",
    })
  })

  it("keeps empty profile replacements guarded even after a prior profile loaded", () => {
    const content = buildNip01ProfilePublishContent({
      profile: {},
      latestProfile: {
        pubkey: "a".repeat(64),
        name: "Conduit Shop",
        about: "A merchant profile",
      },
    })

    expect(content).toEqual({})
    expect(
      shouldEnforceNip01ProfileMinimumFields({
        content,
      })
    ).toBe(true)
  })

  it("keeps one-field publish content guarded when prior context is missing", () => {
    expect(
      shouldEnforceNip01ProfileMinimumFields({
        content: buildNip01ProfilePublishContent({
          profile: {
            name: "Conduit Shop",
          },
          latestProfile: {
            pubkey: "a".repeat(64),
          },
        }),
      })
    ).toBe(true)
  })

  it("counts only meaningful profile fields when enforcing the minimum", () => {
    expect(
      shouldEnforceNip01ProfileMinimumFields({
        content: {
          name: "  ",
          about: "",
        },
      })
    ).toBe(true)
  })
})
