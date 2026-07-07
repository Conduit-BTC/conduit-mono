import { describe, expect, it } from "bun:test"
import {
  onRequestOptions as authorizeAnonZapOptions,
  onRequestPost as authorizeAnonZap,
} from "../apps/market/functions/api/anon-zap-authorize"
import {
  onRequestOptions as signAnonZapOptions,
  onRequestPost as signAnonZap,
} from "../apps/market/functions/api/anon-zap-sign"
import type { AnonZapPagesEnv } from "../apps/market/functions/_lib/anon-zap-checkout-auth"

describe("Anon zap Pages proxy", () => {
  function env(overrides: Partial<AnonZapPagesEnv> = {}): AnonZapPagesEnv {
    return {
      ANON_ZAP_ALLOWED_ORIGINS:
        "https://shop.conduit.market,https://*.conduit-market-coo.pages.dev",
      ...overrides,
    }
  }

  function post(
    url: string,
    body: unknown,
    origin = "https://shop.conduit.market"
  ) {
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(body),
    })
  }

  it("fails closed for checkout authorization until trusted checkout state exists", async () => {
    const response = await authorizeAnonZap({
      request: post("https://shop.conduit.market/api/anon-zap-authorize", {}),
      env: env(),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://shop.conduit.market"
    )
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer requires server-trusted checkout state.",
    })
  })

  it("fails closed for signing until trusted checkout state exists", async () => {
    const response = await signAnonZap({
      request: post("https://shop.conduit.market/api/anon-zap-sign", {}),
      env: env(),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://shop.conduit.market"
    )
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer requires server-trusted checkout state.",
    })
  })

  it("rejects authorization requests from disallowed origins", async () => {
    const response = await authorizeAnonZap({
      request: post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        {},
        "https://evil.example"
      ),
      env: env(),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: "Origin is not allowed.",
    })
  })

  it("handles allowed CORS preflights for authorize and sign", () => {
    const authorize = authorizeAnonZapOptions({
      request: new Request(
        "https://shop.conduit.market/api/anon-zap-authorize",
        {
          method: "OPTIONS",
          headers: { origin: "https://shop.conduit.market" },
        }
      ),
      env: env(),
    })
    const sign = signAnonZapOptions({
      request: new Request("https://shop.conduit.market/api/anon-zap-sign", {
        method: "OPTIONS",
        headers: { origin: "https://shop.conduit.market" },
      }),
      env: env(),
    })

    expect(authorize.status).toBe(204)
    expect(sign.status).toBe(204)
    expect(authorize.headers.get("access-control-allow-origin")).toBe(
      "https://shop.conduit.market"
    )
    expect(sign.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS"
    )
  })

  it("rejects disallowed CORS preflights without allow-origin", () => {
    const response = authorizeAnonZapOptions({
      request: new Request(
        "https://shop.conduit.market/api/anon-zap-authorize",
        {
          method: "OPTIONS",
          headers: { origin: "https://evil.example" },
        }
      ),
      env: env(),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("uses same-origin as the fallback allowed origin", async () => {
    const response = await authorizeAnonZap({
      request: new Request("https://market.example/api/anon-zap-authorize", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://market.example",
        },
        body: JSON.stringify({}),
      }),
      env: env({
        ANON_ZAP_ALLOWED_ORIGINS: undefined,
      }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://market.example"
    )
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer requires server-trusted checkout state.",
    })
  })
})
