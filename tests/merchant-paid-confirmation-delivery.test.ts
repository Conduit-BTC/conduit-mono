import { afterEach, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"

import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import {
  CommerceInboxStore,
  isInboxTransportDeliveryRow,
} from "../packages/core/src/protocol/commerce-inbox-store"
import * as commerceInbox from "../packages/core/src/protocol/commerce-inbox"
import * as messaging from "../packages/core/src/protocol/messaging"
import {
  publishMerchantOrderMessage,
  type PublishMerchantOrderMessageInput,
} from "../packages/core/src/protocol/merchant-order-publish"
import {
  retryPrivateDeliveries,
  type PublishPrivateMessageInput,
} from "../packages/core/src/protocol/private-message-delivery"
import { unwrapPrivateMessageEnvelope } from "../packages/core/src/protocol/private-message-primitives"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
import { createInMemoryAccountNetworkLocalStateRepository } from "../packages/core/src/protocol/account-network-local-state"
import {
  createInMemoryInboxDeclarationEvidenceRepository,
  mergeInboxDeclarationEvidence,
} from "../packages/core/src/protocol/inbox-declaration-evidence"
import {
  __resetInboxDeclarationCache,
  mergeInboxDeclarationEvidenceInMemory,
  readRetainedInboxDeclaration,
  sharedInboxDiscoveryRelayUrls,
} from "../packages/core/src/protocol/private-message-routing"
import { admitFixture } from "./helpers/public-event"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const recipientRelay = "wss://recipient.inbox.conduit.market"
const senderRelay = "wss://sender.inbox.conduit.market"
const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []
const signers: SessionSigner[] = []
const restores: Array<() => void> = []

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const owner of owners.splice(0)) owner.stop()
  __resetProtectedReadSigner()
  __resetInboxDeclarationCache()
  for (const signer of signers.splice(0)) retireAccountSigner(signer)
  for (const database of databases.splice(0)) await database.delete()
})

function realKeySigner(secret: Uint8Array): NostrKeySigner {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
    encryptNip44: async (peer, plaintext) =>
      v2.encrypt(plaintext, v2.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      v2.decrypt(ciphertext, v2.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => {
      throw new Error("Legacy decryption is not part of this fixture")
    },
  }
}

async function setup() {
  const merchantKey = generateSecretKey()
  const buyerKey = generateSecretKey()
  const merchant = getPublicKey(merchantKey)
  const buyer = getPublicKey(buyerKey)
  const provider = realKeySigner(merchantKey)
  const buyerSigner = realKeySigner(buyerKey)
  let signingCalls = 0
  const signer = new SessionSigner(
    {
      ...provider,
      signEvent: async (event) => {
        signingCalls++
        return await provider.signEvent(event)
      },
    },
    {
      expectedPubkey: merchant,
      revision: crypto.randomUUID(),
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: false,
      }),
      hasAuthority: () => true,
    }
  )
  signers.push(signer)
  activateAccountSigner(signer)
  installProtectedReadSigner(signer, merchant, () => true)
  const authorization = getProtectedReadAuthorization(merchant)!
  const database = new ConduitDB(`paid-confirmation-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  databases.push(database)
  let owner = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  owners.push(owner)
  const getOwner = spyOn(commerceInbox, "getCommerceInbox").mockImplementation(
    () => owner
  )
  restores.push(() => getOwner.mockRestore())
  const actualPublish = messaging.publishPrivateMessage
  const received: SignedPublicNostrEvent[] = []
  const attempted: SignedPublicNostrEvent[] = []
  let publications = 0
  let rejectRelay = false
  let current = true
  const networkState = createInMemoryAccountNetworkLocalStateRepository()
  const declarations = createInMemoryInboxDeclarationEvidenceRepository()
  const discoveryRelay = sharedInboxDiscoveryRelayUrls()[0]!
  for (const [secret, relay] of [
    [merchantKey, senderRelay],
    [buyerKey, recipientRelay],
  ] as const) {
    const signedEvent = await admitFixture(
      finalizeEvent(
        {
          kind: 10050,
          created_at: Math.floor(Date.now() / 1_000),
          tags: [["relay", relay]],
          content: "",
        },
        secret
      )
    )
    const evidence = {
      pubkey: getPublicKey(secret),
      signedEvent,
      sourceRelayUrls: [discoveryRelay],
      sharedSourceRelayUrls: [discoveryRelay],
    }
    mergeInboxDeclarationEvidenceInMemory(evidence)
    await mergeInboxDeclarationEvidence(evidence, declarations)
  }
  const publishRelay: NonNullable<
    PublishPrivateMessageInput["publishFn"]
  > = async (event, options) => {
    expect(verifyEvent(event)).toBe(true)
    publications++
    attempted.push(event)
    if (rejectRelay)
      throw new Error("Fixture relay rejected before acknowledgement")
    if (event.tags.some(([name, value]) => name === "p" && value === buyer))
      received.push(event)
    const relay = options.exclusiveRelayUrls![0]!
    return {
      successfulRelayUrls: [relay],
      failedRelayUrls: [],
      attemptedRelayUrls: [relay],
      relayFailureMessages: {},
      plan: {} as never,
    }
  }
  // Only external relay discovery/ACK are supplied; wrapping, encrypted staging,
  // persistence, exact resume and sender-history projection remain production code.
  const publish = spyOn(messaging, "publishPrivateMessage").mockImplementation(
    (input) =>
      actualPublish({
        ...input,
        deliveryStore: owner.store,
        accountNetworkLocalStateRepository: networkState,
        inboxDeclarationEvidenceRepository: declarations,
        recipientInboxRelays: [recipientRelay],
        senderInboxRelays: [senderRelay],
        inspectOwnInboxReadiness: async (pubkey) => {
          const declaration = await readRetainedInboxDeclaration(pubkey, {
            durableEvidenceRepository: declarations,
          })
          if (declaration?.state !== "declared")
            return { state: "lookup_unavailable" }
          return {
            state: "ready",
            eventId: declaration.eventId,
            relayUrls: declaration.relayUrls,
            stale: false,
            distributionRepairable: false,
          }
        },
        publishFn: publishRelay,
      })
  )
  restores.push(() => publish.mockRestore())
  let clock = Date.now()
  const time = spyOn(Date, "now").mockImplementation(() => clock)
  restores.push(() => time.mockRestore())
  const invoice = makeBolt11Fixture({
    hrp: "lntb210n",
    createdAt: Math.floor(clock / 1_000),
    fields: [
      bolt11PaymentHashField(),
      bolt11PlainDescriptionField("Paid confirmation fixture"),
    ],
  })
  const input: PublishMerchantOrderMessageInput = {
    merchantPubkey: merchant,
    buyerPubkey: buyer,
    orderId: crypto.randomUUID(),
    type: "status_update" as const,
    tags: [["status", "paid"]],
    payload: { status: "paid", note: "Payment verified" },
    delivery: "buyer_and_self" as const,
    authenticatedPubkey: merchant,
    shouldContinue: () => current,
    paidInvoiceConfirmation: { invoice, amountMsats: 21_000 },
  }
  return {
    database,
    input,
    signer,
    received,
    attempted,
    publishRelay,
    owner: () => owner,
    signingCalls: () => signingCalls,
    publications: () => publications,
    rejectRelay: (reject: boolean) => {
      rejectRelay = reject
    },
    current: (value: boolean) => {
      current = value
    },
    replaceSigner: (differentIdentity: boolean) => {
      const replacementProvider = realKeySigner(
        differentIdentity ? generateSecretKey() : merchantKey
      )
      const replacement = new SessionSigner(replacementProvider, {
        expectedPubkey: replacementProvider.pubkey,
        revision: crypto.randomUUID(),
        authMethod: "nip07",
        getCapabilities: () => ({
          signEvent: true,
          nip44: true,
          nip04Decrypt: false,
        }),
        hasAuthority: () => true,
      })
      signers.push(replacement)
      activateAccountSigner(replacement)
      installProtectedReadSigner(replacement, replacement.pubkey, () => true)
    },
    advance: () => {
      clock += 3_000
    },
    reload: async () => {
      owner.stop()
      owner = new CommerceInbox(
        authorization,
        signer,
        new CommerceInboxStore(authorization, database)
      )
      owners.push(owner)
      await owner.initialize()
      clock += 3_000
    },
    confirmationRow: async () => {
      const rows = await database.commerceInboxDeliveries.toArray()
      const row = rows.find((row) => row.kind === "merchant_paid_confirmation")
      expect(Boolean(row)).toBe(true)
      return row!
    },
    recipientCounts: async () => {
      const rumorIds = new Set<string>()
      for (const wrap of received) {
        const rumor = await unwrapPrivateMessageEnvelope(wrap, buyerSigner)
        expect(rumor.kind === 16 && rumor.pubkey === merchant).toBe(true)
        expect(
          rumor.tags.some(
            ([name, value]) => name === "order" && value === input.orderId
          )
        ).toBe(true)
        expect(
          rumor.tags.some(
            ([name, value]) => name === "status" && value === "paid"
          )
        ).toBe(true)
        rumorIds.add(rumor.id)
      }
      return {
        recipientWraps: new Set(received.map((wrap) => wrap.id)).size,
        innerRumors: rumorIds.size,
      }
    },
  }
}

it("resumes an accepted exact paid invoice after recreating the inbox without another wrap or signing", async () => {
  const fixture = await setup()
  const first = await publishMerchantOrderMessage(fixture.input)
  expect(first.recipient).toBe("accepted")
  expect(first.localHistory).toBe("saved")
  expect(fixture.received.length).toBe(1)
  const firstSigns = fixture.signingCalls()
  const firstPublications = fixture.publications()
  expect(firstSigns).toBeGreaterThan(0)
  expect(firstPublications).toBe(2)
  await fixture.reload()
  const resumed = await publishMerchantOrderMessage(fixture.input)
  expect(resumed.recipient).toBe("accepted")
  expect(resumed.localHistory).toBe("saved")
  expect({
    ...(await fixture.recipientCounts()),
    newSigning: fixture.signingCalls() - firstSigns,
    newPublications: fixture.publications() - firstPublications,
  }).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
    newSigning: 0,
    newPublications: 0,
  })
})

it("repairs sender projection after recipient ACK and reload without resending the confirmation", async () => {
  const fixture = await setup()
  // Inject a storage fault only at projection commit; encrypted intent and relay
  // checkpoints are written by the real store and transport.
  const projection = spyOn(
    fixture.owner().store,
    "putProjection"
  ).mockImplementation(async () => {
    throw new Error("Fixture projection commit unavailable")
  })
  restores.push(() => projection.mockRestore())
  const first = await publishMerchantOrderMessage(fixture.input)
  expect(first.recipient).toBe("accepted")
  expect(first.localHistory).toBe("unavailable")
  expect(first.checkpointFailure).toBe(true)
  const signs = fixture.signingCalls()
  const publications = fixture.publications()
  projection.mockRestore()
  await fixture.reload()
  const recovered = await publishMerchantOrderMessage(fixture.input)
  expect(recovered.recipient).toBe("accepted")
  expect(recovered.localHistory).toBe("saved")
  expect({
    ...(await fixture.recipientCounts()),
    newSigning: fixture.signingCalls() - signs,
    newPublications: fixture.publications() - publications,
  }).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
    newSigning: 0,
    newPublications: 0,
  })
})

it("resumes the exact staged wrap after pre-ACK relay failure and reload", async () => {
  const fixture = await setup()
  fixture.rejectRelay(true)
  await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow(
    "Fixture relay rejected before acknowledgement"
  )
  expect(fixture.received.length).toBe(0)
  expect(fixture.attempted.length).toBe(1)
  const savedWrapId = fixture.attempted[0]!.id
  const signs = fixture.signingCalls()
  fixture.rejectRelay(false)
  await fixture.reload()
  const recovered = await publishMerchantOrderMessage(fixture.input)
  expect(recovered.recipient).toBe("accepted")
  expect(fixture.received[0]?.id === savedWrapId).toBe(true)
  expect(fixture.signingCalls() - signs).toBe(0)
  expect(await fixture.recipientCounts()).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
  })
})

it("concurrent different-timestamp creators choose one encrypted rumor and one recipient send", async () => {
  const fixture = await setup()
  const store = fixture.owner().store
  const actualSeal = store.seal.bind(store)
  const proposals = new Set<string>()
  let firstPrepared!: () => void
  const firstReady = new Promise<void>((resolve) => {
    firstPrepared = resolve
  })
  let release!: () => void
  const bothPrepared = new Promise<void>((resolve) => {
    release = resolve
  })
  const seal = spyOn(store, "seal").mockImplementation(async (value, id) => {
    const encrypted = await actualSeal(value, id)
    if (id.startsWith("merchant-paid-confirmation:")) {
      proposals.add((value as { rumor: { id: string } }).rumor.id)
      if (proposals.size === 1) firstPrepared()
      if (proposals.size === 2) release()
      await bothPrepared
    }
    return encrypted
  })
  restores.push(() => seal.mockRestore())
  const first = publishMerchantOrderMessage(fixture.input)
  await firstReady
  fixture.advance()
  const second = publishMerchantOrderMessage(fixture.input)
  const results = await Promise.allSettled([first, second])
  expect(proposals.size).toBe(2)
  expect(
    results.filter((result) => result.status === "fulfilled").length
  ).toBeGreaterThanOrEqual(1)
  expect(await fixture.recipientCounts()).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
  })
  expect(
    (await fixture.database.commerceInboxDeliveries.toArray()).filter(
      (row) => row.kind === "merchant_paid_confirmation"
    ).length
  ).toBe(1)
})

it("a different exact invoice on the same order retains a distinct confirmation", async () => {
  const fixture = await setup()
  await publishMerchantOrderMessage(fixture.input)
  fixture.advance()
  const invoice = makeBolt11Fixture({
    hrp: "lntb210n",
    createdAt: Math.floor(Date.now() / 1_000),
    fields: [
      bolt11PaymentHashField(),
      bolt11PlainDescriptionField("Another exact paid invoice"),
    ],
  })
  expect(invoice !== fixture.input.paidInvoiceConfirmation!.invoice).toBe(true)
  await publishMerchantOrderMessage({
    ...fixture.input,
    paidInvoiceConfirmation: { invoice, amountMsats: 21_000 },
  })
  expect(await fixture.recipientCounts()).toEqual({
    recipientWraps: 2,
    innerRumors: 2,
  })
  expect(
    (await fixture.database.commerceInboxDeliveries.toArray()).filter(
      (row) => row.kind === "merchant_paid_confirmation"
    ).length
  ).toBe(2)
})

it("a conflicting exact-intent checkpoint pauses without signing or sending", async () => {
  const fixture = await setup()
  await publishMerchantOrderMessage(fixture.input)
  const signs = fixture.signingCalls()
  const publications = fixture.publications()
  await fixture.reload()
  await expect(
    publishMerchantOrderMessage({
      ...fixture.input,
      payload: { status: "paid", note: "Conflicting local confirmation" },
    })
  ).rejects.toThrow("Saved paid confirmation binding changed")
  expect({
    newSigning: fixture.signingCalls() - signs,
    newPublications: fixture.publications() - publications,
  }).toEqual({ newSigning: 0, newPublications: 0 })
  expect(await fixture.recipientCounts()).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
  })
})

it("an unreadable encrypted checkpoint pauses without replacing its saved rumor", async () => {
  const fixture = await setup()
  await publishMerchantOrderMessage(fixture.input)
  const row = await fixture.confirmationRow()
  const corrupted = new Uint8Array(row.value.bytes.slice(0))
  corrupted[0] = corrupted[0]! ^ 1
  await fixture.database.commerceInboxDeliveries.update(row.id, {
    value: { nonce: row.value.nonce, bytes: corrupted.buffer },
  })
  const signs = fixture.signingCalls()
  const publications = fixture.publications()
  await fixture.reload()
  await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow()
  expect({
    newSigning: fixture.signingCalls() - signs,
    newPublications: fixture.publications() - publications,
  }).toEqual({ newSigning: 0, newPublications: 0 })
  expect(
    (await fixture.database.commerceInboxDeliveries.toArray()).filter(
      (row) => row.kind === "merchant_paid_confirmation"
    ).length
  ).toBe(1)
})

it("a revoked continuation cannot create a confirmation checkpoint or send", async () => {
  const fixture = await setup()
  fixture.current(false)
  await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow(
    "Paid confirmation account session changed"
  )
  expect({
    signing: fixture.signingCalls(),
    publications: fixture.publications(),
    rows: (await fixture.database.commerceInboxDeliveries.toArray()).length,
  }).toEqual({ signing: 0, publications: 0, rows: 0 })
})

for (const differentIdentity of [false, true]) {
  it(`fences ${differentIdentity ? "identity" : "same-identity signer"} replacement during encrypted checkpoint preparation`, async () => {
    const fixture = await setup()
    const store = fixture.owner().store
    const actualSeal = store.seal.bind(store)
    const seal = spyOn(store, "seal").mockImplementation(async (value, id) => {
      const encrypted = await actualSeal(value, id)
      if (id.startsWith("merchant-paid-confirmation:"))
        fixture.replaceSigner(differentIdentity)
      return encrypted
    })
    restores.push(() => seal.mockRestore())
    await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow(
      "This signer session was replaced"
    )
    expect({
      signing: fixture.signingCalls(),
      publications: fixture.publications(),
      rows: (await fixture.database.commerceInboxDeliveries.toArray()).length,
    }).toEqual({ signing: 0, publications: 0, rows: 0 })
  })
}

it("a checkpoint-only row is absent from generic send retry and outgoing-pending counts", async () => {
  const fixture = await setup()
  fixture.rejectRelay(true)
  await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow(
    "Fixture relay rejected before acknowledgement"
  )
  for (const row of await fixture.database.commerceInboxDeliveries.toArray()) {
    if (isInboxTransportDeliveryRow(row))
      await fixture.database.commerceInboxDeliveries.delete(row.id)
  }
  expect(
    (await fixture.database.commerceInboxDeliveries.toArray()).length
  ).toBe(1)
  await fixture.reload()
  expect(fixture.owner().getSnapshot().diagnostics.outgoingPending).toBe(0)
  const publications = fixture.publications()
  const retried = await retryPrivateDeliveries(fixture.input.merchantPubkey, {
    publishFn: fixture.publishRelay,
    store: fixture.owner().store,
    shouldContinue: () => {
      fixture.owner().store.assertCurrent()
      return true
    },
  })
  expect(retried.size).toBe(0)
  const checkpoint = await fixture.confirmationRow()
  const acknowledgedReplay = await retryPrivateDeliveries(
    fixture.input.merchantPubkey,
    {
      publishFn: fixture.publishRelay,
      onlyId: checkpoint.id.slice(fixture.input.merchantPubkey.length + 1),
      store: fixture.owner().store,
      shouldContinue: () => {
        fixture.owner().store.assertCurrent()
        return true
      },
      replayAcknowledged: true,
    }
  )
  expect(acknowledgedReplay.size).toBe(0)
  expect(fixture.publications() - publications).toBe(0)
})

it("a saved legacy absent-kind transport row still resumes unchanged through generic retry", async () => {
  const fixture = await setup()
  fixture.rejectRelay(true)
  await expect(publishMerchantOrderMessage(fixture.input)).rejects.toThrow(
    "Fixture relay rejected before acknowledgement"
  )
  const row = (await fixture.database.commerceInboxDeliveries.toArray()).find(
    isInboxTransportDeliveryRow
  )
  expect(row?.kind === undefined && row?.state === "failed").toBe(true)
  const savedWrapId = fixture.attempted[0]!.id
  const signs = fixture.signingCalls()
  fixture.rejectRelay(false)
  await fixture.reload()
  expect(fixture.owner().getSnapshot().diagnostics.outgoingPending).toBe(1)
  const retried = await retryPrivateDeliveries(fixture.input.merchantPubkey, {
    publishFn: fixture.publishRelay,
    store: fixture.owner().store,
    shouldContinue: () => {
      fixture.owner().store.assertCurrent()
      return true
    },
  })
  expect(retried.size).toBe(1)
  expect(fixture.received[0]?.id === savedWrapId).toBe(true)
  expect(fixture.signingCalls() - signs).toBe(0)
  expect(await fixture.recipientCounts()).toEqual({
    recipientWraps: 1,
    innerRumors: 1,
  })
})
