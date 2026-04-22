import { describe, expect, it } from "bun:test"
import { mergeNip65RelayUrls } from "../packages/core/src/protocol/relay-list"

describe("mergeNip65RelayUrls", () => {
  it("returns an empty map when no urls are provided", () => {
    expect(mergeNip65RelayUrls({})).toEqual({})
  })

  it("marks read-only relays with read:true, write:false", () => {
    expect(mergeNip65RelayUrls({ readRelayUrls: ["wss://r.example"] })).toEqual(
      {
        "wss://r.example": { read: true, write: false },
      }
    )
  })

  it("marks write-only relays with read:false, write:true", () => {
    expect(
      mergeNip65RelayUrls({ writeRelayUrls: ["wss://w.example"] })
    ).toEqual({
      "wss://w.example": { read: false, write: true },
    })
  })

  it("merges urls that appear in both read and write lists", () => {
    expect(
      mergeNip65RelayUrls({
        readRelayUrls: ["wss://both.example"],
        writeRelayUrls: ["wss://both.example"],
      })
    ).toEqual({
      "wss://both.example": { read: true, write: true },
    })
  })

  it("treats bothRelayUrls as read+write", () => {
    expect(
      mergeNip65RelayUrls({ bothRelayUrls: ["wss://both.example"] })
    ).toEqual({
      "wss://both.example": { read: true, write: true },
    })
  })

  it("combines all three lists into a single deduplicated map", () => {
    expect(
      mergeNip65RelayUrls({
        readRelayUrls: ["wss://r.example", "wss://both.example"],
        writeRelayUrls: ["wss://w.example", "wss://both.example"],
        bothRelayUrls: ["wss://explicit-both.example"],
      })
    ).toEqual({
      "wss://r.example": { read: true, write: false },
      "wss://w.example": { read: false, write: true },
      "wss://both.example": { read: true, write: true },
      "wss://explicit-both.example": { read: true, write: true },
    })
  })
})
