import { describe, expect, it, mock } from "bun:test"
import { assertCheckoutSparkLnurlPayoutMetadata } from "../packages/core/src/protocol/checkout-spark-lnurl-readiness"
import {
  fetchLnurlPayMetadata,
  type LnurlPayMetadata,
} from "../packages/core/src/protocol/lightning"

function metadata(
  minSendable = 1_000,
  maxSendable = 100_000
): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.conduit.market/.well-known/lnurlp/seller",
    lnurl: "lnurl1fixture",
    callback: "https://wallet.conduit.market/pay",
    minSendable,
    maxSendable,
    tag: "payRequest",
    allowsNostr: false,
    metadata: "[]",
  }
}

function request(maximumAllocationSats = 111) {
  return {
    lud16: "seller@wallet.conduit.market",
    maximumAllocationSats,
    shouldContinue: () => true,
  }
}

describe("checkout Spark pre-funding LNURL metadata", () => {
  it("reads plain metadata without creating an invoice or requiring public-zap support", async () => {
    const reads: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      reads.push(String(url))
      return new Response(JSON.stringify(metadata()), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    await assertCheckoutSparkLnurlPayoutMetadata(request(), {
      fetchMetadata: (lud16) => fetchLnurlPayMetadata(lud16, { fetchImpl }),
    })
    expect(reads).toEqual([
      "https://wallet.conduit.market/.well-known/lnurlp/seller",
    ])
  })

  it("accepts a possible integer amount without claiming the actual allocation or fees fit", async () => {
    for (const [minimum, maximum, ceiling] of [
      [1, 1_000, 2],
      [1_001, 2_000, 3],
      [2_000, 2_999, 3],
      [1_000, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ]) {
      await assertCheckoutSparkLnurlPayoutMetadata(request(ceiling), {
        fetchMetadata: async () => metadata(minimum, maximum),
      })
    }
  })

  it("rejects no whole-sat overlap or a minimum leaving no possible fee room", async () => {
    for (const [minimum, maximum, ceiling] of [
      [1, 999, 111],
      [1_001, 1_999, 111],
      [2_001, 2_999, 111],
      [2_000, 100_000, 2],
    ]) {
      await expect(
        assertCheckoutSparkLnurlPayoutMetadata(request(ceiling), {
          fetchMetadata: async () => metadata(minimum, maximum),
        })
      ).rejects.toThrow("no usable whole-sat payment range")
    }
  })

  it("checks funding capacity and authority before metadata work", async () => {
    const fetchMetadata = mock(async () => metadata())
    for (const ceiling of [0, 1, 1.5]) {
      await expect(
        assertCheckoutSparkLnurlPayoutMetadata(request(ceiling), {
          fetchMetadata,
        })
      ).rejects.toThrow("payment terms are unavailable")
    }
    await expect(
      assertCheckoutSparkLnurlPayoutMetadata(
        {
          ...request(),
          shouldContinue: () => false,
        },
        { fetchMetadata }
      )
    ).rejects.toThrow("authority changed")
    expect(fetchMetadata).toHaveBeenCalledTimes(0)
  })

  it("rechecks authority after an asynchronous metadata observation", async () => {
    let current = true
    await expect(
      assertCheckoutSparkLnurlPayoutMetadata(
        {
          ...request(),
          shouldContinue: () => current,
        },
        {
          fetchMetadata: async () => {
            current = false
            return metadata()
          },
        }
      )
    ).rejects.toThrow("authority changed")
  })

  it("does not retain an unavailable observation and permits a fresh retry", async () => {
    const input = request()
    const providerError = new Error(
      "provider unavailable: private request detail"
    )
    try {
      await assertCheckoutSparkLnurlPayoutMetadata(input, {
        fetchMetadata: async () => {
          throw providerError
        },
      })
      throw new Error("Expected the metadata observation to fail")
    } catch (error) {
      expect((error as Error).message).toBe(
        "Checkout Spark recipient payment endpoint is unavailable."
      )
      expect((error as Error).cause).toBeUndefined()
    }
    await assertCheckoutSparkLnurlPayoutMetadata(input, {
      fetchMetadata: async () => metadata(),
    })
  })
})
