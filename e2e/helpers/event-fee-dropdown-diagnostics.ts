import type { Page } from "@playwright/test"

/** Observe the original interaction. Text, values, IDs and geometry stay in-page. */
export function observeEventFeeDropdown(page: Page) {
  return page.evaluateHandle(() => {
    const currentTrigger = () => {
      const label = [...document.querySelectorAll("label")].find(
        (node) => node.textContent?.trim() === "Fee setting"
      )
      return label?.control ?? null
    }
    let original = currentTrigger()
    let content: HTMLElement | null = null
    let mounted = false
    let removed = false
    let detached = false
    let replaced = false
    let blurWhileOpen = false
    let resizeWhileOpen = false
    let lastObservedOpen = false
    let downOnTrigger = false
    let upOnTrigger = false
    let clickOnTrigger = false
    let downOnOption = false
    let upOnOption = false
    let pointerUpOutsideWithMovement = false
    let pointerType: "mouse" | "touch" | "pen" | "unavailable" = "unavailable"
    let gesture: { x: number; y: number; moved: boolean } | null = null
    const open = () =>
      currentTrigger()?.getAttribute("aria-expanded") === "true"
    const observe = () => {
      const trigger = currentTrigger()
      lastObservedOpen = open()
      original ??= trigger
      detached ||= !!original && !original.isConnected
      replaced ||= !!original && !!trigger && trigger !== original
      const id = trigger?.getAttribute("aria-controls")
      const next = id ? document.getElementById(id) : null
      if (content && (!content.isConnected || (next && next !== content)))
        removed = true
      if (next) {
        content = next
        mounted = true
      }
    }
    const inTrigger = (event: Event) =>
      event.target instanceof Node && !!original?.contains(event.target)
    const inOption = (event: Event) =>
      event.target instanceof Element &&
      !!event.target.closest('[role="option"]') &&
      !!content?.contains(event.target)
    const onDown = (event: PointerEvent) => {
      observe()
      if (inTrigger(event)) {
        downOnTrigger = true
        gesture = { x: event.pageX, y: event.pageY, moved: false }
        pointerType = ["mouse", "touch", "pen"].includes(event.pointerType)
          ? (event.pointerType as typeof pointerType)
          : "unavailable"
      }
      if (inOption(event)) downOnOption = true
    }
    const onMove = (event: PointerEvent) => {
      if (gesture)
        gesture.moved ||=
          Math.abs(event.pageX - gesture.x) > 10 ||
          Math.abs(event.pageY - gesture.y) > 10
    }
    const onUp = (event: PointerEvent) => {
      observe()
      upOnTrigger ||= inTrigger(event)
      upOnOption ||= inOption(event)
      if (
        gesture?.moved &&
        open() &&
        event.target instanceof Node &&
        !content?.contains(event.target)
      )
        pointerUpOutsideWithMovement = true
      gesture = null
    }
    const onClick = (event: Event) => {
      clickOnTrigger ||= inTrigger(event)
    }
    const onBlur = () => {
      // An earlier listener may synchronously dismiss the open dropdown.
      blurWhileOpen ||= open() || lastObservedOpen
    }
    const onResize = () => {
      resizeWhileOpen ||= open() || lastObservedOpen
    }
    const observer = new MutationObserver(observe)
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("pointermove", onMove, true)
    document.addEventListener("pointerup", onUp, true)
    document.addEventListener("click", onClick, true)
    window.addEventListener("blur", onBlur, true)
    window.addEventListener("resize", onResize, true)
    const visible = (element: HTMLElement) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible"
    const hitTarget = (element: HTMLElement | undefined | null) => {
      const rect = element?.getBoundingClientRect()
      const hit = rect
        ? document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          )
        : null
      return !!element && !!hit && element.contains(hit)
    }
    observe()
    return {
      read() {
        observe()
        const trigger = currentTrigger()
        const options = content?.isConnected
          ? [...content.querySelectorAll<HTMLElement>('[role="option"]')]
          : []
        return {
          observationAvailable: true,
          triggerPresent: !!trigger,
          triggerConnected: !!original?.isConnected,
          triggerDetached: detached,
          triggerReplaced: replaced,
          triggerVisible: !!trigger && visible(trigger),
          triggerEnabled:
            trigger instanceof HTMLButtonElement && !trigger.disabled,
          triggerExpanded: open(),
          triggerHitTarget: hitTarget(trigger),
          optionCount: options.length,
          visibleOptionCount: options.filter(visible).length,
          targetOptionHitTarget: hitTarget(options[0]),
          listboxMounted: mounted,
          listboxRemoved: removed,
          listboxPresent: !!content?.isConnected,
          listboxAnimating:
            content
              ?.getAnimations()
              .some((animation) => animation.playState === "running") ?? false,
          pointerDownOnTrigger: downOnTrigger,
          pointerUpOnTrigger: upOnTrigger,
          clickOnTrigger,
          pointerDownOnOption: downOnOption,
          pointerUpOnOption: upOnOption,
          pointerUpOutsideWithMovement,
          pointerType,
          blurWhileOpen,
          resizeWhileOpen,
          documentVisible: document.visibilityState === "visible",
          documentFocused: document.hasFocus(),
          fontsLoaded: document.fonts.status === "loaded",
        }
      },
      dispose() {
        observer.disconnect()
        document.removeEventListener("pointerdown", onDown, true)
        document.removeEventListener("pointermove", onMove, true)
        document.removeEventListener("pointerup", onUp, true)
        document.removeEventListener("click", onClick, true)
        window.removeEventListener("blur", onBlur, true)
        window.removeEventListener("resize", onResize, true)
      },
    }
  })
}
