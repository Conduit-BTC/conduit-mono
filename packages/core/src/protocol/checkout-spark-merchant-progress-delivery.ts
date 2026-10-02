import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  buildCheckoutSparkMerchantProgressRumor,
  parseCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressPayload,
} from "./checkout-spark-merchant-progress"
import { EVENT_KINDS } from "./kinds"
import {
  publishPrivateMessage,
  type PublishPrivateMessageInput,
} from "./messaging"
import { getNdk } from "./ndk"
import type { NostrKeySigner } from "./nostr-event-signer"
import { waitForVisibleDocument } from "./interactive-signer"
import {
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  resolveInboxDeclaration,
} from "./private-message-routing"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/

/** Only exact signed ciphertext and its private local binding are persisted. */
export interface MerchantCheckoutSparkProgressDeliveryRecord {
  schemaVersion: 1
  merchantPubkey: string
  checkoutId: string
  planDigest: string
  snapshotId: string
  initialHandoffId: string
  rumorId: string
  signedRecipientWrap: SignedPublicNostrEvent
  recordedAt: number
}

export interface MerchantCheckoutSparkProgressDelivery {
  record: MerchantCheckoutSparkProgressDeliveryRecord
  /** Historical relay acceptance, not recipient read, uniqueness, or payment. */
  relayAccepted: boolean
}

export interface MerchantCheckoutSparkProgressDeliveryStore {
  load(
    principal: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string
  ): Promise<MerchantCheckoutSparkProgressDelivery | null>
  stage(
    record: MerchantCheckoutSparkProgressDeliveryRecord,
    assertCurrent: () => void
  ): Promise<MerchantCheckoutSparkProgressDelivery>
  markAccepted(
    principal: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string,
    assertCurrent: () => void
  ): Promise<MerchantCheckoutSparkProgressDelivery>
}

export type MerchantCheckoutSparkProgressTransport = Pick<
  PublishPrivateMessageInput,
  | "recipientInboxRelays"
  | "resolveInboxRelays"
  | "giftWrapFn"
  | "publishFn"
  | "accountNetworkLocalStateRepository"
  | "relayAuthMethod"
  | "waitForSignerVisibility"
>

export function parseMerchantCheckoutSparkProgressDeliveryRecord(
  value: unknown
): MerchantCheckoutSparkProgressDeliveryRecord {
  const keys = [
    "schemaVersion",
    "merchantPubkey",
    "checkoutId",
    "planDigest",
    "snapshotId",
    "initialHandoffId",
    "rumorId",
    "signedRecipientWrap",
    "recordedAt",
  ]
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("Checkout Merchant progress delivery is invalid.")
  }
  const record = value as MerchantCheckoutSparkProgressDeliveryRecord
  const wrap = record.signedRecipientWrap
  if (!isValidSignedPublicNostrEvent(wrap)) {
    throw new Error("Checkout Merchant progress delivery is invalid.")
  }
  const recipients = wrap.tags.filter((tag) => tag[0] === "p")
  if (
    record.schemaVersion !== 1 ||
    [
      record.merchantPubkey,
      record.planDigest,
      record.snapshotId,
      record.initialHandoffId,
      record.rumorId,
    ].some((id) => typeof id !== "string" || !HEX_64.test(id)) ||
    typeof record.checkoutId !== "string" ||
    !record.checkoutId ||
    record.checkoutId.trim() !== record.checkoutId ||
    record.checkoutId.length > 512 ||
    !Number.isSafeInteger(record.recordedAt) ||
    record.recordedAt < 0 ||
    wrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    recipients?.length !== 1 ||
    recipients[0]?.length !== 2 ||
    recipients[0]?.[1] !== record.merchantPubkey ||
    wrap.tags.some((tag) => tag[0] === "expiration")
  ) {
    throw new Error("Checkout Merchant progress delivery is invalid.")
  }
  // Pin exact signed data before any awaited storage or transport work.
  return {
    schemaVersion: 1,
    merchantPubkey: record.merchantPubkey,
    checkoutId: record.checkoutId,
    planDigest: record.planDigest,
    snapshotId: record.snapshotId,
    initialHandoffId: record.initialHandoffId,
    rumorId: record.rumorId,
    signedRecipientWrap: {
      id: wrap.id,
      pubkey: wrap.pubkey,
      created_at: wrap.created_at,
      kind: wrap.kind,
      tags: wrap.tags.map((tag) => [...tag]),
      content: wrap.content,
      sig: wrap.sig,
    },
    recordedAt: record.recordedAt,
  }
}

function didAccept(
  delivery: PublishWithPlannerResult,
  allowed?: readonly string[]
): boolean {
  const attempted = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(delivery.attemptedRelayUrls)
  )
  const eligible = allowed ? new Set(allowed) : attempted
  return normalizeSecureOrIsolatedE2eRelayUrls(
    delivery.successfulRelayUrls
  ).some((url) => attempted.has(url) && eligible.has(url))
}

function requireExactStoredDelivery(
  value: MerchantCheckoutSparkProgressDelivery,
  expected: MerchantCheckoutSparkProgressDeliveryRecord
): MerchantCheckoutSparkProgressDelivery {
  const record = parseMerchantCheckoutSparkProgressDeliveryRecord(value.record)
  if (
    typeof value.relayAccepted !== "boolean" ||
    JSON.stringify(record) !== JSON.stringify(expected)
  ) {
    throw new Error("Checkout Merchant progress persisted wrap changed.")
  }
  return { record, relayAccepted: value.relayAccepted }
}

async function publishStoredMerchantCheckoutSparkProgress(input: {
  stored: MerchantCheckoutSparkProgressDelivery
  record: MerchantCheckoutSparkProgressDeliveryRecord
  signer: NostrKeySigner
  store: MerchantCheckoutSparkProgressDeliveryStore
  assertCurrent: () => void
  shouldContinue: () => boolean
  transport?: MerchantCheckoutSparkProgressTransport
}): Promise<MerchantCheckoutSparkProgressDelivery> {
  const { record, store, assertCurrent, transport } = input
  const pinned = requireExactStoredDelivery(input.stored, record)
  assertCurrent()
  if (pinned.relayAccepted) return pinned
  let relays: readonly string[]
  if (transport?.recipientInboxRelays) relays = transport.recipientInboxRelays
  else if (transport?.resolveInboxRelays)
    relays = await transport.resolveInboxRelays(record.merchantPubkey)
  else {
    const declaration = await resolveInboxDeclaration(record.merchantPubkey, {
      requestingAccountPubkey: record.merchantPubkey,
      authenticatedPubkey: record.merchantPubkey,
      accountNetworkLocalStateRepository:
        transport?.accountNetworkLocalStateRepository,
      shouldContinue: input.shouldContinue,
    })
    assertCurrent()
    if (declaration.state !== "declared")
      throw new Error("Merchant private inbox is not currently usable.")
    relays = declaration.relayUrls
  }
  assertCurrent()
  const relayUrls = normalizeSecureOrIsolatedE2eRelayUrls(relays).slice(
    0,
    MAX_DECLARED_INBOX_WRITE_RELAYS
  )
  if (!relayUrls.length)
    throw new Error("Merchant private inbox is not currently usable.")
  let delivery: PublishWithPlannerResult
  try {
    delivery = await (transport?.publishFn ?? publishWithPlanner)(
      new NDKEvent(getNdk(), record.signedRecipientWrap),
      {
        intent: "recipient_event",
        authorPubkey: record.merchantPubkey,
        authenticatedPubkey: record.merchantPubkey,
        accountPubkey: record.merchantPubkey,
        recipientPubkeys: [record.merchantPubkey],
        exclusiveRelayUrls: relayUrls,
        appRelayUrls: [],
        personalRelayUrls: [],
        independentRelayUrls: relayUrls,
        accountNetworkLocalStateRepository:
          transport?.accountNetworkLocalStateRepository,
        shouldContinue: input.shouldContinue,
        deliveryMode: "critical",
        ...(transport?.relayAuthMethod &&
        input.signer.authMethod === transport.relayAuthMethod
          ? {
              relayAuthentication: {
                expectedPubkey: record.merchantPubkey,
                signer: input.signer,
                sessionScope: input.signer,
                waitForSignerVisibility:
                  transport.waitForSignerVisibility ??
                  ((signal?: AbortSignal) =>
                    waitForVisibleDocument(undefined, signal)),
              },
            }
          : {}),
      }
    )
  } catch (error) {
    assertCurrent()
    if (!(error instanceof RelayPublishDiagnosticsError)) throw error
    delivery = error.diagnostics
  }
  assertCurrent()
  if (!didAccept(delivery, relayUrls)) return pinned
  const accepted = requireExactStoredDelivery(
    await store.markAccepted(
      record.merchantPubkey,
      record.checkoutId,
      record.planDigest,
      record.snapshotId,
      assertCurrent
    ),
    record
  )
  assertCurrent()
  if (!accepted.relayAccepted) {
    throw new Error("Checkout Merchant progress acknowledgement changed.")
  }
  return accepted
}

/**
 * Retry a previously staged self-wrap after the local reconciliation advances.
 * The exact signed bytes must still occupy their original private outbox slot;
 * no payload reconstruction, fresh signature, or payment action occurs here.
 */
export async function retryMerchantCheckoutSparkProgress(input: {
  record: MerchantCheckoutSparkProgressDeliveryRecord
  signer: NostrKeySigner
  store: MerchantCheckoutSparkProgressDeliveryStore
  shouldContinue: () => boolean
  transport?: MerchantCheckoutSparkProgressTransport
}): Promise<MerchantCheckoutSparkProgressDelivery> {
  const record = parseMerchantCheckoutSparkProgressDeliveryRecord(input.record)
  const assertCurrent = () => {
    if (input.shouldContinue() !== true)
      throw new Error("Checkout Merchant progress session changed.")
  }
  assertCurrent()
  const signerPubkey = (await input.signer.getPublicKey()).trim().toLowerCase()
  assertCurrent()
  if (signerPubkey !== record.merchantPubkey)
    throw new Error("Checkout Merchant progress signer changed.")
  const stored = await input.store.load(
    record.merchantPubkey,
    record.checkoutId,
    record.planDigest,
    record.snapshotId
  )
  assertCurrent()
  if (!stored) throw new Error("Checkout Merchant progress wrap is missing.")
  return publishStoredMerchantCheckoutSparkProgress({
    ...input,
    record,
    stored,
    assertCurrent,
  })
}

/**
 * Publish Merchant-to-self machine progress through the normal strict inbox
 * transport. Retrying a staged snapshot never asks the signer to re-wrap it.
 * Neither local staging nor relay acceptance authorizes an outgoing payment.
 */
export async function publishMerchantCheckoutSparkProgress(input: {
  payload: CheckoutSparkMerchantProgressPayload
  signer: NostrKeySigner
  store: MerchantCheckoutSparkProgressDeliveryStore
  shouldContinue: () => boolean
  transport?: MerchantCheckoutSparkProgressTransport
}): Promise<MerchantCheckoutSparkProgressDelivery> {
  const payload = parseCheckoutSparkMerchantProgress(input.payload)
  const rumor = buildCheckoutSparkMerchantProgressRumor(payload)
  const principal = payload.merchantPubkey
  const { checkoutId, planDigest } = payload.state.plan
  const assertCurrent = () => {
    if (input.shouldContinue() !== true)
      throw new Error("Checkout Merchant progress session changed.")
  }
  const boundRecord = (value: MerchantCheckoutSparkProgressDelivery) => {
    const record = parseMerchantCheckoutSparkProgressDeliveryRecord(
      value.record
    )
    if (
      typeof value.relayAccepted !== "boolean" ||
      record.merchantPubkey !== principal ||
      record.checkoutId !== checkoutId ||
      record.planDigest !== planDigest ||
      record.snapshotId !== payload.snapshotId ||
      record.initialHandoffId !== payload.initialHandoffId ||
      record.recordedAt !== payload.recordedAt ||
      record.rumorId !== rumor.id
    ) {
      throw new Error("Checkout Merchant progress snapshot binding changed.")
    }
    return { record, relayAccepted: value.relayAccepted }
  }
  assertCurrent()
  const signerPubkey = (await input.signer.getPublicKey()).trim().toLowerCase()
  assertCurrent()
  if (signerPubkey !== principal)
    throw new Error("Checkout Merchant progress signer changed.")
  const existing = await input.store.load(
    principal,
    checkoutId,
    planDigest,
    payload.snapshotId
  )
  assertCurrent()
  const markAccepted = async (
    record: MerchantCheckoutSparkProgressDeliveryRecord
  ) => {
    const saved = boundRecord(
      await input.store.markAccepted(
        principal,
        checkoutId,
        planDigest,
        payload.snapshotId,
        assertCurrent
      )
    )
    assertCurrent()
    if (
      !saved.relayAccepted ||
      JSON.stringify(saved.record) !== JSON.stringify(record)
    ) {
      throw new Error("Checkout Merchant progress acknowledgement changed.")
    }
    return saved
  }
  if (existing) {
    const pinned = boundRecord(existing)
    return publishStoredMerchantCheckoutSparkProgress({
      stored: pinned,
      record: pinned.record,
      signer: input.signer,
      store: input.store,
      assertCurrent,
      shouldContinue: input.shouldContinue,
      transport: input.transport,
    })
  }
  let staged: MerchantCheckoutSparkProgressDelivery | null = null
  const result = await publishPrivateMessage({
    ...input.transport,
    rumor,
    senderPubkey: principal,
    recipientPubkey: principal,
    accountPubkey: principal,
    authenticatedPubkey: principal,
    signer: input.signer,
    signerInteraction: "external",
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: false,
    shouldContinue: input.shouldContinue,
    onWrapped: async (prepared) => {
      assertCurrent()
      if (prepared.wrappedToSelf)
        throw new Error(
          "Checkout Merchant progress must use one self-addressed wrap."
        )
      const record = parseMerchantCheckoutSparkProgressDeliveryRecord({
        schemaVersion: 1,
        merchantPubkey: principal,
        checkoutId,
        planDigest,
        snapshotId: payload.snapshotId,
        initialHandoffId: payload.initialHandoffId,
        rumorId: prepared.rumorId,
        signedRecipientWrap: prepared.wrappedToRecipient.rawEvent(),
        recordedAt: payload.recordedAt,
      })
      const exactRecord = JSON.stringify(record)
      staged = boundRecord(await input.store.stage(record, assertCurrent))
      assertCurrent()
      if (JSON.stringify(staged.record) !== exactRecord) {
        throw new Error("Checkout Merchant progress persisted wrap changed.")
      }
    },
  })
  assertCurrent()
  if (!staged)
    throw new Error(
      "Checkout Merchant progress was not persisted before delivery."
    )
  const persisted = boundRecord(staged)
  const declaredRelays = Object.entries(result.deliveryRelaySources)
    .filter(([, source]) => source === "declared")
    .map(([url]) => url)
  return didAccept(result.recipientDelivery, declaredRelays)
    ? markAccepted(persisted.record)
    : persisted
}
