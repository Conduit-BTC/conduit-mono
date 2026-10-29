import type { Locator, Page, TestInfo } from "@playwright/test"
import { recordSmokeDiagnostic } from "./smoke-diagnostics"

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

// Observe the original Accept gesture only. The failure read counts the exact
// acceptance key, never loads a row, and is not evidence of stock/payment authority.
export async function observeStockAcceptanceStart(page: Page) {
  const bounded = async <T>(operation: () => Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 250)
        }),
      ])
    } catch {
      return undefined
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const pendingObservation = page.evaluateHandle(() => {
    const seen = {
      pointerDownOnTrigger: false,
      pointerUpOnTrigger: false,
      clickOnTrigger: false,
    }
    const name = (element: HTMLButtonElement) =>
      element.getAttribute("aria-label") ?? element.textContent?.trim()
    const isTrigger = (element: EventTarget) =>
      element instanceof HTMLButtonElement && name(element) === "Accept order"
    const onDown = (event: Event) => {
      if (event.composedPath().some(isTrigger)) seen.pointerDownOnTrigger = true
    }
    const onUp = (event: Event) => {
      if (event.composedPath().some(isTrigger)) seen.pointerUpOnTrigger = true
    }
    const onClick = (event: Event) => {
      if (event.composedPath().some(isTrigger)) seen.clickOnTrigger = true
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("pointerup", onUp, true)
    document.addEventListener("click", onClick, true)
    const cardinality = (count: number) =>
      count === 0 ? "absent" : count === 1 ? "single" : "multiple"
    const visible = (element: Element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible"
    let cancelRead: (() => void) | undefined
    const countAcceptance = (orderId: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        let database: IDBDatabase | undefined
        let transaction: IDBTransaction | undefined
        let finished = false
        const finish = (count?: number) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          cancelRead = undefined
          try {
            transaction?.abort()
          } catch {
            // A completed readonly transaction needs no cancellation.
          }
          database?.close()
          resolve(
            count === undefined
              ? { acceptanceReadAvailable: false }
              : {
                  acceptanceReadAvailable: true,
                  acceptanceCardinality: cardinality(count),
                }
          )
        }
        // Leave time for the result to cross the runner's 250ms bound.
        const timer = setTimeout(() => finish(), 200)
        cancelRead = () => finish()
        void (async () => {
          try {
            // No application import, schema migration, or creation on absence.
            const databases = await indexedDB.databases()
            if (finished) return
            if (!databases.some((entry) => entry.name === "conduit")) {
              finish()
              return
            }
            const request = indexedDB.open("conduit")
            request.onupgradeneeded = () => {
              request.transaction?.abort()
              finish()
            }
            request.onerror = request.onblocked = () => finish()
            request.onsuccess = () => {
              database = request.result
              if (finished) {
                database.close()
                return
              }
              database.onversionchange = () => finish()
              try {
                transaction = database.transaction(
                  "merchantInventoryAcceptedOrders",
                  "readonly"
                )
                const count = transaction
                  .objectStore("merchantInventoryAcceptedOrders")
                  .count(orderId)
                count.onsuccess = () => finish(count.result)
                count.onerror = transaction.onabort = () => finish()
              } catch {
                finish()
              }
            }
          } catch {
            finish()
          }
        })()
      })
    return {
      async read(orderId: string) {
        const buttons = [...document.querySelectorAll("button")]
        const accept = buttons.filter(isTrigger)
        const pending = buttons.filter((button) =>
          /^(Sending|Recording)…$/.test(name(button) ?? "")
        )
        const saved = buttons.filter(
          (button) => name(button) === "Retry acceptance publication"
        )
        const state = {
          observationAvailable: true,
          ...seen,
          acceptCardinality: cardinality(accept.length),
          acceptVisible: accept.some(visible),
          acceptEnabled: accept.some(
            (button) =>
              !button.disabled &&
              button.getAttribute("aria-disabled") !== "true"
          ),
          pendingCardinality: cardinality(pending.length),
          pendingVisible: pending.some(visible),
          savedCardinality: cardinality(saved.length),
          savedVisible: saved.some(visible),
          alertVisible: [...document.querySelectorAll('[role="alert"]')].some(
            visible
          ),
        }
        return { ...state, ...(await countAcceptance(orderId)) }
      },
      dispose() {
        document.removeEventListener("pointerdown", onDown, true)
        document.removeEventListener("pointerup", onUp, true)
        document.removeEventListener("click", onClick, true)
        cancelRead?.()
      },
    }
  })
  const observation = await bounded(() => pendingObservation)
  if (!observation)
    void pendingObservation
      .then(async (late) => {
        await bounded(() => late.evaluate((value) => value.dispose()))
        await bounded(() => late.dispose())
      })
      .catch(() => {})
  return {
    async recordFailure(
      info: TestInfo,
      orderId: string,
      phase: "click" | "start_wait"
    ) {
      try {
        const values = observation
          ? await bounded(() =>
              observation.evaluate((value, key) => value.read(key), orderId)
            )
          : undefined
        recordSmokeDiagnostic(info, "event-stock-acceptance-start", {
          phase,
          ...(values ?? { observationAvailable: false }),
        })
      } catch {
        // Never replace the original operation failure.
      }
    },
    async dispose() {
      if (!observation) return
      await bounded(() => observation.evaluate((value) => value.dispose()))
      await bounded(() => observation.dispose())
    },
  }
}
