import { describe, expect, test } from "bun:test"
import {
  commerceMessageSearchText,
  commerceReplyCounterparty,
  decodeCommerceMessageRumor,
  encodeOpenMarketsCommerceMessage,
  type CommerceRumor,
  type OpenMarketsCommerceInput,
} from "../packages/core/src/protocol/commerce-message-codec"
import {
  buildPrivateFileRumor,
  decryptPrivateFileBytes,
  downloadAndDecryptPrivateFile,
  encryptPrivateFileBytes,
  MAX_PRIVATE_FILE_BYTES,
} from "../packages/core/src/protocol/private-file-message"

function rumor(input: {
  kind: number
  tags?: string[][]
  content?: string
}): CommerceRumor {
  return {
    id: "rumor-id",
    pubkey: "buyer",
    created_at: 100,
    kind: input.kind,
    tags: input.tags ?? [],
    content: input.content ?? "",
  }
}

describe("current Open Markets private commerce grammar", () => {
  const cases: OpenMarketsCommerceInput[] = [
    {
      type: "order",
      recipientPubkey: "merchant",
      orderId: "order-1",
      subject: "Order",
      amountSats: "200",
      items: [{ coordinate: "30402:merchant:book", quantity: "2" }],
      shippingCoordinate: "30406:merchant:post",
      notes: "Please wrap it",
    },
    {
      type: "payment_request",
      recipientPubkey: "buyer",
      orderId: "order-1",
      subject: "Payment",
      amountSats: "200",
      paymentOptions: [{ medium: "lightning", reference: "synthetic-invoice" }],
      expiration: "1000",
    },
    {
      type: "status_update",
      recipientPubkey: "buyer",
      orderId: "order-1",
      subject: "Status",
      status: "confirmed",
    },
    {
      type: "shipping_update",
      recipientPubkey: "buyer",
      orderId: "order-1",
      subject: "Shipping",
      status: "shipped",
      carrier: "Example",
      tracking: "TRACK-1",
      eta: "1000",
    },
    {
      type: "payment_receipt",
      recipientPubkey: "merchant",
      orderId: "order-1",
      subject: "Receipt",
      amountSats: "200",
      paymentProofs: [
        {
          medium: "lightning",
          reference: "synthetic-invoice",
          proof: "synthetic-proof",
        },
      ],
    },
  ]

  for (const input of cases) {
    test(`${input.type} has one verified wire representation and round trips`, () => {
      const wire = encodeOpenMarketsCommerceMessage(input)
      const decoded = decodeCommerceMessageRumor(rumor(wire))
      expect(decoded.category).toBe("commerce")
      if (decoded.category !== "commerce") throw new Error("Expected commerce")
      expect(decoded.protocol).toBe("open_markets")
      expect(decoded.status).toBe("supported")
      expect(decoded.fields.orderId).toBe(input.orderId)
      expect(decoded.fields.messageType).toBe(input.type)
      expect(decoded.parsedOrderMessage).toBeUndefined()
      expect(wire.tags.filter((tag) => tag[0] === "type")).toHaveLength(
        input.type === "payment_receipt" ? 0 : 1
      )
      expect(wire.content).toBe(input.notes ?? "")
    })
  }

  test("missing or malformed required tags remain visible without fabricated values", () => {
    const decoded = decodeCommerceMessageRumor(
      rumor({
        kind: 16,
        tags: [
          ["p", "merchant"],
          ["type", "1"],
          ["order", "order-1"],
        ],
      })
    )
    expect(decoded.category).toBe("commerce")
    if (decoded.category !== "commerce") return
    expect(decoded.status).toBe("malformed")
    expect(decoded.fields.amountSats).toBeUndefined()
    expect(decoded.fields.items).toEqual([])
    expect(commerceMessageSearchText(decoded)).toContain("order-1")
    expect(decoded.provenance.tags).toEqual([
      ["p", "merchant"],
      ["type", "1"],
      ["order", "order-1"],
    ])
  })

  test("unsupported numeric and named kinds are retained for display", () => {
    for (const type of ["7", "future_conduit_type"]) {
      const decoded = decodeCommerceMessageRumor(
        rumor({
          kind: 16,
          tags: [
            ["p", "merchant"],
            ["type", type],
            ["order", "order-1"],
          ],
        })
      )
      expect(decoded.category).toBe("commerce")
      if (decoded.category === "commerce")
        expect(decoded.status).toBe("unsupported")
    }
  })

  test("unrecognized Open Markets version remains visible without action authority", () => {
    const wire = encodeOpenMarketsCommerceMessage({
      type: "status_update",
      recipientPubkey: "buyer",
      orderId: "order-1",
      subject: "Status",
      status: "confirmed",
    })
    wire.tags.push(["version", "2"])
    const decoded = decodeCommerceMessageRumor(rumor(wire))
    expect(decoded.category).toBe("commerce")
    if (decoded.category === "commerce") {
      expect(decoded.status).toBe("unsupported")
      expect(decoded.parsedOrderMessage).toBeUndefined()
    }
  })

  test("payment references are searchable locally while proof material stays out of search", () => {
    const wire = encodeOpenMarketsCommerceMessage({
      type: "payment_receipt",
      recipientPubkey: "merchant",
      orderId: "order-1",
      subject: "Receipt",
      amountSats: "200",
      paymentProofs: [
        {
          medium: "lightning",
          reference: "invoice-token",
          proof: "proof-token",
        },
      ],
      notes: "private-confirmation-token",
    })
    const decoded = decodeCommerceMessageRumor(rumor(wire))
    expect(decoded.category).toBe("commerce")
    const search = commerceMessageSearchText(decoded)
    expect(search).toContain("order-1")
    expect(search).toContain("invoice-token")
    expect(search).not.toContain("proof-token")
    expect(search).not.toContain("private-confirmation-token")
  })

  test("NIP-18 generic repost collision is unrelated", () => {
    const decoded = decodeCommerceMessageRumor(
      rumor({
        kind: 16,
        tags: [
          ["e", "source"],
          ["p", "author"],
          ["k", "1"],
        ],
        content: "{}",
      })
    )
    expect(decoded.category).toBe("unrelated")
  })

  test("Spark machine records never reach searchable fallback", () => {
    for (const input of [
      {
        kind: 16,
        tags: [
          ["type", "checkout_spark_recovery"],
          ["order", "order-1"],
        ],
        content: "secret",
      },
      {
        kind: 16,
        tags: [["order", "order-1"]],
        content: '{"type":"checkout_spark_recovery","wallet":"secret"}',
      },
    ]) {
      const decoded = decodeCommerceMessageRumor(rumor(input))
      expect(decoded.category).toBe("machine")
      expect(commerceMessageSearchText(decoded)).toBe("")
    }
  })

  test("validated Conduit status remains the only order-action payload", () => {
    const decoded = decodeCommerceMessageRumor(
      rumor({
        kind: 16,
        tags: [
          ["p", "buyer"],
          ["type", "status_update"],
          ["order", "order-1"],
          ["status", "processing"],
        ],
        content: '{"status":"processing"}',
      })
    )
    expect(decoded.category).toBe("commerce")
    if (decoded.category !== "commerce") return
    expect(decoded.protocol).toBe("conduit")
    expect(decoded.status).toBe("supported")
    expect(decoded.parsedOrderMessage?.type).toBe("status_update")
  })

  test("kind-14 participants and reply parent are preserved", () => {
    const decoded = decodeCommerceMessageRumor(
      rumor({
        kind: 14,
        tags: [
          ["p", "merchant"],
          ["p", "helper"],
          ["e", "parent"],
        ],
        content: "Hello",
      })
    )
    expect(decoded.category).toBe("direct")
    if (decoded.category === "direct") {
      expect(decoded.participants).toEqual(["buyer", "helper", "merchant"])
      expect(decoded.replyTo).toBe("parent")
    }
  })
})

test("kind-15 AES-GCM bytes verify both hashes and require explicit download", async () => {
  const plaintext = new TextEncoder().encode("synthetic private attachment")
  const { ciphertext, envelope } = await encryptPrivateFileBytes(plaintext)
  const fileRumor = buildPrivateFileRumor({
    recipientPubkeys: ["merchant"],
    url: "https://example.invalid/file",
    mimeType: "text/plain",
    envelope,
    replyTo: "parent",
  })
  const decoded = decodeCommerceMessageRumor(rumor(fileRumor))
  expect(decoded.category).toBe("file")
  if (decoded.category === "file") {
    expect(decoded.encryptedSha256).toBe(envelope.encryptedSha256)
    expect(decoded.replyTo).toBe("parent")
  }
  expect(
    new TextDecoder().decode(
      await decryptPrivateFileBytes(ciphertext, envelope)
    )
  ).toBe("synthetic private attachment")
  const tampered = new Uint8Array(ciphertext)
  tampered[0]! ^= 1
  expect(decryptPrivateFileBytes(tampered, envelope)).rejects.toThrow()
  expect(
    decryptPrivateFileBytes(ciphertext, {
      ...envelope,
      originalSha256: "0".repeat(64),
    })
  ).rejects.toThrow()
  let requests = 0
  const result = await downloadAndDecryptPrivateFile(
    "https://example.invalid/file",
    envelope,
    async () => {
      requests += 1
      return new Response(ciphertext)
    }
  )
  expect(requests).toBe(1)
  expect(result).toEqual(plaintext)
  expect(
    downloadAndDecryptPrivateFile(
      "https://example.invalid/file",
      { ...envelope, encryptedSize: ciphertext.byteLength - 1 },
      async () => {
        requests += 1
        return new Response(ciphertext)
      }
    )
  ).rejects.toThrow()
})

test("kind-15 reads optional size and original hash without weakening ciphertext integrity", async () => {
  const plaintext = new TextEncoder().encode(
    "synthetic interoperable attachment"
  )
  const { ciphertext, envelope } = await encryptPrivateFileBytes(plaintext)
  const minimal = {
    algorithm: envelope.algorithm,
    key: envelope.key,
    nonce: envelope.nonce,
    encryptedSha256: envelope.encryptedSha256,
  }
  expect(await decryptPrivateFileBytes(ciphertext, minimal)).toEqual(plaintext)
  expect(
    await downloadAndDecryptPrivateFile(
      "https://example.invalid/file",
      minimal,
      async () => new Response(ciphertext)
    )
  ).toEqual(plaintext)
  const tampered = new Uint8Array(ciphertext)
  tampered[0]! ^= 1
  await expect(decryptPrivateFileBytes(tampered, minimal)).rejects.toThrow(
    "hash mismatch"
  )
  await expect(
    downloadAndDecryptPrivateFile(
      "https://example.invalid/file",
      minimal,
      async () => new Response(new Uint8Array(8 * 1024 * 1024 + 17))
    )
  ).rejects.toThrow("supported size")
})

describe("two-party reply and attachment boundaries", () => {
  const principal = "a".repeat(64)
  const peer = "b".repeat(64)
  const extra = "c".repeat(64)
  const provenance = (authorPubkey: string, recipients: string[]) => ({
    authorPubkey,
    rumorId: "synthetic",
    rumorKind: 16,
    tags: recipients.map((recipient) => ["p", recipient]),
  })
  test("inbound replies stay with the author while sent records resolve one recipient", () => {
    expect(
      commerceReplyCounterparty(principal, provenance(peer, [principal, extra]))
    ).toBe(peer)
    expect(
      commerceReplyCounterparty(principal, provenance(principal, [peer]))
    ).toBe(peer)
    expect(() =>
      commerceReplyCounterparty(principal, provenance(principal, [peer, extra]))
    ).toThrow()
    expect(() =>
      commerceReplyCounterparty(principal, provenance(peer, [extra]))
    ).toThrow()
  })
  test("ordinary text sends reject a participant fanout", async () => {
    const { createParticipantMessageRumor } =
      await import("../packages/core/src/protocol/messaging")
    expect(() =>
      createParticipantMessageRumor({
        senderPubkey: principal,
        recipientPubkeys: [peer, extra],
        content: "synthetic",
        appId: "market",
      })
    ).toThrow()
  })
  test("oversized files fail before allocating their bytes", async () => {
    const { sendPrivateAttachment } =
      await import("../packages/core/src/protocol/private-file-upload")
    let reads = 0
    const file = new File(["synthetic"], "oversized.txt")
    Object.defineProperty(file, "size", { value: MAX_PRIVATE_FILE_BYTES + 1 })
    file.arrayBuffer = async () => {
      reads++
      throw new Error("must not read")
    }
    await expect(
      sendPrivateAttachment(principal, [peer], file)
    ).rejects.toThrow("supported size")
    expect(reads).toBe(0)
  })
  test("unapproved attachment fanout fails before reading or uploading", async () => {
    const { sendPrivateAttachment } =
      await import("../packages/core/src/protocol/private-file-upload")
    let reads = 0
    const file = new File(["x"], "bounded.txt")
    file.arrayBuffer = async () => {
      reads++
      throw new Error("must not read")
    }
    await expect(
      sendPrivateAttachment(principal, [peer, extra], file)
    ).rejects.toThrow("explicit counterparty")
    expect(reads).toBe(0)
  })
})
