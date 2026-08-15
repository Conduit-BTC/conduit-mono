import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RelaySettingsPanel } from "@conduit/ui"

describe("RelaySettingsPanel", () => {
  it("keeps the remove action visible before hover", () => {
    const relayUrl = "wss://manual.example"
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        settings={{
          entries: [
            {
              url: relayUrl,
              readEnabled: true,
              writeEnabled: true,
              section: "public",
              source: "manual",
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
            },
          ],
        }}
        onAddRelay={() => undefined}
        onRefreshRelay={() => undefined}
        onRemoveRelay={() => undefined}
        onToggleRead={() => undefined}
        onToggleWrite={() => undefined}
      />
    )

    const removeButton = markup.match(
      /<button[^>]*aria-label="Remove wss:\/\/manual\.example"[^>]*>/
    )?.[0]

    expect(removeButton).toBeDefined()
    expect(removeButton).not.toContain("opacity-0")
    expect(removeButton).toContain("hover:border-[var(--error)]")
    expect(removeButton).toContain(
      "hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)]"
    )
    expect(removeButton).toContain("hover:text-[var(--error)]")
  })
})
