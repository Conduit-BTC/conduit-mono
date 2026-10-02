import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ProductSupplierAllocationEditor,
  type ProductSupplierAllocationEditorValue,
} from "../apps/merchant/src/components/ProductSupplierAllocationEditor"
import {
  validateMerchantProductSupplierAllocationForm,
  type MerchantProductSupplierAllocationFormValidation,
} from "../apps/merchant/src/lib/productForm"

function editorValue(): ProductSupplierAllocationEditorValue {
  return {
    enabled: true,
    merchantWeight: "3",
    merchantRelayHint: "wss://relay.example",
    suppliers: [
      {
        identity: "supplier-fixture",
        relayHint: "wss://relay.example",
        weight: "1",
      },
    ],
  }
}

function validPreview(): MerchantProductSupplierAllocationFormValidation {
  return {
    canPublish: true,
    allocation: {
      state: "valid",
      issues: [],
      recipients: [
        {
          pubkey: "1".repeat(64),
          relayHint: "wss://relay.example",
          weight: 3,
          role: "merchant",
        },
        {
          pubkey: "2".repeat(64),
          relayHint: "wss://relay.example",
          weight: 1,
          role: "supplier",
        },
      ],
    },
    error: null,
  }
}

function renderEditor(value = editorValue(), validation = validPreview()) {
  return renderToStaticMarkup(
    <ProductSupplierAllocationEditor
      value={value}
      validation={validation}
      onChange={() => {
        throw new Error("Render-only editor must not change form state.")
      }}
    />
  )
}

describe("merchant supplier allocation editor", () => {
  it("discloses public terms even while allocation authoring is disabled", () => {
    const html = renderEditor(
      { ...editorValue(), enabled: false },
      { canPublish: true, error: null }
    )

    expect(html).toContain("Share revenue with suppliers")
    expect(html).toContain("Supplier identities and shares are published")
    expect(html).toContain("public terms on this product revision")
    expect(html).toContain("declare shares, not payment or settlement")
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain("Merchant weight")
    expect(html).not.toContain("Add supplier")
    expect(html).not.toContain("share preview")
  })

  it("keeps repair-required feedback visible when the restored toggle is off", () => {
    const value = { ...editorValue(), enabled: false }
    const validation = validateMerchantProductSupplierAllocationForm(
      {
        supplierAllocationEnabled: value.enabled,
        supplierAllocationRepairRequired: true,
        merchantAllocationWeight: value.merchantWeight,
        merchantAllocationRelayHint: value.merchantRelayHint,
        supplierAllocations: value.suppliers,
      },
      "1".repeat(64)
    )
    const html = renderEditor(value, validation)
    const errorId = html.match(/<p id="([^"]+)" role="alert"/)?.[1]

    expect(validation.canPublish).toBe(false)
    expect(errorId).toBeDefined()
    expect(html).toContain(`<fieldset aria-describedby="${errorId}"`)
    expect(html).toContain(
      "Repair the invalid signed revenue-split terms or remove them before publishing."
    )
    expect(html).not.toContain("Merchant weight")
    expect(html).not.toContain("share preview")
  })

  it("separates the toggle name from its public-terms disclosure", () => {
    const html = renderEditor()
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]
    const labelId = checkbox?.match(/aria-labelledby="([^"]+)"/)?.[1]
    const descriptionId = checkbox?.match(/aria-describedby="([^"]+)"/)?.[1]

    expect(labelId).toBeDefined()
    expect(descriptionId).toBeDefined()
    expect(labelId).not.toBe(descriptionId)
    expect(html).toContain(`id="${labelId}"`)
    expect(html).toContain(`id="${descriptionId}"`)
  })

  it("renders relative shares without claiming payment or changing prior orders", () => {
    const html = renderEditor()

    expect(html).toContain('value="25"')
    expect(html).toContain("Your share: 75%")
    expect(html).toContain("Shares apply to the item amount")
    expect(html).toContain("whole-satoshi rounding remainder belongs to you")
    expect(html).toContain("Changes apply to future orders")
    expect(html).toContain("existing orders keep their original terms")
    expect(html).not.toContain("Payment received")
    expect(html).not.toContain("Settlement complete")
  })

  it("associates every editable field with a label and identifies row actions", () => {
    const value = editorValue()
    value.suppliers.push({ identity: "", relayHint: "", weight: "1" })
    const html = renderEditor(value, { canPublish: false, error: null })
    const labeledIds = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map(
      (match) => match[1]
    )
    const inputIds = [...html.matchAll(/<input[^>]* id="([^"]+)"/g)].map(
      (match) => match[1]
    )

    expect(inputIds).toHaveLength(7)
    expect(new Set(inputIds).size).toBe(inputIds.length)
    expect(inputIds.every((id) => labeledIds.includes(id))).toBe(true)
    expect(html).toContain("Supplier 1 npub")
    expect(html).toContain("Supplier 2 npub")
    expect(html).toContain('aria-label="Remove supplier 1"')
    expect(html).toContain('aria-label="Remove supplier 2"')
    expect(html.match(/type="button"/g)).toHaveLength(3)
    expect(html.match(/inputMode="decimal"/g)).toHaveLength(2)
  })

  it("shows validation failures instead of an apparently usable share preview", () => {
    const html = renderEditor(editorValue(), {
      ...validPreview(),
      canPublish: false,
      error: "Repair the invalid signed revenue-split terms before publishing.",
    })
    const errorId = html.match(/<p id="([^"]+)" role="alert"/)?.[1]

    expect(errorId).toBeDefined()
    expect(html).toContain(`<fieldset aria-describedby="${errorId}"`)
    expect(html).toContain("Repair the invalid signed revenue-split terms")
    expect(html).not.toContain("Share preview:")
    expect(html).not.toContain("Merchant share preview:")
  })

  it("guides an empty allocation without presenting a share preview", () => {
    const html = renderEditor(
      { ...editorValue(), suppliers: [] },
      { canPublish: false, error: "Add at least one supplier." }
    )

    expect(html).toContain(
      "Add a supplier&#x27;s npub and percentage of the item amount"
    )
    expect(html).toContain("Add supplier")
    expect(html).toContain("Add at least one supplier")
    expect(html).not.toContain("Merchant share preview:")
    expect(html).not.toContain("Remove supplier")
  })

  it("keeps field and help ids unique when two editors share a render", () => {
    const html = renderToStaticMarkup(
      <>
        <ProductSupplierAllocationEditor
          value={editorValue()}
          validation={validPreview()}
          onChange={() => undefined}
        />
        <ProductSupplierAllocationEditor
          value={editorValue()}
          validation={validPreview()}
          onChange={() => undefined}
        />
      </>
    )
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
    const describedIds = [
      ...html.matchAll(/aria-describedby="([^"]+)"/g),
    ].flatMap((match) => match[1]!.split(" "))

    expect(new Set(ids).size).toBe(ids.length)
    expect(describedIds.every((id) => ids.includes(id))).toBe(true)
  })
})
