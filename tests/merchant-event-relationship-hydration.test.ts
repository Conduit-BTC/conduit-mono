import { describe, expect, it } from "bun:test"
import {
  hydrateMerchantEventRelationships,
  prioritizeMerchantEventRelationshipReferences,
  type MerchantEventRelationshipDeadlineScheduler,
} from "../apps/merchant/src/lib/merchant-event-relationship-hydration"

const noDeadline: MerchantEventRelationshipDeadlineScheduler = () => () =>
  undefined

describe("Merchant event relationship hydration", () => {
  it("prioritizes the opened event and products before capping saved reads", async () => {
    const references = prioritizeMerchantEventRelationshipReferences({
      current: { coordinate: "current", reference: "naddr-current" },
      products: [
        { coordinate: "product-a", reference: "product-a" },
        { coordinate: "product-b", reference: "product-b" },
      ],
      saved: [
        {
          coordinate: "current",
          reference: "naddr-current-with-saved-relay-hints",
        },
        { coordinate: "saved-only", reference: "naddr-saved" },
        {
          coordinate: "product-a",
          reference: "naddr-product-a-with-relay-hints",
        },
      ],
    })
    const calls: string[] = []

    const result = await hydrateMerchantEventRelationships({
      references,
      targetLimit: 2,
      concurrency: 2,
      scheduleDeadline: noDeadline,
      resolve: async (reference) => {
        calls.push(reference)
        return reference
      },
    })

    expect(references).toEqual([
      "naddr-current-with-saved-relay-hints",
      "naddr-product-a-with-relay-hints",
      "product-b",
      "naddr-saved",
    ])
    expect(calls).toEqual(references.slice(0, 2))
    expect(result).toEqual({
      values: references.slice(0, 2),
      failedCount: 2,
    })
  })

  it("retains completed values in input order when reads finish out of order", async () => {
    let resolveFirst: ((value: string) => void) | undefined
    let resolveSecond: ((value: string) => void) | undefined
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve
    })

    const pending = hydrateMerchantEventRelationships({
      references: ["first", "second"],
      concurrency: 2,
      scheduleDeadline: noDeadline,
      resolve: (reference) => (reference === "first" ? first : second),
    })
    resolveSecond?.("second-value")
    resolveFirst?.("first-value")

    await expect(pending).resolves.toEqual({
      values: ["first-value", "second-value"],
      failedCount: 0,
    })
  })

  it("returns completed evidence at the deadline without awaiting held work", async () => {
    let fireDeadline: (() => void) | undefined
    let heldSignal: AbortSignal | undefined
    const calls: string[] = []
    const pending = hydrateMerchantEventRelationships({
      references: ["fast", "held", "never-started"],
      concurrency: 1,
      scheduleDeadline: (onDeadline) => {
        fireDeadline = onDeadline
        return () => undefined
      },
      resolve: async (reference, signal) => {
        calls.push(reference)
        if (reference === "fast") return "fast-value"
        heldSignal = signal
        return await new Promise<string>(() => undefined)
      },
    })

    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(calls).toEqual(["fast", "held"])
    fireDeadline?.()

    await expect(pending).resolves.toEqual({
      values: ["fast-value"],
      failedCount: 2,
    })
    expect(heldSignal?.aborted).toBe(true)
  })

  it("treats caller cancellation as an AbortError instead of partial data", async () => {
    const controller = new AbortController()
    const pending = hydrateMerchantEventRelationships({
      references: ["held"],
      signal: controller.signal,
      scheduleDeadline: noDeadline,
      resolve: async () => await new Promise<string>(() => undefined),
    })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})
