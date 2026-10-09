import { describe, expect, it } from "bun:test"
import { selectInboxDeclarationReadiness } from "../packages/core/src/hooks/useInboxDeclaration"
import type { OwnPrivateMessageRelayReadiness } from "../packages/core/src/protocol/messaging"

const cachedReady = {
  state: "ready",
  relayUrls: ["wss://inbox.conduit.market"],
} as OwnPrivateMessageRelayReadiness

describe("inbox declaration readiness visibility", () => {
  it("hides cached ready state while account relay settings are not ready", () => {
    expect(
      selectInboxDeclarationReadiness({
        enabled: false,
        readiness: cachedReady,
        isLoading: false,
        error: null,
      })
    ).toEqual({ readiness: undefined, status: "loading" })
  })

  it("restores current readiness when the lookup is enabled", () => {
    expect(
      selectInboxDeclarationReadiness({
        enabled: true,
        readiness: cachedReady,
        isLoading: false,
        error: null,
      })
    ).toEqual({ readiness: cachedReady, status: "ready" })
  })
})
