import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  EventDetailsEditor,
  EventDetailsFields,
} from "../apps/merchant/src/components/EventDetailsFields"

describe("shared event detail presentation", () => {
  it("uses the same required title, description, banner, location order for create and edit", () => {
    for (const idPrefix of ["future", "future-edit", "series-edit"]) {
      const html = renderToStaticMarkup(
        <EventDetailsFields
          idPrefix={idPrefix}
          title="Fair"
          summary="Public description"
          location="Town Hall"
          banner={<div data-banner="preview">Banner controls</div>}
          onTitleChange={() => undefined}
          onSummaryChange={() => undefined}
          onLocationChange={() => undefined}
        />
      )
      const positions = [
        `id="${idPrefix}-title"`,
        `id="${idPrefix}-summary"`,
        'data-banner="preview"',
        `id="${idPrefix}-location"`,
      ].map((marker) => html.indexOf(marker))
      expect(positions.every((position) => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
      expect(html).toContain("Event title")
      expect(html).toContain("Description · Required")
      expect(html).toContain("This description is public")
      expect(html.match(/required=""/g)).toHaveLength(3)
    }
  })

  it("keeps hidden editor children mounted, names its toggle and locks it during work", () => {
    for (const open of [false, true]) {
      const html = renderToStaticMarkup(
        <EventDetailsEditor
          id="event-editor"
          label="Edit event details"
          open={open}
          disabled
          onOpenChange={() => undefined}
        >
          <input aria-label="Draft" defaultValue="Unsaved draft" />
        </EventDetailsEditor>
      )
      expect(html).toContain(`aria-expanded="${open}"`)
      expect(html).toContain('aria-controls="event-editor"')
      expect(html).toContain('value="Unsaved draft"')
      expect(html).toContain(open ? "Close editor" : "Edit event details")
      expect(html.includes('hidden=""')).toBe(!open)
      expect(html).toContain('disabled=""')
      expect(html).not.toContain("Discard")
    }
  })
})
