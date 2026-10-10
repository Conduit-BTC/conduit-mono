import { describe, expect, it } from "bun:test"
import { secp256k1 } from "../packages/core/node_modules/@noble/curves/secp256k1.js"
import { sha256 } from "../packages/core/node_modules/@noble/hashes/sha2.js"
import {
  bytesToHex,
  hexToBytes,
} from "../packages/core/node_modules/@noble/hashes/utils.js"
import {
  BreezLightningAddressClient,
  breezAddressMessage,
  generateBreezUsername,
  normalizeBreezUsername,
  verifyBreezPublicLookup,
  type BreezAddressCheckpoint,
  type BreezAddressFetch,
  type BreezAddressSigner,
} from "../packages/core/src/wallets/breez-lightning-address"
import { getBreezAddressConfiguration } from "../apps/market/src/lib/breez-lightning-address"
import {
  DefaultSparkSigner,
  deriveViewerIdentityPublicKey,
} from "../apps/market/node_modules/@buildonspark/spark-sdk"
import {
  entropyToMnemonic,
  mnemonicToSeedSync,
} from "../apps/market/node_modules/@scure/bip39"
import { wordlist } from "../apps/market/node_modules/@scure/bip39/wordlists/english.js"

// Published BIP39 zero-entropy vector, deliberately non-funded.
const MNEMONIC = entropyToMnemonic(new Uint8Array(16), wordlist) // Public, non-funded BIP39 vector.
const USERNAME = "wallet-01234567890123456789"
const FIXED_TIME = 1_700_000_000_000
const RECOVERED = (username = USERNAME) => ({
  username,
  lightning_address: `${username}@conduit.cash`,
  description: "test",
  lnurl: `lnurlp://conduit.cash/lnurlp/${username}`,
})
const PUBLIC = (username = USERNAME) => ({
  tag: "payRequest",
  minSendable: 1000,
  maxSendable: 1000000,
  metadata: JSON.stringify([
    ["text/plain", "test"],
    ["text/identifier", `${username}@conduit.cash`],
  ]),
  callback: `https://conduit.cash/lnurlp/${username}/invoice`,
  allowsNostr: true,
  nostrPubkey: "ab".repeat(32),
})
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

async function fixture() {
  const native = new DefaultSparkSigner()
  await native.createSparkWalletFromSeed(mnemonicToSeedSync(MNEMONIC), 1)
  const identity = bytesToHex(await native.getIdentityPublicKey())
  let active = true
  let registered: string | null = null
  let generatorCalls = 0
  const calls: string[] = []
  const checkpoints = new Map<string, BreezAddressCheckpoint>()
  let override:
    | ((
        operation: string,
        fields: Record<string, unknown>
      ) => Promise<Response | null>)
    | null = null
  const signer: BreezAddressSigner = {
    assertActive() {
      if (!active) throw new Error("locked")
    },
    getIdentityPublicKey: async () => identity,
    signDigest: (digest) => native.signMessageWithIdentityKey(digest),
  }
  const fetcher: BreezAddressFetch = async (input, init) => {
    const url = new URL(String(input))
    const operation = url.pathname.includes(".well-known")
      ? "public"
      : url.pathname.endsWith("/recover")
        ? "recover"
        : url.pathname.endsWith("/available")
          ? "available"
          : "register"
    calls.push(operation)
    if (operation === "public") {
      const custom = await override?.(operation, {})
      return custom ?? response(PUBLIC(registered!))
    }
    expect(url.hostname).toBe("conduit.cash")
    expect(url.pathname).toContain(identity)
    const body = JSON.parse(String(init?.body))
    const message = breezAddressMessage({
      operation: operation as "register" | "recover" | "available",
      domain: "conduit.cash",
      identity,
      timestamp: body.timestamp,
      username: body.username,
      description: body.description,
    })
    expect(
      secp256k1.verify(
        hexToBytes(body.signature),
        sha256(new TextEncoder().encode(message)),
        hexToBytes(identity),
        { prehash: false, format: "der" }
      )
    ).toBe(true)
    expect(JSON.stringify(body)).not.toContain(MNEMONIC)
    const custom = await override?.(operation, body)
    if (custom) return custom
    if (operation === "recover")
      return registered
        ? response(RECOVERED(registered))
        : response("user not found", 404)
    if (operation === "available") return response({ available: true })
    registered = body.username
    return response({
      lightning_address: `${registered}@conduit.cash`,
      lnurl: `lnurlp://conduit.cash/lnurlp/${registered}`,
    })
  }
  const store = {
    async read(scope: string) {
      return checkpoints.get(scope) ?? null
    },
    async write(scope: string, checkpoint: BreezAddressCheckpoint | null) {
      if (checkpoint) checkpoints.set(scope, checkpoint)
      else checkpoints.delete(scope)
    },
  }
  const client = () =>
    new BreezLightningAddressClient({
      domain: "conduit.cash",
      apiKey: "test-client-key",
      signer,
      store,
      fetch: fetcher,
      now: () => FIXED_TIME,
      generateUsername: () => {
        generatorCalls++
        return `wallet-${String(generatorCalls).padStart(20, "0")}`
      },
      runExclusive: async (_scope, run) => run(),
    })
  return {
    client,
    calls,
    checkpoints,
    fetcher,
    signer,
    native,
    identity,
    setRegistered: (name: string | null) => {
      registered = name
    },
    setOverride: (value: typeof override) => {
      override = value
    },
    lock: () => {
      active = false
    },
    generatorCalls: () => generatorCalls,
  }
}

describe("Breez address lifecycle on the existing first-party Spark identity", () => {
  it("registers the chosen available name on the existing identity", async () => {
    const f = await fixture()
    expect(await f.client().ensure(" Alice ")).toMatchObject({
      status: "registered",
      address: "alice@conduit.cash",
    })
  })
  it("a taken chosen name never silently falls back to a generated name", async () => {
    const f = await fixture()
    f.setOverride(async (operation) =>
      operation === "available" ? response({ available: false }) : null
    )
    expect(await f.client().ensure("alice")).toEqual({
      status: "unavailable",
      reason: "name_unavailable",
    })
    expect(f.calls.includes("register")).toBe(false)
  })
  it("a new name cannot replace an earlier ambiguous submission", async () => {
    const f = await fixture()
    f.setOverride(async (operation) => {
      if (operation === "register") throw new Error("lost response")
      return null
    })
    expect(await f.client().ensure("alice")).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    const before = f.calls.filter((c) => c === "register").length
    expect(await f.client().ensure("bob")).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    expect(f.calls.filter((c) => c === "register").length).toBe(before)
  })
  it("choosing a name preserves an already owned protected registration", async () => {
    const f = await fixture()
    f.setRegistered("support")
    expect(await f.client().ensure("alice")).toMatchObject({
      status: "registered",
      address: "support@conduit.cash",
    })
    expect(f.calls.includes("register")).toBe(false)
  })
  it("matches independently executed Breez SDK 0.26.1 identity vectors without opening a wallet", async () => {
    const vectors = [
      {
        network: "MAINNET",
        account: 1,
        identity:
          "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5",
      },
      {
        network: "MAINNET",
        account: 7,
        identity:
          "0248178c61b5bdd866d4b5affac3a4bc9d2e0e3e20c66bb2a919501bfac659b60f",
      },
      {
        network: "REGTEST",
        account: 0,
        identity:
          "02698b27ac308b275671b3ca25436346469d04a5bba578ae39feba1d65897a6abc",
      },
    ] as const
    for (const vector of vectors) {
      expect(
        await deriveViewerIdentityPublicKey(
          { network: vector.network },
          MNEMONIC,
          vector.account
        )
      ).toBe(vector.identity)
    }
  })
  it("uses Breez's independently defined canonical register message", () => {
    expect(
      breezAddressMessage({
        operation: "register",
        domain: "lnurl.example.com",
        username: "alice",
        description: "Pay to alice",
        identity: "unused",
        timestamp: 1700000000,
      })
    ).toBe(
      "breez-lnurl:v2\nregister\nlnurl.example.com\nalice\n0261d8b11c7eba9f71ccf5180df58416d3b2d19ba917caf57ba4bacead3ce2c2\n1700000000"
    )
  })
  it("normalizes the LUD-16/provider intersection and rejects unsafe/protected names", () => {
    expect(normalizeBreezUsername(" Alice.Name-1 ")).toBe("alice.name-1")
    for (const name of [
      "admin",
      "a..b",
      ".alice",
      "alice.",
      "alice+tag",
      "alice@other",
      "\n",
      "éclair",
      "a".repeat(65),
    ])
      expect(normalizeBreezUsername(name)).toBeNull()
    expect(
      new Set(Array.from({ length: 100 }, () => generateBreezUsername())).size
    ).toBe(100)
  })
  it("generates the same initial name for the same identity/domain across devices", () => {
    expect(generateBreezUsername("public-identity-scope", 1)).toBe(
      generateBreezUsername("public-identity-scope", 1)
    )
    expect(generateBreezUsername("public-identity-scope", 1)).not.toBe(
      generateBreezUsername("public-identity-scope", 2)
    )
  })
  it("registers only after authenticated absence; read-back and public verification remain separate from offline settlement", async () => {
    const f = await fixture()
    const result = await f.client().ensure()
    expect(result.status).toBe("registered")
    expect(result).toMatchObject({
      publicLookup: "verified",
      zapAdvertised: true,
      receiveEvidence: "unverified",
    })
    expect(f.calls).toEqual([
      "recover",
      "available",
      "recover",
      "register",
      "recover",
      "public",
    ])
    expect(f.generatorCalls()).toBe(1)
  })
  it("restores an existing address without generating or registering another name", async () => {
    const f = await fixture()
    f.setRegistered(USERNAME)
    expect(await f.client().ensure()).toMatchObject({
      status: "registered",
      address: `${USERNAME}@conduit.cash`,
    })
    expect(f.calls).toEqual(["recover", "public"])
    expect(f.generatorCalls()).toBe(0)
  })
  it.each(["a", "ab", "support", "_"])(
    "recovers the existing provider-owned name %s without applying new-name policy",
    async (username) => {
      const f = await fixture()
      f.setRegistered(username)
      expect(normalizeBreezUsername(username)).toBeNull()
      for (const result of [
        await f.client().lookup(),
        await f.client().ensure(),
      ])
        expect(result).toMatchObject({
          status: "registered",
          username,
          address: `${username}@conduit.cash`,
          publicLookup: "verified",
        })
      expect(f.calls).toEqual(["recover", "public", "recover", "public"])
      expect(f.generatorCalls()).toBe(0)
    }
  )
  it("read-only lookup never registers on a fresh restore", async () => {
    const f = await fixture()
    expect(await f.client().lookup()).toEqual({ status: "absent" })
    expect(f.calls).toEqual(["recover"])
  })
  it("bounded availability collisions exhaust five candidates", async () => {
    const f = await fixture()
    f.setOverride(async (op) =>
      op === "available" ? response({ available: false }) : null
    )
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "names_exhausted",
    })
    expect(f.calls.filter((x) => x === "available")).toHaveLength(5)
    expect(f.calls).not.toContain("register")
  })
  it("resolves registration collision using the same identity and a bounded new name", async () => {
    const f = await fixture()
    let first = true
    f.setOverride(async (op) => {
      if (op === "register" && first) {
        first = false
        return response("name already taken", 409)
      }
      return null
    })
    expect(await f.client().ensure()).toMatchObject({
      status: "registered",
      username: "wallet-00000000000000000002",
    })
    expect(f.calls.filter((x) => x === "register")).toHaveLength(2)
  })
  it("recovers success after a lost registration response without renaming", async () => {
    const f = await fixture()
    f.setOverride(async (op, fields) => {
      if (op === "register") {
        f.setRegistered(fields.username as string)
        throw new Error("timeout")
      }
      return null
    })
    expect(await f.client().ensure()).toMatchObject({ status: "registered" })
    expect(f.calls.filter((x) => x === "register")).toHaveLength(1)
  })
  it("persists an ambiguous candidate across restart and does not advance it", async () => {
    const f = await fixture()
    let failed = true
    f.setOverride(async (op) => {
      if (op === "register" && failed) throw new Error("timeout")
      return null
    })
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    const first = [...f.checkpoints.values()][0].username
    failed = false
    expect(await f.client().ensure()).toMatchObject({
      status: "registered",
      username: first,
    })
    expect(f.generatorCalls()).toBe(1)
  })
  it("does not rotate an ambiguous candidate after a retry conflict without recovered ownership", async () => {
    const f = await fixture()
    let retries = 0
    f.setOverride(async (operation) => {
      if (operation !== "register") return null
      retries++
      if (retries === 1) throw new Error("response lost")
      return response("name already taken", 409)
    })
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    expect(f.generatorCalls()).toBe(1)
    expect([...f.checkpoints.values()]).toMatchObject([
      { attempts: 1, phase: "registering" },
    ])
  })
  it.each([400, 401, 403, 404, 405, 422, 429])(
    "resets a fresh registration rejected with %d even when recovery is unavailable",
    async (status) => {
      const f = await fixture()
      let rejected = false
      f.setOverride(async (operation) => {
        if (operation === "register") {
          rejected = true
          return response("rejected", status)
        }
        return rejected && operation === "recover"
          ? response("unavailable", 503)
          : null
      })
      expect(await f.client().ensure()).toEqual({
        status: "unavailable",
        reason: "provider_unavailable",
      })
      expect([...f.checkpoints.values()]).toMatchObject([
        { attempts: 1, phase: "selected" },
      ])
      const first = [...f.checkpoints.values()][0].username
      f.setOverride(async (operation, fields) =>
        operation === "available" && fields.username === first
          ? response({ available: false })
          : null
      )
      expect(await f.client().ensure()).toMatchObject({
        status: "registered",
        username: "wallet-00000000000000000002",
      })
      expect(f.calls.filter((x) => x === "register")).toHaveLength(2)
    }
  )
  it("resets a fresh registration that fails signing before submission", async () => {
    const f = await fixture()
    let signatures = 0
    f.signer.signDigest = async (digest) => {
      if (++signatures === 4) throw new Error("signing unavailable")
      return f.native.signMessageWithIdentityKey(digest)
    }
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "provider_unavailable",
    })
    expect(f.calls).not.toContain("register")
    expect([...f.checkpoints.values()]).toMatchObject([
      { attempts: 1, phase: "selected" },
    ])
    const first = [...f.checkpoints.values()][0].username
    f.setOverride(async (operation, fields) =>
      operation === "available" && fields.username === first
        ? response({ available: false })
        : null
    )
    expect(await f.client().ensure()).toMatchObject({
      status: "registered",
      username: "wallet-00000000000000000002",
    })
    expect(f.calls.filter((x) => x === "register")).toHaveLength(1)
  })
  it("preserves an earlier ambiguous submission after a definite retry rejection", async () => {
    const f = await fixture()
    let submissions = 0
    f.setOverride(async (operation) => {
      if (operation !== "register") return null
      if (++submissions === 1) throw new Error("response lost")
      return response("rejected", 401)
    })
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "invalid_api_key",
    })
    expect([...f.checkpoints.values()]).toMatchObject([
      { attempts: 1, phase: "registering" },
    ])
    f.setOverride(async (operation) =>
      operation === "available" ? response({ available: false }) : null
    )
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "registration_pending",
    })
    expect(f.generatorCalls()).toBe(1)
  })
  it.each(["server_error", "malformed_success", "unknown_conflict"])(
    "preserves an uncertain registration after %s",
    async (outcome) => {
      const f = await fixture()
      f.setOverride(async (operation) => {
        if (operation !== "register") return null
        if (outcome === "server_error") return response("unavailable", 503)
        if (outcome === "unknown_conflict")
          return response("statement already used", 409)
        return new Response("malformed", { status: 200 })
      })
      expect(await f.client().ensure()).toMatchObject({ status: "unavailable" })
      expect([...f.checkpoints.values()]).toMatchObject([
        { attempts: 1, phase: "registering" },
      ])
      f.setOverride(async (operation) =>
        operation === "available" ? response({ available: false }) : null
      )
      expect(await f.client().ensure()).toEqual({
        status: "unavailable",
        reason: "registration_pending",
      })
      expect(f.generatorCalls()).toBe(1)
      expect(f.calls.filter((x) => x === "register")).toHaveLength(1)
    }
  )
  it("never interprets unenabled-domain 404 as address absence", async () => {
    const f = await fixture()
    f.setOverride(async () => response("", 404))
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "domain_unavailable",
    })
    expect(f.calls).toEqual(["recover"])
  })
  it("keeps outage distinct from absence and does not register", async () => {
    const f = await fixture()
    f.setOverride(async () => response("outage", 503))
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "provider_unavailable",
    })
    expect(f.calls).toEqual(["recover"])
  })
  it("classifies invalid API keys without leaking provider bodies or credentials", async () => {
    const f = await fixture()
    f.setOverride(
      async () => new Response("sensitive-provider-body", { status: 401 })
    )
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "invalid_api_key",
    })
  })
  it("refuses signing with a different identity before any request", async () => {
    const f = await fixture()
    f.signer.getIdentityPublicKey = async () => `02${"aa".repeat(32)}`
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "identity_mismatch",
    })
    expect(f.calls).toEqual([])
  })
  it("does not return an address after the wallet is locked during recovery", async () => {
    const f = await fixture()
    f.setRegistered(USERNAME)
    f.setOverride(async (op) => {
      if (op === "recover") f.lock()
      return null
    })
    expect(await f.client().ensure()).toMatchObject({
      status: "unavailable",
      reason: "locked",
    })
    expect(f.calls).not.toContain("register")
  })
  it("keeps a recovered address pending when public LNURL fails", async () => {
    const f = await fixture()
    f.setRegistered(USERNAME)
    f.setOverride(async (op) => (op === "public" ? response("", 404) : null))
    expect(await f.client().ensure()).toMatchObject({
      status: "registered",
      publicLookup: "unavailable",
      zapAdvertised: false,
      receiveEvidence: "unverified",
    })
    expect(f.calls).not.toContain("register")
  })
  it("refuses cross-domain callback or metadata substitutions in public lookup", async () => {
    for (const update of [
      { callback: "https://other.example/invoice" },
      { metadata: "[]" },
      { maxSendable: -1 },
      { callback: `https://user@conduit.cash/lnurlp/${USERNAME}/invoice` },
    ]) {
      expect(
        await verifyBreezPublicLookup(USERNAME, async () =>
          response({ ...PUBLIC(), ...update })
        )
      ).toEqual({ status: "unavailable", zapAdvertised: false })
    }
  })
  it("preserves recovered ownership when checkpoint storage is unavailable", async () => {
    const f = await fixture()
    f.setRegistered(USERNAME)
    const client = new BreezLightningAddressClient({
      domain: "conduit.cash",
      apiKey: "test-client-key",
      signer: f.signer,
      fetch: f.fetcher,
      now: () => FIXED_TIME,
      runExclusive: async (_scope, operation) => operation(),
      store: {
        async read() {
          throw new Error("unavailable")
        },
        async write() {
          throw new Error("unavailable")
        },
      },
    })
    expect(await client.ensure()).toMatchObject({
      status: "registered",
      address: `${USERNAME}@conduit.cash`,
    })
    f.setRegistered(null)
    expect(await client.ensure()).toEqual({
      status: "unavailable",
      reason: "storage_unavailable",
    })
    expect(f.calls).not.toContain("register")
  })
  it("never registers after malformed recovered ownership", async () => {
    const f = await fixture()
    f.setOverride(async (operation) =>
      operation === "recover"
        ? response({ ...RECOVERED(), lightning_address: "other@conduit.cash" })
        : null
    )
    expect(await f.client().ensure()).toEqual({
      status: "unavailable",
      reason: "invalid_response",
    })
    expect(f.calls).toEqual(["recover"])
  })
  it("keeps disabled builds unavailable even with provider configuration", () => {
    for (const enabled of [undefined, false])
      expect(
        getBreezAddressConfiguration({
          enabled,
          network: "mainnet",
          domain: "conduit.cash",
          apiKey: "public-test-key",
        })
      ).toEqual({ status: "unavailable", reason: "unconfigured" })
  })
  it("keeps addresses unavailable until configured with the approved domain/client key", () => {
    expect(getBreezAddressConfiguration({ network: "mainnet" })).toEqual({
      status: "unavailable",
      reason: "unconfigured",
    })
    expect(
      getBreezAddressConfiguration({
        enabled: true,
        network: "mainnet",
        domain: "conduit.cash",
        apiKey: "test",
      }).status
    ).toBe("configured")
    expect(
      getBreezAddressConfiguration({
        enabled: true,
        network: "regtest",
        domain: "conduit.cash",
        apiKey: "test",
      })
    ).toEqual({ status: "unavailable", reason: "unsupported_network" })
    expect(
      getBreezAddressConfiguration({
        enabled: true,
        network: "mainnet",
        domain: "other.example",
        apiKey: "test",
      })
    ).toEqual({ status: "unavailable", reason: "invalid_configuration" })
  })
})
