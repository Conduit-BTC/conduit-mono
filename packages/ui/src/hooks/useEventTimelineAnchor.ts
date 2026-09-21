import { useLayoutEffect, useRef } from "react"

interface TimelineViewportPosition {
  scrollTop: number
}

const timelineViewportPositions = new Map<string, TimelineViewportPosition>()

function preserveTimelineAnchor(
  viewport: HTMLDivElement | null,
  delta: number
): void {
  if (!viewport || Math.abs(delta) < 0.5) return
  viewport.scrollTop += delta
}

export function useEventTimelineAnchor(input: {
  isFetching: boolean
  itemCount: number
  pastCount: number
  viewportKey: string
}) {
  const restoredViewportKeyRef = useRef<string | null>(null)
  const timelineViewportRef = useRef<HTMLDivElement>(null)
  const nowAnchorRef = useRef<HTMLDivElement>(null)
  const pendingPrependAnchorTopRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (restoredViewportKeyRef.current === input.viewportKey) return
    if (input.itemCount === 0 || typeof window === "undefined") return
    const frame = window.requestAnimationFrame(() => {
      const viewport = timelineViewportRef.current
      const nowAnchor = nowAnchorRef.current
      if (!viewport || !nowAnchor) return
      const hasSavedPosition = timelineViewportPositions.has(input.viewportKey)
      const saved = timelineViewportPositions.get(input.viewportKey)
      viewport.scrollTop = saved
        ? saved.scrollTop
        : Math.max(
            0,
            viewport.scrollTop +
              nowAnchor.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top
          )
      // Progressive discovery can prepend past events after the first useful
      // result. Keep Now anchored until that initial read settles, then leave
      // background refreshes alone so they never steal the scroll position.
      if (hasSavedPosition || !input.isFetching) {
        restoredViewportKeyRef.current = input.viewportKey
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [input.isFetching, input.itemCount, input.pastCount, input.viewportKey])

  useLayoutEffect(() => {
    const previousTop = pendingPrependAnchorTopRef.current
    if (previousTop === null) return
    pendingPrependAnchorTopRef.current = null
    const nextTop = nowAnchorRef.current?.getBoundingClientRect().top
    if (nextTop === undefined) return
    preserveTimelineAnchor(timelineViewportRef.current, nextTop - previousTop)
  }, [input.pastCount])

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
        scrollTop: viewport.scrollTop,
      })
    },
  }
}
