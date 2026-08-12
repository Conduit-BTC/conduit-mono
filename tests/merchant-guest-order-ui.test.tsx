import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GuestOrderNotice } from "../apps/merchant/src/components/GuestOrderNotice"

describe("merchant guest order notice", () => {
  it("puts direct phone and email actions beside the guest warning", () => {
    const markup = renderToStaticMarkup(
      <GuestOrderNotice
        contact={{ phone: "+1 (555) 010-2020", email: "buyer@example.com" }}
      />
    )

    expect(markup).toContain("Conduit can’t message this guest")
    expect(markup).toContain('href="tel:+15550102020"')
    expect(markup).toContain('href="mailto:buyer@example.com"')
    expect(markup).toContain("they do not notify the guest")
  })

  it("explains when an order has no recoverable contact", () => {
    const markup = renderToStaticMarkup(<GuestOrderNotice />)

    expect(markup).toContain("This order has no contact details")
    expect(markup).toContain("only your private order history")
  })
})
