import { expect, test } from "bun:test"
import { proveProxyAdmission } from "../scripts/smoke/address_proxy_probe"

test("unapproved registration accepted by the deployed gateway proves a bypass and still cleans up", async () => {
  let upstreamRequests = 0
  const proof = await proveProxyAdmission({
    checkGateway: async () => "bypass",
    request: async () => {
      upstreamRequests++
      return new Response(null, { status: 403 })
    },
    cleanup: async () => true,
  })
  expect(proof.verdict).toBe("bypass_possible")
  expect(proof.cleanupSucceeded).toBe(true)
  expect(upstreamRequests).toBe(0)
})

test("live oracle requires successful controls for every protected mutation", async () => {
  const proof = await proveProxyAdmission({
    request: async (_, admission) =>
      new Response(null, { status: admission === "valid" ? 200 : 403 }),
    cleanup: async () => true,
  })
  expect(proof).toEqual({
    verdict: "bypass_rejected",
    completed: ["register", "rename", "transfer", "unregister"],
    cleanupSucceeded: true,
  })
})
test("an upstream accepting a direct mutation is a bypass, even if later probes would deny", async () => {
  let attempts = 0
  const proof = await proveProxyAdmission({
    request: async () => {
      attempts++
      return new Response(null, { status: 200 })
    },
    cleanup: async () => true,
  })
  expect(proof.verdict).toBe("bypass_possible")
  expect(proof.failedOperation).toBe("register")
  expect(attempts).toBe(1)
  expect(proof.cleanupSucceeded).toBe(true)
})
test("403 from every request proves nothing when the valid control also fails", async () => {
  const proof = await proveProxyAdmission({
    request: async () => new Response(null, { status: 403 }),
    cleanup: async () => true,
  })
  expect(proof.verdict).toBe("inconclusive")
  expect(proof.completed).toHaveLength(0)
})
test("timeouts, redirects and provider errors never count as bypass rejection", async () => {
  for (const status of [301, 400, 401, 404, 429, 500]) {
    const proof = await proveProxyAdmission({
      request: async () => new Response(null, { status }),
      cleanup: async () => true,
    })
    expect(proof.verdict).toBe("inconclusive")
  }
  const proof = await proveProxyAdmission({
    request: async () => {
      throw new Error("network unavailable")
    },
    cleanup: async () => false,
  })
  expect(proof).toEqual({
    verdict: "inconclusive",
    completed: [],
    failedOperation: "register",
    cleanupSucceeded: false,
  })
})
