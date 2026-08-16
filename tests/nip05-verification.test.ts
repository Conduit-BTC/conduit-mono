import { describe, expect, it } from "bun:test"
import {
  getNip05Verification,
  getNip05VerificationCacheId,
  parseNip05Identifier,
  type CachedNip05Verification,
} from "@conduit/core"

const ALICE_PUBKEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const BOB_PUBKEY =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function jsonFetcher(
  body: unknown,
  options: { status?: number; calls?: string[] } = {}
): typeof fetch {
  return async (url) => {
    options.calls?.push(String(url))
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
}

describe("NIP-05 verification", () => {
  it("parses a NIP-05 identifier and normalizes the domain", () => {
    expect(parseNip05Identifier(" Alice@Conduit.MARKET ")).toEqual({
      name: "Alice",
      domain: "conduit.market",
      normalizedIdentifier: "Alice@conduit.market",
    })
  })

  it("parses a bare domain as the NIP-05 root identifier", () => {
    expect(parseNip05Identifier("conduit.market")).toEqual({
      name: "_",
      domain: "conduit.market",
      normalizedIdentifier: "_@conduit.market",
    })
  })

  it("rejects local parts outside the NIP-05 character set", () => {
    expect(parseNip05Identifier("ali+ce@conduit.market")).toBeNull()
  })

  it("rejects URL delimiters and backslashes before building a request", () => {
    for (const identifier of [
      "alice@conduit.market/path",
      "alice@conduit.market\\path",
      "alice@conduit.market?name=bob",
      "alice@conduit.market#fragment",
      "alice@conduit.market:443",
      "alice@%63onduit.market",
      "alice@conduit%2emarket",
    ]) {
      expect(parseNip05Identifier(identifier)).toBeNull()
    }
  })

  it("marks the identifier valid only when the well-known response maps name to pubkey", async () => {
    const calls: string[] = []
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        fetcher: jsonFetcher({ names: { alice: ALICE_PUBKEY } }, { calls }),
        now: () => 1_000,
      }
    )

    expect(calls).toEqual([
      "https://conduit.market/.well-known/nostr.json?name=alice",
    ])
    expect(result.status).toBe("valid")
    expect(result.source).toBe("network")
  })

  it("validates bare-domain NIP-05 claims against the root name", async () => {
    const calls: string[] = []
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "conduit.market",
      },
      {
        fetcher: jsonFetcher({ names: { _: ALICE_PUBKEY } }, { calls }),
        now: () => 1_000,
      }
    )

    expect(calls).toEqual([
      "https://conduit.market/.well-known/nostr.json?name=_",
    ])
    expect(result.status).toBe("valid")
    expect(result.normalizedIdentifier).toBe("_@conduit.market")
  })

  it("marks the identifier invalid when the domain maps the name to another pubkey", async () => {
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        fetcher: jsonFetcher({ names: { alice: BOB_PUBKEY } }),
        now: () => 1_000,
      }
    )

    expect(result.status).toBe("invalid")
    expect(result.reason).toBe("pubkey_mismatch")
  })

  it("marks the identifier invalid when the well-known endpoint does not confirm it", async () => {
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        fetcher: jsonFetcher({}, { status: 404 }),
        now: () => 1_000,
      }
    )

    expect(result.status).toBe("invalid")
    expect(result.reason).toBe("http_404")
  })

  it("keeps network failures unknown instead of claiming validity or fraud", async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error("offline")
    }

    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        fetcher,
        now: () => 1_000,
      }
    )

    expect(result.status).toBe("unknown")
    expect(result.reason).toBe("network_error")
  })

  it("rejects redirects at fetch and does not probe a www fallback", async () => {
    const calls: Array<{
      url: string
      redirect?: RequestRedirect
    }> = []
    const fetcher: typeof fetch = async (url, init) => {
      const call: (typeof calls)[number] = { url: String(url) }
      if (init?.redirect) call.redirect = init.redirect
      calls.push(call)
      throw new TypeError("redirect mode is error")
    }

    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        fetcher,
        now: () => 1_000,
      }
    )

    expect(calls).toEqual([
      {
        url: "https://conduit.market/.well-known/nostr.json?name=alice",
        redirect: "error",
      },
    ])
    expect(result.status).toBe("unknown")
    expect(result.reason).toBe("network_error")
  })

  it("serves fresh cached verification rows without refetching", async () => {
    const id = getNip05VerificationCacheId(ALICE_PUBKEY, "alice@conduit.market")
    const cacheRows = new Map<string, CachedNip05Verification>([
      [
        id,
        {
          id,
          pubkey: ALICE_PUBKEY,
          nip05: "alice@conduit.market",
          normalizedIdentifier: "alice@conduit.market",
          status: "valid",
          checkedAt: 1_000,
          expiresAt: 10_000,
          cachedAt: 1_000,
        },
      ],
    ])
    let fetchCount = 0
    const fetcher: typeof fetch = async () => {
      fetchCount += 1
      return new Response("{}")
    }

    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@conduit.market",
      },
      {
        cache: {
          get: async (cacheId) => cacheRows.get(cacheId),
          put: async (row) => {
            cacheRows.set(row.id, row)
          },
        },
        fetcher,
        now: () => 2_000,
      }
    )

    expect(result.status).toBe("valid")
    expect(result.source).toBe("cache")
    expect(fetchCount).toBe(0)
  })

  it("rejects malformed identifiers before network lookup", async () => {
    let fetchCount = 0
    const fetcher: typeof fetch = async () => {
      fetchCount += 1
      return new Response("{}")
    }

    for (const nip05 of [
      "not-an-identifier",
      "alice@%63onduit.market",
      "alice@conduit%2emarket",
    ]) {
      const result = await getNip05Verification(
        { pubkey: ALICE_PUBKEY, nip05 },
        { fetcher, now: () => 1_000 }
      )

      expect(result.status).toBe("invalid")
      expect(result.reason).toBe("malformed_identifier")
      expect(result.source).toBe("syntax")
    }
    expect(fetchCount).toBe(0)
  })

  it("rejects non-public verification hosts before network lookup", async () => {
    for (const nip05 of [
      "alice@127.0.0.1",
      "alice@192.168.1.5",
      "alice@foo.localhost",
      "alice@example.com",
      "alice@resolver.arpa",
    ]) {
      let fetchCount = 0
      const result = await getNip05Verification(
        { pubkey: ALICE_PUBKEY, nip05 },
        {
          fetcher: async () => {
            fetchCount += 1
            return new Response("{}")
          },
          now: () => 1_000,
        }
      )

      expect(result.status).toBe("invalid")
      expect(result.reason).toBe("malformed_identifier")
      expect(fetchCount).toBe(0)
    }
  })
})
