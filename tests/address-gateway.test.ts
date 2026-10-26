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
  proposeApprovedName,
  reviewNameRequest,
  type StoredNameRequest,
} from "../apps/address-gateway/src/request-review"
import { BreezLightningAddressClient } from "../packages/core/src/wallets/breez-lightning-address"
import {
  createAddressRequestWorkflow,
  type AddressRequestView,
} from "../packages/core/src/wallets/address-request-workflow"
import {
  ADDRESS_REQUEST_PATH,
  addressNameRequestMessage,
  addressNameRequestPayload,
  addressRequestHash,
  decodeAddressNameRequestResponse,
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
      url.origin !== "https://conduit.cash"
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
    if (url.pathname.endsWith("/available"))
      return Response.json({ available: true })
    if (init?.method === "POST" && !url.pathname.endsWith("/available"))
      providerName = JSON.parse(String(init?.body)).username
    return Response.json({ ok: true })
  }) as typeof fetch
  const managementRequest = (
    url: string,
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
    accountSecret = secret
  ) => {
    const raw = JSON.stringify(body)
    const event = finalizeEvent(
      {
        kind: 27235,
        content: "",
        created_at: now,
        tags: [
          ["u", url],
          ["method", method],
          ["payload", addressRequestHash(raw)],
        ],
      },
      accountSecret
    )
    return new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
      },
      body: raw,
    })
  }
  const management = (
    operation: "register" | "recover" | "available" | "unregister",
    extra: Record<string, unknown> = {},
    accountSecret = secret
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
    return managementRequest(
      `https://conduit.cash/lnurlpay/${identity}${["recover", "available"].includes(operation) ? "/" + operation : ""}`,
      operation === "unregister" ? "DELETE" : "POST",
      { ...fields, signature: signatures(message) },
      accountSecret
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
    accountSecret: secret,
    management,
    managementRequest,
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
  test("native repository previews submit and check real gateway records while forks fail closed", async () => {
    const origin = "https://feat-names.conduit-merchant-33n.pages.dev"
    const f = fixture()
    Object.assign(f.env, {
      TRUSTED_PREVIEWS_ENABLED: "true",
      PAGES_ACCOUNT_ID: "a".repeat(32),
      PAGES_READ_API_TOKEN: "server-only-fixture",
      PREVIEW_DISCOVERY_RATE_LIMITER: {
        limit: async () => ({ success: true }),
      },
    })
    const verificationAttempts: string[] = []
    let fork = false,
      expired = false,
      wrongHostname = false,
      providerChecks = 0
    const provider = (async (input, init) => {
      if (
        String(input).startsWith("https://api.cloudflare.com/") &&
        !new URL(String(input)).pathname.endsWith("/deployments")
      )
        return Response.json({
          success: true,
          result: {
            name: "conduit-merchant",
            subdomain: "conduit-merchant-33n.pages.dev",
            source: {
              type: "github",
              config: {
                owner: "Conduit-BTC",
                repo_name: "conduit-mono",
                repo_id: "1154829623",
              },
            },
          },
        })
      if (String(input).startsWith("https://api.cloudflare.com/"))
        return Response.json({
          success: true,
          result: [
            {
              url: "https://abc12345.conduit-merchant-33n.pages.dev",
              aliases: [origin],
              environment: "preview",
              project_name: "conduit-merchant",
              created_on: new Date(
                (f.now - (expired ? 8 * 86400 : 60)) * 1000
              ).toISOString(),
              latest_stage: { name: "deploy", status: "success" },
              source: {
                type: "github",
                config: {
                  owner: fork ? "fork-owner" : "Conduit-BTC",
                  repo_name: "conduit-mono",
                  repo_id: "1154829623",
                },
              },
              deployment_trigger: {
                type: "github:push",
                metadata: {
                  branch: "feat/names",
                  commit_hash: "a".repeat(40),
                  commit_dirty: false,
                },
              },
            },
          ],
          result_info: { total_pages: 1 },
        })
      if (String(input).includes("challenges.cloudflare.com")) {
        providerChecks++
        verificationAttempts.push(
          JSON.parse(String(init?.body)).idempotency_key
        )
        return Response.json({
          success: true,
          hostname: wrongHostname
            ? "shop.conduit.market"
            : new URL(origin).hostname,
          action: "address_name_request",
        })
      }
      return f.fetcher(input, init)
    }) as typeof fetch
    const handle = (request: Request, names: ApprovedName[] = []) => {
      request.headers.set("Origin", origin)
      return handleAddressGateway(request, f.env, names, provider, f.now)
    }
    expect(
      (
        await handle(
          new Request("https://conduit.cash/api/name-requests", {
            method: "OPTIONS",
          })
        )
      ).status
    ).toBe(204)
    wrongHostname = true
    const rejected = await handle(f.nameRequest())
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ status: "challenge_failed" })
    expect(
      f.db.query("SELECT count(*) AS count FROM name_requests").get()
    ).toEqual({ count: 0 })
    wrongHostname = false
    expect(await (await handle(f.nameRequest())).json()).toEqual({
      status: "received",
    })
    // The same signed request is available through production, without re-submission.
    expect(
      await (
        await f.handle(f.nameRequest(ADDRESS_REQUEST_PATH + "/status"), [])
      ).json()
    ).toEqual({ status: "received" })
    expect(
      await (
        await handle(f.nameRequest(ADDRESS_REQUEST_PATH + "/status"), [
          f.approved,
        ])
      ).json()
    ).toEqual({ status: "approved" })
    expect(providerChecks).toBe(2)
    expect(new Set(verificationAttempts).size).toBe(2)
    // Preview admission does not grant registration: the same manual approval,
    // fresh recovery, account proof and wallet signature still protect activation.
    expect((await handle(f.management("register"))).status).toBe(403)
    expect((await handle(f.management("recover"), [f.approved])).status).toBe(
      404
    )
    expect((await handle(f.management("register"), [f.approved])).status).toBe(
      200
    )
    expect(
      f.calls.some((call) => call.path === `/lnurlpay/${f.identity}`)
    ).toBe(true)
    fork = true
    const forbidden = await handle(f.nameRequest())
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(providerChecks).toBe(2)
    // Public readiness exposes only the denial so browsers can give a clear message.
    const readiness = await handle(
      new Request("https://conduit.cash/api/name-requests/availability")
    )
    expect(await readiness.json()).toEqual({ status: "origin_forbidden" })
    expect(readiness.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    fork = false
    expired = true
    expect(
      await (
        await handle(
          new Request("https://conduit.cash/api/name-requests/availability")
        )
      ).json()
    ).toEqual({ status: "preview_expired" })
    expect(
      f.db.query("SELECT count(*) AS count FROM name_requests").get()
    ).toEqual({ count: 1 })
  })
  test("operator proposes only the original verified binding and preserves legacy records", async () => {
    const f = fixture()
    await f.handle(f.nameRequest(), [])
    const row = f.db
      .query("SELECT * FROM name_requests")
      .get() as StoredNameRequest
    const proposal = proposeApprovedName({ version: 1, names: [] }, row)
    expect(proposal.names).toEqual([f.approved])
    expect(proposeApprovedName(proposal, row)).toEqual(proposal)
    expect(() =>
      proposeApprovedName(
        {
          version: 1,
          names: [
            { ...f.approved, ownerPubkey: getPublicKey(generateSecretKey()) },
          ],
        },
        row
      )
    ).toThrow()
    for (const change of [
      { status: "declined" },
      { created_at: row.created_at + 120 },
      { owner_pubkey: getPublicKey(generateSecretKey()) },
      { wallet_proof: "00" },
      { note: "changed" },
      { request_hash: "00" },
      {
        signed_payload: JSON.stringify({
          ...JSON.parse(row.signed_payload),
          desiredName: "changed",
        }),
      },
      { account_proof: "{}" },
    ])
      expect(() =>
        reviewNameRequest({ ...row, ...change } as StoredNameRequest)
      ).toThrow("Request evidence is not eligible for approval.")
    f.db.exec(
      readFileSync(
        new URL(
          "../apps/address-gateway/migrations/0002_immutable_request_evidence.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    expect(
      reviewNameRequest(
        f.db.query("SELECT * FROM name_requests").get() as StoredNameRequest
      )
    ).toEqual(f.approved)
    expect(() =>
      f.db.exec("UPDATE name_requests SET note = 'changed'")
    ).toThrow("request evidence is immutable")
    f.db.exec("UPDATE name_requests SET status = 'declined'")
    expect(() =>
      reviewNameRequest(
        f.db.query("SELECT * FROM name_requests").get() as StoredNameRequest
      )
    ).toThrow()
  })
  test("signed record absence is distinct from a missing status route", async () => {
    const f = fixture()
    const absent = await f.handle(
      f.nameRequest(`${ADDRESS_REQUEST_PATH}/status`),
      []
    )
    expect(absent.status).toBe(404)
    expect(await decodeAddressNameRequestResponse(absent)).toBe("not_received")

    const missingRoute = await f.handle(
      f.nameRequest(`${ADDRESS_REQUEST_PATH}/missing`),
      []
    )
    expect(missingRoute.status).toBe(404)
    expect(await decodeAddressNameRequestResponse(missingRoute)).toBe("pending")
    expect(
      await decodeAddressNameRequestResponse(
        new Response("<html>missing</html>", { status: 404 })
      )
    ).toBe("pending")
    expect(
      await decodeAddressNameRequestResponse(
        Response.json({ status: "pending" }, { status: 404 })
      )
    ).toBe("pending")
    expect(
      await decodeAddressNameRequestResponse(
        Response.json({ status: "not_received", other: true }, { status: 404 })
      )
    ).toBe("pending")
    for (const status of [
      "received",
      "pending",
      "approved",
      "declined",
    ] as const)
      expect(
        await decodeAddressNameRequestResponse(Response.json({ status }))
      ).toBe(status)
  })
  test("workflow and signed client activate within the five-recovery budget after two ordinary lookups", async () => {
    const f = fixture()
    const counts = new Map<string, number>()
    f.env.REQUEST_RATE_LIMITER.limit = async ({ key }) => {
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      return { success: count <= 5 }
    }
    const client = new BreezLightningAddressClient({
      domain: "conduit.cash",
      apiKey: "test-client-key",
      signer: {
        getIdentityPublicKey: async () => f.identity,
        signDigest: async (digest) =>
          secp256k1.sign(digest, f.walletSecret, {
            prehash: false,
            format: "der",
          }),
        assertActive() {},
      },
      signAccountProof: async ({ url, method, body }) => {
        const event = finalizeEvent(
          {
            kind: 27235,
            content: "",
            created_at: f.now,
            tags: [
              ["u", url],
              ["method", method],
              ["payload", addressRequestHash(body)],
            ],
          },
          f.accountSecret
        )
        return `Nostr ${btoa(JSON.stringify(event))}`
      },
      store: {
        read: async () => null,
        write: async () => {},
      },
      runExclusive: async (_scope, run) => run(),
      now: () => f.now * 1000,
      fetch: async (input, init) => {
        if (String(input).includes(".well-known"))
          return Response.json({
            tag: "payRequest",
            minSendable: 1,
            maxSendable: 1000,
            callback: "https://conduit.cash/lnurlp/alice/invoice",
            metadata: JSON.stringify([
              ["text/identifier", "alice@conduit.cash"],
            ]),
          })
        return f.handle(new Request(input, init))
      },
    })
    await client.lookup()
    await client.lookup()
    const original = f.nameRequest()
    const payload = await original.clone().text()
    await f.handle(original.clone())
    let view: AddressRequestView = {
      record: {
        payload,
        accountProof: atob(original.headers.get("Authorization")!.slice(6)),
        phase: "approved",
      },
      publication: "confirmed",
    }
    const workflow = createAddressRequestWorkflow({
      owner: f.owner,
      assertCurrent() {},
      load: async () => view,
      save: async (_id, record) => (view = { record, publication: "local" }),
      signWallet: async () => {
        throw new Error("Retained request")
      },
      signAccount: async (draft) => finalizeEvent(draft, f.accountSecret),
      fetch: (async (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set("Origin", "https://shop.conduit.market")
        return f.handle(new Request(input, { ...init, headers }))
      }) as typeof fetch,
      address: async (_id, register, name, beforeRegister) =>
        register
          ? client.ensure(name, {
              activateApprovedName: true,
              beforeRegister,
              retryKnownNonSubmissionOnly: register === "retry",
            })
          : client.lookup(),
      publishProfile: async () => "a".repeat(64),
    })
    expect((await workflow.activate("wallet")).record.phase).toBe("complete")
    expect(
      [...counts.entries()]
        .filter(([key]) => key.startsWith("recover:"))
        .map(([, count]) => count)
    ).toEqual([5, 5])
    expect(
      f.calls.filter((call) => call.path === `/lnurlpay/${f.identity}`)
    ).toHaveLength(1)
    const registration = f.calls.find(
      (call) => call.path === `/lnurlpay/${f.identity}`
    )
    expect(registration?.headers.get("Authorization")).toBe(
      `Bearer ${f.env.BREEZ_DOMAIN_API_KEY}`
    )
  })
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
        sql ===
        "SELECT request_hash, signed_payload FROM name_requests WHERE request_id = ?"
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
    expect(
      (await f.handle(f.management("register", {}, generateSecretKey()))).status
    ).toBe(401)
    expect(f.calls).toHaveLength(1)
    expect((await f.handle(f.management("register"))).status).toBe(200)
    expect((await f.handle(f.management("register"))).status).toBe(409)
  })
  test("custom-domain mutation proof binds the exact body and cannot be omitted", async () => {
    const f = fixture()
    await f.handle(f.management("recover"))
    const missing = f.management("register")
    missing.headers.delete("Authorization")
    expect((await f.handle(missing)).status).toBe(401)
    const signed = f.management("register", { extra: "original" })
    const body = { ...(await signed.json()), extra: "changed" }
    const altered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(body),
    })
    expect((await f.handle(altered)).status).toBe(401)
    expect(f.calls).toHaveLength(1)
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
      headers.set("Origin", "https://shop.conduit.market")
      const result = await f.handle(new Request(request, { headers }))
      if (attempt >= 5) {
        expect(result.headers.get("Retry-After")).toBe("60")
        expect(result.headers.get("Access-Control-Expose-Headers")).toBe(
          "Retry-After"
        )
      }
      expect(result.status).toBe(attempt < 5 ? 200 : 429)
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
    const reordered = f.managementRequest(
      request.url,
      "POST",
      Object.fromEntries(entries)
    )
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
    const approved = [{ ...f.approved, deleteUntil: f.now + 3600 }]
    expect((await f.handle(f.management("unregister"))).status).toBe(403)
    expect(
      (
        await f.handle(
          f.management("unregister", {}, generateSecretKey()),
          approved
        )
      ).status
    ).toBe(401)
    expect(f.calls).toHaveLength(0)
    expect((await f.handle(f.management("unregister"), approved)).status).toBe(
      200
    )
    const request = f.management("register")
    const body = await request.json()
    expect(
      (
        await f.handle(
          new Request(request.url, {
            method: "DELETE",
            body: JSON.stringify(body),
          }),
          [{ ...f.approved, deleteUntil: f.now + 3600 }]
        )
      ).status
    ).toBe(401)
  })
  test("expired or unbounded destructive approval never reaches the provider", async () => {
    for (const until of [0, -1, NaN, Infinity]) {
      const f = fixture()
      expect(
        (
          await f.handle(f.management("unregister"), [
            { ...f.approved, deleteUntil: until },
          ])
        ).status
      ).toBe(503)
      expect(f.calls).toHaveLength(0)
    }
    for (const delta of [-1, 86401]) {
      const f = fixture()
      expect(
        (
          await f.handle(f.management("unregister"), [
            { ...f.approved, deleteUntil: f.now + delta },
          ])
        ).status
      ).toBe(403)
      expect(f.calls).toHaveLength(0)
    }
  })
  test("unsigned extra fields cannot replay an approved deletion", async () => {
    const f = fixture(),
      approved = [{ ...f.approved, deleteUntil: f.now + 3600 }]
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
    const make = (value = body, accountSecret?: Uint8Array) =>
      f.managementRequest(
        `https://conduit.cash/lnurlpay/${f.identity}/transfer`,
        "POST",
        value,
        accountSecret
      )
    const approved = [
      { ...f.approved, transferFrom: from, transferUntil: f.now + 3600 },
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
    expect(
      (await f.handle(make(body, generateSecretKey()), approved)).status
    ).toBe(401)
    expect(f.calls).toHaveLength(0)
    expect((await f.handle(make(), approved)).status).toBe(200)
  })
  test("exact public verifier route forwards with CORS while malformed paths stay blocked", async () => {
    const f = fixture()
    const hash = "ab".repeat(32)
    const path = `/lnurlp/verify/${hash}`
    const origin = "https://ordinary-lightning-wallet.invalid"
    const request = (path: string, method = "GET") =>
      new Request(`https://conduit.cash${path}`, {
        method,
        headers: { Origin: origin },
      })

    const verified = await f.handle(request(path))
    expect(verified.status).toBe(200)
    expect(verified.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(verified.headers.get("Cache-Control")).toBe("no-store")
    expect(f.calls.map((call) => call.path)).toEqual([path])

    const preflight = await f.handle(request(path, "OPTIONS"))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(f.calls).toHaveLength(1)

    for (const invalid of [
      `/lnurlp/verify/${"a".repeat(63)}`,
      `/lnurlp/verify/${hash}0`,
      `/lnurlp/verify/${hash.toUpperCase()}`,
      `${path}/extra`,
    ]) {
      const rejected = await f.handle(request(invalid))
      expect(rejected.status).toBe(403)
      expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull()
    }
    expect((await f.handle(request(path, "POST"))).status).toBe(403)
    expect(f.calls).toHaveLength(1)
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
      "https://conduit.cash/lnurlpay/" + f.identity,
      {
        method: "POST",
        headers: {
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

test("durable request retries retain original proofs after expiry and require fresh account authority", async () => {
  const f = fixture()
  const original = f.nameRequest()
  const payload = await original.text()
  const originalProof = original.headers.get("Authorization")!.slice(6)
  const later = f.now + 86400
  const make = (
    path: string,
    key = f.accountSecret,
    proof = originalProof,
    body = payload
  ) => {
    const event = finalizeEvent(
      {
        kind: 27235,
        content: "",
        created_at: later,
        tags: [
          ["u", "https://conduit.cash" + path],
          ["method", "POST"],
          ["payload", addressRequestHash(body)],
        ],
      },
      key
    )
    return new Request("https://conduit.cash" + path, {
      method: "POST",
      body,
      headers: {
        Origin: "https://shop.conduit.market",
        Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
        "X-Address-Request-Proof": proof,
        "X-Turnstile-Token": "controlled",
      },
    })
  }
  expect(
    (
      await handleAddressGateway(
        make(ADDRESS_REQUEST_PATH, generateSecretKey()),
        f.env,
        [],
        f.fetcher,
        later
      )
    ).status
  ).toBe(401)
  expect(
    (
      await handleAddressGateway(
        make(ADDRESS_REQUEST_PATH, f.accountSecret, btoa("{}")),
        f.env,
        [],
        f.fetcher,
        later
      )
    ).status
  ).toBe(401)
  expect(
    (
      await handleAddressGateway(
        make(ADDRESS_REQUEST_PATH, f.accountSecret, ""),
        f.env,
        [],
        f.fetcher,
        later
      )
    ).status
  ).toBe(401)
  expect(
    (
      await handleAddressGateway(
        make(ADDRESS_REQUEST_PATH),
        f.env,
        [],
        f.fetcher,
        later
      )
    ).status
  ).toBe(200)
  const row = f.db
    .query("SELECT * FROM name_requests")
    .get() as StoredNameRequest
  expect(row.signed_payload).toBe(payload)
  expect(JSON.parse(row.account_proof).event).toEqual(
    JSON.parse(atob(originalProof))
  )
  expect(reviewNameRequest(row)).toEqual(f.approved)
  expect(
    (
      await handleAddressGateway(
        make(ADDRESS_REQUEST_PATH),
        f.env,
        [],
        f.fetcher,
        later
      )
    ).status
  ).toBe(200)
  expect(f.db.query("SELECT * FROM name_requests").get()).toEqual(row)
  const originalValue = JSON.parse(payload)
  const alteredSignature = bytesToHex(
    secp256k1.sign(
      sha256(
        new TextEncoder().encode(addressNameRequestMessage(originalValue))
      ),
      f.walletSecret,
      {
        prehash: false,
        format: "der",
        extraEntropy: new Uint8Array(32).fill(1),
      }
    )
  )
  expect(alteredSignature).not.toBe(originalValue.walletSignature)
  const changedRequests = [
    { ...originalValue, note: "Different reviewer note" },
    { ...originalValue, timestamp: f.now + 30 },
    { ...originalValue, walletSignature: alteredSignature },
  ]
  const changedBodies = changedRequests.map((changed) => {
    if (changed.walletSignature === originalValue.walletSignature)
      changed.walletSignature = f.signatures(addressNameRequestMessage(changed))
    return addressNameRequestPayload(changed)
  })
  changedBodies.push(
    JSON.stringify(Object.fromEntries(Object.entries(originalValue).reverse()))
  )
  for (const body of changedBodies) {
    const changed = JSON.parse(body)
    const proof = finalizeEvent(
      {
        kind: 27235,
        content: "",
        created_at: changed.timestamp,
        tags: [
          ["u", `https://conduit.cash${ADDRESS_REQUEST_PATH}`],
          ["method", "POST"],
          ["payload", addressRequestHash(body)],
        ],
      },
      f.accountSecret
    )
    for (const path of [ADDRESS_REQUEST_PATH, `${ADDRESS_REQUEST_PATH}/status`])
      expect(
        (
          await handleAddressGateway(
            make(path, f.accountSecret, btoa(JSON.stringify(proof)), body),
            f.env,
            [],
            f.fetcher,
            later
          )
        ).status
      ).toBe(409)
  }
  expect(f.db.query("SELECT * FROM name_requests").get()).toEqual(row)
  const result = await handleAddressGateway(
    make(ADDRESS_REQUEST_PATH + "/status"),
    f.env,
    [f.approved],
    f.fetcher,
    later
  )
  expect(await result.json()).toEqual({ status: "approved" })
  const legacyStatus = await f.handle(
    f.nameRequest(`${ADDRESS_REQUEST_PATH}/status`, {
      note: "Legacy status lookup",
    }),
    []
  )
  expect(await legacyStatus.json()).toEqual({ status: "received" })
  const stale = make(ADDRESS_REQUEST_PATH + "/status")
  expect(
    (await handleAddressGateway(stale, f.env, [], f.fetcher, later + 120))
      .status
  ).toBe(401)
})
