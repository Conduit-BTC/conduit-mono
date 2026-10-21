import { describe, expect, it } from "bun:test"
import { generateSecretKey, getPublicKey } from "nostr-tools"
import {
  decodeConduitCommerceExtension,
  encodeOpenMarketsMerchantReply,
} from "@conduit/core/protocol/commerce-wire"
import { decodeCommerceMessageRumor } from "@conduit/core/protocol/commerce-message-codec"
import { parseOrderMessageRumorEvent } from "@conduit/core/protocol/orders"
import { createPrivateMessageRumor } from "@conduit/core/protocol/private-message-primitives"

function statusFixture(status = "accepted", version: 1 | 2 = 2) {
  const canonical = createPrivateMessageRumor({
    kind: 16,
    pubkey: getPublicKey(generateSecretKey()),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", getPublicKey(generateSecretKey())],
      ["type", "status_update"],
      ["order", crypto.randomUUID()],
      ["status", status],
    ],
    content: JSON.stringify({ status }),
  })
  const numeric = encodeOpenMarketsMerchantReply(
    canonical,
    canonical.tags.find(([name]) => name === "order")![1]!,
    version
  )
  return { canonical, numeric }
}

function restoredField(
  numeric: ReturnType<typeof statusFixture>["numeric"],
  field: string,
  tags: string[][]
) {
  const extension = numeric.tags.find(([name]) => name === "conduit")!
  const value = JSON.parse(extension[3]!) as { tags: string[][] }
  value.tags = value.tags.filter(([name]) => name !== field).concat(tags)
  extension[3] = JSON.stringify(value)
  return createPrivateMessageRumor(numeric)
}

describe("complete commerce status consistency", () => {
  it("rejects a restored paid tag overriding an accepted payload and pending common status", () => {
    const { numeric } = statusFixture()
    const conflict = restoredField(numeric, "status", [["status", "paid"]])
    expect(() => parseOrderMessageRumorEvent(conflict)).toThrow("status")
    const decoded = decodeCommerceMessageRumor(conflict)
    expect(decoded.category).toBe("commerce")
    if (decoded.category !== "commerce") throw new Error("Expected commerce")
    expect(decoded.status).toBe("malformed")
    expect(decoded.parsedOrderMessage).toBeUndefined()
  })

  it.each(
    [
      [
        ["status", "accepted"],
        ["status", "paid"],
      ],
      [
        ["status", "paid"],
        ["status", "accepted"],
      ],
      [
        ["status", "accepted"],
        ["status", "accepted"],
      ],
      [["status", "accepted", "paid"]],
      [["status"]],
      [["status", "pending"]],
    ].map((statuses) => [statuses])
  )("rejects ambiguous or mismatched restored status %j", (statuses) => {
    const { numeric } = statusFixture()
    const conflict = restoredField(numeric, "status", statuses)
    expect(() => decodeConduitCommerceExtension(conflict)).toThrow("status")
  })

  it.each(["confirmed", "pending"])(
    "rejects duplicate common status %s",
    (extra) => {
      const { numeric } = statusFixture()
      numeric.tags.push(["status", extra])
      expect(() => decodeConduitCommerceExtension(numeric)).toThrow("status")
    }
  )

  it.each([
    ["accepted", "pending"],
    ["invoiced", "pending"],
    ["paid", "confirmed"],
    ["shipped", "processing"],
    ["complete", "completed"],
    ["cancelled", "cancelled"],
  ])(
    "preserves the valid %s/%s mapping and original rumor",
    (status, common) => {
      const { canonical, numeric } = statusFixture(status)
      const snapshot = structuredClone(numeric)
      expect(numeric.tags).toContainEqual(["status", common])
      const decoded = decodeConduitCommerceExtension(numeric)
      expect(decoded.tags).toContainEqual(["status", status])
      const parsed = parseOrderMessageRumorEvent(
        createPrivateMessageRumor(numeric)
      )
      expect(parsed.type === "status_update" && parsed.payload.status).toBe(
        status
      )
      expect(numeric).toEqual(snapshot)
      expect(canonical.tags).toContainEqual(["status", status])
    }
  )

  it("uses the validated payload when the optional restored status is absent", () => {
    const { numeric } = statusFixture()
    const parsed = parseOrderMessageRumorEvent(
      restoredField(numeric, "status", [])
    )
    expect(parsed.type === "status_update" && parsed.payload.status).toBe(
      "accepted"
    )
  })

  it.each(["accepted", "paid"])(
    "preserves named and v1 status %s",
    (status) => {
      const { canonical, numeric } = statusFixture(status, 1)
      for (const rumor of [canonical, createPrivateMessageRumor(numeric)]) {
        const snapshot = structuredClone(rumor)
        const parsed = parseOrderMessageRumorEvent(rumor)
        expect(parsed.type === "status_update" && parsed.payload.status).toBe(
          status
        )
        expect(rumor).toEqual(snapshot)
      }
    }
  )
})

function shippingFixture(version: 1 | 2 = 2, includeFields = true) {
  const { canonical } = statusFixture()
  const payload = includeFields
    ? { carrier: "Carrier", trackingNumber: "tracking-reference" }
    : {}
  const shipping = createPrivateMessageRumor({
    ...canonical,
    tags: canonical.tags
      .filter(([name]) => !["status", "type"].includes(name!))
      .concat([
        ["type", "shipping_update"],
        ...(includeFields
          ? [
              ["carrier", "Carrier"],
              ["tracking", "tracking-reference"],
            ]
          : []),
      ]),
    content: JSON.stringify(payload),
  })
  return {
    canonical: shipping,
    payload,
    numeric: encodeOpenMarketsMerchantReply(
      shipping,
      shipping.tags.find(([name]) => name === "order")![1]!,
      version
    ),
  }
}

describe("complete commerce shipping consistency", () => {
  it.each(["carrier", "tracking"])(
    "rejects a restored %s overriding validated shipping details",
    (field) => {
      const { numeric } = shippingFixture()
      const conflict = restoredField(numeric, field, [[field, "different"]])
      expect(() => parseOrderMessageRumorEvent(conflict)).toThrow("shipping")
      const decoded = decodeCommerceMessageRumor(conflict)
      expect(decoded.category).toBe("commerce")
      if (decoded.category !== "commerce") throw new Error("Expected commerce")
      expect(decoded.status).toBe("malformed")
      expect(decoded.parsedOrderMessage).toBeUndefined()
    }
  )

  it.each(["carrier", "tracking"])(
    "rejects duplicate and malformed restored %s tags",
    (field) => {
      for (const tags of [
        [
          [field, "different"],
          [field, "different"],
        ],
        [[field]],
        [[field, "different", "extra"]],
      ]) {
        const { numeric } = shippingFixture()
        expect(() =>
          decodeConduitCommerceExtension(restoredField(numeric, field, tags))
        ).toThrow("shipping")
      }
    }
  )

  it.each(["carrier", "tracking"])(
    "rejects duplicate common %s tags",
    (field) => {
      const { numeric } = shippingFixture()
      numeric.tags.push([...numeric.tags.find(([name]) => name === field)!])
      expect(() => decodeConduitCommerceExtension(numeric)).toThrow("shipping")
    }
  )

  it.each(["carrier", "tracking"])(
    "rejects restored %s absent from the validated payload",
    (field) => {
      const { numeric } = shippingFixture(2, false)
      expect(() =>
        decodeConduitCommerceExtension(
          restoredField(numeric, field, [[field, "injected"]])
        )
      ).toThrow("shipping")
    }
  )

  it.each([true, false])(
    "preserves valid and absent shipping details (present=%s)",
    (includeFields) => {
      for (const version of [1, 2] as const) {
        const { canonical, numeric, payload } = shippingFixture(
          version,
          includeFields
        )
        for (const rumor of [canonical, createPrivateMessageRumor(numeric)]) {
          const snapshot = structuredClone(rumor)
          const parsed = parseOrderMessageRumorEvent(rumor)
          expect(
            parsed.type === "shipping_update" && parsed.payload
          ).toMatchObject(payload)
          expect(rumor).toEqual(snapshot)
        }
      }
    }
  )

  it("uses validated shipping payload fields when original tags omit them", () => {
    const { numeric, payload } = shippingFixture()
    const withoutCarrier = restoredField(numeric, "carrier", [])
    const parsed = parseOrderMessageRumorEvent(
      restoredField(withoutCarrier, "tracking", [])
    )
    expect(parsed.type === "shipping_update" && parsed.payload).toMatchObject(
      payload
    )
  })
})
