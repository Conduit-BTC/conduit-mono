import type { Locator } from "@playwright/test"

export function classifyStockAcceptanceError(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  const category = /strict mode violation/i.test(message)
    ? "strict_locator"
    : /Target.*closed|page.*closed|browser.*closed/i.test(message)
      ? "target_closed"
      : error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "other"
  return {
    errorCategory: category,
    disabledDuringClick: /element is not enabled/i.test(message),
    obstructedDuringClick: /intercepts pointer events/i.test(message),
    detachedDuringClick: /element was detached|not attached to the DOM/i.test(
      message
    ),
  }
}

// Run only after the unchanged click fails. No DOM text, attributes, coordinates
// or raw Playwright errors leave this boundary.
export async function observeStockAcceptance(buttons: Locator) {
  try {
    return await buttons.evaluateAll((elements) => {
      const states = elements.map((element) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const visible =
          box.width > 0 && box.height > 0 && style.visibility !== "hidden"
        const left = Math.max(0, box.left)
        const right = Math.min(innerWidth, box.right)
        const top = Math.max(0, box.top)
        const bottom = Math.min(innerHeight, box.bottom)
        const inViewport = visible && right > left && bottom > top
        const hit = inViewport
          ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          : null
        return {
          enabled: !element.matches(":disabled, [aria-disabled='true']"),
          visible,
          inViewport,
          unobstructed: !!hit && (hit === element || element.contains(hit)),
        }
      })
      return {
        observationAvailable: true,
        matchingButtons: states.length,
        enabledButtons: states.filter((state) => state.enabled).length,
        visibleButtons: states.filter((state) => state.visible).length,
        inViewportButtons: states.filter((state) => state.inViewport).length,
        unobstructedButtons: states.filter((state) => state.unobstructed)
          .length,
      }
    })
  } catch {
    return { observationAvailable: false }
  }
}
