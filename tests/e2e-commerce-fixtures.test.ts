import { describe, expect, it } from "bun:test"
import type { Page } from "@playwright/test"
import { getEventHash, SimplePool } from "nostr-tools"
import { verifyEvent, type Event, type UnsignedEvent } from "nostr-tools/pure"

import { decodeLightningInvoiceAmount } from "@conduit/core"

import {
  createDeterministicNwcWallet,
  DeterministicNwcOperationError,
  type DeterministicNwcWallet,
} from "../e2e/helpers/deterministic-nwc-wallet"
import {
  countDistinctMatchingRuntimePrivateWraps,
  createRuntimeSignerIdentity,
  decryptRuntimeTestPayload,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "../e2e/helpers/real-nip07-signer"
import { startRelayServer } from "../scripts/dev/relay_bun"

function startTestRelay() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 49_152 + Math.floor(Math.random() * 16_384)
    try {
      const relay = startRelayServer({
        hostname: "127.0.0.1",
        port,
        persistence: false,
      })
      return {
        relay,
        relayUrl: `ws://127.0.0.1:${relay.server.port}`,
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error
      }
    }
  }
  throw new Error("Unable to bind an ephemeral test relay port")
}

function createPrivateGiftWrapFixture(input: {
  createdAt?: number
  inboxOwner?: RuntimeSignerIdentity
  recipient: RuntimeSignerIdentity
  rumorTags?: string[][]
  sender: RuntimeSignerIdentity
  sealTags?: string[][]
  signedRumor?: boolean
  wrapper: RuntimeSignerIdentity
  wrapperTags?: string[][]
}): Event {
  const createdAt = input.createdAt ?? 1_800_000_000
  const inboxOwner = input.inboxOwner ?? input.recipient
  const rumorTemplate: UnsignedEvent = {
    content: "runner-only private fixture",
    created_at: createdAt,
    kind: 16,
    pubkey: input.sender.pubkey,
    tags: [["p", input.recipient.pubkey], ...(input.rumorTags ?? [])],
  }
  const rumor = input.signedRumor
    ? signRuntimeTestEvent(input.sender, rumorTemplate)
    : { ...rumorTemplate, id: getEventHash(rumorTemplate) }
  const seal = signRuntimeTestEvent(input.sender, {
    content: encryptRuntimeTestPayload(
      input.sender,
      inboxOwner.pubkey,
      JSON.stringify(rumor)
    ),
    created_at: createdAt + 1,
    kind: 13,
    tags: input.sealTags ?? [],
  })
  return signRuntimeTestEvent(input.wrapper, {
    content: encryptRuntimeTestPayload(
      input.wrapper,
      inboxOwner.pubkey,
      JSON.stringify(seal)
    ),
    created_at: createdAt + 2,
    kind: 1_059,
    tags: input.wrapperTags ?? [["p", inboxOwner.pubkey]],
  })
}

describe("real NIP-07 test signer", () => {
  it("rejects non-canonical NIP-59 envelope fixtures", () => {
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const canonicalWrapper = createRuntimeSignerIdentity()
    const metadataWrapper = createRuntimeSignerIdentity()
    const duplicateRecipientWrapper = createRuntimeSignerIdentity()
    const taggedSealWrapper = createRuntimeSignerIdentity()
    const signedRumorWrapper = createRuntimeSignerIdentity()

    try {
      const parse = (wrap: Event) =>
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrap,
        })

      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            wrapper: canonicalWrapper,
          })
        )
      ).not.toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            wrapper: metadataWrapper,
            wrapperTags: [
              ["p", recipient.pubkey],
              ["expiration", "1800000100"],
              ["nonce", "1", "1"],
            ],
          })
        )
      ).not.toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            wrapper: duplicateRecipientWrapper,
            wrapperTags: [
              ["p", recipient.pubkey],
              ["p", recipient.pubkey],
            ],
          })
        )
      ).toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sealTags: [["p", recipient.pubkey]],
            sender,
            wrapper: taggedSealWrapper,
          })
        )
      ).toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            signedRumor: true,
            wrapper: signedRumorWrapper,
          })
        )
      ).toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            wrapper: sender,
          })
        )
      ).toBeNull()
      expect(
        parse(
          createPrivateGiftWrapFixture({
            recipient,
            sender,
            wrapper: recipient,
          })
        )
      ).toBeNull()
    } finally {
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(canonicalWrapper)
      disposeRuntimeSignerIdentity(metadataWrapper)
      disposeRuntimeSignerIdentity(duplicateRecipientWrapper)
      disposeRuntimeSignerIdentity(taggedSealWrapper)
      disposeRuntimeSignerIdentity(signedRumorWrapper)
    }
  })

  it("fails the NIP-59 oracle when a wrapper key is reused", () => {
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const wrapper = createRuntimeSignerIdentity()
    const wrapperKeyAssignments = new Map<string, string>()

    try {
      const first = createPrivateGiftWrapFixture({
        recipient,
        sender,
        wrapper,
      })
      const second = createPrivateGiftWrapFixture({
        createdAt: 1_800_000_100,
        recipient,
        sender,
        wrapper,
      })

      expect(
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: first,
        })
      ).not.toBeNull()
      expect(
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: first,
        })
      ).not.toBeNull()
      expect(() =>
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: second,
        })
      ).toThrow("E2E_COM_NIP59_WRAPPER_KEY_REUSED")
    } finally {
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(wrapper)
    }
  })

  it("counts two distinct wraps carrying one rumor as duplicate deliveries", () => {
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const firstWrapper = createRuntimeSignerIdentity()
    const secondWrapper = createRuntimeSignerIdentity()
    const wrapperKeyAssignments = new Map<string, string>()

    try {
      const first = createPrivateGiftWrapFixture({
        recipient,
        rumorTags: [
          ["type", "order"],
          ["order", "fixture-order"],
        ],
        sender,
        wrapper: firstWrapper,
      })
      const second = createPrivateGiftWrapFixture({
        recipient,
        rumorTags: [
          ["type", "order"],
          ["order", "fixture-order"],
        ],
        sender,
        wrapper: secondWrapper,
      })
      const firstRumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: recipient,
        recipient,
        sender,
        wrapperKeyAssignments,
        wrap: first,
      })
      const secondRumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: recipient,
        recipient,
        sender,
        wrapperKeyAssignments,
        wrap: second,
      })
      const count = (
        observations: Array<{
          rumor: typeof firstRumor
          wrapId: string
        }>
      ) =>
        countDistinctMatchingRuntimePrivateWraps({
          observations,
          orderId: "fixture-order",
          type: "order",
        })

      expect(firstRumor).not.toBeNull()
      expect(secondRumor).not.toBeNull()
      expect(firstRumor?.id).toBe(secondRumor?.id)
      expect(
        count([
          { rumor: firstRumor, wrapId: first.id },
          { rumor: firstRumor, wrapId: first.id },
        ])
      ).toBe(1)
      expect(
        count([
          { rumor: firstRumor, wrapId: first.id },
          { rumor: secondRumor, wrapId: second.id },
        ])
      ).toBe(2)
    } finally {
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(firstWrapper)
      disposeRuntimeSignerIdentity(secondWrapper)
    }
  })

  it("validates sender self-copies and catches wrapper reuse across inboxes", () => {
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const receiverWrapper = createRuntimeSignerIdentity()
    const senderCopyWrapper = createRuntimeSignerIdentity()
    const reusedWrapper = createRuntimeSignerIdentity()

    try {
      const senderCopy = createPrivateGiftWrapFixture({
        inboxOwner: sender,
        recipient,
        sender,
        wrapper: senderCopyWrapper,
      })
      const senderCopyRumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: sender,
        recipient,
        sender,
        wrap: senderCopy,
      })
      expect(senderCopyRumor?.tags).toContainEqual(["p", recipient.pubkey])

      const wrapperKeyAssignments = new Map<string, string>()
      const receiverCopy = createPrivateGiftWrapFixture({
        recipient,
        sender,
        wrapper: reusedWrapper,
      })
      const reusedSenderCopy = createPrivateGiftWrapFixture({
        inboxOwner: sender,
        recipient,
        sender,
        wrapper: reusedWrapper,
      })
      expect(
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: receiverCopy,
        })
      ).not.toBeNull()
      expect(() =>
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: sender,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: reusedSenderCopy,
        })
      ).toThrow("E2E_COM_NIP59_WRAPPER_KEY_REUSED")

      const independentReceiverCopy = createPrivateGiftWrapFixture({
        recipient,
        sender,
        wrapper: receiverWrapper,
      })
      expect(
        parseCanonicalRuntimePrivateRumor({
          inboxOwner: recipient,
          recipient,
          sender,
          wrapperKeyAssignments,
          wrap: independentReceiverCopy,
        })
      ).not.toBeNull()
    } finally {
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(receiverWrapper)
      disposeRuntimeSignerIdentity(senderCopyWrapper)
      disposeRuntimeSignerIdentity(reusedWrapper)
    }
  })

  it("uses neutral page bindings and explicitly disposes runner-held keys", async () => {
    const identity = createRuntimeSignerIdentity()
    const secondIdentity = createRuntimeSignerIdentity()
    const exposedNames: string[] = []
    const secondExposedNames: string[] = []
    const page = {
      async addInitScript() {},
      async exposeFunction(name: string) {
        exposedNames.push(name)
      },
    } as unknown as Page
    const secondPage = {
      async addInitScript() {},
      async exposeFunction(name: string) {
        secondExposedNames.push(name)
      },
    } as unknown as Page

    try {
      await installRealTestSigner(page, identity, "ws://127.0.0.1:7777")
      await installRealTestSigner(
        secondPage,
        secondIdentity,
        "ws://127.0.0.1:7777"
      )

      expect(
        exposedNames.length === 3 &&
          exposedNames.every(
            (name) => !name.includes(identity.pubkey.slice(0, 16))
          ) &&
          secondExposedNames.length === 3 &&
          secondExposedNames.every(
            (name) => !name.includes(secondIdentity.pubkey.slice(0, 16))
          )
      ).toBe(true)
      const firstSuffixes = exposedNames.map(
        (name) => name.match(/(\d+)$/)?.[1] ?? ""
      )
      const secondSuffixes = secondExposedNames.map(
        (name) => name.match(/(\d+)$/)?.[1] ?? ""
      )
      expect(
        new Set(firstSuffixes).size === 1 &&
          new Set(secondSuffixes).size === 1 &&
          Number(secondSuffixes[0]) > Number(firstSuffixes[0])
      ).toBe(true)
      expect(disposeRuntimeSignerIdentity(identity)).toBe(true)
      expect(disposeRuntimeSignerIdentity(identity)).toBe(false)
      expect(disposeRuntimeSignerIdentity(secondIdentity)).toBe(true)

      let disposedIdentityRejected = false
      try {
        signRuntimeTestEvent(identity, {
          kind: 1,
          created_at: 1_800_000_000,
          tags: [],
          content: "runner-only fixture",
        })
      } catch {
        disposedIdentityRejected = true
      }
      expect(disposedIdentityRejected).toBe(true)
    } finally {
      disposeRuntimeSignerIdentity(identity)
      disposeRuntimeSignerIdentity(secondIdentity)
    }
  })

  it("keeps runtime keys out of the public descriptor and produces valid events", () => {
    const identity = createRuntimeSignerIdentity()
    try {
      const signed = signRuntimeTestEvent(identity, {
        kind: 1,
        created_at: 1_800_000_000,
        tags: [["t", "commerce-smoke"]],
        content: "signed fixture",
      })

      expect(Object.keys(identity)).toEqual(["pubkey"])
      expect(/^[0-9a-f]{64}$/.test(identity.pubkey)).toBe(true)
      expect(signed.pubkey === identity.pubkey).toBe(true)
      expect(verifyEvent(signed)).toBe(true)
      expect(
        verifyEvent({
          id: signed.id,
          pubkey: signed.pubkey,
          created_at: signed.created_at,
          kind: signed.kind,
          tags: signed.tags,
          content: "tampered",
          sig: signed.sig,
        })
      ).toBe(false)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })

  it("round-trips authenticated NIP-44 v2 payloads between identities", () => {
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const unrelated = createRuntimeSignerIdentity()
    const plaintext = "runner-only encrypted fixture"
    try {
      const ciphertext = encryptRuntimeTestPayload(
        sender,
        recipient.pubkey,
        plaintext
      )

      expect(ciphertext.includes(plaintext)).toBe(false)
      expect(
        decryptRuntimeTestPayload(recipient, sender.pubkey, ciphertext) ===
          plaintext
      ).toBe(true)
      expect(() =>
        decryptRuntimeTestPayload(unrelated, sender.pubkey, ciphertext)
      ).toThrow()
    } finally {
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(unrelated)
    }
  })

  it("authenticates recipient-scoped NIP-42 gift-wrap reads", async () => {
    const { relay, relayUrl } = startTestRelay()
    const sender = createRuntimeSignerIdentity()
    const recipient = createRuntimeSignerIdentity()
    const unrelated = createRuntimeSignerIdentity()
    const pool = new SimplePool()

    try {
      const recipientWrap = signRuntimeTestEvent(sender, {
        kind: 1_059,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [["p", recipient.pubkey]],
        content: "opaque runner-only fixture",
      })
      const unrelatedWrap = signRuntimeTestEvent(sender, {
        kind: 1_059,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [["p", unrelated.pubkey]],
        content: "unrelated opaque runner-only fixture",
      })
      await Promise.all(
        pool.publish([relayUrl], recipientWrap, { maxWait: 2_000 })
      )
      await Promise.all(
        pool.publish([relayUrl], unrelatedWrap, { maxWait: 2_000 })
      )

      const wraps = await readAuthenticatedGiftWraps(recipient, relayUrl)
      expect(wraps.map((event) => event.id)).toEqual([recipientWrap.id])
      expect(relay.counters.authAccepted).toBe(1)
      expect(relay.counters.protectedRequests).toBe(1)
    } finally {
      pool.close([relayUrl])
      disposeRuntimeSignerIdentity(sender)
      disposeRuntimeSignerIdentity(recipient)
      disposeRuntimeSignerIdentity(unrelated)
      relay.server.stop()
    }
  })
})

describe("deterministic NWC wallet service", () => {
  it("suppresses SDK console content and returns only a typed failure", async () => {
    const { relay, relayUrl } = startTestRelay()
    const wallet = createDeterministicNwcWallet({ relayUrl })
    const privateSentinel = "private-nwc-runner-value"
    const capturedConsoleCalls: unknown[][] = []
    const captureConsoleCall = (...args: unknown[]) => {
      capturedConsoleCalls.push(args)
    }
    const originalConsole = {
      debug: console.debug,
      dir: console.dir,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    }

    console.debug = captureConsoleCall
    console.dir = captureConsoleCall
    console.error = captureConsoleCall
    console.info = captureConsoleCall
    console.log = captureConsoleCall
    console.warn = captureConsoleCall

    try {
      await wallet.start()
      let failure: unknown = null
      try {
        await wallet.withMerchantClient(async () => {
          console.debug(privateSentinel)
          console.dir({ value: privateSentinel })
          console.error(privateSentinel)
          console.info(privateSentinel)
          console.log(privateSentinel)
          console.warn(privateSentinel)
          throw new Error(privateSentinel)
        })
      } catch (error) {
        failure = error
      }

      expect(
        failure instanceof DeterministicNwcOperationError &&
          failure.code === "NWC_OPERATION_FAILED" &&
          failure.stage === "merchant_session"
      ).toBe(true)
      const failureText =
        failure instanceof Error
          ? `${failure.name} ${failure.message} ${failure.stack ?? ""}`
          : ""
      expect(failureText.includes(privateSentinel)).toBe(false)
      expect(capturedConsoleCalls.length === 0).toBe(true)
      expect(
        console.debug === captureConsoleCall &&
          console.dir === captureConsoleCall &&
          console.error === captureConsoleCall &&
          console.info === captureConsoleCall &&
          console.log === captureConsoleCall &&
          console.warn === captureConsoleCall
      ).toBe(true)
    } finally {
      await wallet.close()
      relay.server.stop()
      console.debug = originalConsole.debug
      console.dir = originalConsole.dir
      console.error = originalConsole.error
      console.info = originalConsole.info
      console.log = originalConsole.log
      console.warn = originalConsole.warn
    }
  })

  it("serves one encrypted invoice/payment cycle and exposes content-free counters", async () => {
    const { relay, relayUrl } = startTestRelay()
    let wallet: DeterministicNwcWallet | null = null

    try {
      wallet = createDeterministicNwcWallet({
        relayUrl,
        lud16: "merchant@example.com",
        nowSeconds: () => 1_800_000_000,
      })
      await wallet.start()
      let receivedMerchantConnection = false
      await wallet.configureMerchantConnection((connectionString) => {
        receivedMerchantConnection =
          connectionString.startsWith("nostr+walletconnect://") &&
          connectionString.includes("secret=")
      })
      expect(receivedMerchantConnection).toBe(true)
      expect("merchantUri" in wallet).toBe(false)
      expect(JSON.stringify(wallet).includes("nostr+walletconnect://")).toBe(
        false
      )

      const issued = await wallet.withMerchantClient(async (merchantClient) => {
        const info = await merchantClient.getInfo()
        const invoice = await merchantClient.makeInvoice({
          amount: 10_000,
          description: "Conduit commerce smoke",
        })
        const decoded = decodeLightningInvoiceAmount(invoice.invoice)
        return {
          infoMatches:
            info.methods.includes("make_invoice") &&
            info.methods.includes("lookup_invoice") &&
            info.lud16 === "merchant@example.com",
          invoiceAmountMatches:
            decoded?.msats === 10_000 && decoded.sats === 10,
          paymentHash: invoice.payment_hash,
        }
      })
      expect(issued.infoMatches).toBe(true)
      expect(issued.invoiceAmountMatches).toBe(true)

      await wallet.payLastInvoice()

      const settlementMatches = await wallet.withMerchantClient(
        async (merchantClient) => {
          const settled = await merchantClient.lookupInvoice({
            payment_hash: issued.paymentHash,
          })
          return (
            settled.state === "settled" &&
            settled.amount === 10_000 &&
            settled.payment_hash === issued.paymentHash
          )
        }
      )
      expect(settlementMatches).toBe(true)

      expect(wallet.snapshot()).toEqual({
        counters: {
          makeInvoice: 1,
          payInvoice: 1,
          lookupInvoice: 1,
        },
        invoiceState: "settled",
      })
    } finally {
      await wallet?.close()
      relay.server.stop()
    }
  })
})
