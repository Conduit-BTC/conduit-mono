import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { orderSchema } from "@conduit/core"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { MerchantOrderContactNotice } from "../apps/merchant/src/components/MerchantOrderContactNotice"

describe("Merchant guest handoff guidance", () => {
  const fixture = createEventMarketOrderFixture({
    price: 0,
    mode: "merchant_present",
    newAssignment: true,
  })

  it("explains valid contact-free pickup without a missing-contact warning or payment claim", () => {
    const order = orderSchema.parse({
      ...fixture.order,
      buyerIdentityKind: "guest_ephemeral",
      contactFreePickup: { label: "Guest", receiptCommitment: "a".repeat(64) },
    })
    const markup = renderToStaticMarkup(
      <MerchantOrderContactNotice
        buyerInboxKnown={false}
        isGuestOrder
        order={order}
      />
    )
    expect(markup).toContain("This guest chose name-only pickup")
    expect(markup).toContain("verify payment and pickup authority")
    expect(markup).not.toContain("missing required contact details")
    expect(markup).not.toContain("border-warning")
    expect(markup).not.toContain("Payment verified")
    expect(markup).not.toContain("a".repeat(64))
  })

  it("retains warnings for a partial guest order and hides notices for a confirmed inbox", () => {
    const missing = renderToStaticMarkup(
      <MerchantOrderContactNotice
        buyerInboxKnown={false}
        isGuestOrder
        order={null}
      />
    )
    expect(missing).toContain("missing required contact details")
    expect(missing).toContain("border-warning")
    expect(
      renderToStaticMarkup(
        <MerchantOrderContactNotice
          buyerInboxKnown
          isGuestOrder={false}
          order={fixture.order}
        />
      )
    ).toBe("")
  })
})
