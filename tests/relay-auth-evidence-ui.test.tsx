import { describe, expect, it } from "bun:test"
import {
  prepareRelaySettingsContextPresentation,
  RELAY_SETTINGS_STORAGE_VERSION,
  resolveRelayAuthDisplayEvidence,
} from "@conduit/core"

describe("relay authentication evidence", () => {
  it("keeps advertised metadata until stronger runtime evidence exists", () => {
    expect(resolveRelayAuthDisplayEvidence(undefined, true)).toBe("advertised")
    expect(resolveRelayAuthDisplayEvidence("untested", true)).toBe("advertised")
    expect(resolveRelayAuthDisplayEvidence(undefined, false)).toBe("untested")

    for (const state of [
      "challenge_observed",
      "succeeded",
      "rejected",
      "unavailable",
    ] as const) {
      expect(resolveRelayAuthDisplayEvidence(state, true)).toBe(state)
    }
  })

  it("masks the previous account's relay evidence before the new scope initializes", () => {
    const previousSettings = {
      version: RELAY_SETTINGS_STORAGE_VERSION,
      entries: [
        {
          url: "wss://account-a-private.example",
          readEnabled: true,
          writeEnabled: false,
          section: "public" as const,
          capabilities: {
            nip11: true,
            search: false,
            dm: true,
            auth: true,
            commerce: false,
          },
          warnings: {
            dmWithoutAuth: false,
            staleRelayInfo: false,
            unreachable: false,
            commercePartialSupport: false,
          },
        },
      ],
      updatedAt: 1,
    }
    const presentation = prepareRelaySettingsContextPresentation(
      previousSettings,
      { "wss://account-a-private.example": "succeeded" },
      false
    )

    expect(presentation.settings.entries).toEqual([])
    expect(presentation.authEvidenceByUrl).toEqual({})
    expect(JSON.stringify(presentation)).not.toContain("account-a-private")
  })
})
