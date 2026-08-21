import { describe, expect, it } from "bun:test"
import type { NDKSigner, NostrEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools"
import { createNdkNostrEventSigner } from "../packages/core/src/protocol/ndk-nostr-event-signer"
import { Nip07SessionSigner } from "../packages/core/src/protocol/nip07-signer"
import {
  NdkBunkerSignerAdapter,
  type RemoteBunkerSigner,
} from "../packages/core/src/protocol/remote-signer"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"

const PRIVATE_KEY = new Uint8Array(32).fill(3)
const PUBKEY = getPublicKey(PRIVATE_KEY)

describe("NDK external-signer edge adapter", () => {
  it("returns a verified plain event without exposing NDK objects to the executor", async () => {
    let received: NostrEvent | undefined
    const ndkSigner = {
      sign: async (event: NostrEvent) => {
        received = event
        return finalizeEvent(
          {
            kind: event.kind,
            pubkey: event.pubkey,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
          },
          PRIVATE_KEY
        ).sig
      },
    } as NDKSigner
    const signer = createNdkNostrEventSigner(ndkSigner, PUBKEY, "nip07")

    const signed = await signer.signEvent({
      kind: 22_242,
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      tags: [
        ["relay", "wss://protected.example"],
        ["challenge", "adapter-test"],
      ],
      content: "",
    })

    expect(received).toEqual({
      kind: 22_242,
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      tags: [
        ["relay", "wss://protected.example"],
        ["challenge", "adapter-test"],
      ],
      content: "",
    })
    expect(verifyEvent(signed)).toBe(true)
    expect(signed.constructor).toBe(Object)
  })

  it("rejects a draft whose identity differs from the active account", async () => {
    let signCalls = 0
    const ndkSigner = {
      sign: async () => {
        signCalls += 1
        return "0".repeat(128)
      },
    } as unknown as NDKSigner
    const signer = createNdkNostrEventSigner(ndkSigner, PUBKEY, "nip07")

    await expect(
      signer.signEvent({
        kind: 22_242,
        pubkey: "f".repeat(64),
        created_at: 1_700_000_000,
        tags: [],
        content: "",
      })
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(signCalls).toBe(0)
  })

  it("maps common signer rejection shapes without misclassifying bridge failures", async () => {
    const draft = {
      kind: 22_242,
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      tags: [],
      content: "",
    }
    for (const rejection of [
      "User rejected request",
      { message: "User denied request" },
      { code: "ACTION_REJECTED" },
      { code: "declined" },
      { code: 4001, message: "Request rejected by user" },
    ]) {
      const ndkSigner = {
        sign: async () => {
          throw rejection
        },
      } as unknown as NDKSigner
      const signer = createNdkNostrEventSigner(ndkSigner, PUBKEY, "nip07")
      await expect(signer.signEvent(draft)).rejects.toMatchObject({
        code: "authorization_denied",
      })
    }

    const transientSigner = createNdkNostrEventSigner(
      {
        sign: async () => {
          throw new Error(
            "Connection cancelled because extension context invalidated"
          )
        },
      } as unknown as NDKSigner,
      PUBKEY,
      "nip07"
    )
    await expect(transientSigner.signEvent(draft)).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("completes a kind-22242 signature through the NIP-07 session fence", async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        nostr: {
          getPublicKey: async () => PUBKEY,
          signEvent: async (event: {
            kind: number
            created_at: number
            tags: string[][]
            content: string
          }) => finalizeEvent(event, PRIVATE_KEY),
        },
      },
    })
    try {
      const nip07 = new Nip07SessionSigner()
      await nip07.blockUntilReady()
      const session = new SessionSigner(nip07, {
        expectedPubkey: PUBKEY,
        hasAuthority: () => true,
      })
      const signer = createNdkNostrEventSigner(session, PUBKEY, "nip07")
      const signed = await signer.signEvent({
        kind: 22_242,
        pubkey: PUBKEY,
        created_at: 1_700_000_000,
        tags: [
          ["relay", "wss://protected.example"],
          ["challenge", "nip07"],
        ],
        content: "",
      })

      expect(verifyEvent(signed)).toBe(true)
      expect(signed.pubkey).toBe(PUBKEY)
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: originalWindow,
      })
    }
  })

  it("completes a kind-22242 signature through the NIP-46 session fence", async () => {
    const bunkerSigner = {
      signEvent: async (event: {
        kind: number
        created_at: number
        tags: string[][]
        content: string
      }) => finalizeEvent(event, PRIVATE_KEY),
      close: async () => undefined,
    } as unknown as RemoteBunkerSigner
    const nip46 = new NdkBunkerSignerAdapter(bunkerSigner, PUBKEY)
    const session = new SessionSigner(nip46, {
      expectedPubkey: PUBKEY,
      hasAuthority: () => true,
    })
    const signer = createNdkNostrEventSigner(session, PUBKEY, "nip46")
    const signed = await signer.signEvent({
      kind: 22_242,
      pubkey: PUBKEY,
      created_at: 1_700_000_000,
      tags: [
        ["relay", "wss://protected.example"],
        ["challenge", "nip46"],
      ],
      content: "",
    })

    expect(verifyEvent(signed)).toBe(true)
    expect(signed.pubkey).toBe(PUBKEY)
  })

  it("maps NIP-46 timeout and unavailable failures without exposing signer details", async () => {
    for (const [createFailure, expectedCode, options] of [
      [() => new Promise<never>(() => undefined), "timeout", { timeoutMs: 1 }],
      [
        () => Promise.reject(new Error("remote signer offline")),
        "unavailable",
        {},
      ],
    ] as const) {
      const bunkerSigner = {
        signEvent: async () => createFailure(),
        close: async () => undefined,
      } as unknown as RemoteBunkerSigner
      const session = new SessionSigner(
        new NdkBunkerSignerAdapter(bunkerSigner, PUBKEY, options),
        {
          expectedPubkey: PUBKEY,
          hasAuthority: () => true,
        }
      )
      const signer = createNdkNostrEventSigner(session, PUBKEY, "nip46")

      await expect(
        signer.signEvent({
          kind: 22_242,
          pubkey: PUBKEY,
          created_at: 1_700_000_000,
          tags: [
            ["relay", "wss://protected.example"],
            ["challenge", expectedCode],
          ],
          content: "",
        })
      ).rejects.toMatchObject({ code: expectedCode })
    }
  })
})
