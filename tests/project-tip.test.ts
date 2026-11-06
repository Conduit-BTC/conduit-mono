import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { createHash } from "node:crypto"

import {
  PROJECT_TIP_LIGHTNING_ADDRESS,
  PROJECT_TIP_LNURL,
  PROJECT_TIP_MESSAGE,
  PROJECT_TIP_PAY_REQUEST_URL,
  PROJECT_TIP_RECIPIENT_PUBKEY,
  assertProjectTipSignature,
  buildProjectTipRequest,
  validateProjectTipAmount,
  validateProjectTipMetadata,
} from "@conduit/core/protocol/project-tip"
import type { LnurlPayMetadata } from "@conduit/core"
import { isLightningPaymentPreimageForInvoice } from "@conduit/core"
import { encodeLnurl } from "@conduit/core/protocol/lightning"
import { bolt11PaymentHashField } from "./support/bolt11-fixture"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"
const SECRET = generateSecretKey()
const SENDER = getPublicKey(SECRET)
const METADATA: LnurlPayMetadata = {
  payRequestUrl: PROJECT_TIP_PAY_REQUEST_URL,
  lnurl: encodeLnurl(PROJECT_TIP_PAY_REQUEST_URL),
  callback: "https://conduit.cash/lnurlp/receiver/invoice",
  minSendable: 100_000,
  maxSendable: 100_000_000,
  tag: "payRequest",
  allowsNostr: true,
  nostrPubkey: getPublicKey(generateSecretKey()),
  metadata: "[]",
}

describe("project tip contract", () => {
  it("keeps the signer-only LNURL constant tied to the fixed address", () => {
    expect(PROJECT_TIP_LIGHTNING_ADDRESS).toBe("receiver@conduit.cash")
    expect(PROJECT_TIP_PAY_REQUEST_URL).toBe(
      "https://conduit.cash/.well-known/lnurlp/receiver"
    )
    expect(PROJECT_TIP_LNURL).toBe(encodeLnurl(PROJECT_TIP_PAY_REQUEST_URL))
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
