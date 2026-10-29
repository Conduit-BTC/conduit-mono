import type { Page } from "@playwright/test"

export async function delayCartNotifications(
  page: Page,
  options: { resumeEvents?: boolean } = {}
): Promise<void> {
  await page.addInitScript(({ resumeEvents }) => {
    type DelayControl = {
      count(): number
      release(): void
    }
    const queued: Array<() => void> = []
    let delayResume = resumeEvents === true
    // Delaying storage alone does not hold a stale snapshot: the repository
    // also reconciles on resume. Opt in only for tests that need that barrier.
    const delayResumeEvent = (target: EventTarget, type: string) => {
      target.addEventListener(
        type,
        (event) => {
          if (!delayResume) return
          event.stopImmediatePropagation()
          queued.push(() => target.dispatchEvent(new Event(type)))
        },
        true
      )
    }
    if (resumeEvents) {
      delayResumeEvent(window, "focus")
      delayResumeEvent(window, "pageshow")
      delayResumeEvent(document, "visibilitychange")
    }
    const NativeBroadcastChannel = window.BroadcastChannel

    class DelayedBroadcastChannel extends NativeBroadcastChannel {
      private assignedHandler: ((event: MessageEvent) => void) | null = null

      override set onmessage(
        listener: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null
      ) {
        this.assignedHandler = listener
          ? (event) => listener.call(this, event)
          : null
        super.onmessage = this.assignedHandler
          ? (event) => {
              queued.push(() => this.assignedHandler?.(event))
            }
          : null
      }

      override get onmessage() {
        return this.assignedHandler
      }
    }

    window.BroadcastChannel = DelayedBroadcastChannel

    const addEventListener = window.addEventListener.bind(window)
    const removeEventListener = window.removeEventListener.bind(window)
    const storageListeners = new Map<
      EventListenerOrEventListenerObject,
      EventListener
    >()
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type !== "storage") {
        addEventListener(type, listener, options)
        return
      }
      const delayed: EventListener = (event) => {
        queued.push(() => {
          if (typeof listener === "function") listener.call(window, event)
          else listener.handleEvent(event)
        })
      }
      storageListeners.set(listener, delayed)
      addEventListener(type, delayed, options)
    }) as typeof window.addEventListener
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      removeEventListener(
        type,
        type === "storage"
          ? (storageListeners.get(listener) ?? listener)
          : listener,
        options
      )
      storageListeners.delete(listener)
    }) as typeof window.removeEventListener

    ;(
      window as typeof window & { __cartNotificationDelay: DelayControl }
    ).__cartNotificationDelay = {
      count: () => queued.length,
      release: () => {
        delayResume = false
        const pending = queued.splice(0)
        for (const deliver of pending.reverse()) deliver()
      },
    }
  }, options)
}
