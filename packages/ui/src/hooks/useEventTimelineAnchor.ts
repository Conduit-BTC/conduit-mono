import { useLayoutEffect, useRef } from "react"

interface TimelineViewportPosition {
  scrollTop: number
}

const timelineViewportPositions = new Map<string, TimelineViewportPosition>()

/** Page layouts may scroll a desktop main panel or the mobile document. */
export function resolveEventTimelineScrollRoot(
  viewport: HTMLElement,
  scrollMode: "contained" | "page" = "contained"
): HTMLElement {
  if (scrollMode === "contained") return viewport
  const document = viewport.ownerDocument
  let parent = viewport.parentElement
  while (parent && parent !== document.documentElement) {
    const overflow = document.defaultView?.getComputedStyle(parent).overflowY
    if (
      (overflow === "auto" || overflow === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    )
      return parent
    parent = parent.parentElement
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement
}

export function restoreEventTimelineAnchor(input: {
  scrollRoot: HTMLElement
  nowAnchor: HTMLElement
  savedScrollTop?: number
}): void {
  const { scrollRoot, nowAnchor } = input
  const rootTop =
    scrollRoot === scrollRoot.ownerDocument.scrollingElement
      ? 0
      : scrollRoot.getBoundingClientRect().top
  const anchorInset =
    Number.parseFloat(
      nowAnchor.ownerDocument.defaultView?.getComputedStyle(nowAnchor)
        .scrollMarginTop ?? "0"
    ) || 0
  scrollRoot.scrollTop =
    input.savedScrollTop ??
    Math.max(
      0,
      scrollRoot.scrollTop +
        nowAnchor.getBoundingClientRect().top -
        rootTop -
        anchorInset
    )
}

export function preserveEventTimelineAnchor(
  scrollRoot: HTMLElement,
  previousTop: number,
  nextTop: number
): void {
  const delta = nextTop - previousTop
  if (Math.abs(delta) >= 0.5) scrollRoot.scrollTop += delta
}

export function useEventTimelineAnchor(input: {
  isFetching: boolean
  itemCount: number
  pastCount: number
  viewportKey: string
  scrollMode?: "contained" | "page"
  /** Sections on one page share this ref and key so only one restores it. */
  restorationRef?: { current: string | null }
  restoreOnMount?: boolean
}) {
  const ownRestorationRef = useRef<string | null>(null)
  const restoredViewportKeyRef = input.restorationRef ?? ownRestorationRef
  const scrollMode = input.scrollMode ?? "contained"
  const timelineViewportRef = useRef<HTMLDivElement>(null)
  const nowAnchorRef = useRef<HTMLDivElement>(null)
  const pendingPrependAnchorTopRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (restoredViewportKeyRef.current === input.viewportKey) return
    if (input.restoreOnMount === false) return
    if (input.itemCount === 0 || typeof window === "undefined") return
    // A page's saved offset may be below either timeline. Wait until both
    // initial sections have their height, rather than clamp to a partial page.
    if (scrollMode === "page" && input.isFetching) return
    const frame = window.requestAnimationFrame(() => {
      if (restoredViewportKeyRef.current === input.viewportKey) return
      const viewport = timelineViewportRef.current
      const nowAnchor = nowAnchorRef.current
      if (!viewport || !nowAnchor) return
      const hasSavedPosition = timelineViewportPositions.has(input.viewportKey)
      const saved = timelineViewportPositions.get(input.viewportKey)
      restoreEventTimelineAnchor({
        scrollRoot: resolveEventTimelineScrollRoot(viewport, scrollMode),
        nowAnchor,
        savedScrollTop: saved?.scrollTop,
      })
      // Progressive discovery can prepend past events after the first useful
      // result. Keep Now anchored until that initial read settles, then leave
      // background refreshes alone so they never steal the scroll position.
      if (hasSavedPosition || !input.isFetching) {
        restoredViewportKeyRef.current = input.viewportKey
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    input.isFetching,
    input.itemCount,
    input.pastCount,
    input.viewportKey,
    input.restoreOnMount,
    restoredViewportKeyRef,
    scrollMode,
  ])

  useLayoutEffect(() => {
    const previousTop = pendingPrependAnchorTopRef.current
    if (previousTop === null) return
    pendingPrependAnchorTopRef.current = null
    const nextTop = nowAnchorRef.current?.getBoundingClientRect().top
    const viewport = timelineViewportRef.current
    if (nextTop === undefined || !viewport) return
    preserveEventTimelineAnchor(
      resolveEventTimelineScrollRoot(viewport, scrollMode),
      previousTop,
      nextTop
    )
  }, [input.pastCount, scrollMode])

  useLayoutEffect(() => {
    const viewport = timelineViewportRef.current
    if (scrollMode !== "page" || !viewport || input.restoreOnMount === false)
      return
    const document = viewport.ownerDocument
    const remember = () => {
      if (restoredViewportKeyRef.current !== input.viewportKey) return
      timelineViewportPositions.set(input.viewportKey, {
        scrollTop: resolveEventTimelineScrollRoot(viewport, scrollMode)
          .scrollTop,
      })
    }
    // Capture also observes the responsive main-panel scroller. Resolve it
    // again for each event so resizing does not leave a stale scroll owner.
    document.addEventListener("scroll", remember, {
      capture: true,
      passive: true,
    })
    return () => document.removeEventListener("scroll", remember, true)
  }, [
    input.itemCount,
    input.viewportKey,
    input.restoreOnMount,
    restoredViewportKeyRef,
    scrollMode,
  ])

  return {
    nowAnchorRef,
    timelineViewportRef,
    prepareForPrepend(): void {
      pendingPrependAnchorTopRef.current =
        nowAnchorRef.current?.getBoundingClientRect().top ?? null
    },
    rememberPosition(): void {
      const viewport = timelineViewportRef.current
      if (!viewport) return
      timelineViewportPositions.set(input.viewportKey, {
        scrollTop: resolveEventTimelineScrollRoot(viewport, scrollMode)
          .scrollTop,
      })
    },
  }
}
