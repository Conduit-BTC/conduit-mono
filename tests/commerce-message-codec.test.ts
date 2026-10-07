import { describe, expect, test } from "bun:test"
import {
  commerceMessageSearchText,
  commerceReplyCounterparty,
  decodeCommerceMessageRumor,
  type CommerceFields,
  type CommerceRumor,
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
  const cases: Array<{
    wire: Pick<CommerceRumor, "kind" | "tags" | "content">
    fields: Partial<CommerceFields>
  }> = [
    {
      wire: {
        kind: 16,
        tags: [
          ["p", "merchant"],
          ["subject", "Order"],
          ["type", "1"],
          ["order", "order-1"],
          ["amount", "200"],
          ["item", "30402:merchant:book", "2"],
          ["shipping", "30406:merchant:post"],
        ],
        content: "Please wrap it",
      },
      fields: {
        messageType: "order",
        amountSats: "200",
        items: [{ coordinate: "30402:merchant:book", quantity: "2" }],
        shippingCoordinate: "30406:merchant:post",
      },
    },
    {
      wire: {
        kind: 16,
        tags: [
          ["p", "buyer"],
          ["subject", "Payment"],
          ["type", "2"],
          ["order", "order-1"],
          ["amount", "200"],
          ["payment", "lightning", "synthetic-invoice"],
          ["expiration", "1000"],
        ],
        content: "",
      },
      fields: {
        messageType: "payment_request",
        amountSats: "200",
        paymentOptions: [
          { medium: "lightning", reference: "synthetic-invoice" },
        ],
        expiration: "1000",
      },
    },
    {
      wire: {
        kind: 16,
        tags: [
          ["p", "buyer"],
          ["subject", "Status"],
          ["type", "3"],
          ["order", "order-1"],
          ["status", "confirmed"],
        ],
        content: "",
      },
      fields: { messageType: "status_update", status: "confirmed" },
    },
    {
      wire: {
        kind: 16,
        tags: [
          ["p", "buyer"],
          ["subject", "Shipping"],
          ["type", "4"],
          ["order", "order-1"],
          ["status", "shipped"],
          ["tracking", "TRACK-1"],
          ["carrier", "Example"],
          ["eta", "1000"],
        ],
        content: "",
      },
      fields: {
        messageType: "shipping_update",
        status: "shipped",
        carrier: "Example",
        tracking: "TRACK-1",
        eta: "1000",
      },
    },
    {
      wire: {
        kind: 17,
        tags: [
          ["p", "merchant"],
          ["subject", "Receipt"],
          ["order", "order-1"],
          ["payment", "lightning", "synthetic-invoice", "synthetic-proof"],
          ["amount", "200"],
        ],
        content: "",
      },
      fields: {
        messageType: "payment_receipt",
        amountSats: "200",
        paymentProofs: [
          {
            medium: "lightning",
            reference: "synthetic-invoice",
            proof: "synthetic-proof",
          },
        ],
      },
    },
  ]

  for (const { wire, fields } of cases) {
    test(`${fields.messageType} reads a fixed wire fixture without order-action authority`, () => {
      const decoded = decodeCommerceMessageRumor(rumor(wire))
      expect(decoded.category).toBe("commerce")
      if (decoded.category !== "commerce") throw new Error("Expected commerce")
      expect(decoded.protocol).toBe("open_markets")
      expect(decoded.status).toBe("supported")
      expect(decoded.fields.orderId).toBe("order-1")
      expect(decoded.fields).toMatchObject(fields)
      expect(decoded.parsedOrderMessage).toBeUndefined()
      expect(decoded.provenance.tags).toEqual(wire.tags)
      expect(decoded.text).toBe(wire.content)
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
    const wire = {
      kind: 16,
      tags: [
        ["p", "buyer"],
        ["subject", "Status"],
        ["type", "3"],
        ["order", "order-1"],
        ["status", "confirmed"],
        ["version", "2"],
      ],
      content: "",
    }
    const decoded = decodeCommerceMessageRumor(rumor(wire))
    expect(decoded.category).toBe("commerce")
    if (decoded.category === "commerce") {
      expect(decoded.status).toBe("unsupported")
      expect(decoded.parsedOrderMessage).toBeUndefined()
    }
  })

  test("payment references are searchable locally while proof material stays out of search", () => {
    const wire = {
      kind: 17,
      tags: [
        ["p", "merchant"],
        ["subject", "Receipt"],
        ["order", "order-1"],
        ["payment", "lightning", "invoice-token", "proof-token"],
        ["amount", "200"],
      ],
      content: "private-confirmation-token",
    }
    const decoded = decodeCommerceMessageRumor(rumor(wire))
    expect(decoded.category).toBe("commerce")
    const search = commerceMessageSearchText(decoded)
    expect(search).toContain("order-1")
    expect(search).toContain("invoice-token")
    expect(search).not.toContain("proof-token")
    expect(search).not.toContain("private-confirmation-token")
  })

  test("extreme safe timestamps remain searchable without date conversion failures", () => {
    const decoded = decodeCommerceMessageRumor({
      ...rumor({
        kind: 16,
        tags: [
          ["p", "merchant"],
          ["type", "future-commerce"],
          ["order", "extreme-time-order"],
        ],
      }),
      created_at: Number.MAX_SAFE_INTEGER,
    })
    expect(decoded.category).toBe("commerce")
    expect(commerceMessageSearchText(decoded)).toContain("extreme-time-order")
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
    url: "https://files.conduit.market/file",
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
    "https://files.conduit.market/file",
    envelope,
    async () => {
      requests += 1
      return new Response(new Uint8Array(ciphertext))
    }
  )
  expect(requests).toBe(1)
  expect(result).toEqual(plaintext)
  for (const unsafeUrl of [
    "http://files.conduit.market/file",
    "https://127.0.0.1/file",
    "https://localhost/file",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    await expect(
      downloadAndDecryptPrivateFile(unsafeUrl, envelope, async () => {
        requests += 1
        return new Response(new Uint8Array(ciphertext))
      })
    ).rejects.toThrow("public HTTPS")
  }
  expect(requests).toBe(1)
  expect(
    downloadAndDecryptPrivateFile(
      "https://files.conduit.market/file",
      { ...envelope, encryptedSize: ciphertext.byteLength - 1 },
      async () => {
        requests += 1
        return new Response(new Uint8Array(ciphertext))
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
      "https://files.conduit.market/file",
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
      "https://files.conduit.market/file",
      minimal,
      async () => new Response(new Uint8Array(8 * 1024 * 1024 + 17))
    )
  ).rejects.toThrow("supported size")
})

test("kind-15 hex metadata retains fixed lengths and accepts uppercase", async () => {
  const plaintext = new TextEncoder().encode("synthetic hex attachment")
  const { ciphertext, envelope } = await encryptPrivateFileBytes(plaintext)
  const uppercase = {
    ...envelope,
    key: envelope.key.toUpperCase(),
    nonce: envelope.nonce.toUpperCase(),
    encryptedSha256: envelope.encryptedSha256.toUpperCase(),
    originalSha256: envelope.originalSha256.toUpperCase(),
  }
  expect(await decryptPrivateFileBytes(ciphertext, uppercase)).toEqual(
    plaintext
  )
  for (const field of [
    "key",
    "nonce",
    "encryptedSha256",
    "originalSha256",
  ] as const) {
    for (const value of [
      envelope[field].slice(2),
      `${envelope[field]}00`,
      `g${envelope[field].slice(1)}`,
    ]) {
      const invalid = { ...envelope, [field]: value }
      expect(() =>
        buildPrivateFileRumor({
          recipientPubkeys: ["merchant"],
          url: "https://files.conduit.market/file",
          mimeType: "text/plain",
          envelope: invalid,
        })
      ).toThrow("Invalid private file key, nonce, or hash")
      await expect(
        decryptPrivateFileBytes(ciphertext, invalid)
      ).rejects.toThrow("Invalid private file key, nonce, or hash")
    }
  }
})

test("kind-15 terminal line separators retain generic metadata errors", async () => {
  const { ciphertext, envelope } = await encryptPrivateFileBytes(
    new TextEncoder().encode("synthetic line separator attachment")
  )
  const expectedError = /^Invalid private file key, nonce, or hash$/
  for (const field of [
    "key",
    "nonce",
    "encryptedSha256",
    "originalSha256",
  ] as const) {
    for (const separator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
      const value = envelope[field].slice(0, -separator.length) + separator
      const invalid = { ...envelope, [field]: value }
      expect(() =>
        buildPrivateFileRumor({
          recipientPubkeys: ["merchant"],
          url: "https://files.conduit.market/file",
          mimeType: "text/plain",
          envelope: invalid,
        })
      ).toThrow(expectedError)
      await expect(
        decryptPrivateFileBytes(ciphertext, invalid)
      ).rejects.toThrow(expectedError)
    }
  }
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
