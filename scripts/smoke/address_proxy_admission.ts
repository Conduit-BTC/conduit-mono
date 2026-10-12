// Approved, unfunded provider admission test. Temporary registrations are
// cleaned up; no wallet network session is opened and no payment is made.
import { DefaultSparkSigner } from "../../apps/market/node_modules/@buildonspark/spark-sdk"
import {
  generateMnemonic,
  mnemonicToSeedSync,
} from "../../packages/core/node_modules/@scure/bip39"
import { wordlist } from "../../packages/core/node_modules/@scure/bip39/wordlists/english.js"
import { bytesToHex } from "../../packages/core/node_modules/@noble/hashes/utils.js"
import { sha256 } from "../../packages/core/node_modules/@noble/hashes/sha2.js"
import { addressRequestHash } from "../../packages/core/src/wallets/address-name-request"
import { breezAddressMessage } from "../../packages/core/src/wallets/breez-lightning-address"
import { proveProxyAdmission, type ProbeOperation } from "./address_proxy_probe"

async function run(): Promise<boolean> {
  if (process.env.ADDRESS_ADMISSION_PROBE_APPROVED !== "true") {
    console.log(
      JSON.stringify({
        check: "address-proxy-admission",
        verdict: "inconclusive",
        reason: "approval_required",
      })
    )
    return false
  }
  const key = process.env.BREEZ_DOMAIN_API_KEY,
    proxySecret = process.env.BREEZ_PROXY_SHARED_SECRET
  if (!key || !proxySecret) {
    console.log(
      JSON.stringify({
        check: "address-proxy-admission",
        verdict: "inconclusive",
        reason: "secret_bindings_required",
      })
    )
    return false
  }
  const identities = await Promise.all(
    [1, 2].map(async () => {
      const signer = new DefaultSparkSigner()
      await signer.createSparkWalletFromSeed(
        mnemonicToSeedSync(generateMnemonic(wordlist)),
        1
      )
      return {
        signer,
        identity: bytesToHex(await signer.getIdentityPublicKey()),
      }
    })
  )
  const [source, target] = identities as [
    (typeof identities)[number],
    (typeof identities)[number],
  ]
  const initialName = `qa-admission-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  const renamedName = `${initialName}-r`
  const description = "Approved unfunded admission probe"
  async function sign(
    signer: DefaultSparkSigner,
    message: string
  ): Promise<string> {
    return bytesToHex(
      await signer.signMessageWithIdentityKey(
        sha256(new TextEncoder().encode(message))
      )
    )
  }
  async function send(
    identity: string,
    method: string,
    suffix: string,
    fields: Record<string, unknown>,
    admission: "valid" | "missing" | "wrong"
  ): Promise<Response> {
    return fetch(`https://breez.tips/lnurlpay/${identity}${suffix}`, {
      method,
      headers: {
        Host: "conduit.cash",
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(admission === "missing"
          ? {}
          : {
              "X-Breez-Reverse-Proxy-Shared-Secret":
                admission === "valid" ? proxySecret! : crypto.randomUUID(),
            }),
      },
      body: JSON.stringify(fields),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
  }
  async function recover(wallet: typeof source): Promise<string | null> {
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await sign(
      wallet.signer,
      breezAddressMessage({
        operation: "recover",
        domain: "conduit.cash",
        identity: wallet.identity,
        timestamp,
      })
    )
    const result = await send(
      wallet.identity,
      "POST",
      "/recover",
      { timestamp, signature },
      "valid"
    )
    const text = await result.text()
    if (text.length > 8192) throw new Error("control_unavailable")
    const value = JSON.parse(text)
    if (result.status === 404 && value === "user not found") return null
    if (
      !result.ok ||
      value.lightning_address !== `${value.username}@conduit.cash`
    )
      throw new Error("control_unavailable")
    return value.username
  }
  async function unregister(
    wallet: typeof source,
    username: string,
    admission: "valid" | "missing" | "wrong"
  ) {
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await sign(
      wallet.signer,
      [
        "breez-lnurl:v2",
        "unregister",
        "conduit.cash",
        username,
        String(timestamp),
      ].join("\n")
    )
    return send(
      wallet.identity,
      "DELETE",
      "",
      { username, timestamp, signature },
      admission
    )
  }
  let gatewayRejectedUnapproved = false
  const proof = await proveProxyAdmission({
    async checkGateway() {
      const gatewayTimestamp = Math.floor(Date.now() / 1000)
      const gatewaySignature = await sign(
        source.signer,
        breezAddressMessage({
          operation: "register",
          domain: "conduit.cash",
          identity: source.identity,
          username: initialName,
          description,
          timestamp: gatewayTimestamp,
        })
      )
      const gateway = await fetch(
        `https://conduit.cash/lnurlpay/${source.identity}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: initialName,
            description,
            timestamp: gatewayTimestamp,
            signature: gatewaySignature,
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        }
      )

      gatewayRejectedUnapproved =
        gateway.status === 403 &&
        gateway.headers.get("X-Conduit-Address-Gateway") ===
          "approved-names-v1" &&
        (await gateway.json()) === "name not approved"
      if (gatewayRejectedUnapproved) return "rejected"
      if (gateway.ok && (await recover(source)) === initialName) return "bypass"
      return "unqualified"
    },
    async request(operation: ProbeOperation, admission) {
      const timestamp = Math.floor(Date.now() / 1000)
      let result: Response
      if (operation === "transfer") {
        const base = [
          "breez-lnurl:v2",
          "transfer-from",
          "conduit.cash",
          renamedName,
          source.identity,
          target.identity,
          String(timestamp),
        ].join("\n")
        const to = [
          "breez-lnurl:v2",
          "transfer-to",
          "conduit.cash",
          renamedName,
          source.identity,
          target.identity,
          addressRequestHash(description),
          String(timestamp),
        ].join("\n")
        result = await send(
          target.identity,
          "POST",
          "/transfer",
          {
            username: renamedName,
            description,
            from_pubkey: source.identity,
            timestamp,
            from_signature: await sign(source.signer, base),
            to_signature: await sign(target.signer, to),
          },
          admission
        )
      } else if (operation === "unregister")
        result = await unregister(target, renamedName, admission)
      else {
        const username = operation === "register" ? initialName : renamedName
        const signature = await sign(
          source.signer,
          breezAddressMessage({
            operation: "register",
            domain: "conduit.cash",
            identity: source.identity,
            username,
            description,
            timestamp,
          })
        )
        result = await send(
          source.identity,
          "POST",
          "",
          { username, description, timestamp, signature },
          admission
        )
      }
      if (admission === "valid" && result.ok) {
        const wallet =
          operation === "transfer" || operation === "unregister"
            ? target
            : source
        const expected =
          operation === "unregister"
            ? null
            : operation === "register"
              ? initialName
              : renamedName
        if ((await recover(wallet)) !== expected)
          return new Response(null, { status: 502 })
        if (operation === "transfer" && (await recover(source)) !== null)
          return new Response(null, { status: 502 })
      }
      return result
    },
    async cleanup() {
      let cleaned = true
      for (const wallet of identities) {
        try {
          const existing = await recover(wallet)
          if (existing !== null) {
            if (
              ![initialName, renamedName].includes(existing) ||
              !(await unregister(wallet, existing, "valid")).ok ||
              (await recover(wallet)) !== null
            )
              cleaned = false
          }
        } catch {
          cleaned = false
        }
      }
      return cleaned
    },
  })
  // Fixed categories only: no addresses, identities, bodies or admissions.
  console.log(
    JSON.stringify({
      check: "address-proxy-admission",
      gatewayRejectedUnapproved,
      ...proof,
    })
  )
  return proof.verdict === "bypass_rejected" && proof.cleanupSucceeded
}
if (import.meta.main) {
  try {
    if (!(await run())) process.exitCode = 1
  } catch {
    console.error(
      "Address admission probe is inconclusive. Activation remains blocked."
    )
    process.exitCode = 1
  }
}
