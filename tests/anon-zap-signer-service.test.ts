import { describe, expect, it } from "bun:test"
import { EVENT_KINDS } from "@conduit/core"
import { getPublicKey } from "nostr-tools"
import {
  handleAnonZapSignerRequest,
  signAnonZapRequestDraft,
  type AnonZapSignerEnv,
} from "../apps/anon-zap-signer/src/signer"
import type { AnonZapRequestDraft } from "@conduit/core"

const PRIVATE_KEY_HEX = "0".repeat(63) + "1"
const EXPECTED_PUBKEY = getPublicKey(
  Uint8Array.from([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 1,
  ])
)
const NOW_SECONDS = 1_800_000_000

function env(overrides: Partial<AnonZapSignerEnv> = {}): AnonZapSignerEnv {
  return {
    ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX: PRIVATE_KEY_HEX,
    ANON_CONDUIT_SHOPPER_PUBKEY: EXPECTED_PUBKEY,
    ANON_SIGNER_ALLOWED_ORIGINS: "http://localhost:7000",
    ...overrides,
  }
}

function draft(
  overrides: Partial<AnonZapRequestDraft> = {}
): AnonZapRequestDraft {
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: NOW_SECONDS,
    content: "Anon shopper supported this merchant on Conduit",
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

function postRequest(body: unknown, origin = "http://localhost:7000"): Request {
  return new Request("http://localhost:7010", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  })
}

describe("Anon zap signer service", () => {
  it("signs a validated kind 9734 zap request with the configured anon key", async () => {
    const signed = await signAnonZapRequestDraft(draft(), env(), {
      nowSeconds: NOW_SECONDS,
    })

    expect(signed.kind).toBe(EVENT_KINDS.ZAP_REQUEST)
    expect(signed.pubkey).toBe(EXPECTED_PUBKEY)
    expect(signed.id).toHaveLength(64)
    expect(signed.sig).toHaveLength(128)
    expect(signed.tags).toEqual(draft().tags)
  })

  it("rejects private tags before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            ["order", "private-order-id"],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request contains private tags.")
  })

  it("rejects a signer secret that does not match the expected pubkey", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft(),
        env({ ANON_CONDUIT_SHOPPER_PUBKEY: "a".repeat(64) }),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Anon signer private key does not match expected pubkey.")
  })

  it("serves signed events over the local POST endpoint", async () => {
    const response = await handleAnonZapSignerRequest(
      postRequest({ zapRequest: draft() }),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
    expect(body).toMatchObject({
      id: expect.any(String),
      rawEvent: {
        pubkey: EXPECTED_PUBKEY,
        kind: EVENT_KINDS.ZAP_REQUEST,
        content: draft().content,
        tags: draft().tags,
      },
    })
  })

  it("rejects disallowed browser origins", async () => {
    const response = await handleAnonZapSignerRequest(
      postRequest({ zapRequest: draft() }, "https://evil.example"),
      env()
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("rejects POST requests without an origin", async () => {
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ zapRequest: draft() }),
      }),
      env()
    )

    expect(response.status).toBe(403)
  })

  it("handles allowed CORS preflight without signing", async () => {
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:7000" },
      }),
      env()
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
  })
})
