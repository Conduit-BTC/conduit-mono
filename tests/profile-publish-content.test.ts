import { describe, expect, it } from "bun:test"
import {
  buildNip01ProfileContent,
  buildNip01ProfilePublishContent,
  buildProfileUpdatePayload,
  getNextProfileEventCreatedAt,
  getProfileSingletonQueryKey,
  parseProfileEvent,
  shouldEnforceNip01ProfileMinimumFields,
} from "@conduit/core"

describe("profile publish content", () => {
  it("separates public and authenticated-owner profile query perspectives", () => {
    const pubkey = "a".repeat(64)

    expect(getProfileSingletonQueryKey(pubkey, null)).not.toEqual(
      getProfileSingletonQueryKey(pubkey, pubkey)
    )
  })

  it("advances replacements beyond the durable profile frontier", () => {
    expect(getNextProfileEventCreatedAt(1_000, 1_000_999)).toBe(1_001)
    expect(getNextProfileEventCreatedAt(1_500, 1_000_999)).toBe(1_501)
    expect(getNextProfileEventCreatedAt(undefined, 1_000_999)).toBe(1_000)
  })

  it("drops unsafe or malformed media from untrusted kind-0 content", () => {
    const profile = parseProfileEvent({
      pubkey: "a".repeat(64),
      content: JSON.stringify({
        name: "Mallory",
        picture: "http://127.0.0.1/avatar.png",
        banner: "https://cdn.conduit.market/banner.png",
        about: { unexpected: true },
      }),
    })

    expect(profile).toEqual({
      pubkey: "a".repeat(64),
      name: "Mallory",
      displayName: undefined,
      about: undefined,
      picture: undefined,
      banner: "https://cdn.conduit.market/banner.png",
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

  it("preserves raw unsafe media on unrelated edits without exposing it for rendering", () => {
    const rawContent = JSON.stringify({
      display_name: "Conduit Shop",
      picture: "http://127.0.0.1/avatar.png",
      banner: "https://assets.localhost/banner.png",
      about: "A merchant profile",
    })

    expect(
      parseProfileEvent({ pubkey: "a".repeat(64), content: rawContent })
    ).toMatchObject({ picture: undefined, banner: undefined })
    expect(
      buildNip01ProfilePublishContent({
        profile: { displayName: "Updated Shop" },
        latestContent: rawContent,
      })
    ).toEqual({
      display_name: "Updated Shop",
      picture: "http://127.0.0.1/avatar.png",
      banner: "https://assets.localhost/banner.png",
      about: "A merchant profile",
    })
  })

  it("omits hidden media clears from full form-shaped unrelated edits", () => {
    const rawContent = JSON.stringify({
      display_name: "Conduit Shop",
      picture: "http://127.0.0.1/avatar.png",
      banner: "https://assets.localhost/banner.png",
    })
    const projected = parseProfileEvent({
      pubkey: "a".repeat(64),
      content: rawContent,
    })
    const update = buildProfileUpdatePayload(
      {
        name: undefined,
        displayName: "Updated Shop",
        about: undefined,
        picture: undefined,
        banner: undefined,
        nip05: undefined,
        lud16: undefined,
        website: undefined,
      },
      projected
    )

    expect(update).toEqual({ displayName: "Updated Shop" })
    expect(
      buildNip01ProfilePublishContent({
        profile: update,
        latestContent: rawContent,
      })
    ).toEqual({
      display_name: "Updated Shop",
      picture: "http://127.0.0.1/avatar.png",
      banner: "https://assets.localhost/banner.png",
    })
  })

  it("lets an explicit clear remove media retained in raw publish context", () => {
    expect(
      buildNip01ProfilePublishContent({
        profile: { picture: undefined },
        latestContent: JSON.stringify({
          name: "Conduit Shop",
          picture: "http://127.0.0.1/avatar.png",
        }),
      })
    ).toEqual({ name: "Conduit Shop" })
  })

  it("rejects newly supplied private media without rejecting retained raw media", () => {
    expect(() =>
      buildNip01ProfilePublishContent({
        profile: { picture: "http://127.0.0.1/replacement.png" },
        latestContent: JSON.stringify({
          name: "Conduit Shop",
          picture: "http://127.0.0.1/existing.png",
        }),
      })
    ).toThrow("public http or https destination")
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
