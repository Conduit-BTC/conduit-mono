import { expect, test } from "bun:test"
import type { Page, TestInfo } from "@playwright/test"

import { observePrepaidConfirmationTrigger } from "../e2e/helpers/smoke-diagnostics"

test("unavailable confirmation observation does not block failure reporting or cleanup", async () => {
  const page = {
    evaluateHandle: () => new Promise(() => {}),
  } as unknown as Page
  const annotations: TestInfo["annotations"] = []

  const observation = await observePrepaidConfirmationTrigger(page)
  await observation.recordFailure({ annotations } as TestInfo)
  await observation.dispose()

  expect(annotations).toEqual([
    {
      type: "smoke:event-prepaid-confirmation",
      description: JSON.stringify({ observationAvailable: false }),
    },
  ])
})

for (const mode of ["rejected", "unresponsive"] as const) {
  test(`${mode === "rejected" ? "failed" : mode} page-side confirmation cleanup still releases its remote handle`, async () => {
    const originalFailure = new Error("original caller failure")
    let handleReleased = false
    const page = {
      evaluateHandle: () =>
        Promise.resolve({
          evaluate: () =>
            mode === "unresponsive"
              ? new Promise(() => {})
              : Promise.reject(new Error("page cleanup unavailable")),
          dispose: async () => {
            handleReleased = true
          },
        }),
    } as unknown as Page
    const observation = await observePrepaidConfirmationTrigger(page)

    const surfacedFailure = await (async () => {
      try {
        throw originalFailure
      } finally {
        await observation.dispose()
      }
    })().catch((error: unknown) => error)

    expect(surfacedFailure).toBe(originalFailure)
    expect(handleReleased).toBe(true)
  })
}

test("a late confirmation observer is cleaned up after unavailable fallback", async () => {
  const annotations: TestInfo["annotations"] = []
  let pageCleanupAttempted = false
  let released!: () => void
  const releaseComplete = new Promise<void>((resolve) => {
    released = resolve
  })
  const lateHandle = {
    evaluate: async () => {
      pageCleanupAttempted = true
      throw new Error("late page cleanup unavailable")
    },
    dispose: async () => {
      released()
    },
  }
  let resolveObservation!: (handle: typeof lateHandle) => void
  const page = {
    evaluateHandle: () =>
      new Promise<typeof lateHandle>((resolve) => {
        resolveObservation = resolve
      }),
  } as unknown as Page
  const observation = await observePrepaidConfirmationTrigger(page)
  await observation.recordFailure({ annotations } as TestInfo)
  await observation.dispose()

  resolveObservation(lateHandle)
  await releaseComplete

  expect(pageCleanupAttempted).toBe(true)
  expect(annotations).toEqual([
    {
      type: "smoke:event-prepaid-confirmation",
      description: JSON.stringify({ observationAvailable: false }),
    },
  ])
})
