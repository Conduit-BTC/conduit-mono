import { useEffect, useRef, type RefObject } from "react"
import { Button } from "./Button"

/** Reveal one page near the viewport; keep a keyboard/fallback action. */
export function ScrollLoadMore({
  onLoadMore,
  rootRef,
  label = "Load more",
}: {
  onLoadMore: () => void
  rootRef?: RefObject<HTMLElement | null>
  label?: string
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        // A page moving this sentinel offscreen rearms the observer. Do not
        // eagerly reveal the entire list while it remains in view.
        observer.unobserve(sentinel)
        onLoadMore()
      },
      { root: rootRef?.current ?? null, rootMargin: "120px 0px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, rootRef])

  return (
    <div ref={sentinelRef} className="flex justify-center p-2">
      <Button type="button" variant="ghost" size="sm" onClick={onLoadMore}>
        {label}
      </Button>
    </div>
  )
}
