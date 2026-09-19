import { describe, expect, it } from "bun:test"
import NDK, { NDKEvent, NDKRelaySet, type NDKRelay } from "@nostr-dev-kit/ndk"

type ControlledRelay = {
  relay: NDKRelay
  resolve: (accepted: boolean) => void
}

function controlledRelay(url: string): ControlledRelay {
  let resolvePublish: ((accepted: boolean) => void) | null = null
  const published = new Promise<boolean>((resolve) => {
    resolvePublish = resolve
  })
  const relay = {
    url,
    publish: async () => published,
  } as NDKRelay

  return {
    relay,
    resolve: (accepted) => {
      if (!resolvePublish) throw new Error("Controlled relay is not ready")
      resolvePublish(accepted)
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("deterministic relay publish latency harness", () => {
  it("reproduces NDK waiting for every relay after the required ACK", async () => {
    const ndk = new NDK({ explicitRelayUrls: [] })
    const fast = controlledRelay("wss://fast.example")
    const stalled = controlledRelay("wss://stalled.example")
    const relaySet = new NDKRelaySet(new Set([fast.relay, stalled.relay]), ndk)
    const event = new NDKEvent(ndk, {
      id: "0".repeat(64),
      pubkey: "1".repeat(64),
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: "deterministic publish timing fixture",
      sig: "2".repeat(128),
    })
    let settled = false
    const publishing = relaySet.publish(event, undefined, 1).then((result) => {
      settled = true
      return result
    })

    fast.resolve(true)
    await flushMicrotasks()

    expect(settled).toBe(false)

    stalled.resolve(false)
    const publishedRelays = await publishing

    expect(publishedRelays).toEqual(new Set([fast.relay]))
  })
})
