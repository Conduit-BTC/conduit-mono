import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  bindCheckoutReferral,
  clearCheckoutReferral,
  getCheckoutReferralClaim,
  recordCheckoutReferralOrderSubmitted,
} from "../apps/market/src/lib/checkout-referral"
import {
  captureCheckoutIntentFragment,
  clearStagedCheckoutIntent,
  getStagedCheckoutIntent,
  recordCheckoutHandoffStage,
} from "../apps/market/src/lib/checkout-intent-stage"
import { encodeProductNaddr, type CheckoutIntent } from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import { readFileSync } from "node:fs"

const storage = new Map<string, string>()
const oldWindow = globalThis.window
const oldDocument = globalThis.document
const merchant = "a".repeat(64)
const coordinate = `30402:${merchant}:first`
const item = { productId: coordinate, quantity: 2 } as CartItem
const intent: CheckoutIntent = {
  v: 1,
  mode: "buy",
  source: { domain: "example.com", method: "claimed" },
  items: [{ product: encodeProductNaddr(coordinate), coordinate, quantity: 2 }],
}
let scrubbed = false
beforeEach(() => {
  scrubbed = false
  globalThis.window = {
    location: {
      pathname: "/checkout",
      hash: "",
      hostname: "localhost",
      origin: "http://localhost",
    },
    history: {
      state: null,
      replaceState: () => {
        scrubbed = true
        window.location.hash = ""
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  } as unknown as Window & typeof globalThis
  globalThis.document = {
    referrer: "https://shop.project.github.io/private?contact=hidden#fragment",
  } as Document
  clearCheckoutReferral()
  clearStagedCheckoutIntent()
})
afterEach(() => {
  clearCheckoutReferral()
  clearStagedCheckoutIntent()
  globalThis.window = oldWindow
  globalThis.document = oldDocument
})
const stagedEvidence = () => {
  const result = getStagedCheckoutIntent()?.result
  return result?.status === "valid"
    ? { status: result.status, source: result.intent.source }
    : { status: result?.status }
}
const bind = (createdAt = Date.now()) =>
  bindCheckoutReferral(intent, merchant, "purchase", "0:guest", createdAt)
const claim = (items = [item], scope = "0:guest", purchase = "purchase") =>
  getCheckoutReferralClaim(merchant, purchase, items, scope)

describe("checkout source staging and buyer-local purchase", () => {
  it("captures a normalized source before scrubbing, without retaining the referrer", () => {
    window.location.hash = `#buy=${intent.items[0]!.product}&source=user123.example.com`
    captureCheckoutIntentFragment()
    expect(scrubbed).toBe(true)
    expect(stagedEvidence()).toMatchObject({
      status: "valid",
      source: intent.source,
    })
    expect(
      [...storage.values()].some(
        (value) =>
          value.includes("private") ||
          value.includes("hidden") ||
          value.includes("user123")
      )
    ).toBe(false)
    const main = readFileSync("apps/market/src/main.tsx", "utf8")
    expect(
      main.indexOf("captureCheckoutIntentFragment()") <
        main.indexOf("const queryClient =")
    ).toBe(true)
  })

  it("captures referrer fallback and missing source and clears an earlier purchase on a new arrival", () => {
    bind()
    window.location.hash = `#buy=${intent.items[0]!.product}`
    captureCheckoutIntentFragment()
    expect(claim()).toBeUndefined()
    expect(stagedEvidence()).toMatchObject({
      status: "valid",
      source: { domain: "project.github.io", method: "referrer" },
    })
    Object.assign(document, { referrer: "" }) // Test-only stub.
    window.location.hash = `#buy=${intent.items[0]!.product}&source=https://bad.com/path`
    captureCheckoutIntentFragment()
    const stage = getStagedCheckoutIntent()
    expect(stage?.result.status).toBe("valid")
    if (stage?.result.status === "valid")
      expect(stage.result.intent.source).toBeUndefined()
  })

  it("retains an unregistered claim through matching retries and submission only for the exact purchase", () => {
    bind()
    expect(claim()).toEqual({
      sourceDomain: "example.com",
      sourceMethod: "claimed",
      linkMode: "buy",
    })
    expect(claim()).toEqual(claim())
    recordCheckoutReferralOrderSubmitted(
      merchant,
      "purchase",
      [item],
      "0:guest"
    )
    expect(claim()?.sourceDomain).toBe("example.com")
    expect(
      [...storage.values()].some(
        (value) => JSON.parse(value).orderSubmitted === true
      )
    ).toBe(true)
    clearCheckoutReferral() // The Keep my cart choice calls this shared boundary.
    expect(claim()).toBeUndefined()
  })

  it("clears on quantity, purchase, merchant, account or generation mismatch", () => {
    for (const mismatch of [
      () => claim([{ ...item, quantity: 3 }]),
      () => claim([item], "0:guest", "other-purchase"),
      () => claim([item], "1:guest"),
      () => claim([item], "0:account-a"),
      () =>
        getCheckoutReferralClaim(
          "other-merchant",
          "purchase",
          [item],
          "0:guest"
        ),
    ]) {
      bind()
      expect(mismatch()).toBeUndefined()
      expect(claim()).toBeUndefined()
      expect(storage.size).toBe(0)
    }
  })

  it("uses arrival time for expiry so rebinding/retry cannot extend attribution", () => {
    const expiredAt = Date.now() - 30 * 60_000 - 1
    bind(expiredAt)
    expect(claim()).toBeUndefined()
    bind(Date.now() + 60_000)
    expect(claim()).toBeUndefined()
    const original = Date.now() - 20 * 60_000
    bind(original)
    expect(claim()).toBeDefined()
    expect(JSON.parse([...storage.values()][0]!).createdAt).toBe(original)
    clearStagedCheckoutIntent()
    window.location.hash = `#buy=${intent.items[0]!.product}`
    captureCheckoutIntentFragment()
    const stage = getStagedCheckoutIntent()!
    const key = [...storage.keys()].find((key) => key.includes("intent"))!
    storage.set(key, JSON.stringify({ ...stage, createdAt: expiredAt }))
    expect(getStagedCheckoutIntent()).toBeNull()
    recordCheckoutHandoffStage(stage, "checkout_ready")
    expect(storage.has(key)).toBe(false)
  })

  it("preserves the staged purchase and source when writes hit quota but reads still work", () => {
    window.sessionStorage.setItem = () => {
      throw new Error("quota exceeded")
    }
    window.location.hash = `#buy=${intent.items[0]!.product}&source=example.com`
    captureCheckoutIntentFragment()
    expect(getStagedCheckoutIntent()?.result.status).toBe("valid")
    bind()
    expect(claim()?.sourceDomain).toBe("example.com")
    clearCheckoutReferral()
    expect(claim()).toBeUndefined()
  })

  it("does not revive stale persisted purchases after failed writes or removals", () => {
    window.location.hash = `#buy=${intent.items[0]!.product}&source=example.com`
    captureCheckoutIntentFragment()
    bind()
    window.sessionStorage.setItem = () => {
      throw new Error("quota exceeded")
    }
    window.sessionStorage.removeItem = () => {
      throw new Error("storage unavailable")
    }
    window.location.hash = `#buy=${intent.items[0]!.product}&source=other.com`
    captureCheckoutIntentFragment()
    const result = getStagedCheckoutIntent()?.result
    expect(
      result?.status === "valid" && result.intent.source?.domain === "other.com"
    ).toBe(true)
    bindCheckoutReferral(
      { ...intent, source: { domain: "other.com", method: "claimed" } },
      merchant,
      "purchase",
      "0:guest"
    )
    expect(claim()?.sourceDomain).toBe("other.com")
    clearCheckoutReferral()
    clearStagedCheckoutIntent()
    expect(claim()).toBeUndefined()
    expect(getStagedCheckoutIntent()).toBeNull()
  })

  it("keeps the same expiry in tab memory when storage is unavailable", () => {
    window.sessionStorage.getItem = () => {
      throw new Error("storage unavailable")
    }
    window.sessionStorage.setItem = () => {
      throw new Error("storage unavailable")
    }
    bind()
    expect(claim()?.sourceDomain).toBe("example.com")
    clearCheckoutReferral()
    expect(claim()).toBeUndefined()
  })
})
