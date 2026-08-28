import { describe, expect, it } from "bun:test"
import {
  clearProductDraftReturnIntent,
  consumeProductDraftResumeRequest,
  getProductDraftReturnStorageKey,
  loadProductDraftReturnIntent,
  requestProductDraftResume,
  saveProductDraftReturnIntent,
} from "../apps/merchant/src/lib/productDraftReturn"

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe("merchant product draft return intent", () => {
  it("stores only content-free continuation state in a merchant-scoped key", () => {
    const storage = new MemoryStorage()
    const merchantPubkey = "merchant-a"

    expect(
      saveProductDraftReturnIntent(merchantPubkey, undefined, storage)
    ).toBe(true)
    const storageKey = getProductDraftReturnStorageKey(merchantPubkey)
    expect(storageKey).not.toBe(null)
    const raw = storage.getItem(storageKey!)

    expect(JSON.parse(raw!)).toEqual({
      version: 1,
      route: "/products",
      draftTarget: "create",
      state: "awaiting_inbox_setup",
    })
    expect(raw).not.toContain(merchantPubkey)
    expect(raw).not.toContain("title")
    expect(raw).not.toContain("price")
    expect(raw).not.toContain("image")
  })

  it("requires an explicit return transition and consumes it once", () => {
    const storage = new MemoryStorage()
    expect(saveProductDraftReturnIntent("merchant-a", undefined, storage)).toBe(
      true
    )

    expect(consumeProductDraftResumeRequest("merchant-a", storage)).toBe(false)
    expect(
      loadProductDraftReturnIntent("merchant-a", storage).intent?.state
    ).toBe("awaiting_inbox_setup")

    expect(requestProductDraftResume("merchant-a", storage)).toBe(true)
    expect(consumeProductDraftResumeRequest("merchant-a", storage)).toBe(true)
    expect(consumeProductDraftResumeRequest("merchant-a", storage)).toBe(false)
    expect(loadProductDraftReturnIntent("merchant-a", storage).intent).toBe(
      null
    )
  })

  it("keeps another merchant's continuation state isolated", () => {
    const storage = new MemoryStorage()
    expect(saveProductDraftReturnIntent("merchant-a", undefined, storage)).toBe(
      true
    )
    expect(saveProductDraftReturnIntent("merchant-b", undefined, storage)).toBe(
      true
    )

    expect(loadProductDraftReturnIntent("merchant-c", storage).intent).toBe(
      null
    )
    expect(clearProductDraftReturnIntent("merchant-a", storage)).toBe(true)
    expect(loadProductDraftReturnIntent("merchant-a", storage).intent).toBe(
      null
    )
    expect(
      loadProductDraftReturnIntent("merchant-b", storage).intent?.state
    ).toBe("awaiting_inbox_setup")
  })

  it("removes malformed continuation state without exposing it", () => {
    const storage = new MemoryStorage()
    const storageKey = getProductDraftReturnStorageKey("merchant-a")!
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        route: "/orders",
        draftTarget: "edit",
        state: "resume_requested",
        form: { title: "must not load" },
      })
    )

    expect(loadProductDraftReturnIntent("merchant-a", storage)).toEqual({
      intent: null,
      storageAvailable: true,
    })
    expect(storage.getItem(storageKey)).toBe(null)
  })
})
