import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AddressNameRequestForm } from "../packages/ui/src/components/AddressNameRequestForm"
import type { BreezAddressState } from "@conduit/core"

function renderForm() {
  return renderToStaticMarkup(
    <AddressNameRequestForm
      walletId="wallet-1"
      ownerPubkey="owner-pubkey"
      submit={async () => "received"}
      activate={async (): Promise<BreezAddressState> => ({
        status: "unavailable",
        reason: "provider_unavailable",
      })}
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
    expect(markup).toContain("Get your own @conduit.cash address")
    expect(markup).toContain("Names require approval.")
    expect(markup).not.toContain("Connected public identity")
    expect(markup).not.toContain("Note for the review team")
    expect(markup).not.toContain("Submit name request")
  })

  it("explains preview availability without claiming requests are generally disabled", () => {
    const markup = renderForm()

    expect(markup).toContain("Preview: requests open after release.")
    expect(markup).not.toContain("not enabled in this build")
  })
})
