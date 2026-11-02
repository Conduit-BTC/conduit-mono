import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { EventTimelineViewport } from "../packages/ui/src/components/EventTimeline"
import {
  preserveEventTimelineAnchor,
  resolveEventTimelineScrollRoot,
  restoreEventTimelineAnchor,
} from "../packages/ui/src/hooks/useEventTimelineAnchor"

function viewportMarkup(scrollMode?: "contained" | "page") {
  return renderToStaticMarkup(
    <EventTimelineViewport
      scrollMode={scrollMode}
      currentAndFutureEvents={<li>Upcoming event</li>}
      hiddenEarlierCount={14}
      hiddenLaterCount={2}
      nowAnchorRef={null}
      onLoadEarlier={() => {}}
      onLoadLater={() => {}}
      pageSize={12}
      pastEvents={<li>Earlier event</li>}
      viewportRef={null}
    />
  )
}

function scrollFixture() {
  const overflow = new Map<HTMLElement, string>()
  const scrollMargin = new Map<HTMLElement, string>()
  const document = {
    defaultView: {
      getComputedStyle: (element: HTMLElement) => ({
        overflowY: overflow.get(element) ?? "visible",
        scrollMarginTop: scrollMargin.get(element) ?? "0px",
      }),
    },
  } as unknown as Document
  function element(parent: HTMLElement | null, top = 0) {
    return {
      ownerDocument: document,
      parentElement: parent,
      scrollTop: 0,
      scrollHeight: 2_000,
      clientHeight: 600,
      getBoundingClientRect: () => ({ top }),
    } as unknown as HTMLElement
  }
  const root = element(null, -300)
  Object.assign(document, { documentElement: root, scrollingElement: root })
  const shell = element(root)
  const main = element(shell, 80)
  const viewport = element(main, 160)
  const anchor = element(viewport, 500)
  return { overflow, scrollMargin, root, shell, main, viewport, anchor }
}

describe("Event timeline page scrolling", () => {
  it("wires Market's viewport and navigation anchor to the same page scroller", () => {
    const source = readFileSync(
      new URL(
        "../apps/market/src/components/MarketEventsTimeline.tsx",
        import.meta.url
      ),
      "utf8"
    )
    const anchor = source.match(/useEventTimelineAnchor\(\{([\s\S]*?)\}\)/)?.[1]
    const viewport = source.match(/<EventTimelineViewport\b([\s\S]*?)\/>/)?.[1]
    expect(anchor).toMatch(/scrollMode:\s*"page"/)
    expect(anchor).toMatch(/isFetching:\s*discovery\.isFetching/)
    expect(anchor).toMatch(/viewportKey:\s*filterKey/)
    expect(viewport).toContain('scrollMode="page"')
    expect(viewport).toContain("busy={discovery.isFetching}")
    expect(viewport).toContain("onLoadEarlier={loadEarlier}")
    expect(viewport).toContain("onLoadLater={loadLater}")
    expect(source).toMatch(
      /onOpen=\{\(\) => \{\s*timelineAnchor\.rememberPosition\(\)\s*onOpen\(/
    )
    expect(source).toMatch(
      /function loadEarlier\(\): void \{\s*timelineAnchor\.prepareForPrepend\(\)/
    )
  })

  it("lets the page own scrolling without an extra focus stop or nested panel", () => {
    const html = viewportMarkup("page")
    expect(html).not.toContain("max-h-")
    expect(html).not.toContain("overflow-y-auto")
    expect(html).not.toContain("overscroll-contain")
    expect(html).not.toContain('tabindex="0"')
    expect(html.split(">")[0]).not.toContain("px-3")
    expect(html).toContain('aria-label="Chronological events"')
    expect(html).toContain('aria-label="Now"')
    expect(html).toContain("Load 12 earlier events")
    expect(html).toContain("Load 2 later events")
    expect(html).toContain("Earlier event")
    expect(html).toContain("Upcoming event")
  })

  it("keeps contained-mode compatibility for other consumers", () => {
    const html = viewportMarkup()
    expect(html).toContain("max-h-[70dvh]")
    expect(html).toContain("overflow-y-auto")
    expect(html).toContain("overscroll-contain")
    expect(html).toContain('tabindex="0"')
  })

  it("offers explicit show/hide history controls without rendering hidden past rows", () => {
    const renderHistory = (count: number) =>
      renderToStaticMarkup(
        <EventTimelineViewport
          scrollMode="page"
          currentAndFutureEvents={<li>Current event</li>}
          hiddenEarlierCount={count === 0 ? 14 : 2}
          hiddenLaterCount={0}
          nowAnchorRef={null}
          onLoadEarlier={() => undefined}
          onHideEarlier={() => undefined}
          onLoadLater={() => undefined}
          pageSize={12}
          pastEvents={count > 0 ? <li>Past event</li> : null}
          visiblePastCount={count}
          viewportRef={null}
        />
      )
    const hidden = renderHistory(0)
    expect(hidden).toContain("Show past events")
    expect(hidden).toContain('aria-expanded="false"')
    expect(hidden).not.toContain("Hide past events")
    expect(hidden).not.toContain("Past event</li>")
    expect(hidden).toContain("Current event</li>")
    const shown = renderHistory(12)
    expect(shown).toContain("Hide past events")
    expect(shown).toContain("Load 2 earlier events")
    expect(shown).toContain("Past event</li>")
  })

  it("wires both timelines to a zero-past initial page and the explicit history controls", () => {
    for (const app of ["market", "merchant"]) {
      const name =
        app === "market" ? "MarketEventsTimeline" : "MerchantEventsTimeline"
      const source = readFileSync(
        new URL(`../apps/${app}/src/components/${name}.tsx`, import.meta.url),
        "utf8"
      )
      expect(source).toMatch(/earlier:\s*0/)
      expect(source).not.toMatch(
        /earlier:\s*(?:MARKET|MERCHANT)_EVENT_TIMELINE_PAGE_SIZE/
      )
      expect(source).toContain("onHideEarlier={hideEarlier}")
      expect(source).toContain("visiblePastCount={presentation.past.length}")
      expect(source).toContain(
        "pastEvents={renderMixedEntries(presentation.past)}"
      )
    }
  })

  it("chooses the desktop main scroller, not the non-scrolling timeline", () => {
    const fixture = scrollFixture()
    fixture.overflow.set(fixture.main, "auto")
    expect(resolveEventTimelineScrollRoot(fixture.viewport, "page")).toBe(
      fixture.main
    )
    expect(resolveEventTimelineScrollRoot(fixture.viewport)).toBe(
      fixture.viewport
    )
  })

  it("uses the mobile document when an overflow-x shell has no vertical scroll range", () => {
    const fixture = scrollFixture()
    fixture.overflow.set(fixture.shell, "auto")
    Object.assign(fixture.shell, { scrollHeight: 2_000, clientHeight: 2_000 })
    expect(resolveEventTimelineScrollRoot(fixture.viewport, "page")).toBe(
      fixture.root
    )
  })

  it("anchors Now relative to the actual scroll viewport on desktop and mobile", () => {
    const fixture = scrollFixture()
    fixture.main.scrollTop = 120
    restoreEventTimelineAnchor({
      scrollRoot: fixture.main,
      nowAnchor: fixture.anchor,
    })
    expect(fixture.main.scrollTop).toBe(540)
    fixture.root.scrollTop = 300
    restoreEventTimelineAnchor({
      scrollRoot: fixture.root,
      nowAnchor: fixture.anchor,
    })
    expect(fixture.root.scrollTop).toBe(800)
  })

  it("restores the remembered position, including zero, instead of jumping back to Now", () => {
    const fixture = scrollFixture()
    for (const savedScrollTop of [1_240, 0]) {
      restoreEventTimelineAnchor({
        scrollRoot: fixture.main,
        nowAnchor: fixture.anchor,
        savedScrollTop,
      })
      expect(fixture.main.scrollTop).toBe(savedScrollTop)
    }
  })

  it("keeps the Now anchor below page chrome without offsetting saved positions", () => {
    const fixture = scrollFixture()
    fixture.scrollMargin.set(fixture.anchor, "112px")
    restoreEventTimelineAnchor({
      scrollRoot: fixture.root,
      nowAnchor: fixture.anchor,
    })
    expect(fixture.root.scrollTop).toBe(388)
    restoreEventTimelineAnchor({
      scrollRoot: fixture.root,
      nowAnchor: fixture.anchor,
      savedScrollTop: 900,
    })
    expect(fixture.root.scrollTop).toBe(900)
  })

  it("compensates earlier-page insertion in the owning scroller without double-adjusting native anchoring", () => {
    const fixture = scrollFixture()
    for (const root of [fixture.main, fixture.root, fixture.viewport]) {
      root.scrollTop = 700
      preserveEventTimelineAnchor(root, 100, 460)
      expect(root.scrollTop).toBe(1_060)
      preserveEventTimelineAnchor(root, 100, 100)
      expect(root.scrollTop).toBe(1_060)
    }
  })
})
