import { describe, expect, it } from "bun:test"
import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
  giftWrap,
  nip19,
} from "@nostr-dev-kit/ndk"
import { randomBytes } from "node:crypto"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  buildConduitHandlerEventTags,
  buildNip89ClientTag,
} from "@conduit/core"

describe("nip89 helpers", () => {
  it("builds a client tag tuple from explicit handler metadata", () => {
    const tag = buildNip89ClientTag({
      name: "Conduit Market",
      address: "31990:abc123:conduit-market",
      relayHint: "wss://relay.conduit.market",
    })

    expect(tag).toEqual([
      "client",
      "Conduit Market",
      "31990:abc123:conduit-market",
      "wss://relay.conduit.market",
    ])
  })

  it("removes stale Conduit client tags when the current handler metadata is unavailable", () => {
    const next = appendConduitClientTag(
      [
        [
          "client",
          "Conduit Market",
          "31990:old:conduit-market",
          "wss://old.example",
        ],
      ],
      "market"
    )
    expect(next.some((tag) => tag[0] === "client")).toBe(false)
  })

  it("preserves unrelated client tags when Conduit handler metadata is unavailable", () => {
    const otherClientTag = [
      "client",
      "Another App",
      "31990:other:another-app",
      "wss://other.example",
    ]
    const next = appendConduitClientTag([otherClientTag], "market")
    expect(next).toEqual([otherClientTag])
  })

  it("includes d and k tags in handler metadata", () => {
    const tags = buildConduitHandlerEventTags("merchant")
    expect(tags.some((tag) => tag[0] === "d")).toBe(true)
    expect(
      tags.some(
        (tag) => tag[0] === "k" && tag[1] === String(EVENT_KINDS.PRODUCT)
      )
    ).toBe(true)
    expect(tags.some((tag) => tag[0] === "k" && tag[1] === "23194")).toBe(true)
  })
})

describe("nip89 with gift wrap", () => {
  it("keeps the client tag on the inner rumor only", async () => {
    const sender = new NDKPrivateKeySigner(nip19.nsecEncode(randomBytes(32)))
    const receiver = new NDKUser({
      pubkey: (
        await new NDKPrivateKeySigner(nip19.nsecEncode(randomBytes(32))).user()
      ).pubkey,
    })
    const ndk = new NDK()
    ndk.signer = sender

    const rumor = new NDKEvent(ndk)
    rumor.kind = EVENT_KINDS.ORDER
    rumor.created_at = Math.floor(Date.now() / 1000)
    rumor.tags = [
      ["p", receiver.pubkey],
      ["type", "message"],
      ["order", "order-123"],
    ]
    rumor.tags.push(
      buildNip89ClientTag({
        name: "Conduit Market",
        address: "31990:abc123:conduit-market",
        relayHint: "wss://relay.conduit.market",
      })
    )
    rumor.content = JSON.stringify({ note: "hello" })

    const wrapped = await giftWrap(rumor, receiver, sender, {
      rumorKind: EVENT_KINDS.ORDER,
    })

    expect(rumor.tags.some((tag) => tag[0] === "client")).toBe(true)
    expect(wrapped.tags.some((tag) => tag[0] === "client")).toBe(false)
  })
})
