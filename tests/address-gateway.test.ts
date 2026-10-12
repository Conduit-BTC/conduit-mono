import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import { bytesToHex } from "../packages/core/node_modules/@noble/hashes/utils.js"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  handleAddressGateway,
  type AddressGatewayEnv,
  type ApprovedName,
} from "../apps/address-gateway/src/gateway"
import { breezAddressMessage } from "../packages/core/src/wallets/breez-lightning-address"
import {
  ADDRESS_REQUEST_PATH,
  addressNameRequestMessage,
  addressNameRequestPayload,
  addressRequestHash,
  verifyAddressRequestAuthority,
} from "../packages/core/src/wallets/address-name-request"

function fixture() {
  const db = new Database(":memory:")
  db.exec(
    readFileSync(
      new URL(
        "../apps/address-gateway/migrations/0001_address_requests.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  const secret = generateSecretKey(),
    walletSecret = generateSecretKey()
  const identity = bytesToHex(secp256k1.getPublicKey(walletSecret))
  const owner = getPublicKey(secret),
    now = Math.floor(Date.now() / 1000)
  const env: AddressGatewayEnv = {
    ADDRESS_REQUESTS: {
      prepare(sql) {
        let values: unknown[] = []
        const statement = {
          bind(...next: unknown[]) {
            values = next
            return statement
          },
          async first<T>() {
            return db.query(sql).get(...(values as never[])) as T | null
          },
          async run() {
            const r = db.query(sql).run(...(values as never[]))
            return { success: true, meta: { changes: r.changes } }
          },
        }
        return statement
      },
    },
    REQUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ALLOWED_ORIGINS: "https://shop.conduit.market",
    TURNSTILE_HOSTNAMES: "shop.conduit.market",
    TURNSTILE_SECRET_KEY: crypto.randomUUID(),
    BREEZ_DOMAIN_API_KEY: crypto.randomUUID(),
    BREEZ_PROXY_SHARED_SECRET: crypto.randomUUID(),
    PROVIDER_PROXY_QUALIFIED: "true",
  }
  const approved: ApprovedName = {
    name: "alice",
    ownerPubkey: owner,
    sparkIdentity: identity,
    registration: true,
  }
  const signatures = (message: string, key = walletSecret) =>
    bytesToHex(
      secp256k1.sign(sha256(new TextEncoder().encode(message)), key, {
        prehash: false,
        format: "der",
      })
    )
  const calls: { path: string; headers: Headers }[] = []
  let providerName: string | null = null
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    if (url.hostname === "challenges.cloudflare.com")
      return Response.json({
        success: true,
        hostname: "shop.conduit.market",
        action: "address_name_request",
      })
    calls.push({ path: url.pathname, headers })
    // Controlled provider: this assumption must also be qualified live.
    if (
      headers.get("X-Breez-Reverse-Proxy-Shared-Secret") !==
        env.BREEZ_PROXY_SHARED_SECRET ||
      headers.get("Host") !== "conduit.cash"
    )
      return Response.json("proxy required", { status: 403 })
    if (url.pathname.endsWith("/recover"))
      return providerName
        ? Response.json({
            username: providerName,
            lightning_address: `${providerName}@conduit.cash`,
            lnurl: `lnurlp://conduit.cash/lnurlp/${providerName}`,
          })
        : Response.json("user not found", { status: 404 })
    if (init?.method === "POST" && !url.pathname.endsWith("/available"))
      providerName = JSON.parse(String(init?.body)).username
    return Response.json({ ok: true })
  }) as typeof fetch
  const management = (
    operation: "register" | "recover" | "available" | "unregister",
    extra: Record<string, unknown> = {}
  ) => {
    const fields = {
      username: "alice",
      description: "Pay to alice",
      timestamp: now,
      ...extra,
    }
    const message =
      operation === "unregister"
        ? [
            "breez-lnurl:v2",
            operation,
            "conduit.cash",
            fields.username,
            String(fields.timestamp),
          ].join("\n")
        : breezAddressMessage({
            operation,
            domain: "conduit.cash",
            identity,
            ...fields,
          })
    return new Request(
      `https://conduit.cash/lnurlpay/${identity}${["recover", "available"].includes(operation) ? "/" + operation : ""}`,
      {
        method: operation === "unregister" ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, signature: signatures(message) }),
      }
    )
  }
  const requestId = crypto.randomUUID()
  const nameRequest = (
    path = ADDRESS_REQUEST_PATH,
    changed: Record<string, unknown> = {}
  ) => {
    const draft = {
      requestId,
      desiredName: "alice",
      ownerPubkey: owner,
      sparkIdentity: identity,
      network: "mainnet" as const,
      note: "Optional reviewer note",
      timestamp: now,
      ...changed,
    }
    const value = {
      ...draft,
      walletSignature: signatures(addressNameRequestMessage(draft)),
    }
    const payload = addressNameRequestPayload(value)
    const event = finalizeEvent(
      {
        kind: 27235,
        content: "",
        created_at: now,
        tags: [
          ["u", `https://conduit.cash${path}`],
          ["method", "POST"],
          ["payload", addressRequestHash(payload)],
        ],
      },
      secret
    )
    return new Request(`https://conduit.cash${path}`, {
      method: "POST",
      body: payload,
      headers: {
        Origin: "https://shop.conduit.market",
        "Content-Type": "application/json",
        Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
        "X-Turnstile-Token": crypto.randomUUID(),
      },
    })
  }
  return {
    db,
    env,
    identity,
    owner,
    now,
    approved,
    fetcher,
    calls,
    signatures,
    walletSecret,
    management,
    nameRequest,
    setProviderName(value: string | null) {
      providerName = value
    },
    handle(request: Request, names: ApprovedName[] = [approved]) {
      return handleAddressGateway(request, env, names, fetcher, now)
    },
  }
}
describe("approved-name gateway", () => {
  test("submission stores both proofs but never approves; approval requires a matching reviewed identity", async () => {
    const f = fixture()
    expect(await (await f.handle(f.nameRequest(), [])).json()).toEqual({
      status: "received",
    })
    expect(
      await (
        await f.handle(f.nameRequest(ADDRESS_REQUEST_PATH + "/status"), [])
      ).json()
    ).toEqual({ status: "received" })
    expect(
      await (
        await f.handle(f.nameRequest(ADDRESS_REQUEST_PATH + "/status"))
      ).json()
    ).toEqual({ status: "approved" })
    expect(f.db.query("SELECT COUNT(*) AS n FROM name_requests").get()).toEqual(
      { n: 1 }
    )
    expect(await (await f.handle(f.nameRequest(), [])).json()).toEqual({
      status: "received",
    })
    expect(f.calls).toHaveLength(0)
    const stored = f.db
      .query(
        "SELECT signed_payload, account_proof, created_at FROM name_requests"
      )
      .get() as {
      signed_payload: string
      account_proof: string
      created_at: number
    }
    expect(
      verifyAddressRequestAuthority(
        JSON.parse(stored.signed_payload),
        JSON.parse(stored.account_proof),
        ADDRESS_REQUEST_PATH,
        stored.created_at,
        "https://conduit.cash",
        stored.signed_payload
      )
    ).toBe(true)
  })
  test("changing a request under the same id never overwrites review evidence", async () => {
    const f = fixture()
    await f.handle(f.nameRequest(), [])
    expect(
      (
        await f.handle(
          f.nameRequest(ADDRESS_REQUEST_PATH, { desiredName: "bob" }),
          []
        )
      ).status
    ).toBe(409)
    expect(f.db.query("SELECT desired_name FROM name_requests").get()).toEqual({
      desired_name: "alice",
    })
  })
  test("persisted submission survives failed readback and exact signed status recovers it", async () => {
    const f = fixture()
    const originalPrepare = f.env.ADDRESS_REQUESTS.prepare.bind(
      f.env.ADDRESS_REQUESTS
    )
    let failReadback = true
    f.env.ADDRESS_REQUESTS.prepare = (sql) => {
      const statement = originalPrepare(sql)
      if (
        sql === "SELECT request_hash FROM name_requests WHERE request_id = ?"
      ) {
        const originalFirst = statement.first.bind(statement)
        statement.first = async <T>() => {
          if (failReadback) {
            failReadback = false
            throw new Error("readback unavailable after insert")
          }
          return originalFirst<T>()
        }
      }
      return statement
    }
    const originalRequest = f.nameRequest()
    const originalBody = await originalRequest.clone().text()
    expect((await f.handle(originalRequest, [])).status).toBe(503)
    expect(failReadback).toBe(false)
    const saved = f.db
      .query(
        "SELECT request_id, desired_name, request_hash, signed_payload, account_proof, wallet_proof FROM name_requests"
      )
      .get()
    expect(saved).toMatchObject({
      request_id: JSON.parse(originalBody).requestId,
      desired_name: "alice",
      signed_payload: originalBody,
    })
    const status = await f.handle(
      f.nameRequest(`${ADDRESS_REQUEST_PATH}/status`),
      []
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ status: "received" })
    expect(
      (
        await f.handle(
          f.nameRequest(ADDRESS_REQUEST_PATH, { desiredName: "bob" }),
          []
        )
      ).status
    ).toBe(409)
    expect(
      f.db
        .query(
          "SELECT request_id, desired_name, request_hash, signed_payload, account_proof, wallet_proof FROM name_requests"
        )
        .get()
    ).toEqual(saved)
    expect(f.db.query("SELECT COUNT(*) AS n FROM name_requests").get()).toEqual(
      { n: 1 }
    )
  })
  test("NIP-98 rejects reordered HTTP bytes even when their decoded fields are identical", async () => {
    const f = fixture(),
      original = f.nameRequest()
    const body = JSON.stringify(
      Object.fromEntries(Object.entries(await original.json()).reverse())
    )
    const reordered = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body,
    })
    expect((await f.handle(reordered, [])).status).toBe(401)
    expect(f.db.query("SELECT COUNT(*) AS n FROM name_requests").get()).toEqual(
      { n: 0 }
    )
  })
  test("tampered account and wallet bindings, notes and payloads fail before storage", async () => {
    for (const field of [
      "desiredName",
      "note",
      "ownerPubkey",
      "sparkIdentity",
    ]) {
      const f = fixture(),
        request = f.nameRequest(),
        body = await request.json()
      body[field] =
        field === "desiredName"
          ? "bob"
          : field === "note"
            ? "changed"
            : field === "ownerPubkey"
              ? getPublicKey(generateSecretKey())
              : bytesToHex(secp256k1.getPublicKey(generateSecretKey()))
      const forged = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      })
      expect((await f.handle(forged)).status).toBe(401)
      expect(
        f.db.query("SELECT COUNT(*) AS n FROM name_requests").get()
      ).toEqual({ n: 0 })
    }
  })
  test("challenge denial and untrusted origins cannot submit", async () => {
    const f = fixture()
    const request = f.nameRequest()
    request.headers.set("Origin", "https://other.invalid")
    expect((await f.handle(request)).status).toBe(403)
    const noToken = f.nameRequest()
    noToken.headers.delete("X-Turnstile-Token")
    expect((await f.handle(noToken)).status).toBe(400)
    expect(f.db.query("SELECT COUNT(*) AS n FROM name_requests").get()).toEqual(
      { n: 0 }
    )
  })
  test("registration requires an approved exact identity and fresh authenticated recovery", async () => {
    const f = fixture()
    expect((await f.handle(f.management("register"))).status).toBe(409)
    expect((await f.handle(f.management("recover"))).status).toBe(404)
    expect((await f.handle(f.management("register"), [])).status).toBe(403)
    expect((await f.handle(f.management("register"))).status).toBe(200)
    expect((await f.handle(f.management("register"))).status).toBe(409)
  })
  test("new signed identities share a bounded source budget before provider and storage", async () => {
    const f = fixture()
    const counts = new Map<string, number>()
    const keys: string[] = []
    f.env.REQUEST_RATE_LIMITER = {
      async limit({ key }) {
        keys.push(key)
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        return { success: count <= 5 }
      },
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const secret = generateSecretKey()
      const identity = bytesToHex(secp256k1.getPublicKey(secret))
      const message = breezAddressMessage({
        operation: "recover",
        domain: "conduit.cash",
        identity,
        timestamp: f.now,
      })
      const request = new Request(
        `https://conduit.cash/lnurlpay/${identity}/recover`,
        {
          method: "POST",
          headers: { "CF-Connecting-IP": "192.0.2.10" },
          body: JSON.stringify({
            timestamp: f.now,
            signature: f.signatures(message, secret),
          }),
        }
      )
      expect((await f.handle(request, [])).status).toBe(attempt < 5 ? 404 : 429)
    }
    expect(f.calls).toHaveLength(5)
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM address_observations").get()
    ).toEqual({ n: 0 })
    expect(keys.every((key) => !key.includes("192.0.2.10"))).toBe(true)

    // A different source can still recover an existing approved wallet.
    f.setProviderName("alice")
    const existing = f.management("recover")
    const headers = new Headers(existing.headers)
    headers.set("CF-Connecting-IP", "198.51.100.20")
    expect((await f.handle(new Request(existing, { headers }))).status).toBe(
      200
    )
    expect((await f.handle(f.management("register"))).status).toBe(200)
  })
  test("repeated recovery of one identity is bounded across sources", async () => {
    const f = fixture()
    const counts = new Map<string, number>()
    f.env.REQUEST_RATE_LIMITER = {
      async limit({ key }) {
        const count = (counts.get(key) ?? 0) + 1
        counts.set(key, count)
        return { success: count <= 5 }
      },
    }
    f.setProviderName("alice")
    for (let attempt = 0; attempt < 7; attempt++) {
      const request = f.management("recover")
      const headers = new Headers(request.headers)
      headers.set("CF-Connecting-IP", `192.0.2.${attempt + 1}`)
      expect((await f.handle(new Request(request, { headers }))).status).toBe(
        attempt < 5 ? 200 : 429
      )
    }
    expect(f.calls).toHaveLength(5)
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM address_observations").get()
    ).toEqual({ n: 1 })
  })
  test("an existing wallet recovers without approval and creates no observation", async () => {
    const f = fixture()
    f.setProviderName("existing-name")
    const result = await f.handle(f.management("recover"), [])
    expect(result.status).toBe(200)
    expect((await result.json()).username).toBe("existing-name")
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM address_observations").get()
    ).toEqual({ n: 0 })
  })
  test("approved recovery prunes expired registration observations", async () => {
    const f = fixture()
    f.db
      .query(
        "INSERT INTO address_observations (identity, name, observed_at) VALUES (?, ?, ?)"
      )
      .run("expired-identity", null, f.now - 86401)
    expect((await f.handle(f.management("recover"))).status).toBe(404)
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM address_observations").get()
    ).toEqual({ n: 1 })
    expect(
      f.db.query("SELECT identity FROM address_observations").get()
    ).toEqual({ identity: f.identity })
  })
  test("recovery fails closed before provider and storage when limiter is unavailable", async () => {
    const f = fixture()
    f.env.REQUEST_RATE_LIMITER =
      undefined as unknown as AddressGatewayEnv["REQUEST_RATE_LIMITER"]
    expect((await f.handle(f.management("recover"))).status).toBe(503)
    expect(f.calls).toHaveLength(0)
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM address_observations").get()
    ).toEqual({ n: 0 })
  })
  test("reordering JSON does not bypass the mutation replay claim", async () => {
    const f = fixture()
    await f.handle(f.management("recover"))
    await f.handle(f.management("register"))
    const request = f.management("register"),
      entries = Object.entries(await request.json()).reverse()
    const reordered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(Object.fromEntries(entries)),
    })
    expect((await f.handle(reordered)).status).toBe(409)
  })
  test("a registered address cannot be renamed without exact replacement approval", async () => {
    const f = fixture()
    f.setProviderName("old-name")
    await f.handle(f.management("recover"))
    expect((await f.handle(f.management("register"))).status).toBe(409)
    expect(
      (
        await f.handle(f.management("register"), [
          { ...f.approved, replaces: "old-name" },
        ])
      ).status
    ).toBe(200)
  })
  test("deletion requires an unexpired manual approval and its own valid signature", async () => {
    const f = fixture()
    expect((await f.handle(f.management("unregister"))).status).toBe(403)
    expect(
      (
        await f.handle(f.management("unregister"), [
          { ...f.approved, deleteUntil: f.now + 60 },
        ])
      ).status
    ).toBe(200)
    const request = f.management("register")
    const body = await request.json()
    expect(
      (
        await f.handle(
          new Request(request.url, {
            method: "DELETE",
            body: JSON.stringify(body),
          }),
          [{ ...f.approved, deleteUntil: f.now + 60 }]
        )
      ).status
    ).toBe(401)
  })
  test("unsigned extra fields cannot replay an approved deletion", async () => {
    const f = fixture(),
      approved = [{ ...f.approved, deleteUntil: f.now + 60 }]
    expect((await f.handle(f.management("unregister"), approved)).status).toBe(
      200
    )
    // Description is not part of Breez's deletion statement. Changing it must
    // not turn the same signed authorization into another mutation.
    expect(
      (
        await f.handle(
          f.management("unregister", {
            description: "different",
            extra: "ignored",
          }),
          approved
        )
      ).status
    ).toBe(409)
    expect(f.calls).toHaveLength(1)
  })
  test("public Lightning preflight is accessible without the application origin", async () => {
    const f = fixture()
    const result = await f.handle(
      new Request("https://conduit.cash/lnurlp/alice/invoice", {
        method: "OPTIONS",
        headers: { Origin: "https://ordinary-lightning-wallet.invalid" },
      })
    )
    expect(result.status).toBe(204)
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(f.calls).toHaveLength(0)
  })
  test("transfers require approved old/new identities and both role-specific signatures", async () => {
    const f = fixture(),
      fromSecret = generateSecretKey(),
      from = bytesToHex(secp256k1.getPublicKey(fromSecret))
    const body = {
      username: "alice",
      description: "Pay to alice",
      from_pubkey: from,
      timestamp: f.now,
      from_signature: f.signatures(
        [
          "breez-lnurl:v2",
          "transfer-from",
          "conduit.cash",
          "alice",
          from,
          f.identity,
          String(f.now),
        ].join("\n"),
        fromSecret
      ),
      to_signature: f.signatures(
        [
          "breez-lnurl:v2",
          "transfer-to",
          "conduit.cash",
          "alice",
          from,
          f.identity,
          addressRequestHash("Pay to alice"),
          String(f.now),
        ].join("\n")
      ),
    }
    const make = (value = body) =>
      new Request(`https://conduit.cash/lnurlpay/${f.identity}/transfer`, {
        method: "POST",
        body: JSON.stringify(value),
      })
    const approved = [
      { ...f.approved, transferFrom: from, transferUntil: f.now + 60 },
    ]
    expect((await f.handle(make())).status).toBe(403)
    expect(
      (
        await f.handle(
          make({ ...body, to_signature: body.from_signature }),
          approved
        )
      ).status
    ).toBe(401)
    expect((await f.handle(make(), approved)).status).toBe(200)
  })
  test("ordinary receiving is public while credentials remain on the proxy hop", async () => {
    const f = fixture(),
      request = new Request("https://conduit.cash/.well-known/lnurlp/alice", {
        headers: {
          Origin: "https://ordinary-lightning-wallet.invalid",
          "X-Breez-Reverse-Proxy-Shared-Secret": "untrusted",
          "X-Forwarded-For": "untrusted",
          Cookie: "untrusted",
        },
      })
    const result = await f.handle(request, [])
    expect(result.status).toBe(200)
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*")
    const forwarded = f.calls[0]!.headers
    expect(
      forwarded.get("X-Breez-Reverse-Proxy-Shared-Secret") ===
        f.env.BREEZ_PROXY_SHARED_SECRET
    ).toBe(true)
    expect(forwarded.get("X-Forwarded-For")).toBe("")
    expect(forwarded.get("Cookie")).toBeNull()
    expect(
      (await result.text()).includes(f.env.BREEZ_PROXY_SHARED_SECRET)
    ).toBe(false)
  })
  test("controlled upstream rejects bypass; live upstream admission is a separate release requirement", async () => {
    const f = fixture(),
      signed = f.management("register")
    const direct = await f.fetcher(
      "https://breez.tips/lnurlpay/" + f.identity,
      {
        method: "POST",
        headers: {
          Host: "conduit.cash",
          Authorization: `Bearer ${f.env.BREEZ_DOMAIN_API_KEY}`,
        },
        body: await signed.text(),
      }
    )
    expect(direct.status).toBe(403)
  })
  test("unqualified management stays disabled while public receiving remains accessible", async () => {
    const f = fixture()
    f.env.PROVIDER_PROXY_QUALIFIED = "false"
    await f.handle(f.management("recover"))
    expect((await f.handle(f.management("register"))).status).toBe(503)
    expect(
      (
        await f.handle(
          new Request("https://conduit.cash/.well-known/lnurlp/alice")
        )
      ).status
    ).toBe(200)
  })
  test("unknown management methods and routes cannot reach upstream", async () => {
    const f = fixture()
    for (const method of ["PUT", "PATCH", "GET"]) {
      expect(
        (
          await f.handle(
            new Request(`https://conduit.cash/lnurlpay/${f.identity}`, {
              method,
            })
          )
        ).status
      ).toBe(405)
    }
    expect(
      (
        await f.handle(
          new Request(`https://conduit.cash/lnurlpay/${f.identity}/rename`, {
            method: "POST",
            body: "{}",
          })
        )
      ).status
    ).toBe(404)
    expect(f.calls).toHaveLength(0)
  })
})
