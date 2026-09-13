import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  SearchSuggestions,
  getSearchSuggestionInputProps,
  getSearchSuggestionOptionId,
} from "../packages/ui/src/components/SearchSuggestions"

describe("SearchSuggestions", () => {
  it("exposes combobox attributes that point at the active option", () => {
    expect(
      getSearchSuggestionInputProps({
        listboxId: "lb",
        open: false,
        activeIndex: 1,
      })
    ).toMatchObject({
      role: "combobox",
      "aria-expanded": false,
      "aria-controls": undefined,
      "aria-activedescendant": undefined,
    })
    expect(
      getSearchSuggestionInputProps({
        listboxId: "lb",
        open: true,
        activeIndex: 1,
      })
    ).toMatchObject({
      "aria-expanded": true,
      "aria-controls": "lb",
      "aria-activedescendant": getSearchSuggestionOptionId("lb", 1),
    })
  })

  it("renders a labelled listbox with selected state, badges, and footer", () => {
    const html = renderToStaticMarkup(
      <SearchSuggestions
        id="lb"
        heading="Accounts"
        ariaLabel="Matching accounts"
        items={[
          {
            id: "a",
            label: "Alice",
            description: "alice@conduit.market",
            badge: "Seller",
          },
          { id: "b", label: "Bob" },
        ]}
        activeIndex={1}
        onActiveIndexChange={() => {}}
        onSelect={() => {}}
        footer="Some search relays did not answer."
      />
    )
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-label="Matching accounts"')
    expect(html).toContain('id="lb-option-0"')
    expect(html).toContain(
      'id="lb-option-1" role="option" aria-selected="true"'
    )
    expect(html).toMatch(/aria-selected="true"[^>]*bg-\[var\(--muted\)\]/)
    expect(html).toContain(">Seller<")
    expect(html).toContain("alice@conduit.market")
    expect(html).toContain("Some search relays did not answer.")
  })
})
