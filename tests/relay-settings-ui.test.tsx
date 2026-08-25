import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RelaySettingsPanel } from "@conduit/ui"

describe("RelaySettingsPanel", () => {
  const relayUrl = "wss://manual.example"

  function relayEntry(
    overrides: Partial<
      Parameters<typeof RelaySettingsPanel>[0]["settings"]["entries"][number]
    > = {}
  ) {
    return {
      url: relayUrl,
      readEnabled: true,
      writeEnabled: true,
      section: "public" as const,
      source: "manual" as const,
      capabilities: {
        nip11: true,
        search: false,
        dm: false,
        auth: false,
        commerce: false,
      },
      warnings: {
        dmWithoutAuth: false,
        staleRelayInfo: false,
        unreachable: false,
        commercePartialSupport: false,
      },
      scannedAt: 1_750_000_000_000,
      ...overrides,
    }
  }

  it("keeps the remove action visible before hover", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{ entries: [relayEntry()] }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    const removeButton = markup.match(
      /<button[^>]*aria-label="Remove wss:\/\/manual\.example from Conduit"[^>]*>/
    )?.[0]

    expect(removeButton).toBeDefined()
    expect(removeButton).not.toContain("opacity-0")
    expect(removeButton).toContain("hover:border-[var(--error)]")
    expect(removeButton).toContain(
      "hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]"
    )
    expect(removeButton).toContain("hover:text-[var(--error)]")
  })

  it("explains relay use without calling non-commerce relays public", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{
          entries: [
            relayEntry({
              writeEnabled: false,
              source: "published",
            }),
          ],
        }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
        onPublishRelayList={() => undefined}
        privateInbox={{
          status: "ready",
          candidateRelays: [
            {
              url: relayUrl,
              configured: true,
              enabled: true,
              declared: true,
              retained: false,
              selectable: true,
              relayInfoProbe: "succeeded",
              protectedMessageCapabilityEvidence: "unknown",
              protectedMessageRuntimeEvidence: "unknown",
            },
          ],
          onPublish: () => undefined,
          onRetryLookup: () => undefined,
        }}
      />
    )

    expect(markup).toContain("Your relay setup")
    expect(markup).toContain("Other Relays")
    expect(markup).toContain("Relay info available")
    expect(markup).toContain("Published relay list")
    expect(markup).toContain("Private inbox")
    expect(markup).toContain("Relay details")
    expect(markup).toContain("Full profile not confirmed")
    expect(markup).toContain("1 selected")
    expect(markup).toContain("0 selected")
    expect(markup).toContain("which other Nostr apps may use")
    expect(markup).not.toContain("Public relay")
    expect(markup).not.toContain("Public Relays")
  })

  it("treats incomplete commerce evidence as neutral context", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{
          entries: [
            relayEntry({
              warnings: {
                dmWithoutAuth: false,
                staleRelayInfo: false,
                unreachable: false,
                commercePartialSupport: true,
              },
            }),
          ],
        }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    expect(markup).toContain("Partial support detected")
    expect(markup).toContain("This is not a reason to remove the relay")
  })

  it("names each relay disclosure for assistive technology", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{
          entries: [
            relayEntry({ url: "wss://first.example" }),
            relayEntry({ url: "wss://second.example" }),
          ],
        }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    expect(markup).toContain(
      'Relay details<span class="sr-only"> for wss://first.example</span>'
    )
    expect(markup).toContain(
      'Relay details<span class="sr-only"> for wss://second.example</span>'
    )
  })

  it("does not crash when a persisted relay check time is malformed", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{
          entries: [
            relayEntry({
              scannedAt: "not-a-timestamp" as unknown as number,
            }),
          ],
        }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    expect(markup).toContain("Not recorded")
  })

  it("keeps the inbox summary aligned with degraded and repairable evidence", () => {
    const redistribution = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{ entries: [relayEntry()] }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
        privateInbox={{
          status: "ready",
          stale: true,
          distributionRepairable: true,
          candidateRelays: [],
          onPublish: () => undefined,
          onRetryLookup: () => undefined,
        }}
      />
    )
    expect(redistribution).toContain("Redistribution needed")
    expect(redistribution).toContain("Redistribute your private inbox")

    const degradedSignedEmpty = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{ entries: [relayEntry()] }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
        privateInbox={{
          status: "signed_empty",
          stale: true,
          candidateRelays: [],
          onPublish: () => undefined,
          onRetryLookup: () => undefined,
        }}
      />
    )
    expect(degradedSignedEmpty).toContain("Needs a fresh check")
    expect(degradedSignedEmpty).toContain("latest shared lookup was degraded")
    expect(degradedSignedEmpty).not.toContain("No relays declared")

    const partialLookup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{ entries: [relayEntry()] }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
        privateInbox={{
          status: "lookup_partial",
          stale: true,
          candidateRelays: [],
          onPublish: () => undefined,
          onRetryLookup: () => undefined,
        }}
      />
    )
    expect(partialLookup).toContain("Status unknown")
  })
})
