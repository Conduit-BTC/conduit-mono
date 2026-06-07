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
    expect(parseNip05Identifier(" Alice@Example.COM ")).toEqual({
      name: "Alice",
      domain: "example.com",
      normalizedIdentifier: "Alice@example.com",
    })
  })

  it("marks the identifier valid only when the well-known response maps name to pubkey", async () => {
    const calls: string[] = []
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@example.com",
      },
      {
        fetcher: jsonFetcher({ names: { alice: ALICE_PUBKEY } }, { calls }),
        now: () => 1_000,
      }
    )

    expect(calls).toEqual([
      "https://example.com/.well-known/nostr.json?name=alice",
    ])
    expect(result.status).toBe("valid")
    expect(result.source).toBe("network")
  })

  it("marks the identifier invalid when the domain maps the name to another pubkey", async () => {
    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "alice@example.com",
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
        nip05: "alice@example.com",
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
        nip05: "alice@example.com",
      },
      {
        fetcher,
        now: () => 1_000,
      }
    )

    expect(result.status).toBe("unknown")
    expect(result.reason).toBe("network_error")
  })

  it("serves fresh cached verification rows without refetching", async () => {
    const id = getNip05VerificationCacheId(ALICE_PUBKEY, "alice@example.com")
    const cacheRows = new Map<string, CachedNip05Verification>([
      [
        id,
        {
          id,
          pubkey: ALICE_PUBKEY,
          nip05: "alice@example.com",
          normalizedIdentifier: "alice@example.com",
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
        nip05: "alice@example.com",
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

    const result = await getNip05Verification(
      {
        pubkey: ALICE_PUBKEY,
        nip05: "not-an-identifier",
      },
      {
        fetcher,
        now: () => 1_000,
      }
    )

    expect(result.status).toBe("invalid")
    expect(result.reason).toBe("malformed_identifier")
    expect(result.source).toBe("syntax")
    expect(fetchCount).toBe(0)
  })
})
