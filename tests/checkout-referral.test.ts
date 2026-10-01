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
import {
  checkoutAttributionTelemetryProperties,
  encodeProductNaddr,
  type CheckoutIntent,
} from "@conduit/core"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import { readFileSync } from "node:fs"

import { createCheckoutReferralSessionFence } from "../apps/market/src/lib/checkout-referral-session"

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
  storage.clear()
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

  it.each([false, true])(
    "preserves account fencing without randomUUID when storage is blocked: %s",
    (storageBlocked) => {
      const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: undefined,
      })
      try {
        if (storageBlocked)
          window.sessionStorage.setItem = () => {
            throw new Error("Storage blocked")
          }
        const fence = createCheckoutReferralSessionFence()
        fence.synchronize({
          accountPubkey: null,
          authGeneration: 0,
          pending: false,
        })
        const guestScope = fence.getScope(null, 0)!
        expect(guestScope).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
        bindCheckoutReferral(intent, merchant, "purchase", guestScope)
        if (!storageBlocked) expect(claim([item], guestScope)).toBeDefined()
        fence.synchronize({
          accountPubkey: merchant,
          authGeneration: 1,
          pending: false,
        })
        expect(fence.getScope(merchant, 1)).toBeDefined()
        expect(fence.getScope(merchant, 1)).not.toBe(guestScope)
        expect(fence.getScope(null, 0)).toBeUndefined()
        expect(claim([item], guestScope)).toBeUndefined()
      } finally {
        if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor)
        else Reflect.deleteProperty(crypto, "randomUUID")
      }
    }
  )

  it("invalidates sources on off-checkout account transitions before a generation-reset reload", () => {
    const fence = createCheckoutReferralSessionFence()
    fence.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    const original = fence.getScope(null, 0)!
    bindCheckoutReferral(intent, merchant, "purchase", original)
    fence.synchronize({ accountPubkey: null, authGeneration: 1, pending: true })
    expect(claim([item], original)).toBeUndefined()
    fence.synchronize({
      accountPubkey: merchant,
      authGeneration: 1,
      pending: false,
    })
    fence.synchronize({
      accountPubkey: null,
      authGeneration: 2,
      pending: false,
    })
    const reloaded = createCheckoutReferralSessionFence()
    reloaded.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    expect(reloaded.getScope(null, 0) !== original).toBe(true)
    expect(claim([item], reloaded.getScope(null, 0)!)).toBeUndefined()
    expect(fence.getScope(null, 0)).toBeUndefined()
    const main = readFileSync("apps/market/src/main.tsx", "utf8")
    expect(main.includes("checkoutReferralSessionFence.synchronize")).toBe(true)
  })

  it("keeps the guest fence across process-only startup cleanup and reload", () => {
    const fence = createCheckoutReferralSessionFence()
    fence.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    const original = fence.getScope(null, 0)!
    bindCheckoutReferral(intent, merchant, "purchase", original)
    fence.synchronize({
      accountPubkey: null,
      authGeneration: 1,
      pending: false,
    })
    expect(fence.getScope(null, 1) === original).toBe(true)
    expect(claim([item], fence.getScope(null, 1)!)?.sourceDomain).toBe(
      "example.com"
    )
    const reloaded = createCheckoutReferralSessionFence()
    reloaded.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    expect(reloaded.getScope(null, 0) === original).toBe(true)
  })

  it("preserves the same identity and arrival expiry across saved signer restoration", () => {
    const fence = createCheckoutReferralSessionFence()
    fence.synchronize({
      accountPubkey: merchant,
      authGeneration: 3,
      pending: false,
    })
    const original = fence.getScope(merchant, 3)!
    const arrival = Date.now() - 20 * 60_000
    bindCheckoutReferral(intent, merchant, "purchase", original, arrival)
    const reloaded = createCheckoutReferralSessionFence()
    reloaded.synchronize({
      accountPubkey: merchant,
      authGeneration: 0,
      pending: true,
    })
    expect(reloaded.getScope(merchant, 0)).toBeUndefined()
    reloaded.synchronize({
      accountPubkey: merchant,
      authGeneration: 1,
      pending: false,
    })
    expect(reloaded.getScope(merchant, 1) === original).toBe(true)
    expect(claim([item], reloaded.getScope(merchant, 1)!)?.sourceDomain).toBe(
      "example.com"
    )
    const stored = [...storage.entries()].find(
      ([key]) => key === "conduit:checkout-referral:v1"
    )!
    expect(JSON.parse(stored[1]).createdAt).toBe(arrival)
    expect(
      JSON.stringify(
        checkoutAttributionTelemetryProperties(claim([item], original))
      ).includes(original)
    ).toBe(false)
    reloaded.synchronize({
      accountPubkey: "different-account",
      authGeneration: 2,
      pending: false,
    })
    expect(claim([item], original)).toBeUndefined()
  })

  it("does not let an older async buyer frame adopt or clear a newer source", () => {
    const fence = createCheckoutReferralSessionFence()
    fence.synchronize({
      accountPubkey: merchant,
      authGeneration: 1,
      pending: false,
    })
    const oldScope = () => fence.getScope(merchant, 1)
    bindCheckoutReferral(intent, merchant, "purchase", oldScope()!)
    const nextBuyer = "b".repeat(64)
    fence.synchronize({
      accountPubkey: nextBuyer,
      authGeneration: 2,
      pending: false,
    })
    const nextScope = fence.getScope(nextBuyer, 2)!
    bindCheckoutReferral(
      { ...intent, source: { domain: "other.com", method: "claimed" } },
      merchant,
      "purchase",
      nextScope
    )
    expect(
      getCheckoutReferralClaim(merchant, "purchase", [item], oldScope())
    ).toBeUndefined()
    recordCheckoutReferralOrderSubmitted(
      merchant,
      "purchase",
      [item],
      oldScope()
    )
    expect(claim([item], nextScope)?.sourceDomain).toBe("other.com")
    const stored = storage.get("conduit:checkout-referral:v1")!
    expect(JSON.parse(stored).orderSubmitted).toBe(false)
  })

  it("does not reuse an old persisted fence when session storage cannot rotate it", () => {
    const fence = createCheckoutReferralSessionFence()
    fence.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    const original = fence.getScope(null, 0)!
    bindCheckoutReferral(intent, merchant, "purchase", original)
    window.sessionStorage.setItem = () => {
      throw new Error("quota exceeded")
    }
    const reloaded = createCheckoutReferralSessionFence()
    reloaded.synchronize({
      accountPubkey: null,
      authGeneration: 0,
      pending: false,
    })
    expect(reloaded.getScope(null, 0) !== original).toBe(true)
    expect(claim([item], original)).toBeUndefined()
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
