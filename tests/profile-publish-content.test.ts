import { describe, expect, it } from "bun:test"
import {
  assertProfilePublishRetained,
  buildNip01ProfileContent,
  buildNip01ProfilePublishContent,
  buildProfileUpdatePayload,
  getNextProfileEventCreatedAt,
  getProfileSingletonQueryKey,
  parseProfileEvent,
  ProfilePublishSupersededError,
  retainStrongestCachedProfileRow,
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

  it("keeps known profile frontiers ahead of legacy projection-only rows", () => {
    const retained = {
      pubkey: "a".repeat(64),
      name: "Retained",
      rawContent: JSON.stringify({ name: "Retained", bot: true }),
      eventId: "1".repeat(64),
      eventCreatedAt: 110,
      cachedAt: 110_000,
    }

    expect(
      retainStrongestCachedProfileRow(retained, {
        pubkey: retained.pubkey,
        name: "Legacy overwrite",
        cachedAt: 120_000,
      })
    ).toBe(retained)
  })

  it("does not resurrect cleared fields while reconciling the same event", () => {
    const eventId = "1".repeat(64)
    const rawContent = JSON.stringify({ name: "Alice" })
    const current = {
      pubkey: "a".repeat(64),
      name: "Alice",
      about: "Stale enriched biography",
      rawContent,
      eventId,
      eventCreatedAt: 110,
      cachedAt: 110_000,
    }

    expect(
      retainStrongestCachedProfileRow(current, {
        pubkey: current.pubkey,
        name: "Alice",
        rawContent,
        eventId,
        eventCreatedAt: 110,
        cachedAt: 120_000,
      })
    ).toEqual({
      pubkey: current.pubkey,
      name: "Alice",
      displayName: undefined,
      about: undefined,
      picture: undefined,
      banner: undefined,
      nip05: undefined,
      lud16: undefined,
      website: undefined,
      rawContent,
      eventId,
      eventCreatedAt: 110,
      sourceRelayUrls: undefined,
      cachedAt: 120_000,
    })
  })

  it("rejects a publish success when another profile frontier was retained", () => {
    const publishedEvent = {
      id: "7".repeat(64),
      created_at: 110,
    }

    expect(() =>
      assertProfilePublishRetained(
        {
          eventId: "1".repeat(64),
          eventCreatedAt: 110,
        },
        publishedEvent
      )
    ).toThrow(ProfilePublishSupersededError)
    expect(() =>
      assertProfilePublishRetained(
        {
          eventId: publishedEvent.id,
          eventCreatedAt: publishedEvent.created_at,
        },
        publishedEvent
      )
    ).not.toThrow()
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

  it("preserves every JSON metadata value on unrelated profile edits", () => {
    const latestContent = JSON.stringify({
      name: "Alice",
      about: { rich: "profile extension" },
      bot: true,
      birthday: { year: 1990, month: 8 },
      custom_count: 7,
      custom_zero: 0,
      custom_false: false,
      custom_null: null,
      custom_array: ["one", { nested: true }],
      displayName: "Legacy Alice",
    })

    expect(
      buildNip01ProfilePublishContent({
        profile: { displayName: "Edited" },
        latestContent,
      })
    ).toEqual({
      name: "Alice",
      about: { rich: "profile extension" },
      bot: true,
      birthday: { year: 1990, month: 8 },
      custom_count: 7,
      custom_zero: 0,
      custom_false: false,
      custom_null: null,
      custom_array: ["one", { nested: true }],
      display_name: "Edited",
    })
  })

  it("preserves numeric tokens that JavaScript cannot represent exactly", () => {
    const content = buildNip01ProfilePublishContent({
      profile: { displayName: "Edited" },
      latestContent:
        '{"name":"Alice","custom_large":9007199254740993,"custom_exponent":1e3}',
    })

    expect(JSON.stringify(content)).toBe(
      '{"name":"Alice","custom_large":9007199254740993,"custom_exponent":1e3,"display_name":"Edited"}'
    )
  })

  it("fails closed on lossy numbers when token-source parsing is unavailable", () => {
    const originalParse = JSON.parse
    JSON.parse = ((
      text: string,
      reviver?: (key: string, value: unknown) => unknown
    ) =>
      originalParse(
        text,
        reviver ? (key, value) => reviver(key, value) : undefined
      )) as typeof JSON.parse

    try {
      expect(() =>
        buildNip01ProfilePublishContent({
          profile: { displayName: "Edited" },
          latestContent:
            '{"name":"Alice","birthday":{"year":1990},"custom_large":9007199254740993}',
        })
      ).toThrow("cannot preserve profile numeric metadata")

      expect(
        buildNip01ProfilePublishContent({
          profile: { displayName: "Edited" },
          latestContent: '{"name":"Alice","birthday":{"year":1990,"month":8}}',
        })
      ).toEqual({
        name: "Alice",
        birthday: { year: 1990, month: 8 },
        display_name: "Edited",
      })
    } finally {
      JSON.parse = originalParse
    }
  })

  it("clears a touched non-string field without deleting other raw evidence", () => {
    expect(
      buildNip01ProfilePublishContent({
        profile: { about: undefined },
        latestContent: JSON.stringify({
          name: "Alice",
          about: { rich: "profile extension" },
          bot: false,
          birthday: null,
        }),
      })
    ).toEqual({
      name: "Alice",
      bot: false,
      birthday: null,
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
