import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  prepareRelaySettingsContextPresentation,
  RELAY_SETTINGS_STORAGE_VERSION,
  resolveRelayAuthDisplayEvidence,
} from "@conduit/core"
import {
  RelaySettingsPanel,
  type RelayAuthEvidenceState,
} from "../packages/ui/src/components/RelaySettingsPanel"

const evidence: readonly RelayAuthEvidenceState[] = [
  "untested",
  "advertised",
  "challenge_observed",
  "succeeded",
  "rejected",
  "unavailable",
]

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

  it("masks the previous account's relay settings before the new scope initializes", () => {
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

  it("keeps NIP-11 metadata distinct from runtime NIP-42 outcomes", () => {
    const entries = evidence.map((state) => ({
      url: `wss://${state}.example`,
      readEnabled: true,
      writeEnabled: false,
      section: "public" as const,
      source: "manual" as const,
      capabilities: {
        nip11: true,
        search: false,
        dm: true,
        auth: state === "advertised",
        commerce: false,
      },
      warnings: {
        dmWithoutAuth: false,
        staleRelayInfo: false,
        unreachable: false,
        commercePartialSupport: false,
      },
    }))
    const authEvidenceByUrl = Object.fromEntries(
      evidence.map((state) => [`wss://${state}.example`, state])
    )

    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{ entries }}
        authEvidenceByUrl={authEvidenceByUrl}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    expect(markup).toContain("Relay info available")
    expect(markup).toContain("Auth untested")
    expect(markup).toContain("Auth advertised")
    expect(markup).toContain("Auth challenge observed")
    expect(markup).toContain("Auth succeeded")
    expect(markup).toContain("Auth rejected")
    expect(markup).toContain("Auth unavailable")
    expect(markup).not.toContain("Auth supported")
    expect(markup).not.toContain(">Verified<")
  })
})
