import { describe, expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools"
import { classifyAccountNetworkReadback } from "../packages/core/src/protocol/account-network-evidence"
import {
  attachEventSourceRelayUrl,
  getEventSourceRelayUrls,
  mergeEventSourceRelayUrls,
  verifySignedEvents,
} from "../packages/core/src/protocol/relay-reader"

const firstRelay = "wss://first.provenance.test"
const secondRelay = "wss://second.provenance.test"

function event() {
  return finalizeEvent(
    {
      kind: 10002,
      content: "",
      created_at: 10,
      tags: [["r", "wss://declared.provenance.test"]],
    },
    new Uint8Array(32).fill(17)
  )
}

describe("relay-read provenance across account evidence", () => {
  it("carries exact observation sources through verification into readback", async () => {
    const wire = event()
    attachEventSourceRelayUrl(wire, ` ${firstRelay} `)
    attachEventSourceRelayUrl(wire, firstRelay)
    attachEventSourceRelayUrl(wire, " ")
    const verified = await verifySignedEvents([wire])
    expect(verified.events).toHaveLength(1)
    const admitted = verified.events[0]!
    expect(admitted).not.toBe(wire)
    expect(getEventSourceRelayUrls(admitted)).toEqual([firstRelay])
    const result = {
      events: [admitted],
      successfulRelayUrls: [firstRelay, secondRelay],
    }
    expect(
      classifyAccountNetworkReadback({
        relayUrl: firstRelay,
        signedEvent: wire,
        result,
      })
    ).toBe("observed")
    expect(
      classifyAccountNetworkReadback({
        relayUrl: secondRelay,
        signedEvent: wire,
        result,
      })
    ).toBe("absent")
    expect(JSON.stringify(admitted)).not.toContain(firstRelay)
    expect(Object.keys(admitted)).not.toContain("eventSourceRelayUrls")
  })

  it("does not let an identical signed clone borrow another observation's source", async () => {
    const wire = event()
    attachEventSourceRelayUrl(wire, firstRelay)
    const admitted = (await verifySignedEvents([wire])).events[0]!
    const clone = structuredClone(admitted)
    expect(getEventSourceRelayUrls(clone)).toEqual([])
    const verifiedClone = (await verifySignedEvents([clone])).events[0]!
    expect(getEventSourceRelayUrls(verifiedClone)).toEqual([])
    expect(
      classifyAccountNetworkReadback({
        relayUrl: firstRelay,
        signedEvent: wire,
        result: {
          events: [verifiedClone],
          successfulRelayUrls: [firstRelay],
        },
      })
    ).toBe("absent")
  })

  it("merges sources in stable order and returns copies of process-local evidence", () => {
    const source = {}
    const target = {}
    attachEventSourceRelayUrl(source, secondRelay)
    attachEventSourceRelayUrl(source, firstRelay)
    attachEventSourceRelayUrl(target, firstRelay)
    mergeEventSourceRelayUrls(target, source)
    expect(getEventSourceRelayUrls(target)).toEqual([firstRelay, secondRelay])
    expect(getEventSourceRelayUrls(source)).toEqual([secondRelay, firstRelay])
    const copied = getEventSourceRelayUrls(target)
    copied.push("wss://invented.provenance.test")
    expect(getEventSourceRelayUrls(target)).toEqual([firstRelay, secondRelay])
    expect(getEventSourceRelayUrls({})).toEqual([])
    expect(JSON.stringify(target)).toBe("{}")
  })

  it("retains explicit readback source-map precedence over local metadata", async () => {
    const wire = event()
    attachEventSourceRelayUrl(wire, firstRelay)
    const admitted = (await verifySignedEvents([wire])).events[0]!
    expect(
      classifyAccountNetworkReadback({
        relayUrl: firstRelay,
        signedEvent: wire,
        result: {
          events: [admitted],
          successfulRelayUrls: [firstRelay],
          eventSourceRelayUrls: { [wire.id]: [] },
        },
      })
    ).toBe("absent")
  })
})
