import { describe, expect, test, spyOn } from "bun:test"
import { resolveCheckoutSparkLnurlInvoice } from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import { verifyCheckoutSparkReceiverInvoice } from "../packages/core/src/protocol/checkout-spark-receiver-verification"
import {
  handleAddressGateway,
  type AddressGatewayEnv,
} from "../apps/address-gateway/src/gateway"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const NOW = 1_800_000_000
const ORIGIN = "https://conduit.cash"
const BROWSER_ORIGIN = "https://ordinary-lightning-wallet.invalid"

describe("custom-domain gateway and routed private receiver", () => {
  test("binds one invoice through the gateway and resumes exact settlement without reissuing", async () => {
    const receiver = qualifiedReceiverFixture({
      lud16: "merchant@conduit.cash",
      amountSats: 995,
      nowSeconds: NOW,
    })
    const callback = `${ORIGIN}/lnurlp/merchant/invoice`
    const metadata = { ...receiver.metadata, callback }
    const verifyPath = `/lnurlp/verify/${receiver.paymentHash}`
    const env: AddressGatewayEnv = {
      ADDRESS_REQUESTS: {
        prepare() {
          throw new Error("Receiving must not access request records.")
        },
      },
      REQUEST_RATE_LIMITER: {
        limit() {
          throw new Error("Receiving must not consume management quota.")
        },
      },
      ALLOWED_ORIGINS: "https://shop.conduit.market",
      TURNSTILE_HOSTNAMES: "shop.conduit.market",
      TURNSTILE_SECRET_KEY: "synthetic-challenge-key",
      BREEZ_PROXY_SHARED_SECRET: "synthetic-proxy-key",
      BREEZ_DOMAIN_API_KEY: "synthetic-domain-key",
      PROVIDER_PROXY_QUALIFIED: "false",
    }
    let metadataReads = 0
    let invoicesIssued = 0
    let verifierReads = 0
    let settled = false
    let metadataUnavailable = false
    let verifierUnavailable = false
    let verifierOverride: Record<string, unknown> | undefined
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      expect(url.origin).toBe(ORIGIN)
      expect(headers.get("X-Breez-Reverse-Proxy-Shared-Secret")).toBe(
        env.BREEZ_PROXY_SHARED_SECRET
      )
      expect(headers.get("Authorization")).toBe(
        `Bearer ${env.BREEZ_DOMAIN_API_KEY}`
      )
      expect(init?.method).toBe("GET")
      if (url.pathname === "/.well-known/lnurlp/merchant") {
        metadataReads += 1
        return metadataUnavailable
          ? Response.json({ status: "ERROR" }, { status: 503 })
          : Response.json(metadata)
      }
      if (url.pathname === "/lnurlp/merchant/invoice") {
        invoicesIssued += 1
        expect(url.searchParams.get("amount")).toBe("995000")
        expect(url.searchParams.has("nostr")).toBe(false)
        expect(url.searchParams.has("lnurl")).toBe(false)
        return Response.json({
          pr: receiver.paymentRequest,
          verify: `${ORIGIN}${verifyPath}`,
        })
      }
      if (url.pathname === verifyPath) {
        verifierReads += 1
        return verifierUnavailable
          ? Response.json({ status: "ERROR" }, { status: 503 })
          : Response.json(verifierOverride ?? receiver.verifier(settled))
      }
      throw new Error("Unexpected provider path.")
    }
    const mockedFetch = spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const inbound = new Request(input, init)
        const headers = new Headers(inbound.headers)
        headers.set("Origin", BROWSER_ORIGIN)
        const response = await handleAddressGateway(
          new Request(inbound, { headers }),
          env,
          [],
          providerFetch,
          NOW
        )
        if (inbound.url.startsWith(ORIGIN)) {
          expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*")
          expect(response.headers.get("Cache-Control")).toBe("no-store")
        }
        return response
      }
    )
    try {
      const prepared = await resolveCheckoutSparkLnurlInvoice(
        {
          lud16: receiver.lud16,
          amountSats: 995,
          network: "mainnet",
          nowSeconds: NOW,
          shouldContinue: () => true,
          receiverMode: "private",
        },
        { receiverContracts: receiver.contracts }
      )
      expect(prepared.paymentRequest).toBe(receiver.paymentRequest)
      expect(prepared.paymentHash).toBe(receiver.paymentHash)
      expect(prepared.receiverBinding?.callbackUrl).toBe(callback)
      expect(invoicesIssued).toBe(1)
      expect(verifierReads).toBe(1)

      const input = {
        binding: JSON.parse(JSON.stringify(prepared.receiverBinding)),
        paymentRequest: prepared.paymentRequest,
        paymentHash: prepared.paymentHash,
        amountSats: 995,
        network: "mainnet" as const,
        assertCurrent: () => undefined,
      }
      const dependencies = { contracts: receiver.contracts }
      expect(
        await verifyCheckoutSparkReceiverInvoice(input, dependencies)
      ).toEqual({ status: "verified", settled: false })
      settled = true
      expect(
        await verifyCheckoutSparkReceiverInvoice(input, dependencies)
      ).toEqual({ status: "verified", settled: true })

      verifierOverride = { ...receiver.verifier(true), pr: "other invoice" }
      expect(
        (await verifyCheckoutSparkReceiverInvoice(input, dependencies)).status
      ).toBe("conflicting")
      verifierOverride = {
        ...receiver.verifier(true),
        preimage: "00".repeat(32),
      }
      expect(
        (await verifyCheckoutSparkReceiverInvoice(input, dependencies)).status
      ).toBe("conflicting")
      verifierOverride = undefined
      const readsBeforeInvalidBinding = verifierReads
      expect(
        (
          await verifyCheckoutSparkReceiverInvoice(
            {
              ...input,
              binding: {
                ...input.binding,
                callbackUrl: `${ORIGIN}/lnurlp/other/invoice`,
              },
            },
            dependencies
          )
        ).status
      ).toBe("conflicting")
      expect(
        (
          await verifyCheckoutSparkReceiverInvoice(
            { ...input, paymentHash: "00".repeat(32) },
            dependencies
          )
        ).status
      ).toBe("conflicting")
      expect(
        (
          await verifyCheckoutSparkReceiverInvoice(
            { ...input, amountSats: 996 },
            dependencies
          )
        ).status
      ).toBe("conflicting")
      expect(verifierReads).toBe(readsBeforeInvalidBinding)

      verifierUnavailable = true
      expect(
        (await verifyCheckoutSparkReceiverInvoice(input, dependencies)).status
      ).toBe("unavailable")
      verifierUnavailable = false
      metadataUnavailable = true
      expect(
        (await verifyCheckoutSparkReceiverInvoice(input, dependencies)).status
      ).toBe("unavailable")
      expect(metadataReads).toBeGreaterThan(1)
      expect(invoicesIssued).toBe(1)
    } finally {
      mockedFetch.mockRestore()
    }
  })
})
