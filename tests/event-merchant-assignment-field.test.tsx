import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { EventMerchantAssignmentField } from "../apps/merchant/src/components/EventMerchantAssignmentField"

describe("merchant public assignment field", () => {
  it("connects the required field to the reason shown before approval", () => {
    const html = renderToStaticMarkup(
      <EventMerchantAssignmentField
        id="assignment-fixture"
        value=""
        disabled={false}
        onChange={() => undefined}
      />
    )
    expect(html).toContain('for="assignment-fixture"')
    expect(html).toContain('aria-describedby="assignment-fixture-description"')
    expect(html).toContain('id="assignment-fixture-description"')
    expect(html).toContain("Required before approval")
    expect(html).toContain("which booth or pickup desk")
    expect(html).toContain('required=""')
    expect(html).not.toContain('disabled=""')
  })

  it("preserves a saved assignment and locks editing while its decision is in flight", () => {
    const html = renderToStaticMarkup(
      <EventMerchantAssignmentField
        id="assignment-fixture"
        value="Booth 4"
        disabled
        onChange={() => undefined}
      />
    )
    expect(html).toContain('value="Booth 4"')
    expect(html).toContain('disabled=""')
  })
})
