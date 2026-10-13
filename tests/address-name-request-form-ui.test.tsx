import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AddressNameRequestForm } from "../packages/ui/src/components/AddressNameRequestForm"

function renderForm() {
  return renderToStaticMarkup(
    <AddressNameRequestForm
      walletId="wallet-1"
      ownerPubkey="owner-pubkey"
      submit={{
        load: async () => undefined,
        check: async () => undefined,
        submit: async () => {
          throw new Error("unused")
        },
        activate: async () => {
          throw new Error("unused")
        },
      }}
      onActivated={async () => {}}
      siteKey=""
    />
  )
}

describe("address name request form", () => {
  it("keeps the request control inline and concise", () => {
    const markup = renderForm()

    expect(markup).toContain('aria-label="Desired name"')
    expect(markup).toContain("@conduit.cash")
    expect(markup).toContain("Request name")
    expect(markup).not.toContain("<textarea")
    expect(markup).not.toContain("Connected public identity")
    expect(markup).not.toContain("Note for the review team")
    expect(markup).not.toContain("Submit name request")
  })

  it("explains preview availability without claiming requests are generally disabled", () => {
    const markup = renderForm()

    expect(markup).toContain("Restoring your saved request")
    expect(markup).not.toContain("not enabled in this build")
  })
})
