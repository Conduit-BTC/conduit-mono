import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckoutSparkMerchantSettlementStatus } from "../apps/merchant/src/components/CheckoutSparkMerchantSettlementStatus"

describe("Merchant checkout provider verification presentation", () => {
  it("does not call a missing record unpaid or paid", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus projection={null} />
    )
    expect(html).toContain("Payment not yet verified")
    expect(html).not.toContain("Commerce payments verified")
    expect(html).not.toContain("unpaid")
  })

  it("keeps verified funding separate from merchant settlement", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus
        projection={{
          creditVerified: true,
          merchantVerified: false,
          commerceVerified: false,
          feePending: true,
        }}
      />
    )
    expect(html).toContain(
      "Funding verified; merchant payment not yet verified"
    )
    expect(html).not.toContain("Commerce remains paid")
  })

  it("does not turn provider-paid evidence into a verified recipient or a repayment prompt", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus
        projection={{
          creditVerified: true,
          merchantVerified: false,
          commerceVerified: false,
          feePending: true,
          recipientUnverified: true,
        }}
      />
    )
    expect(html).toContain("Payout observed; recipient not yet verified")
    expect(html).toContain("no saved evidence")
    expect(html).toContain("Do not pay it again")
    expect(html).not.toContain("Commerce payments verified")
    expect(html).not.toContain("merchant payment not yet verified")
  })

  it("distinguishes merchant payment from required supplier completion", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: false,
          feePending: true,
        }}
      />
    )
    expect(html).toContain("Merchant payment verified")
    expect(html).toContain("other commerce payouts need verification")
    expect(html).not.toContain("Commerce payments verified")
  })

  it("does not reopen paid commerce because its service fee is unresolved", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus
        projection={{
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: true,
          feePending: true,
        }}
      />
    )
    expect(html).toContain("Commerce payments verified")
    expect(html).toContain("Commerce remains paid")
    expect(html).not.toContain("invoice")
  })

  it("names missing receive proof separately from other unpaid recipients", () => {
    const html = renderToStaticMarkup(
      <CheckoutSparkMerchantSettlementStatus
        projection={{
          creditVerified: false,
          merchantVerified: true,
          commerceVerified: false,
          feePending: true,
        }}
      />
    )
    expect(html).toContain(
      "Merchant payment verified; funding verification incomplete"
    )
    expect(html).not.toContain("other commerce payouts")
  })
})
