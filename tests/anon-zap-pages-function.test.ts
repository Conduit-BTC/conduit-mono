import { describe, expect, it } from "bun:test"
import { onRequestPost } from "../apps/market/functions/api/anon-zap-sign"

describe("Anon zap Pages proxy", () => {
  it("fails closed until trusted checkout authorization is available", async () => {
    const response = await onRequestPost({
      request: new Request("https://market.example/api/anon-zap-sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer requires trusted checkout authorization.",
    })
  })
})
