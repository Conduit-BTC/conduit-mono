import {
  buildCheckoutSparkMerchantProgressRumor,
  openCheckoutSparkMerchantProgressWrap,
  parseCheckoutSparkMerchantProgress,
  type CheckoutSparkMerchantProgressPayload,
} from "./checkout-spark-merchant-progress"
import {
  buildCheckoutSparkMerchantEventProgressRumor,
  createCheckoutSparkMerchantEventProgress,
} from "./checkout-spark-merchant-event-progress"
import type { CheckoutSparkOrganizerOrderBinding } from "./checkout-spark-organizer-recovery"
import {
  preparePrivateMessageRecipientWrap,
  retryPrivateMessageWraps,
} from "./private-message-delivery"
import { EVENT_KINDS } from "./kinds"
import {
  publishPrivateMessage,
  type PublishPrivateMessageInput,
} from "./messaging"
import type { AccountSigner, NostrKeySigner } from "./nostr-event-signer"
import { waitForVisibleDocument } from "./interactive-signer"
import {
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
} from "./private-message-routing"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import { relayTargetsFromUrls } from "./relay-authority"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/

/** Only exact signed ciphertext and its private local binding are persisted. */
export interface MerchantCheckoutSparkProgressDeliveryRecord {
  schemaVersion: 1 | 2
  merchantPubkey: string
  checkoutId: string
  planDigest: string
  snapshotId: string
  initialHandoffId: string
  rumorId: string
  signedRecipientWrap: SignedPublicNostrEvent
  recordedAt: number
  organizerDelivery?: {
    organizerPubkey: string
    snapshotId: string
    initialHandoffId: string
    rumorId: string
    signedRecipientWrap: SignedPublicNostrEvent
  }
}

export interface MerchantCheckoutSparkProgressDelivery {
  record: MerchantCheckoutSparkProgressDeliveryRecord
  /** Historical relay acceptance, not recipient read, uniqueness, or payment. */
  relayAccepted: boolean
  merchantAccepted?: boolean
  organizerAccepted?: boolean
}

export interface MerchantCheckoutSparkProgressDeliveryStore {
  /** Only a schema-two witness rehashed from the authenticated original Order. */
  loadOrganizerOrderBinding?(
    principal: string,
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkOrganizerOrderBinding | null>
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
    assertCurrent: () => void,
    acknowledgements?: {
      merchantAccepted?: boolean
      organizerAccepted?: boolean
    }
  ): Promise<MerchantCheckoutSparkProgressDelivery>
}

export type MerchantCheckoutSparkProgressTransport = Pick<
  PublishPrivateMessageInput,
  | "recipientInboxRelays"
  | "resolveInboxRelays"
  | "giftWrapFn"
  | "publishFn"
  | "accountNetworkLocalStateRepository"
  | "inboxDeclarationEvidenceRepository"
  | "relayAuthMethod"
  | "waitForSignerVisibility"
  | "deliveryStore"
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
  if ((value as { schemaVersion?: unknown })?.schemaVersion === 2)
    keys.push("organizerDelivery")
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
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
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
    schemaVersion: record.schemaVersion,
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
    ...(record.schemaVersion === 2
      ? { organizerDelivery: parseOrganizerDelivery(record.organizerDelivery) }
      : {}),
  }
}

function parseOrganizerDelivery(
  value: unknown
): NonNullable<
  MerchantCheckoutSparkProgressDeliveryRecord["organizerDelivery"]
> {
  const keys = [
    "organizerPubkey",
    "snapshotId",
    "initialHandoffId",
    "rumorId",
    "signedRecipientWrap",
  ]
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Checkout Merchant organizer delivery is invalid.")
  const child = value as NonNullable<
    MerchantCheckoutSparkProgressDeliveryRecord["organizerDelivery"]
  >
  const wrap = child.signedRecipientWrap
  if (
    [
      child.organizerPubkey,
      child.snapshotId,
      child.initialHandoffId,
      child.rumorId,
    ].some((id) => typeof id !== "string" || !HEX_64.test(id)) ||
    !isValidSignedPublicNostrEvent(wrap) ||
    wrap.kind !== 1059 ||
    JSON.stringify(wrap.tags.filter((tag) => tag[0] === "p")) !==
      JSON.stringify([["p", child.organizerPubkey]]) ||
    wrap.tags.some((tag) => tag[0] === "expiration")
  )
    throw new Error("Checkout Merchant organizer delivery is invalid.")
  return {
    organizerPubkey: child.organizerPubkey,
    snapshotId: child.snapshotId,
    initialHandoffId: child.initialHandoffId,
    rumorId: child.rumorId,
    signedRecipientWrap: structuredClone(wrap),
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
  if (
    record.schemaVersion === 2 &&
    (typeof value.merchantAccepted !== "boolean" ||
      typeof value.organizerAccepted !== "boolean" ||
      value.relayAccepted !==
        (value.merchantAccepted && value.organizerAccepted))
  )
    throw new Error("Checkout Merchant progress acknowledgement changed.")
  return {
    record,
    relayAccepted: value.relayAccepted,
    ...(record.schemaVersion === 2
      ? {
          merchantAccepted: value.merchantAccepted!,
          organizerAccepted: value.organizerAccepted!,
        }
      : {}),
  }
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
  if (record.schemaVersion === 2)
    return publishStoredMerchantEventProgress({ ...input, stored: pinned })
  let relays: readonly string[]
  if (transport?.recipientInboxRelays) relays = transport.recipientInboxRelays
  else if (transport?.resolveInboxRelays)
    relays = await transport.resolveInboxRelays(record.merchantPubkey)
  else {
    const retained = transport?.inboxDeclarationEvidenceRepository
      ? await readRetainedInboxDeclaration(record.merchantPubkey, {
          durableEvidenceRepository:
            transport.inboxDeclarationEvidenceRepository,
        })
      : null
    assertCurrent()
    const declaration =
      retained && !retained.stale
        ? retained
        : await resolveInboxDeclaration(record.merchantPubkey, {
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
      record.signedRecipientWrap,
      {
        intent: "recipient_event",
        authorPubkey: record.merchantPubkey,
        authenticatedPubkey: record.merchantPubkey,
        accountPubkey: record.merchantPubkey,
        recipientPubkeys: [record.merchantPubkey],
        exclusiveRelayUrls: relayUrls,
        relayTargets: relayTargetsFromUrls(relayUrls, {
          kind: "owner_nip17",
          operation: "write",
          ownerPubkey: record.merchantPubkey,
        }),
        appRelayUrls: [],
        personalRelayUrls: [],
        independentRelayUrls: relayUrls,
        accountNetworkLocalStateRepository:
          transport?.accountNetworkLocalStateRepository,
        inboxDeclarationEvidenceRepository:
          transport?.inboxDeclarationEvidenceRepository,
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

async function publishStoredMerchantEventProgress(input: {
  stored: MerchantCheckoutSparkProgressDelivery
  record: MerchantCheckoutSparkProgressDeliveryRecord
  signer: NostrKeySigner
  store: MerchantCheckoutSparkProgressDeliveryStore
  assertCurrent(): void
  shouldContinue(): boolean
  transport?: MerchantCheckoutSparkProgressTransport
}): Promise<MerchantCheckoutSparkProgressDelivery> {
  const { record, assertCurrent, store } = input
  const child = record.organizerDelivery!
  let stored = requireExactStoredDelivery(input.stored, record)
  for (const role of ["merchant", "organizer"] as const) {
    assertCurrent()
    if ((await input.signer.getPublicKey()) !== record.merchantPubkey)
      throw new Error("Checkout Merchant progress signer changed.")
    assertCurrent()
    if (
      role === "merchant" ? stored.merchantAccepted : stored.organizerAccepted
    )
      continue
    const result = await retryPrivateMessageWraps({
      ...input.transport,
      rumorId: role === "merchant" ? record.rumorId : child.rumorId,
      senderPubkey: record.merchantPubkey,
      recipientPubkey:
        role === "merchant" ? record.merchantPubkey : child.organizerPubkey,
      accountPubkey: record.merchantPubkey,
      authenticatedPubkey: record.merchantPubkey,
      wrappedToRecipient:
        role === "merchant"
          ? record.signedRecipientWrap
          : child.signedRecipientWrap,
      ...(input.transport?.relayAuthMethod &&
      input.signer.authMethod === input.transport.relayAuthMethod
        ? {
            foregroundRelayAuthentication: {
              // The shared transport independently requires this exact active
              // account signer; this annotation does not confer authority.
              signer: input.signer as AccountSigner,
              method: input.transport.relayAuthMethod,
              waitForSignerVisibility: input.transport.waitForSignerVisibility,
            },
          }
        : {}),
      shouldContinue: () => {
        assertCurrent()
        return true
      },
    })
    assertCurrent()
    if ((await input.signer.getPublicKey()) !== record.merchantPubkey)
      throw new Error("Checkout Merchant progress signer changed.")
    assertCurrent()
    if (result.recipientDelivery && didAccept(result.recipientDelivery)) {
      stored = requireExactStoredDelivery(
        await store.markAccepted(
          record.merchantPubkey,
          record.checkoutId,
          record.planDigest,
          record.snapshotId,
          assertCurrent,
          role === "merchant"
            ? { merchantAccepted: true }
            : { organizerAccepted: true }
        ),
        record
      )
      assertCurrent()
      if (
        !(role === "merchant"
          ? stored.merchantAccepted
          : stored.organizerAccepted)
      )
        throw new Error("Checkout Merchant progress acknowledgement changed.")
    }
  }
  return stored
}

async function stageMerchantEventProgress(input: {
  payload: CheckoutSparkMerchantProgressPayload
  signer: NostrKeySigner
  store: MerchantCheckoutSparkProgressDeliveryStore
  shouldContinue(): boolean
  assertCurrent(): void
  existing: MerchantCheckoutSparkProgressDelivery | null
  transport?: MerchantCheckoutSparkProgressTransport
}): Promise<MerchantCheckoutSparkProgressDelivery> {
  const { payload, assertCurrent, existing, store } = input
  const current = () => {
    assertCurrent()
    return true
  }
  if (!store.loadOrganizerOrderBinding)
    throw new Error(
      "Original Event checkout order must be authenticated again."
    )
  const orderBinding = await store.loadOrganizerOrderBinding(
    payload.merchantPubkey,
    payload.state.plan.checkoutId,
    payload.state.plan.planDigest
  )
  assertCurrent()
  if (!orderBinding)
    throw new Error(
      "Original Event checkout order must be authenticated again."
    )
  const companion = createCheckoutSparkMerchantEventProgress({
    merchantProgress: payload,
    orderBinding,
  })
  const merchantRumor = buildCheckoutSparkMerchantProgressRumor(payload)
  const organizerRumor = buildCheckoutSparkMerchantEventProgressRumor(companion)
  const previous = existing
    ? parseMerchantCheckoutSparkProgressDeliveryRecord(existing.record)
    : null
  if (
    previous &&
    (previous.merchantPubkey !== payload.merchantPubkey ||
      previous.checkoutId !== payload.state.plan.checkoutId ||
      previous.planDigest !== payload.state.plan.planDigest ||
      previous.snapshotId !== payload.snapshotId ||
      previous.initialHandoffId !== payload.initialHandoffId ||
      previous.rumorId !== merchantRumor.id ||
      previous.recordedAt !== payload.recordedAt)
  )
    throw new Error("Checkout Merchant progress snapshot binding changed.")
  if (previous?.schemaVersion === 2) {
    const child = previous.organizerDelivery!
    if (
      child.organizerPubkey !== companion.organizerPubkey ||
      child.snapshotId !== companion.snapshotId ||
      child.initialHandoffId !== companion.initialOrganizerHandoffId ||
      child.rumorId !== organizerRumor.id
    )
      throw new Error("Checkout Merchant organizer progress binding changed.")
    return requireExactStoredDelivery(existing!, previous)
  }
  // Prepare BOTH role-bound ciphertexts in RAM before one atomic domain stage.
  // Historical self ciphertext and ACK survive an authenticated v5 upgrade.
  const self = previous
    ? { wrappedToRecipient: previous.signedRecipientWrap }
    : await preparePrivateMessageRecipientWrap({
        rumor: merchantRumor,
        senderPubkey: payload.merchantPubkey,
        recipientPubkey: payload.merchantPubkey,
        signer: input.signer,
        shouldContinue: current,
        giftWrapFn: input.transport?.giftWrapFn,
      })
  assertCurrent()
  const organizer = await preparePrivateMessageRecipientWrap({
    rumor: organizerRumor,
    senderPubkey: payload.merchantPubkey,
    recipientPubkey: companion.organizerPubkey,
    signer: input.signer,
    shouldContinue: current,
    giftWrapFn: input.transport?.giftWrapFn,
  })
  assertCurrent()
  if ((await input.signer.getPublicKey()) !== payload.merchantPubkey)
    throw new Error("Checkout Merchant progress signer changed.")
  assertCurrent()
  const record = parseMerchantCheckoutSparkProgressDeliveryRecord({
    schemaVersion: 2,
    merchantPubkey: payload.merchantPubkey,
    checkoutId: payload.state.plan.checkoutId,
    planDigest: payload.state.plan.planDigest,
    snapshotId: payload.snapshotId,
    initialHandoffId: payload.initialHandoffId,
    rumorId: merchantRumor.id,
    signedRecipientWrap: self.wrappedToRecipient,
    recordedAt: payload.recordedAt,
    organizerDelivery: {
      organizerPubkey: companion.organizerPubkey,
      snapshotId: companion.snapshotId,
      initialHandoffId: companion.initialOrganizerHandoffId,
      rumorId: organizerRumor.id,
      signedRecipientWrap: organizer.wrappedToRecipient,
    },
  })
  const staged = requireExactStoredDelivery(
    await store.stage(structuredClone(record), assertCurrent),
    record
  )
  assertCurrent()
  return staged
}

/**
 * Retry a previously staged self-wrap after the local reconciliation advances.
 * The exact signed bytes must still occupy their original private outbox slot;
 * Current pairs need no fresh signature. A historical event self-only entry
 * may add its missing companion after authenticating the original Buyer order;
 * its existing self ciphertext and acknowledgement are never replaced.
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
    if (
      input.shouldContinue() !== true ||
      (typeof input.signer.pubkey === "string" &&
        input.signer.pubkey !== record.merchantPubkey)
    )
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
  const currentRecord = parseMerchantCheckoutSparkProgressDeliveryRecord(
    stored.record
  )
  const legacyCurrent = { ...currentRecord, schemaVersion: 1 as const }
  delete legacyCurrent.organizerDelivery
  if (
    JSON.stringify(record) !== JSON.stringify(currentRecord) &&
    !(
      record.schemaVersion === 1 &&
      JSON.stringify(record) === JSON.stringify(legacyCurrent)
    )
  )
    throw new Error("Checkout Merchant progress persisted wrap changed.")
  if (record.schemaVersion === 1 && input.store.loadOrganizerOrderBinding) {
    const binding = await input.store.loadOrganizerOrderBinding(
      record.merchantPubkey,
      record.checkoutId,
      record.planDigest
    )
    assertCurrent()
    if (binding) {
      const opened = await openCheckoutSparkMerchantProgressWrap({
        signedRecipientWrap: record.signedRecipientWrap,
        signer: input.signer,
      })
      assertCurrent()
      return publishMerchantCheckoutSparkProgress({
        ...input,
        payload: opened.payload,
      })
    }
  }
  return publishStoredMerchantCheckoutSparkProgress({
    ...input,
    record: currentRecord,
    stored,
    assertCurrent,
  })
}

/**
 * Publish Merchant machine progress through the normal strict inbox transport.
 * Delegated event plans also retain the separately typed Organizer companion.
 * Retrying an already-staged pair never asks the signer to re-wrap it.
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
    if (
      input.shouldContinue() !== true ||
      (typeof input.signer.pubkey === "string" &&
        input.signer.pubkey !== principal)
    )
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
    return requireExactStoredDelivery(value, record)
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
  if (
    payload.state.plan.schemaVersion === 5 &&
    payload.state.plan.eventMarket?.mode === "organizer_handoff"
  ) {
    const staged = await stageMerchantEventProgress({
      ...input,
      payload,
      existing,
      assertCurrent,
    })
    return publishStoredMerchantEventProgress({
      ...input,
      record: staged.record,
      stored: staged,
      assertCurrent,
    })
  }
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
        signedRecipientWrap: prepared.wrappedToRecipient,
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
