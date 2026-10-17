import type { ConduitDB, EventMarketOrganizerStockEntry } from "../db"
import {
  assertCheckoutSparkOrganizerCommerceProof,
  type CheckoutSparkOrganizerCommerceProof,
} from "./checkout-spark-organizer-commerce"
import {
  assertEventMarketOrganizerPurchaseAuthority,
  type EventMarketOrganizerPurchaseAuthority,
} from "./event-market-organizer-purchase"
import { formatEventMarketPickupClaimCode } from "./event-market-handoff"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockHandout,
} from "./event-market-stock-authority"
import { sameOrganizerStockRumor } from "./event-market-stock-import-authority"
import { validateOrganizerStockJournalPool } from "./event-market-stock-journal"
import {
  acceptAndPublishOrganizerStockOrder,
  inspectEventMarketStockPacket,
} from "./event-market-stock-workflow"
import type { AccountSigner } from "./nostr-event-signer"
import { retryPrivateMessageWraps } from "./private-message-delivery"
import { wrapPrivateMessage } from "./private-message-primitives"
import type { SignedPublicNostrEvent } from "./signed-event"
import { orderSchema, type OrderSchema } from "../schemas"
import { getOrganizerStockOrderBindings } from "./merchant-order-acceptance-bindings"
import { classifyEventMarketOrderHandoff } from "./event-market-order-handoff-policy"

type Session = {
  db: ConduitDB
  signer: AccountSigner
  authenticatedPubkey: string
  shouldContinue(): boolean
}
type Delivery = Pick<
  Parameters<typeof retryPrivateMessageWraps>[0],
  | "deliveryStore"
  | "publishFn"
  | "resolveInboxRelays"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
>
type Purchase = ReturnType<typeof assertEventMarketOrganizerPurchaseAuthority>
const clone = <T>(value: T): T => structuredClone(value)

function session(input: Session) {
  const { revision, authMethod } = input.signer
  const check = () => {
    if (
      !input.shouldContinue() ||
      !revision ||
      !authMethod ||
      input.signer.revision !== revision ||
      input.signer.authMethod !== authMethod ||
      input.signer.pubkey !== input.authenticatedPubkey ||
      !input.signer.capabilities.nip44
    )
      throw new Error("Organizer handout session changed.")
  }
  return {
    check,
    authenticate: async () => {
      check()
      const pubkey = await input.signer.getPublicKey()
      check()
      if (pubkey !== input.authenticatedPubkey)
        throw new Error("Organizer handout session changed.")
    },
  }
}

function assertPurchase(purchase: Purchase, account: string) {
  if (
    purchase.eventMarket.mode !== "organizer_handoff" ||
    purchase.organizerPubkey !== account ||
    !purchase.writerBindings.length
  )
    throw new Error("Exact organizer purchase authority required.")
}

/** Reserve every line atomically before the existing payment executor can send commerce payouts. */
export async function acceptCheckoutSparkOrganizerStockOrder(
  input: Session & {
    authority: EventMarketOrganizerPurchaseAuthority
    delivery?: Delivery
    nowMs?: number
  }
) {
  const authority = session(input)
  await authority.authenticate()
  const purchase = assertEventMarketOrganizerPurchaseAuthority(input.authority)
  assertPurchase(purchase, input.authenticatedPubkey)
  return acceptAndPublishOrganizerStockOrder({
    ...input,
    orderId: purchase.orderId,
    identityBinding: purchase.orderBinding.identityHash,
    termsBinding: purchase.orderBinding.termsHash,
    claimRef: purchase.claimRef,
    evidence: JSON.stringify({
      handoffId: purchase.handoffId,
      ...purchase.recoveryBinding,
      orderBinding: purchase.orderBinding,
    }),
    entries: purchase.writerBindings,
    shouldContinue: () => {
      authority.check()
      assertEventMarketOrganizerPurchaseAuthority(input.authority)
      return true
    },
  })
}

async function entriesForOrder(
  db: ConduitDB,
  account: string,
  orderId: string
) {
  return (
    await db.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(account)
      .toArray()
  )
    .filter((entry) => entry.orderId === orderId)
    .sort((a, b) => a.poolId.localeCompare(b.poolId))
}

function assertManifest(
  entries: readonly EventMarketOrganizerStockEntry[],
  payload: EventMarketStockHandout
) {
  if (entries.length !== payload.entries.length)
    throw new Error(
      "The complete accepted-order journal is required before handout."
    )
  const manifest = JSON.stringify(
    entries.map((entry) => ({
      poolId: entry.poolId,
      writerId: payload.writerId,
      quantity: entry.quantity,
    }))
  )
  for (const [index, entry] of entries.entries()) {
    const accepted = parseEventMarketStockAuthorityRumor(entry.rumor)
    const expected = payload.entries[index]
    if (
      !expected ||
      accepted.type !== "accepted" ||
      accepted.orderId !== payload.orderId ||
      accepted.identityBinding !== payload.identityBinding ||
      accepted.termsBinding !== payload.termsBinding ||
      accepted.claimRef !== payload.claimRef ||
      accepted.merchantPubkey !== payload.merchantPubkey ||
      accepted.organizerPubkey !== payload.organizerPubkey ||
      accepted.writerId !== payload.writerId ||
      accepted.poolId !== expected.poolId ||
      accepted.quantity !== expected.quantity ||
      accepted.acceptedAtMs > payload.handedOutAtMs ||
      entry.rumor.id !== expected.acceptedId ||
      entry.claimRef !== payload.claimRef ||
      entry.quantity !== expected.quantity ||
      entry.orderPoolBinding !== manifest
    )
      throw new Error(
        "Handout does not match the complete immutable stock decision."
      )
  }
}

/**
 * Persist a unique physical-handout decision before requesting any signature.
 * Retrying this operation never consumes stock twice or creates another release.
 */
export async function confirmOrganizerStockOrderHandout(
  input: Session & {
    authority: EventMarketOrganizerPurchaseAuthority
    commerceProof: CheckoutSparkOrganizerCommerceProof
    enteredClaimCode: string
    physicalReleaseConfirmed: true
    delivery?: Delivery
    nowMs?: number
  }
) {
  const authority = session(input)
  await authority.authenticate()
  const purchase = assertEventMarketOrganizerPurchaseAuthority(input.authority)
  assertPurchase(purchase, input.authenticatedPubkey)
  const check = () => {
    authority.check()
    assertEventMarketOrganizerPurchaseAuthority(input.authority)
    assertCheckoutSparkOrganizerCommerceProof(input.commerceProof, {
      organizerPubkey: input.authenticatedPubkey,
      orderBinding: purchase.orderBinding,
      orderId: purchase.orderId,
      merchantPubkey: purchase.merchantPubkey,
      initialHandoffId: purchase.handoffId,
    })
  }
  check()
  const now = input.nowMs ?? Date.now()
  if (
    input.physicalReleaseConfirmed !== true ||
    !Number.isSafeInteger(now) ||
    now < purchase.orderBinding.createdAt ||
    input.enteredClaimCode.trim().toUpperCase() !==
      formatEventMarketPickupClaimCode(purchase.claimRef).toUpperCase()
  )
    throw new Error(
      "Verify the buyer's exact pickup code before physical handout."
    )
  const result = await input.db.transaction(
    "rw",
    [
      input.db.eventMarketOrganizerStockPools,
      input.db.eventMarketOrganizerStockEntries,
    ],
    async () => {
      check()
      const entries = await entriesForOrder(
        input.db,
        input.authenticatedPubkey,
        purchase.orderId
      )
      if (entries.length !== purchase.writerBindings.length)
        throw new Error(
          "Accept the complete reserved-stock order before handout."
        )
      const writers = new Set(
        purchase.writerBindings.map((entry) => entry.writerId)
      )
      if (writers.size !== 1)
        throw new Error("One designated device must hold the complete order.")
      for (const expected of purchase.writerBindings) {
        const entry = entries.find(
          (candidate) => candidate.poolId === expected.poolId
        )
        const pool = await input.db.eventMarketOrganizerStockPools.get(
          `${input.authenticatedPubkey}:${expected.poolId}`
        )
        if (
          !entry ||
          entry.quantity !== expected.quantity ||
          !pool ||
          pool.writerId !== expected.writerId ||
          pool.readOnlyRecovery
        )
          throw new Error(
            "The original organizer stock writer is required for handout."
          )
        validateOrganizerStockJournalPool(pool)
      }
      const payload: EventMarketStockHandout = {
        version: 1,
        type: "handed_out",
        merchantPubkey: purchase.merchantPubkey,
        organizerPubkey: input.authenticatedPubkey,
        writerId: purchase.writerBindings[0]!.writerId,
        orderId: purchase.orderId,
        identityBinding: purchase.orderBinding.identityHash,
        termsBinding: purchase.orderBinding.termsHash,
        claimRef: purchase.claimRef,
        entries: entries.map((entry) => ({
          poolId: entry.poolId,
          acceptedId: entry.rumor.id,
          quantity: entry.quantity,
        })),
        handedOutAtMs: now,
      }
      assertManifest(entries, payload)
      const prior = entries.find((entry) => entry.handout)?.handout
      if (prior) {
        const saved = parseEventMarketStockAuthorityRumor(prior.rumor)
        if (saved.type !== "handed_out")
          throw new Error("Saved physical handout is malformed.")
        assertManifest(entries, saved)
        if (
          entries.some(
            (entry) =>
              !entry.handout ||
              !sameOrganizerStockRumor(entry.handout.rumor, prior.rumor)
          )
        )
          throw new Error("Conflicting physical handout needs reconciliation.")
        check()
        return { replayed: true, rumor: prior.rumor }
      }
      const rumor = createEventMarketStockAuthorityRumor({
        payload,
        createdAt: Math.floor(now / 1000),
      })
      for (const entry of entries)
        await input.db.eventMarketOrganizerStockEntries.put({
          ...entry,
          handout: { rumor },
        })
      check()
      return { replayed: false, rumor }
    }
  )
  const delivery = await retryOrganizerStockOrderHandout({
    ...input,
    orderId: purchase.orderId,
  })
  return { ...result, delivery }
}

/** Exact saved handout only; this never authorizes another physical release. */
export async function retryOrganizerStockOrderHandout(
  input: Session & { orderId: string; delivery?: Delivery }
) {
  const authority = session(input)
  await authority.authenticate()
  const entries = await entriesForOrder(
    input.db,
    input.authenticatedPubkey,
    input.orderId
  )
  const first = entries[0]?.handout
  if (!first) throw new Error("Saved physical handout is unavailable.")
  const payload = parseEventMarketStockAuthorityRumor(first.rumor)
  if (
    payload.type !== "handed_out" ||
    payload.organizerPubkey !== input.authenticatedPubkey
  )
    throw new Error("Only the original organizer can retry this handout.")
  assertManifest(entries, payload)
  if (
    entries.some(
      (entry) =>
        !entry.handout ||
        !sameOrganizerStockRumor(entry.handout.rumor, first.rumor)
    )
  )
    throw new Error("Conflicting physical handout needs reconciliation.")
  let wraps = first.wraps
  if (!wraps) {
    const recipient = await wrapPrivateMessage(
      first.rumor,
      { pubkey: payload.merchantPubkey },
      input.signer
    )
    authority.check()
    const self = await wrapPrivateMessage(
      first.rumor,
      { pubkey: payload.organizerPubkey },
      input.signer
    )
    authority.check()
    wraps = await input.db.transaction(
      "rw",
      input.db.eventMarketOrganizerStockEntries,
      async () => {
        authority.check()
        const current = await entriesForOrder(
          input.db,
          input.authenticatedPubkey,
          input.orderId
        )
        assertManifest(current, payload)
        if (
          current.some(
            (entry) =>
              !entry.handout ||
              !sameOrganizerStockRumor(entry.handout.rumor, first.rumor)
          )
        )
          throw new Error("Saved physical handout changed.")
        const retained = current.find((entry) => entry.handout?.wraps)?.handout
          ?.wraps ?? { recipient, self }
        for (const entry of current)
          await input.db.eventMarketOrganizerStockEntries.put({
            ...entry,
            handout: { ...entry.handout!, wraps: retained },
          })
        authority.check()
        return retained
      }
    )
  }
  authority.check()
  return retryPrivateMessageWraps({
    ...input.delivery,
    rumorId: first.rumor.id,
    senderPubkey: payload.organizerPubkey,
    recipientPubkey: payload.merchantPubkey,
    accountPubkey: input.authenticatedPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    wrappedToRecipient: wraps.recipient,
    wrappedToSelf: wraps.self,
    shouldContinue: () => {
      authority.check()
      return true
    },
  })
}

/** Authenticated history prevents re-release on a recovered device; no payment is inferred. */
export async function restoreOrganizerStockOrderHandout(
  input: Session & { envelope: SignedPublicNostrEvent }
) {
  const authority = session(input)
  const packet = await inspectEventMarketStockPacket(input)
  if (!packet || packet.payload.type !== "handed_out")
    throw new Error("Authenticated organizer handout required.")
  const payload = packet.payload
  return input.db.transaction(
    "rw",
    input.db.eventMarketOrganizerStockEntries,
    async () => {
      authority.check()
      const entries = await entriesForOrder(
        input.db,
        input.authenticatedPubkey,
        payload.orderId
      )
      assertManifest(entries, payload)
      for (const entry of entries) {
        if (
          entry.handout &&
          !sameOrganizerStockRumor(entry.handout.rumor, packet.rumor)
        )
          throw new Error(
            "Conflicting physical handout prevents another release."
          )
      }
      for (const entry of entries)
        await input.db.eventMarketOrganizerStockEntries.put({
          ...entry,
          handout: {
            ...entry.handout,
            rumor: clone(packet.rumor),
            receivedEnvelope: clone(packet.envelope),
          },
        })
      authority.check()
      return {
        rumor: packet.rumor,
        replayed: entries.every((entry) => entry.handout !== undefined),
      }
    }
  )
}

/**
 * Merchant completion reads an already imported, authenticated handout. It
 * neither signs a new release nor infers goods payment or consumes stock again.
 */
export async function assertMerchantOrganizerStockOrderHandout(
  input: Session & { order: OrderSchema }
) {
  input = { ...input, order: orderSchema.parse(clone(input.order)) }
  const authority = session(input)
  await authority.authenticate()
  if (
    input.order.merchantPubkey !== input.authenticatedPubkey ||
    classifyEventMarketOrderHandoff(input.order) !== "reserved_organizer_stock"
  )
    throw new Error("Exact reserved organizer pickup required.")
  const bindings = getOrganizerStockOrderBindings(input.order)
  const accepted = await input.db.merchantInventoryAcceptedOrders.get(
    input.order.id
  )
  authority.check()
  const imported = accepted?.organizerImport
  if (
    !accepted ||
    !imported ||
    !imported.entries.length ||
    accepted.merchantPubkey !== input.authenticatedPubkey ||
    accepted.identityBinding !== bindings.identityBinding ||
    accepted.termsBinding !== bindings.termsBinding ||
    accepted.evidence !== bindings.termsBinding
  )
    throw new Error(
      "Import the organizer's exact accepted stock history before completion."
    )
  const entries = await input.db.eventMarketOrganizerStockEntries.bulkGet(
    imported.entries.map((row) => `${input.authenticatedPubkey}:${row.entryId}`)
  )
  authority.check()
  if (
    entries.some((entry, index) => {
      const expected = imported.entries[index]!
      if (
        !entry ||
        !entry.imported ||
        entry.accountPubkey !== input.authenticatedPubkey ||
        entry.orderId !== input.order.id ||
        entry.poolId !== expected.poolId ||
        entry.quantity !== expected.quantity ||
        !entry.handout?.receivedEnvelope
      )
        return true
      const acceptedPayload = parseEventMarketStockAuthorityRumor(entry.rumor)
      return (
        acceptedPayload.type !== "accepted" ||
        acceptedPayload.writerId !== expected.writerId
      )
    })
  )
    throw new Error(
      "An exact authenticated organizer handout is required before completion."
    )
  const complete = entries
    .filter(
      (entry): entry is EventMarketOrganizerStockEntry => entry !== undefined
    )
    .sort((a, b) => a.poolId.localeCompare(b.poolId))
  const handout = complete[0]!.handout!
  const packet = await inspectEventMarketStockPacket({
    ...input,
    envelope: handout.receivedEnvelope!,
  })
  authority.check()
  if (
    !packet ||
    packet.payload.type !== "handed_out" ||
    packet.payload.orderId !== input.order.id ||
    packet.payload.merchantPubkey !== input.authenticatedPubkey ||
    packet.payload.organizerPubkey !== imported.organizerPubkey ||
    packet.payload.claimRef !== imported.claimRef ||
    packet.payload.identityBinding !== bindings.identityHash ||
    packet.payload.termsBinding !== bindings.termsHash ||
    !complete.every(
      (entry) =>
        entry.handout &&
        sameOrganizerStockRumor(entry.handout.rumor, packet.rumor)
    )
  )
    throw new Error(
      "Organizer handout does not match this exact imported order."
    )
  assertManifest(complete, packet.payload)
  const [freshAccepted, freshEntries] = await Promise.all([
    input.db.merchantInventoryAcceptedOrders.get(input.order.id),
    input.db.eventMarketOrganizerStockEntries.bulkGet(
      imported.entries.map(
        (row) => `${input.authenticatedPubkey}:${row.entryId}`
      )
    ),
  ])
  authority.check()
  if (
    JSON.stringify(freshAccepted) !== JSON.stringify(accepted) ||
    JSON.stringify(freshEntries) !== JSON.stringify(entries)
  )
    throw new Error(
      "Organizer handout history changed; reload before completion."
    )
  return {
    handoutId: packet.rumor.id,
    orderId: input.order.id,
    handedOutAtMs: packet.payload.handedOutAtMs,
  }
}
