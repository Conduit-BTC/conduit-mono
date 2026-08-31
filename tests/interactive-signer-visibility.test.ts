import { describe, expect, it } from "bun:test"

import { waitForVisibleDocument } from "../packages/core/src/protocol/interactive-signer"

class VisibilityDocumentFixture {
  visibilityState: DocumentVisibilityState
  readonly listeners = new Set<() => void>()
  addCalls = 0
  removeCalls = 0

  constructor(visibilityState: DocumentVisibilityState) {
    this.visibilityState = visibilityState
  }

  addEventListener(type: string, listener: () => void): void {
    if (type !== "visibilitychange") return
    this.addCalls += 1
    this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type !== "visibilitychange") return
    this.removeCalls += 1
    this.listeners.delete(listener)
  }

  show(): void {
    this.visibilityState = "visible"
    for (const listener of [...this.listeners]) listener()
  }
}

describe("interactive signer visibility", () => {
  it("resolves immediately outside a browser", async () => {
    await expect(waitForVisibleDocument(undefined)).resolves.toBeUndefined()
  })

  it("resolves immediately when the document is visible", async () => {
    const fixture = new VisibilityDocumentFixture("visible")

    await expect(
      waitForVisibleDocument(fixture as never)
    ).resolves.toBeUndefined()
    expect(fixture.addCalls).toBe(0)
    expect(fixture.removeCalls).toBe(0)
  })

  it("waits while hidden and removes its listener after visibility returns", async () => {
    const fixture = new VisibilityDocumentFixture("hidden")
    let resolved = false
    const waiting = waitForVisibleDocument(fixture as never).then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(fixture.listeners.size).toBe(1)

    fixture.show()
    await waiting

    expect(resolved).toBe(true)
    expect(fixture.listeners.size).toBe(0)
    expect(fixture.removeCalls).toBe(1)
  })

  it("rechecks after registering so a visibility transition cannot be missed", async () => {
    const fixture = new VisibilityDocumentFixture("hidden")
    const originalAdd = fixture.addEventListener.bind(fixture)
    fixture.addEventListener = (type, listener) => {
      originalAdd(type, listener)
      fixture.visibilityState = "visible"
    }

    await expect(
      waitForVisibleDocument(fixture as never)
    ).resolves.toBeUndefined()

    expect(fixture.addCalls).toBe(1)
    expect(fixture.removeCalls).toBe(1)
    expect(fixture.listeners.size).toBe(0)
  })
})
