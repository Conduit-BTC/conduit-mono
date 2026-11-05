import { describe, expect, it } from "bun:test"

import { renderToStaticMarkup } from "react-dom/server"
import { HoldToReleaseButton } from "@conduit/ui"

describe("HoldToReleaseButton", () => {
  it("renders an accessible idle hold control", () => {
    const html = renderToStaticMarkup(
      <HoldToReleaseButton onHoldComplete={() => undefined}>
        Zap out
      </HoldToReleaseButton>
    )

    expect(html).toContain('data-hold-state="idle"')
    expect(html).toContain("Hold, then release to confirm")
    expect(html).toContain('role="status"')
  })
})
