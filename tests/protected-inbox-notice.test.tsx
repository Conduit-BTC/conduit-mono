import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  getProtectedInboxNoticePresentation,
  ProtectedInboxNotice,
} from "@conduit/ui"

describe("protected inbox notice", () => {
  it("stays silent for a complete readable inbox", () => {
    expect(
      getProtectedInboxNoticePresentation({ state: "complete" })
    ).toBeNull()
    expect(
      renderToStaticMarkup(<ProtectedInboxNotice state="complete" />)
    ).toBe("")
  })

  it("aggregates read and decryption consequences into one notice", () => {
    expect(
      getProtectedInboxNoticePresentation({
        state: "cached",
        subject: "orders",
        decryptFailureCount: 2,
      })
    ).toEqual({
      message:
        "Showing saved orders. Some recent order updates may be missing. 2 order updates couldn't be opened.",
      unavailable: false,
    })
  })

  it("offers one recovery action when an empty inbox is unreliable", () => {
    const html = renderToStaticMarkup(
      <ProtectedInboxNotice
        state="unavailable"
        subject="messages"
        decryptFailureCount={1}
        onRetry={() => undefined}
      />
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain(
      "Messages couldn&#x27;t be loaded. Retry before relying on an empty inbox."
    )
    expect(html).toContain("1 message couldn&#x27;t be opened.")
    expect(html.match(/>Retry</g)).toHaveLength(1)
  })

  it("does not announce a usable partial inbox as an alert", () => {
    const html = renderToStaticMarkup(
      <ProtectedInboxNotice state="partial" subject="activity" />
    )

    expect(html).toContain("Some recent buyer activity may be missing.")
    expect(html).not.toContain('role="alert"')
  })
})
