import { describe, expect, it, mock } from "bun:test"
import { EVENT_KINDS, OMF_ZAPOUT_MARKER_TAG } from "@conduit/core"
import {
  isAnonZapSignerConfigured,
  signCheckoutZapRequestWithAnonSigner,
  validateAnonZapSignerDraft,
} from "../apps/market/src/lib/anon-zap-signer"
import type { CheckoutZapRequestDraft } from "../apps/market/src/lib/checkout-payment"

function draft(
  overrides: Partial<CheckoutZapRequestDraft> = {}
): CheckoutZapRequestDraft {
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: 1_700_000_000,
    content: "Zapped out 1 item on Conduit",
    tags: [
      ["p", "b".repeat(64)],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["client", "conduit-market"],
    ],
    ...overrides,
  }
}

describe("Anon zap signer client", () => {
  it("does not enable browser anon signing until trusted checkout state exists", () => {
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: "/api/anon-zap-sign",
        anonZapSignerPubkey: "a".repeat(64),
      })
    ).toBe(false)
  })

  it("rejects arbitrary/private tags before signer authorization", () => {
    const result = validateAnonZapSignerDraft(
      draft({
        tags: [
          ["p", "b".repeat(64)],
          ["amount", "50000"],
          ["lnurl", "lnurl1test"],
          ["relays", "wss://relay.example"],
          ["order", "private-order-id"],
        ],
      })
    )

    expect(result).toEqual({
      ok: false,
      reason: "Zap request contains private tags.",
    })
  })

  it("allows the canonical OMF zapout marker before signer authorization", () => {
    const result = validateAnonZapSignerDraft(
      draft({
        tags: [...draft().tags, [...OMF_ZAPOUT_MARKER_TAG]],
      })
    )

    expect(result).toEqual({ ok: true })
  })

  it("rejects expanded OMF marker payloads before signer authorization", () => {
    const result = validateAnonZapSignerDraft(
      draft({
        tags: [...draft().tags, ["omf", "zapout", "order-123"]],
      })
    )

    expect(result).toEqual({
      ok: false,
      reason: "Zap request tag payload is invalid.",
    })
  })

  it("fails closed without calling the public signer proxy", async () => {
    const fetchImpl = mock(
      async () => new Response("{}")
    ) as unknown as typeof fetch

    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), { fetchImpl })
    ).rejects.toThrow("Anon zap signer requires server-trusted checkout state.")
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })
})
