import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  PROJECT_TIP_LIGHTNING_ADDRESS,
  PROJECT_TIP_LNURL,
  PROJECT_TIP_MESSAGE,
  PROJECT_TIP_PAY_REQUEST_URL,
  PROJECT_TIP_RECIPIENT_PUBKEY,
  assertProjectTipSignature,
  buildProjectTipRequest,
  isAuthorizedProjectTipDraft,
  validateProjectTipAmount,
  validateProjectTipMetadata,
} from "@conduit/core/protocol/project-tip"
import type { LnurlPayMetadata } from "@conduit/core"
import {
  fetchLnurlPayMetadata,
  isLightningPaymentPreimageForInvoice,
} from "@conduit/core"
import { encodeLnurl } from "@conduit/core/protocol/lightning"
import type { AnonZapRequestDraft } from "@conduit/core/protocol/anon-zap"
import type { ProjectTipSigningAuthorization } from "@conduit/core/protocol/project-tip"
import {
  handleAnonZapSignerRequest,
  type AnonZapSignerEnv,
} from "../apps/anon-zap-signer/src/signer"
import { bolt11PaymentHashField } from "./support/bolt11-fixture"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"
import {
  signAnonymousProjectTipRequest,
  type AnonZapPagesEnv,
} from "../apps/market/functions/_lib/anon-zap-checkout-auth"

const SECRET = generateSecretKey()
const SENDER = getPublicKey(SECRET)
const METADATA: LnurlPayMetadata = {
  payRequestUrl: PROJECT_TIP_PAY_REQUEST_URL,
  lnurl: encodeLnurl(PROJECT_TIP_PAY_REQUEST_URL),
  callback: "https://strike.me/api/lnurl/callback",
  minSendable: 100_000,
  maxSendable: 100_000_000,
  tag: "payRequest",
  allowsNostr: true,
  nostrPubkey: getPublicKey(generateSecretKey()),
  metadata: "[]",
}

describe("project tip contract", () => {
  it("keeps the signer-only LNURL constant tied to the fixed address", () => {
    expect(PROJECT_TIP_LNURL).toBe(encodeLnurl(PROJECT_TIP_PAY_REQUEST_URL))
  })

  it("keeps relay receipt observation out of the shared UI component", () => {
    const component = readFileSync(
      new URL("../packages/ui/src/components/ProjectTip.tsx", import.meta.url),
      "utf8"
    )
    expect(component).not.toContain("waitForZapReceipt")
    expect(component).not.toContain("PROJECT_TIP_RECIPIENT_PUBKEY")
    expect(component).toContain("onReceiptWatchChange")
  })

  it("requires wallet proof for the exact invoice before thanking", () => {
    const preimage = "ab".repeat(32)
    const paymentHash = createHash("sha256")
      .update(Buffer.from(preimage, "hex"))
      .digest()
    const invoice = makeSignedBolt11Fixture({
      fields: [bolt11PaymentHashField(paymentHash)],
    })
    expect(isLightningPaymentPreimageForInvoice(invoice, preimage)).toBe(true)
    expect(isLightningPaymentPreimageForInvoice(invoice, "cd".repeat(32))).toBe(
      false
    )
    expect(isLightningPaymentPreimageForInvoice(invoice, "invalid")).toBe(false)
  })

  it("enforces whole-sat minimum and provider range", () => {
    expect(validateProjectTipAmount(100)).toBe(100_000)
    expect(() => validateProjectTipAmount(99)).toThrow()
    expect(() => validateProjectTipAmount(111.5)).toThrow()
    expect(() => validateProjectTipMetadata(METADATA, 111_000)).not.toThrow()
    expect(() =>
      validateProjectTipMetadata({ ...METADATA, allowsNostr: false }, 111_000)
    ).toThrow()
    expect(() =>
      validateProjectTipMetadata(
        { ...METADATA, nostrPubkey: "f".repeat(64) },
        111_000
      )
    ).toThrow()
    expect(() => validateProjectTipMetadata(METADATA, 100_000_001)).toThrow()
  })

  it("binds a nonempty public note to only the fixed Conduit target", () => {
    const draft = buildProjectTipRequest({
      senderPubkey: SENDER,
      amountMsats: 111_000,
      lnurl: METADATA.lnurl,
      relayUrls: ["wss://relay.conduit.market"],
      createdAt: 1_800_000_000,
    })
    expect(draft.content).toBe(PROJECT_TIP_MESSAGE)
    expect(draft.tags).toEqual([
      ["p", PROJECT_TIP_RECIPIENT_PUBKEY],
      ["amount", "111000"],
      ["lnurl", METADATA.lnurl],
      ["relays", "wss://relay.conduit.market"],
    ])
    const signed = finalizeEvent(
      {
        kind: draft.kind,
        created_at: draft.created_at,
        content: draft.content,
        tags: draft.tags,
      },
      SECRET
    )
    expect(() => assertProjectTipSignature(signed, draft)).not.toThrow()
    expect(() =>
      assertProjectTipSignature(signed, { ...draft, content: "Changed" })
    ).toThrow()
  })
})

describe("guest project tip signing", () => {
  const requestAuthSecret = randomBytes(32).toString("base64url")
  const signerEnv: AnonZapSignerEnv = {
    ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX: Buffer.from(SECRET).toString("hex"),
    ANON_CONDUIT_SHOPPER_PUBKEY: SENDER,
    ANON_SIGNER_REQUEST_AUTH_SECRET: requestAuthSecret,
    ANON_SIGNER_ALLOWED_ORIGINS: "https://shop.conduit.market",
    ANON_SIGNER_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  }
  const env: AnonZapPagesEnv = {
    ANON_SIGNER_REQUEST_AUTH_SECRET: requestAuthSecret,
    ANON_ZAP_SIGNER_URL: "https://signer.conduit.market/",
    ANON_ZAP_SIGNER_ALLOWED_HOSTS: "signer.conduit.market",
    ANON_ZAP_RATE_LIMIT_SERVICE: {
      fetch: async () => new Response(null, { status: 204 }),
    },
    ANON_ZAP_SIGNER_SERVICE: {
      fetch: (request) => handleAnonZapSignerRequest(request, signerEnv),
    },
  }
  const request = (body: Record<string, unknown>) =>
    new Request("https://shop.conduit.market/api/project-tip-sign", {
      method: "POST",
      headers: {
        origin: "https://shop.conduit.market",
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
      },
      body: JSON.stringify(body),
    })

  async function postToSigner(
    draft: AnonZapRequestDraft,
    authorization: Record<string, unknown>
  ): Promise<Response> {
    const body = JSON.stringify({ zapRequest: draft, authorization })
    const timestamp = String(Math.floor(Date.now() / 1_000))
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(requestAuthSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`${timestamp}.${body}`)
      )
    ).toString("hex")
    return handleAnonZapSignerRequest(
      new Request("https://signer.conduit.market/", {
        method: "POST",
        headers: {
          origin: "https://shop.conduit.market",
          "content-type": "application/json",
          "x-conduit-anon-signer-timestamp": timestamp,
          "x-conduit-anon-signer-signature": signature,
        },
        body,
      }),
      signerEnv
    )
  }

  it("rejects amounts below 100 sats and browser-supplied destinations", async () => {
    const dependencies = { fetchTipMetadata: async () => METADATA }
    expect(
      (
        await signAnonymousProjectTipRequest(
          request({ amountSats: 99 }),
          env,
          dependencies
        )
      ).status
    ).toBe(400)
    expect(
      (
        await signAnonymousProjectTipRequest(
          request({ amountSats: 111, recipient: SENDER }),
          env,
          dependencies
        )
      ).status
    ).toBe(400)
  })

  it("rejects project-tip scope changes at the Worker, even with valid transport auth", async () => {
    const draft: AnonZapRequestDraft = {
      kind: 9734,
      createdAt: Math.floor(Date.now() / 1_000),
      content: PROJECT_TIP_MESSAGE,
      tags: [
        ["p", PROJECT_TIP_RECIPIENT_PUBKEY],
        ["amount", "111000"],
        ["lnurl", METADATA.lnurl],
        ["relays", "wss://relay.conduit.market"],
      ],
    }
    const authorization: ProjectTipSigningAuthorization = {
      scope: "project_tip",
      requestId: randomBytes(32).toString("hex"),
      recipientPubkey: PROJECT_TIP_RECIPIENT_PUBKEY,
      amountMsats: 111_000,
      lnurl: METADATA.lnurl,
    }
    expect(isAuthorizedProjectTipDraft(draft, authorization)).toBe(true)
    const wrongRecipient = "a".repeat(64)
    const cases: Array<{
      draft: AnonZapRequestDraft
      authorization: Record<string, unknown>
    }> = [
      {
        draft: {
          ...draft,
          tags: [["p", wrongRecipient], ...draft.tags.slice(1)],
        },
        authorization,
      },
      { draft: { ...draft, content: "Changed" }, authorization },
      {
        draft: { ...draft, tags: [...draft.tags, ["e", wrongRecipient]] },
        authorization,
      },
      {
        draft: {
          ...draft,
          tags: draft.tags.map((tag) =>
            tag[0] === "amount" ? ["amount", "99000"] : tag
          ),
        },
        authorization: { ...authorization, amountMsats: 99_000 },
      },
      { draft, authorization: { ...authorization, lnurl: "lnurl1different" } },
      {
        draft,
        authorization: {
          ...authorization,
          checkoutSessionId: "checkout-session",
        },
      },
      {
        draft,
        authorization: {
          checkoutSessionId: "checkout-session",
          merchantPubkey: PROJECT_TIP_RECIPIENT_PUBKEY,
          amountMsats: 111_000,
          lnurl: METADATA.lnurl,
          publicZapPolicy: "anonymous_public_zap_allowed",
          scope: "project_tip",
        },
      },
    ]
    for (const candidate of cases) {
      const response = await postToSigner(
        candidate.draft,
        candidate.authorization
      )
      expect(response.status).toBe(400)
    }
  })

  it("uses the fixed target and existing authenticated signer binding", async () => {
    const response = await signAnonymousProjectTipRequest(
      request({ amountSats: 111 }),
      env,
      {
        fetchTipMetadata: async (address) => {
          expect(address).toBe(PROJECT_TIP_LIGHTNING_ADDRESS)
          return METADATA
        },
      }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      rawEvent: { tags: string[][]; content: string }
      amountMsats: number
    }
    expect(body.amountMsats).toBe(111_000)
    expect(body.rawEvent.content).toBe(PROJECT_TIP_MESSAGE)
    expect(body.rawEvent.tags.find((tag) => tag[0] === "p")?.[1]).toBe(
      PROJECT_TIP_RECIPIENT_PUBKEY
    )
  })

  it("resolves the fixed Lightning address with an edge-compatible no-redirect request", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.redirect !== "manual") {
        throw new TypeError(
          'invalid redirect value, must be one of "follow" or "manual"'
        )
      }
      return Response.json({
        tag: "payRequest",
        callback: METADATA.callback,
        minSendable: METADATA.minSendable,
        maxSendable: METADATA.maxSendable,
        allowsNostr: true,
        nostrPubkey: METADATA.nostrPubkey,
      })
    }
    const response = await signAnonymousProjectTipRequest(
      request({ amountSats: 111 }),
      env,
      {
        fetchTipMetadata: (address) =>
          fetchLnurlPayMetadata(address, { fetchImpl }),
      }
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { amountMsats: number }
    expect(body.amountMsats).toBe(111_000)
  })
})
