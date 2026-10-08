import type {
  OrderDeliveryRoute,
  OrderRelayCompatibilityPlan,
  OrderRelayDeliveryRecord,
  OrderRelayDeliveryStatus,
  OrderRelayRoutingAuthority,
} from "../db"
import {
  recordBrowserTelemetryEvent,
  type ConduitTelemetryApp,
} from "../telemetry"
import {
  buildNip17CompatibilityResultTelemetryProperties,
  type Nip17CompatibilityResultTelemetryInput,
} from "../telemetry-event-properties"
import {
  filterEligibleAccountRelayUrls,
  normalizeAccountNetworkPubkey,
  orderEquivalentAccountRelayOperations,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { CommerceInboxStore } from "./commerce-inbox-store"
import { waitForVisibleDocument } from "./interactive-signer"
import { EVENT_KINDS } from "./kinds"
import { type AccountSigner, type NostrKeySigner } from "./nostr-event-signer"
import {
  assertPrivateMessageFitsTransport,
  completePrivateMessageEvent,
  consumeValidatedGuestOrderCompanionScope,
  consumeValidatedOrderRouteScope,
  createPrivateMessageRumor,
  inspectRetainedOwnPrivateMessageRelayReadiness,
  wrapPrivateMessage,
  type OwnPrivateMessageRelayReadiness,
  type PrivateMessageEvent,
  type ValidatedGuestOrderCompanionScope,
  type ValidatedOrderRouteScope,
} from "./private-message-primitives"
import type { ResolveInboxDeclarationOptions } from "./private-message-routing"
import {
  isApprovedCompatibilityOrderRelayPlan,
  publicRelayHintUrls,
  readRetainedInboxDeclaration,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  type CompatibilityOrderRelaySource,
  type DeliveryRouteSelection,
  type InboxDeclarationResolution,
  type PrivateMessageDeliveryRoute,
} from "./private-message-routing"
import {
  assertProtectedReadAuthorization,
  getProtectedReadAuthorization,
} from "./protected-read-authorization"
import { getRelayLists } from "./relay-list"
import {
  getRelayPublishTargetStatus,
  publishSignedEventToRelay,
  publishWithPlanner,
  publishWithPlannerProgressive,
  RelayPublishDiagnosticsError,
  type ProgressivePublishSnapshot,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { type PublicRelayReadOptions } from "./relay-reader"
import { normalizeOwnerSelectedRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export interface PrivateDeliveryLeg {
  recipientPubkey: string
  event: SignedPublicNostrEvent
  relayUrls: string[]
  ownerSelectedRelayUrls: string[]
  compatibility: boolean
  relaySources?: Record<string, "declared" | CompatibilityOrderRelaySource>
  truncated?: boolean
  acknowledged: string[]
  failed: string[]
  delivery?: PublishWithPlannerResult
}
export interface PrivateDeliveryJob {
  rumorId: string
  senderPubkey: string
  legs: PrivateDeliveryLeg[]
  createdAt: number
}

export async function stagePrivateDelivery(
  store: CommerceInboxStore,
  job: PrivateDeliveryJob,
  selfCopy = false
): Promise<string> {
  store.assertCurrent()
  if (
    job.senderPubkey !== store.principal ||
    !job.legs.length ||
    job.legs.some(
      (leg) =>
        !isValidSignedPublicNostrEvent(leg.event) ||
        leg.event.kind !== 1059 ||
        !leg.event.tags.some(
          (tag) => tag[0] === "p" && tag[1] === leg.recipientPubkey
        ) ||
        !leg.relayUrls.length
    )
  )
    throw new Error("Invalid private delivery stage")
  const logicalId = `delivery:${job.rumorId}${selfCopy ? ":self" : ""}`
  const value = await store.seal(structuredClone(job), logicalId)
  await store.database.transaction(
    "rw",
    store.database.commerceInboxDeliveries,
    async () => {
      store.assertCurrent()
      const id = store.key(logicalId)
      if (await store.database.commerceInboxDeliveries.get(id))
        throw new Error(
          "Private message is already staged; retry the saved delivery"
        )
      await store.database.commerceInboxDeliveries.put({
        id,
        accountPubkey: store.principal,
        value,
        state: "queued",
        updatedAt: Date.now(),
        claim: { owner: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
      })
      store.assertCurrent()
    }
  )
  return logicalId
}

export async function recordPrivateDelivery(
  store: CommerceInboxStore,
  id: string,
  eventId: string,
  delivery: PublishWithPlannerResult | null,
  options: { holdClaim?: boolean } = {}
): Promise<void> {
  // Encryption stays outside the IndexedDB transaction. Compare the cipher
  // revision inside it so parallel leg outcomes merge with the latest job.
  for (let attempt = 0; attempt < 32; attempt++) {
    const row = await store.database.commerceInboxDeliveries.get(store.key(id))
    store.assertCurrent()
    if (!row) throw new Error("Private delivery stage is missing")
    const job = await store.open<PrivateDeliveryJob>(row.value, id)
    const leg = job.legs.find((candidate) => candidate.event.id === eventId)
    if (!leg) throw new Error("Private delivery bytes changed")
    leg.delivery = delivery ?? leg.delivery
    leg.acknowledged = [
      ...new Set([
        ...leg.acknowledged,
        ...(delivery?.successfulRelayUrls ?? []).filter((relay) =>
          leg.relayUrls.includes(relay)
        ),
      ]),
    ]
    leg.failed = leg.relayUrls.filter(
      (relay) => !leg.acknowledged.includes(relay)
    )
    const value = await store.seal(job, id)
    const committed = await store.database.transaction(
      "rw",
      store.database.commerceInboxDeliveries,
      async () => {
        store.assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(row.id)
        if (!current) throw new Error("Private delivery stage is missing")
        if (
          current.value.nonce.some(
            (byte, index) => byte !== row.value.nonce[index]
          )
        )
          return false
        await store.database.commerceInboxDeliveries.update(row.id, {
          value,
          claim:
            !options.holdClaim &&
            (job.legs.at(-1)?.event.id === eventId ||
              !delivery?.successfulRelayUrls.length)
              ? undefined
              : current.claim,
          state: job.legs.every((l) =>
            l.relayUrls.every((relay) => l.acknowledged.includes(relay))
          )
            ? "accepted"
            : job.legs.some((l) => l.acknowledged.length)
              ? "partial"
              : "failed",
          updatedAt: Date.now(),
        })
        store.assertCurrent()
        return true
      }
    )
    if (committed) return
  }
  throw new Error(
    "Private delivery outcomes changed concurrently; retry the saved delivery"
  )
}

/** Keep a staged multi-leg send owned until its entire publish attempt exits. */
export async function holdPrivateDeliveryClaim(
  store: CommerceInboxStore,
  id: string
) {
  const row = await store.database.commerceInboxDeliveries.get(store.key(id))
  store.assertCurrent()
  const owner = row?.claim?.owner
  if (!owner) throw new Error("Private delivery claim is missing")
  let lost = false
  const assertCurrent = () => {
    store.assertCurrent()
    if (lost)
      throw new Error(
        "Private delivery ownership changed; retry the saved delivery"
      )
  }
  const heartbeat = setInterval(() => {
    void store.database
      .transaction("rw", store.database.commerceInboxDeliveries, async () => {
        assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(
          store.key(id)
        )
        if (current?.claim?.owner !== owner)
          throw new Error("Private delivery ownership changed")
        await store.database.commerceInboxDeliveries.update(current.id, {
          claim: { owner, expiresAt: Date.now() + 60_000 },
        })
      })
      .catch(() => {
        lost = true
        clearInterval(heartbeat)
      })
  }, 10_000)
  return {
    assertCurrent,
    release: async () => {
      clearInterval(heartbeat)
      assertCurrent()
      await store.database.transaction(
        "rw",
        store.database.commerceInboxDeliveries,
        async () => {
          assertCurrent()
          const current = await store.database.commerceInboxDeliveries.get(
            store.key(id)
          )
          if (current?.claim?.owner === owner)
            await store.database.commerceInboxDeliveries.update(current.id, {
              claim: undefined,
            })
        }
      )
    },
  }
}

/** Retry preserves saved wrap bytes and targets. Foreground relay AUTH may sign
 * a separate NIP-42 event, but never signs or replaces the message wrap.
 */
export async function retryPrivateDeliveries(
  principal: string,
  publisher = publishWithPlanner,
  onlyId?: string,
  suppliedStore?: CommerceInboxStore,
  resolveDeclaration = resolveInboxDeclaration,
  options: {
    replayAcknowledged?: boolean
    shouldContinue?: () => boolean
    foregroundRelayAuthentication?: {
      signer: AccountSigner
      method: "nip07" | "nip46"
      waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
    }
  } = {}
): Promise<Map<string, PublishWithPlannerResult>> {
  if (options.replayAcknowledged && !onlyId)
    throw new Error("Exact replay requires one selected delivery")
  const attempts = new Map<string, PublishWithPlannerResult>()
  const authorization = getProtectedReadAuthorization(principal)
  if (!authorization)
    throw new Error("Reconnect the intended account to retry delivery")
  const foregroundAuth = options.foregroundRelayAuthentication
  const assertForegroundAuthority = () => {
    if (!foregroundAuth) return
    assertProtectedReadAuthorization(authorization, principal)
    if (
      foregroundAuth.signer !== authorization.signer ||
      foregroundAuth.signer.pubkey !== principal ||
      foregroundAuth.signer.authMethod !== foregroundAuth.method
    )
      throw new Error(
        "Foreground relay auth requires the active account signer"
      )
  }
  assertForegroundAuthority()
  const relayAuthentication = foregroundAuth
    ? {
        expectedPubkey: principal,
        signer: foregroundAuth.signer,
        sessionScope: foregroundAuth.signer,
        waitForSignerVisibility: async (signal?: AbortSignal) => {
          assertForegroundAuthority()
          await (
            foregroundAuth.waitForSignerVisibility ??
            ((signal?: AbortSignal) =>
              waitForVisibleDocument(undefined, signal))
          )(signal)
          assertForegroundAuthority()
        },
      }
    : undefined
  const store = suppliedStore ?? new CommerceInboxStore(authorization)
  const rows = await store.database.commerceInboxDeliveries
    .where("accountPubkey")
    .equals(principal)
    .filter(
      (row) =>
        (options.replayAcknowledged || row.state !== "accepted") &&
        (!onlyId || row.id === store.key(onlyId))
    )
    .toArray()
  for (const row of rows) {
    store.assertCurrent()
    const id = row.id.slice(principal.length + 1)
    const claimant = crypto.randomUUID()
    const claimed = await store.database.transaction(
      "rw",
      store.database.commerceInboxDeliveries,
      async () => {
        store.assertCurrent()
        const current = await store.database.commerceInboxDeliveries.get(row.id)
        if (
          !current ||
          (!options.replayAcknowledged && current.state === "accepted") ||
          (current.claim && current.claim.expiresAt > Date.now())
        )
          return null
        await store.database.commerceInboxDeliveries.update(row.id, {
          claim: { owner: claimant, expiresAt: Date.now() + 60_000 },
        })
        return current
      }
    )
    if (!claimed) continue
    const claim = await holdPrivateDeliveryClaim(store, id)
    try {
      const job = await store.open<PrivateDeliveryJob>(claimed.value, id)
      for (const leg of job.legs) {
        const context = {
          senderPubkey: principal,
          accountPubkey: principal,
          authenticatedPubkey: principal,
          shouldContinue: () => {
            assertPrivateMessageSignerSessionCurrent(options.shouldContinue)
            assertForegroundAuthority()
            claim.assertCurrent()
            return true
          },
        }
        try {
          const targets = await privateDeliveryRetryTargets({
            ...context,
            leg: options.replayAcknowledged
              ? { ...leg, acknowledged: [] }
              : leg,
            resolveDeclaration,
          })
          if (!targets.length) continue
          await publishPrivateDeliveryLeg({
            ...context,
            leg: { ...leg, relayUrls: targets },
            publishFn: publisher,
            relayAuthentication,
            requireAck: false,
            onSettled: async (delivery) => {
              await recordPrivateDelivery(store, id, leg.event.id, delivery, {
                holdClaim: true,
              })
              if (delivery) attempts.set(leg.event.id, delivery)
            },
          })
          if (leg.recipientPubkey === principal) await store.receive(leg.event)
        } catch (error) {
          // Optional saved self-copy failure cannot change an acknowledged recipient.
          if (
            !id.endsWith(":self") &&
            !(job.legs.length > 1 && leg.recipientPubkey === principal)
          )
            throw error
        }
      }
    } finally {
      await claim.release()
    }
  }
  return attempts
}

export async function resumePrivateDelivery(
  store: CommerceInboxStore,
  rumorId: string,
  recipient: string,
  publisher = publishWithPlanner,
  onDeliveryStarting?: () => void | Promise<void>
) {
  const id = `delivery:${rumorId}`
  let row = await store.database.commerceInboxDeliveries.get(store.key(id))
  store.assertCurrent()
  if (!row) return null
  // A retained immutable send needs the same caller fence before recovery I/O.
  await onDeliveryStarting?.()
  if (row.state !== "accepted") {
    await retryPrivateDeliveries(store.principal, publisher, id, store)
    row = await store.database.commerceInboxDeliveries.get(store.key(id))
    store.assertCurrent()
  }
  if (!row) throw new Error("Saved delivery is unavailable")
  const job = await store.open<PrivateDeliveryJob>(row.value, id)
  const leg = job.legs.find((l) => l.recipientPubkey === recipient)
  if (!leg?.delivery || !leg.acknowledged.length)
    throw new Error(
      "Saved message is still waiting for recipient relay acceptance"
    )
  let self = job.legs.find(
    (l) => l.recipientPubkey === store.principal && l !== leg
  )
  const selfId = `${id}:self`
  try {
    await retryPrivateDeliveries(store.principal, publisher, selfId, store)
    const row = await store.database.commerceInboxDeliveries.get(
      store.key(selfId)
    )
    if (row)
      self = (await store.open<PrivateDeliveryJob>(row.value, selfId)).legs[0]
  } catch {
    // Recipient acceptance is independent of optional self-copy recovery.
  }
  return {
    wrappedToRecipient: leg.event,
    wrappedToSelf: self?.event ?? null,
    recipientDelivery: accumulatedDelivery(leg),
    selfDelivery: self?.delivery ? accumulatedDelivery(self) : null,
    selfDeliveryStatus: self
      ? self.acknowledged.length === self.relayUrls.length
        ? ("full_success" as const)
        : self.acknowledged.length
          ? ("partial_success" as const)
          : ("zero_success" as const)
      : null,
    selfCopyError:
      self && self.acknowledged.length !== self.relayUrls.length
        ? "Saved self-copy still needs relay acceptance"
        : null,
    deliveryRoute: leg.compatibility
      ? ("compatibility_order" as const)
      : ("declared_inbox" as const),
    deliveryStatus:
      leg.acknowledged.length === leg.relayUrls.length
        ? ("full_success" as const)
        : ("partial_success" as const),
    deliveryRelaySources:
      leg.relaySources ??
      Object.fromEntries(
        leg.relayUrls.map((url) => [
          url,
          leg.compatibility
            ? ("compatibility_registry" as const)
            : ("declared" as const),
        ])
      ),
    deliveryPlanTruncated: leg.truncated ?? false,
  }
}
export interface PublishPrivateMessageInput {
  /** Caller-built rumor (pubkey stamped); its kind must equal rumorKind. */
  rumor: PrivateMessageEvent
  senderPubkey: string
  recipientPubkey: string
  /**
   * Explicit signed-in account whose durable whole-relay exclusions apply to
   * discovery and delivery. Omit for guest/public sends; this is never inferred
   * from the rumor author or recipient.
   */
  accountPubkey?: string | null
  /**
   * Active authenticated account. Owner-selected ws:// authority is granted
   * only when this separately supplied identity, accountPubkey, and the
   * signer-verified sender are the same account.
   */
  authenticatedPubkey?: string | null
  /** Injectable durable-state reader for deterministic eligibility tests. */
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Live caller authority for recipient and sender declaration reads. */
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
  signer: NostrKeySigner
  rumorKind: 14 | 15 | 16 | 17
  /** Domain recovery evidence required by enrollment/handoff before publication.
   * Ordinary delivery never requires a self-wrap. This does not require its relay ACK.
   */
  requireSelfWrap?: boolean
  /** Store adapter for the account-owned outbox. */
  deliveryStore?: CommerceInboxStore
  /** Wrap a sender self-copy for local recovery. Default true. */
  selfCopy?: boolean
  refreshRelayLists?: boolean
  /** Skip foreground coordination for a caller-owned ephemeral guest signer. */
  signerInteraction?: "external" | "background_external" | "application_owned"
  /** External account method eligible to answer a foreground NIP-42 challenge. */
  relayAuthMethod?: "nip07" | "nip46"
  /** Controlled visibility seam for interactive external signer workflows. */
  waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  giftWrapFn?: typeof wrapPrivateMessage
  /**
   * Durable exact-retry seam. Runs after wrapping and before the first relay
   * write; callers may persist the signed ciphertext wraps, never plaintext.
   */
  onWrapped?: (prepared: PreparedPrivateMessageWraps) => void | Promise<void>
  /** Persist the exact merchant wrap and signed route before relay I/O. */
  onRecipientPrepared?: (
    prepared: PreparedPrivateMessageRecipientDelivery
  ) => void | Promise<void>
  /** Commit the attempt fence immediately before recipient relay I/O. */
  onRecipientPublishStarting?: (
    prepared: PreparedPrivateMessageRecipientDelivery
  ) => void | Promise<void>
  /**
   * Persist the first positive recipient relay ACK before an accepted-boundary
   * send may return to its caller.
   */
  onRecipientPublishAccepted?: (
    delivery: ProgressivePublishSnapshot
  ) => void | Promise<void>
  /** Persist terminal outcomes from the current recipient publish batch. */
  onRecipientPublishSettled?: (
    delivery: PublishWithPlannerResult | null
  ) => void | Promise<void>
  /** Best-effort local work after recipient acceptance and before optional self-copy. */
  onRecipientAccepted?: (
    delivery: PublishWithPlannerResult | ProgressivePublishSnapshot
  ) => void | Promise<void>
  /**
   * Durable caller fence immediately before recipient staging or saved-send
   * recovery. Readiness, wrapping and session checks precede this boundary;
   * checkpoint failure prevents staging/publication. No private data is passed.
   */
  onRecipientDeliveryStarting?: () => void | Promise<void>
  /**
   * Recipient/sender kind-10050 inbox relays. NIP-17 delivery is exclusive to
   * these declarations; an empty recipient list means the peer is not ready.
   */
  recipientInboxRelays?: readonly string[]
  senderInboxRelays?: readonly string[]
  /**
   * Legacy string[]-or-throw kind-10050 resolver seam (tests). This seam
   * cannot express a malformed declaration; when omitted, the typed
   * resolveInboxDeclaration path is used instead.
   */
  resolveInboxRelays?: (pubkey: string) => Promise<string[]>
  /** Controlled readiness seam for the sender-side kind-14 safety gate. */
  inspectOwnInboxReadiness?: (
    pubkey: string
  ) => Promise<OwnPrivateMessageRelayReadiness>
  /**
   * One-use capability for a recipient-only guest-order notification. It may
   * skip sender readiness, but cannot bypass recipient declaration routing.
   */
  validatedGuestOrderCompanionScope?: ValidatedGuestOrderCompanionScope
  /** Injectable relay publisher for focused transport tests. */
  publishFn?: typeof publishWithPlanner
  /**
   * Opt-in completion boundary for a durably staged initial order. All other
   * private messages retain the settled boundary.
   */
  recipientDeliveryBoundary?: "settled" | "accepted"
  /** Injectable progressive publisher for deterministic milestone tests. */
  publishProgressiveFn?: typeof publishWithPlannerProgressive
  /**
   * One-use capability for a validated kind-16 order lifecycle send (locally created
   * checkout/order or a validated inbound order with matching order identity
   * and counterparty). Enables the temporary compatibility order route
   * when the recipient has no usable declaration and the redeploy-controlled
   * flag is on. Kind-14 general DMs must not set this.
   */
  validatedOrderScope?: ValidatedOrderRouteScope
  /**
   * Override the compatibility lane gate and registry (tests/config seams).
   * Defaults to the repo-controlled deployment profile and
   * config.dmCompatibilityOrderRelayUrls.
   */
  compatibilityOrderRoute?: {
    enabled?: boolean
    relayUrls?: readonly string[]
    maxRelays?: number
  }
  /** Test seam for recipient-specific, signed NIP-65 read evidence. */
  resolveCompatibilityRecipientReadRelays?: (
    pubkey: string
  ) => Promise<readonly string[]>
  /** Browser app emitting the fixed-label compatibility rollout counter. */
  telemetryApp?: ConduitTelemetryApp
  /** Content-free test/adapter seam; exceptions are ignored. */
  onNip17CompatibilityOutcome?: (
    outcome: Nip17CompatibilityResultTelemetryInput
  ) => void
}

function assertPrivateMessageSignerSessionCurrent(
  shouldContinue: (() => boolean) | undefined
): void {
  if (shouldContinue?.() === false) {
    throw new Error("Private message signer session changed.")
  }
}

function createInteractionGatedSigner(
  signer: NostrKeySigner,
  waitForSignerVisibility: (() => Promise<void>) | undefined,
  shouldContinue: (() => boolean) | undefined
): NostrKeySigner {
  const beforeSignerOperation = async () => {
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
    await waitForSignerVisibility?.()
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
  }
  const afterSignerOperation = () => {
    assertPrivateMessageSignerSessionCurrent(shouldContinue)
  }

  return new Proxy(signer, {
    get(target, property) {
      if (property === "getPublicKey") {
        return async (...args: Parameters<NostrKeySigner["getPublicKey"]>) => {
          await beforeSignerOperation()
          const result = await target.getPublicKey(...args)
          afterSignerOperation()
          return result
        }
      }
      if (property === "signEvent") {
        return async (...args: Parameters<NostrKeySigner["signEvent"]>) => {
          await beforeSignerOperation()
          const result = await target.signEvent(...args)
          afterSignerOperation()
          return result
        }
      }
      if (property === "encryptNip44") {
        return async (...args: Parameters<NostrKeySigner["encryptNip44"]>) => {
          await beforeSignerOperation()
          const result = await target.encryptNip44(...args)
          afterSignerOperation()
          return result
        }
      }

      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export interface PreparedPrivateMessageWraps {
  rumorId: string
  wrappedToRecipient: SignedPublicNostrEvent
  wrappedToSelf: SignedPublicNostrEvent | null
}

export interface PreparedPrivateMessageRecipientDelivery {
  rumorId: string
  wrappedToRecipient: SignedPublicNostrEvent
  deliveryRoute: OrderDeliveryRoute
  routingAuthority?: OrderRelayRoutingAuthority
  compatibilityPlan?: OrderRelayCompatibilityPlan
  relayPlan: Array<{
    relayUrl: string
    source: "declared" | "recipient_nip65" | "compatibility_registry"
  }>
}

export interface PublishPrivateMessageResult {
  wrappedToRecipient: SignedPublicNostrEvent
  wrappedToSelf: SignedPublicNostrEvent | null
  /** Exact content-free planner result for the self-copy leg, when attempted. */
  selfDelivery: PublishWithPlannerResult | null
  /** Exact ACK completeness for the attempted self-copy leg. */
  selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null
  /** Non-null when the non-critical self-copy leg needs retry. */
  selfCopyError: string | null
  /** Lane used for the critical recipient leg. */
  deliveryRoute: Exclude<PrivateMessageDeliveryRoute, "blocked">
  /** Full per-relay result for the critical recipient leg. */
  recipientDelivery: Awaited<ReturnType<typeof publishWithPlanner>>
  deliveryStatus: "full_success" | "partial_success"
  deliveryRelaySources: DeliveryRouteSelection["relaySources"]
  deliveryPlanTruncated: boolean
  /** A post-ACK local checkpoint failed; recipient acceptance still stands. */
  checkpointFailure?: true
  /** Present for a real signed kind-16 recipient wrap; content-safe and local. */
  orderRelayDelivery?: OrderRelayDeliveryRecord
  /**
   * Memoized, caller-started recovery work for an accepted initial order.
   * It never creates or republishes the semantic merchant order.
   */
  startPostAcceptanceWork?: () => Promise<PrivateMessagePostAcceptanceResult>
}

export interface PrivateMessagePostAcceptanceResult {
  wrappedToSelf: SignedPublicNostrEvent | null
  selfDelivery: PublishWithPlannerResult | null
  selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null
  selfCopyError: string | null
}

export type PrivateMessageSelfDeliveryStatus =
  "zero_success" | "partial_success" | "full_success"

export function summarizePrivateMessageSelfDelivery(
  delivery: PublishWithPlannerResult
): {
  status: PrivateMessageSelfDeliveryStatus
  error: string | null
} {
  if (
    Array.isArray(delivery.successfulRelayUrls) &&
    delivery.successfulRelayUrls.length === 0
  ) {
    return {
      status: "zero_success",
      error: "Sender self-copy received no relay ACK.",
    }
  }
  if (
    Array.isArray(delivery.failedRelayUrls) &&
    delivery.failedRelayUrls.length > 0
  ) {
    return {
      status: "partial_success",
      error: "Sender self-copy reached only part of its inbox relay set.",
    }
  }
  return { status: "full_success", error: null }
}

function isCanonicalInitialOrderRumor(rumor: PrivateMessageEvent): boolean {
  const typeTags = rumor.tags.filter((tag) => tag[0] === "type")
  return (
    typeTags.length === 1 && ["order", "1"].includes(typeTags[0]?.[1] ?? "")
  )
}

const ORDER_RELAY_RETRY_RETENTION_MS = 24 * 60 * 60 * 1_000

export type PrivateMessageRelayReadinessReason =
  | "sender_not_ready"
  | "recipient_not_ready"
  | "recipient_relays_excluded"
  | "recipient_lookup_failed"
  | "recipient_declaration_distribution_pending"
  | "recipient_declaration_signed_empty"
  | "recipient_declaration_malformed"

const READINESS_MESSAGES: Record<PrivateMessageRelayReadinessReason, string> = {
  sender_not_ready:
    "Your current NIP-17 inbox declaration is not ready for direct messages.",
  recipient_not_ready:
    "No usable recipient NIP-17 inbox declaration was found on the relays checked.",
  recipient_relays_excluded:
    "Recipient inbox relays are excluded by your Network settings.",
  recipient_lookup_failed: "Recipient inbox relay discovery failed.",
  recipient_declaration_distribution_pending:
    "Recipient inbox declaration has not been confirmed on discovery relays.",
  recipient_declaration_signed_empty:
    "Recipient's signed inbox declaration lists no relays.",
  recipient_declaration_malformed:
    "Recipient inbox relay declaration is unusable.",
}

export class PrivateMessageRelayReadinessError extends Error {
  readonly reason: PrivateMessageRelayReadinessReason

  constructor(reason: PrivateMessageRelayReadinessReason) {
    super(READINESS_MESSAGES[reason])
    this.name = "PrivateMessageRelayReadinessError"
    this.reason = reason
  }
}

function recordValidatedOrderCompatibilityOutcome(
  input: PublishPrivateMessageInput,
  validatedOrder: boolean,
  outcome: Pick<
    Nip17CompatibilityResultTelemetryInput,
    "declarationClass" | "deliveryRoute" | "ackOutcome"
  > & {
    blockReason?: Nip17CompatibilityResultTelemetryInput["blockReason"]
  }
): void {
  if (!validatedOrder || input.shouldContinue?.() === false) return
  const telemetryOutcome: Nip17CompatibilityResultTelemetryInput = {
    ...outcome,
    action: "order_delivery",
    repairOutcome: "not_applicable",
    blockReason: outcome.blockReason ?? "not_applicable",
  }
  try {
    input.onNip17CompatibilityOutcome?.(telemetryOutcome)
  } catch {
    // Diagnostics are best-effort and must never affect message delivery.
  }
  if (!input.telemetryApp) return
  recordBrowserTelemetryEvent({
    app: input.telemetryApp,
    eventName: "nip17_compatibility_result",
    properties:
      buildNip17CompatibilityResultTelemetryProperties(telemetryOutcome),
  })
}

function buildRecoverableRecipientRoutingAuthority(input: {
  recipientPubkey: string
  declaration: InboxDeclarationResolution
  route: DeliveryRouteSelection
}): OrderRelayRoutingAuthority | null {
  const eventId = input.declaration.eventId?.trim().toLowerCase()
  const eventCreatedAt = input.declaration.eventCreatedAt
  const pubkey = input.recipientPubkey.trim().toLowerCase()
  if (
    input.route.route !== "declared_inbox" ||
    input.declaration.state !== "declared" ||
    !eventId ||
    !/^[0-9a-f]{64}$/.test(eventId) ||
    !Number.isSafeInteger(eventCreatedAt) ||
    (eventCreatedAt ?? -1) < 0 ||
    input.route.relayUrls.length === 0 ||
    input.route.relayUrls.some(
      (relayUrl) => input.route.relaySources[relayUrl] !== "declared"
    )
  ) {
    return null
  }

  return {
    eventId,
    eventCreatedAt: eventCreatedAt!,
    pubkey,
    kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
    relayUrls: [...input.route.relayUrls],
  }
}

/**
 * Gift-wrap a rumor to the recipient (critical) and optionally to the sender as
 * a self-copy (non-critical), publishing both through the shared relay planner.
 * Kind 14 and kind 16 sends share this primitive; the caller owns local caching.
 */
export async function publishPrivateMessage(
  input: PublishPrivateMessageInput
): Promise<PublishPrivateMessageResult> {
  if (input.rumor.kind !== input.rumorKind)
    throw new Error("Private message rumor kind does not match requested kind")
  if (![14, 15, 16, 17].includes(input.rumor.kind))
    throw new Error("Unsupported private message rumor kind")

  const senderPubkey = input.senderPubkey.trim().toLowerCase()
  const recipientPubkey = input.recipientPubkey.trim().toLowerCase()
  let accountPubkey: string | null = null
  if (input.accountPubkey !== undefined && input.accountPubkey !== null) {
    accountPubkey = normalizeAccountNetworkPubkey(input.accountPubkey)
    if (!accountPubkey) {
      throw new Error("Private message account pubkey is invalid")
    }
    if (accountPubkey !== senderPubkey) {
      throw new Error("Private message account does not match sender")
    }
  }
  if (input.rumor.pubkey?.trim().toLowerCase() !== senderPubkey) {
    throw new Error("Private message rumor author does not match sender")
  }
  assertPrivateMessageFitsTransport({
    pubkey: senderPubkey,
    kind: input.rumorKind,
    created_at: input.rumor.created_at ?? Math.floor(Date.now() / 1000),
    tags: input.rumor.tags,
    content: input.rumor.content,
  })
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  const signerPubkey = (await input.signer.getPublicKey()).trim().toLowerCase()
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  if (signerPubkey !== senderPubkey) {
    throw new Error("Private message signer does not match sender")
  }
  const suppliedAuthenticatedPubkey = input.authenticatedPubkey
    ? normalizeAccountNetworkPubkey(input.authenticatedPubkey)
    : null
  const authenticatedOwnerPubkey =
    accountPubkey &&
    suppliedAuthenticatedPubkey === accountPubkey &&
    signerPubkey === accountPubkey
      ? accountPubkey
      : null
  if (
    recipientPubkey !== senderPubkey &&
    !input.rumor.tags.some(
      (tag) =>
        tag[0] === "p" && tag[1]?.trim().toLowerCase() === recipientPubkey
    )
  ) {
    throw new Error(
      "Private message rumor recipient does not match delivery recipient"
    )
  }

  const participants = [
    ...new Set(
      input.rumor.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1]?.trim().toLowerCase())
    ),
  ]
  if (
    participants.length !== 1 ||
    !participants[0] ||
    !/^[0-9a-f]{64}$/.test(participants[0]) ||
    (recipientPubkey !== senderPubkey && participants[0] !== recipientPubkey)
  )
    throw new Error("Private messages require one explicit counterparty")

  const originalId = input.rumor.id
  const stableRumor = createPrivateMessageRumor(
    completePrivateMessageEvent(input.rumor)
  )
  if (originalId && originalId !== stableRumor.id)
    throw new Error("Private message rumor id does not match its content")
  input = { ...input, rumor: stableRumor }

  const currentDeliveryAuthorization = authenticatedOwnerPubkey
    ? getProtectedReadAuthorization(authenticatedOwnerPubkey)
    : null
  if (
    currentDeliveryAuthorization &&
    input.recipientDeliveryBoundary !== "accepted"
  ) {
    const resumed = await resumePrivateDelivery(
      input.deliveryStore ??
        new CommerceInboxStore(currentDeliveryAuthorization),
      stableRumor.id,
      recipientPubkey,
      input.publishFn,
      input.onRecipientDeliveryStarting
    )
    if (resumed) return resumed
  }
  const giftWrapFn = input.giftWrapFn ?? wrapPrivateMessage
  const selfCopy = input.selfCopy ?? true
  const refreshRelayLists = input.refreshRelayLists ?? true
  const wrapParams = { rumorKind: input.rumorKind }
  const publishFn = input.publishFn ?? publishWithPlanner
  const publishProgressiveFn =
    input.publishProgressiveFn ?? publishWithPlannerProgressive
  const validatedGuestOrderCompanion = consumeValidatedGuestOrderCompanionScope(
    {
      scope: input.validatedGuestOrderCompanionScope,
      rumor: input.rumor,
      senderPubkey,
      recipientPubkey,
      selfCopy,
    }
  )

  // NIP-17 delivery is exclusive to the recipient's declared inbox. The only
  // exception is the temporary compatibility route for validated kind-16
  // order traffic (CND-208); a valid declaration always outranks it.
  const validatedOrder = consumeValidatedOrderRouteScope({
    scope: input.validatedOrderScope,
    rumor: input.rumor,
    senderPubkey,
    recipientPubkey,
  })
  const progressiveRecipientDelivery =
    input.recipientDeliveryBoundary === "accepted"
  if (
    progressiveRecipientDelivery &&
    (!validatedOrder ||
      !isCanonicalInitialOrderRumor(input.rumor) ||
      !input.onRecipientPrepared ||
      !input.onRecipientPublishStarting ||
      !input.onRecipientPublishAccepted ||
      !input.onRecipientPublishSettled)
  ) {
    throw new Error(
      "Accepted delivery requires a durably staged initial order send."
    )
  }
  const resolvedRecipientDeclaration = await resolveDeclarationForSend(
    input.recipientPubkey,
    input.recipientInboxRelays,
    input.resolveInboxRelays,
    false,
    accountPubkey,
    authenticatedOwnerPubkey,
    input.accountNetworkLocalStateRepository,
    input.shouldContinue
  )
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  const recipientDeclaration = await applyAccountRelayEligibilityToDeclaration(
    resolvedRecipientDeclaration,
    accountPubkey,
    authenticatedOwnerPubkey,
    input.accountNetworkLocalStateRepository
  )
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  if (
    resolvedRecipientDeclaration.state === "declared" &&
    resolvedRecipientDeclaration.relayUrls.length > 0 &&
    recipientDeclaration.relayUrls.length === 0
  ) {
    // Keep a valid kind:10050 declaration authoritative even when local policy
    // excludes every target. Do not reinterpret it as missing and activate the
    // non-standard compatibility lane.
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: "declared",
      deliveryRoute: "blocked",
      ackOutcome: "not_applicable",
      blockReason: "recipient_relays_excluded",
    })
    throw new PrivateMessageRelayReadinessError("recipient_relays_excluded")
  }
  const compatibilityRecipientReadRelays =
    validatedOrder && recipientDeclaration.state !== "declared"
      ? await resolveCompatibilityRecipientReadRelays(
          input.recipientPubkey,
          input.resolveCompatibilityRecipientReadRelays
        )
      : []
  const recipientRoute = selectPrivateMessageDeliveryRoute({
    rumorKind: input.rumorKind === 16 ? 16 : 14,
    declaration: recipientDeclaration,
    validatedOrder,
    compatibilityEnabled: input.compatibilityOrderRoute?.enabled,
    compatibilityRelayUrls: input.compatibilityOrderRoute?.relayUrls,
    recipientReadRelayUrls: compatibilityRecipientReadRelays,
    maxCompatibilityRelays: input.compatibilityOrderRoute?.maxRelays,
  })
  if (recipientRoute.route === "blocked") {
    const readinessReason: PrivateMessageRelayReadinessReason =
      recipientRoute.blockedReason === "declaration_malformed"
        ? "recipient_declaration_malformed"
        : recipientRoute.blockedReason === "declaration_signed_empty"
          ? "recipient_declaration_signed_empty"
          : recipientRoute.blockedReason === "declaration_distribution_pending"
            ? "recipient_declaration_distribution_pending"
            : (recipientRoute.blockedReason ?? "recipient_not_ready")
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: "blocked",
      ackOutcome: "not_applicable",
      blockReason: readinessReason,
    })
    throw new PrivateMessageRelayReadinessError(readinessReason)
  }
  const recoverableRoutingAuthority = buildRecoverableRecipientRoutingAuthority(
    {
      recipientPubkey,
      declaration: recipientDeclaration,
      route: recipientRoute,
    }
  )
  const recoverableCompatibilityPlan =
    validatedOrder &&
    recipientRoute.route === "compatibility_order" &&
    isApprovedCompatibilityOrderRelayPlan(recipientRoute.relayUrls)
      ? { relayUrls: [...recipientRoute.relayUrls] }
      : null
  const recoverableDeliveryRequested = Boolean(
    input.onRecipientPrepared ||
    input.onRecipientPublishStarting ||
    input.onRecipientPublishSettled
  )
  if (
    recoverableDeliveryRequested &&
    !recoverableRoutingAuthority &&
    !recoverableCompatibilityPlan
  ) {
    throw new Error(
      "Recoverable order delivery requires a validated recipient relay plan."
    )
  }

  let senderReadyRelays: string[] | null = null
  if (input.rumorKind !== EVENT_KINDS.ORDER && !validatedGuestOrderCompanion) {
    const senderReadiness = await (
      input.inspectOwnInboxReadiness ??
      inspectRetainedOwnPrivateMessageRelayReadiness
    )(senderPubkey)
    if (senderReadiness.state !== "ready") {
      throw new PrivateMessageRelayReadinessError("sender_not_ready")
    }
    const senderRelayUrls = await filterRelayUrlsForAccount(
      senderReadiness.relayUrls,
      accountPubkey,
      authenticatedOwnerPubkey,
      input.accountNetworkLocalStateRepository,
      senderReadiness.relayUrls
    )
    if (senderRelayUrls.length === 0) {
      throw new PrivateMessageRelayReadinessError("sender_not_ready")
    }
    senderReadyRelays = senderRelayUrls
  }
  const resolveSenderRoute =
    async (): Promise<DeliveryRouteSelection | null> => {
      if (senderReadyRelays)
        return selectPrivateMessageDeliveryRoute({
          rumorKind: 14,
          declaration: {
            pubkey: senderPubkey,
            state: "declared",
            relayUrls: senderReadyRelays,
            stale: false,
            fetchedAt: Date.now(),
          },
          validatedOrder: false,
          authenticatedOwnerPubkey,
          ownerSelectedRelayUrls: senderReadyRelays,
        })
      if (!selfCopy) return null

      const senderDeclaration = await resolveDeclarationForSend(
        input.senderPubkey,
        input.senderInboxRelays,
        input.resolveInboxRelays,
        true,
        accountPubkey,
        authenticatedOwnerPubkey,
        input.accountNetworkLocalStateRepository,
        input.shouldContinue
      )
      // The compatibility lane is recipient-only: the non-critical sender self-copy
      // stays strict and fails soft instead of writing to compatibility relays.
      return selectPrivateMessageDeliveryRoute({
        rumorKind: input.rumorKind === 16 ? 16 : 14,
        declaration: senderDeclaration,
        validatedOrder: false,
        authenticatedOwnerPubkey,
        ownerSelectedRelayUrls: senderDeclaration.relayUrls,
      })
    }
  const externalSignerInteraction =
    (input.signerInteraction ?? "background_external") === "external"
  const waitForSignerVisibility =
    input.waitForSignerVisibility ??
    ((signal?: AbortSignal) => waitForVisibleDocument(undefined, signal))
  const giftWrapSigner =
    externalSignerInteraction || input.shouldContinue
      ? createInteractionGatedSigner(
          input.signer,
          externalSignerInteraction
            ? () => waitForSignerVisibility()
            : undefined,
          input.shouldContinue
        )
      : input.signer
  const relayAuthentication =
    externalSignerInteraction &&
    authenticatedOwnerPubkey &&
    input.relayAuthMethod &&
    input.signer.authMethod === input.relayAuthMethod
      ? {
          expectedPubkey: authenticatedOwnerPubkey,
          signer: input.signer,
          sessionScope: input.signer,
          waitForSignerVisibility,
        }
      : undefined

  const deliveryAuthorization = authenticatedOwnerPubkey
    ? getProtectedReadAuthorization(authenticatedOwnerPubkey)
    : null
  const deliveryStore =
    input.deliveryStore ??
    (deliveryAuthorization
      ? new CommerceInboxStore(deliveryAuthorization)
      : null)
  if (deliveryStore && deliveryStore.principal !== senderPubkey)
    throw new Error("Private delivery belongs to another account")
  const assertCurrent = () => {
    assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
    deliveryStore?.assertCurrent()
  }
  try {
    assertCurrent()
    const wrappedToRecipient = await giftWrapFn(
      input.rumor,
      { pubkey: recipientPubkey },
      giftWrapSigner,
      wrapParams
    )
    assertCurrent()
    // Only callers whose authenticated recovery evidence requires this ciphertext
    // may make a self-wrap part of their durable pre-publish transaction.
    const requiredSelfWrap = input.requireSelfWrap
      ? await giftWrapFn(
          input.rumor,
          { pubkey: senderPubkey },
          giftWrapSigner,
          wrapParams
        )
      : null
    assertCurrent()
    const preparedRecipientDelivery: PreparedPrivateMessageRecipientDelivery | null =
      recoverableRoutingAuthority || recoverableCompatibilityPlan
        ? {
            rumorId: input.rumor.id,
            wrappedToRecipient,
            deliveryRoute: recipientRoute.route as OrderDeliveryRoute,
            ...(recoverableRoutingAuthority
              ? { routingAuthority: recoverableRoutingAuthority }
              : {}),
            ...(recoverableCompatibilityPlan
              ? { compatibilityPlan: recoverableCompatibilityPlan }
              : {}),
            relayPlan: recipientRoute.relayUrls.map((relayUrl) => ({
              relayUrl,
              source: recipientRoute.relaySources[relayUrl] ?? "declared",
            })),
          }
        : null
    if (preparedRecipientDelivery) {
      await input.onRecipientPrepared?.(preparedRecipientDelivery)
    }

    await input.onWrapped?.({
      rumorId: input.rumor.id,
      wrappedToRecipient,
      wrappedToSelf: requiredSelfWrap,
    })
    assertCurrent()
    if (preparedRecipientDelivery)
      await input.onRecipientPublishStarting?.(preparedRecipientDelivery)
    assertCurrent()

    const recipientLeg = deliveryLeg(
      recipientPubkey,
      wrappedToRecipient,
      recipientRoute
    )
    const context = {
      senderPubkey,
      accountPubkey,
      authenticatedPubkey: authenticatedOwnerPubkey,
      accountNetworkLocalStateRepository:
        input.accountNetworkLocalStateRepository,
      refreshRelayLists,
      relayAuthentication,
      shouldContinue: input.shouldContinue,
      publishFn,
    }
    let checkpointFailure = false
    const recipientDelivery = await stageAndPublishPrivateLeg({
      ...context,
      onDeliveryStarting: input.onRecipientDeliveryStarting,
      rumorId: stableRumor.id,
      leg: recipientLeg,
      // Accepted-order staging and retry stay in the domain transaction.
      store: progressiveRecipientDelivery ? null : deliveryStore,
      ...(progressiveRecipientDelivery
        ? { publishProgressiveFn, onAccepted: input.onRecipientPublishAccepted }
        : {}),
      onSettled: preparedRecipientDelivery
        ? input.onRecipientPublishSettled
        : undefined,
      ...(input.onRecipientAccepted
        ? {
            onAcceptedCheckpointFailure: () => {
              checkpointFailure = true
            },
          }
        : {}),
    })
    const deliveryStatus =
      (recipientDelivery.failedRelayUrls?.length ?? 0) ||
      ("pendingRelayUrls" in recipientDelivery &&
        recipientDelivery.pendingRelayUrls.length)
        ? ("partial_success" as const)
        : ("full_success" as const)
    if (
      input.onRecipientAccepted &&
      recipientDelivery.successfulRelayUrls?.length
    ) {
      try {
        await input.onRecipientAccepted?.(recipientDelivery)
      } catch {
        // Expose the local failure without turning acceptance into a resend.
        checkpointFailure = true
      }
    }
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: recipientRoute.route,
      ackOutcome: deliveryStatus === "partial_success" ? "partial" : "positive",
    })
    const orderRelayDelivery =
      input.rumorKind === EVENT_KINDS.ORDER
        ? buildOrderRelayDeliveryRecord({
            rumorId: stableRumor.id,
            wrappedToRecipient,
            recipientRoute,
            recipientDelivery,
            routingAuthority: recoverableRoutingAuthority,
            compatibilityPlan: recoverableCompatibilityPlan,
          })
        : undefined
    let postAcceptanceWork: Promise<PrivateMessagePostAcceptanceResult> | null =
      null
    const startPostAcceptanceWork = () =>
      (postAcceptanceWork ??= (async () => {
        let wrappedToSelf = requiredSelfWrap
        let selfDelivery: PublishWithPlannerResult | null = null
        let selfDeliveryStatus: PrivateMessageSelfDeliveryStatus | null = null
        let selfCopyError: string | null = null
        if (selfCopy) {
          try {
            assertCurrent()
            const route = await resolveSenderRoute()
            assertCurrent()
            if (!route || route.route === "blocked")
              throw new Error(
                "Sender has no usable NIP-17 inbox relay declaration."
              )
            wrappedToSelf ??= await giftWrapFn(
              input.rumor,
              { pubkey: senderPubkey },
              giftWrapSigner,
              wrapParams
            )
            assertCurrent()
            const leg = deliveryLeg(senderPubkey, wrappedToSelf, route)
            selfDelivery = await stageAndPublishPrivateLeg({
              ...context,
              rumorId: stableRumor.id,
              leg,
              selfCopy: true,
              store: deliveryStore,
              requireAck: false,
            })
            const summary = summarizePrivateMessageSelfDelivery(selfDelivery)
            selfDeliveryStatus = summary.status
            selfCopyError = summary.error
            if (deliveryStore) await deliveryStore.receive(wrappedToSelf)
          } catch (error) {
            let sessionChanged: boolean
            try {
              sessionChanged = input.shouldContinue?.() === false
            } catch {
              // A revoked session guard may throw; recipient acceptance stands.
              sessionChanged = true
            }
            selfCopyError = sessionChanged
              ? "Sender self-copy was skipped because the signer session changed after recipient delivery."
              : error instanceof Error
                ? error.message
                : "Self-copy failed"
          }
        }
        return {
          wrappedToSelf,
          selfDelivery,
          selfDeliveryStatus,
          selfCopyError,
        }
      })())
    const result = {
      wrappedToRecipient,
      wrappedToSelf: null,
      selfDelivery: null,
      selfDeliveryStatus: null,
      selfCopyError: null,
      deliveryRoute: recipientRoute.route,
      recipientDelivery,
      deliveryStatus,
      deliveryRelaySources: recipientRoute.relaySources,
      deliveryPlanTruncated: recipientRoute.truncated,
      ...(checkpointFailure ? { checkpointFailure: true as const } : {}),
      orderRelayDelivery,
    }
    return progressiveRecipientDelivery
      ? { ...result, startPostAcceptanceWork }
      : { ...result, ...(await startPostAcceptanceWork()) }
  } catch (error) {
    recordValidatedOrderCompatibilityOutcome(input, validatedOrder, {
      declarationClass: recipientDeclaration.state,
      deliveryRoute: recipientRoute.route,
      ackOutcome:
        error instanceof RelayPublishDiagnosticsError &&
        error.diagnostics.attemptedRelayUrls.length
          ? "zero"
          : "unavailable",
    })
    throw error
  }
}

function buildOrderRelayDeliveryRecord(input: {
  rumorId: string
  wrappedToRecipient: SignedPublicNostrEvent
  recipientRoute: DeliveryRouteSelection
  recipientDelivery:
    Awaited<ReturnType<typeof publishWithPlanner>> | ProgressivePublishSnapshot
  routingAuthority: OrderRelayRoutingAuthority | null
  compatibilityPlan: OrderRelayCompatibilityPlan | null
}): OrderRelayDeliveryRecord | undefined {
  const route = input.recipientRoute.route
  if (
    (route === "declared_inbox" && !input.routingAuthority) ||
    (route === "compatibility_order" && !input.compatibilityPlan) ||
    (route !== "declared_inbox" && route !== "compatibility_order")
  ) {
    return undefined
  }
  let signedRecipientWrap: SignedPublicNostrEvent
  try {
    signedRecipientWrap = input.wrappedToRecipient as SignedPublicNostrEvent
  } catch {
    return undefined
  }
  if (!isValidSignedPublicNostrEvent(signedRecipientWrap)) return undefined

  const now = Date.now()
  const relayDelivery = input.recipientRoute.relayUrls.map((relayUrl) => {
    const outcome = getRelayPublishTargetStatus(
      input.recipientDelivery,
      relayUrl
    )
    const status: OrderRelayDeliveryStatus = outcome
    const acked = status === "acked"
    const rejected = status === "rejected"
    return {
      relayUrl,
      source: input.recipientRoute.relaySources[relayUrl] ?? "declared",
      status,
      attemptCount: 1,
      lastAttemptAt: now,
      ...(acked ? { acknowledgedAt: now } : {}),
      ...(rejected ? { rejectedAt: now } : {}),
      ...(status === "timed_out" ? { timedOutAt: now } : {}),
    }
  })

  return {
    rumorId: input.rumorId,
    signedRecipientWrap,
    route,
    ...(input.routingAuthority
      ? { routingAuthority: structuredClone(input.routingAuthority) }
      : {}),
    ...(input.compatibilityPlan
      ? { compatibilityPlan: structuredClone(input.compatibilityPlan) }
      : {}),
    relayDelivery,
    deliveryAttemptCount: 1,
    retryCount: 0,
    nextRetryAt: relayDelivery.some(
      (delivery) =>
        delivery.status !== "acked" && delivery.status !== "policy_blocked"
    )
      ? now + 15_000
      : undefined,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ORDER_RELAY_RETRY_RETENTION_MS,
  }
}

async function resolveCompatibilityRecipientReadRelays(
  pubkey: string,
  seam?: (pubkey: string) => Promise<readonly string[]>
): Promise<readonly string[]> {
  if (seam) return await seam(pubkey)
  try {
    const lists = await getRelayLists([pubkey], { cacheOnly: true })
    return lists.get(pubkey.trim())?.readRelayUrls ?? []
  } catch {
    return []
  }
}

/**
 * Resolve the declaration for one send leg. Precedence: caller-known relays,
 * then the legacy string[] seam (tests), then the typed resolver. The typed
 * default preserves the malformed state so it can block writes.
 */
async function resolveDeclarationForSend(
  pubkey: string,
  knownRelayUrls: readonly string[] | undefined,
  legacySeam: ((pubkey: string) => Promise<string[]>) | undefined,
  allowLocalRelayUrls = false,
  requestingAccountPubkey: string | null = null,
  authenticatedPubkey: string | null = null,
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >,
  shouldContinue?: PublicRelayReadOptions["shouldContinue"]
): Promise<InboxDeclarationResolution> {
  const key = pubkey.trim().toLowerCase()
  if (knownRelayUrls) {
    return declarationFromKnownRelays(key, knownRelayUrls, allowLocalRelayUrls)
  }
  if (legacySeam) {
    return resolveDeclarationViaSeam(pubkey, legacySeam, allowLocalRelayUrls)
  }
  return resolveInboxDeclaration(pubkey, {
    allowLocalRelayUrlsForPubkey: allowLocalRelayUrls ? pubkey : null,
    requestingAccountPubkey,
    authenticatedPubkey,
    accountNetworkLocalStateRepository,
    shouldContinue,
  })
}

async function filterRelayUrlsForAccount(
  relayUrls: readonly string[],
  accountPubkey: string | null,
  authenticatedPubkey: string | null,
  repository?: Pick<AccountNetworkLocalStateRepository, "get">,
  ownerSelectedRelayUrls: readonly string[] = []
): Promise<string[]> {
  return accountPubkey
    ? await filterEligibleAccountRelayUrls({
        accountPubkey,
        authenticatedPubkey,
        candidateRelayUrls: relayUrls,
        ownerSelectedRelayUrls,
        repository,
      })
    : [...relayUrls]
}

async function applyAccountRelayEligibilityToDeclaration(
  declaration: InboxDeclarationResolution,
  accountPubkey: string | null,
  authenticatedPubkey: string | null,
  repository?: Pick<AccountNetworkLocalStateRepository, "get">
): Promise<InboxDeclarationResolution> {
  if (declaration.state !== "declared" || !accountPubkey) return declaration
  return {
    ...declaration,
    relayUrls: await filterRelayUrlsForAccount(
      declaration.relayUrls,
      accountPubkey,
      authenticatedPubkey,
      repository
    ),
  }
}

/**
 * Treat caller-supplied inbox relays as an authoritative declaration state.
 * Owner context may retain explicit ws:// selections; recipient context stays
 * remote-safe. A nonempty unusable list is malformed rather than absent.
 */
function declarationFromKnownRelays(
  pubkey: string,
  relayUrls: readonly string[],
  allowLocalRelayUrls: boolean
): InboxDeclarationResolution {
  const eligible = allowLocalRelayUrls
    ? normalizeOwnerSelectedRelayUrls(relayUrls)
    : publicRelayHintUrls(relayUrls)
  const state =
    eligible.length > 0
      ? "declared"
      : relayUrls.length > 0
        ? "malformed"
        : "not_observed"
  return {
    pubkey,
    state,
    relayUrls: eligible,
    stale: false,
    fetchedAt: Date.now(),
  }
}

/**
 * Adapt the legacy string[]-or-throw inbox resolver seam into the typed
 * declaration model. A thrown "incomplete" lookup maps to lookup_partial;
 * any other failure maps to lookup_unavailable.
 */
async function resolveDeclarationViaSeam(
  pubkey: string,
  resolveInboxRelays: (pubkey: string) => Promise<string[]>,
  allowLocalRelayUrls: boolean
): Promise<InboxDeclarationResolution> {
  const key = pubkey.trim().toLowerCase()
  try {
    const relayUrls = await resolveInboxRelays(pubkey)
    return declarationFromKnownRelays(key, relayUrls, allowLocalRelayUrls)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    return {
      pubkey: key,
      state: message.includes("incomplete")
        ? "lookup_partial"
        : "lookup_unavailable",
      relayUrls: [],
      stale: false,
      fetchedAt: Date.now(),
    }
  }
}

function deliveryLeg(
  recipientPubkey: string,
  event: SignedPublicNostrEvent,
  route: DeliveryRouteSelection
): PrivateDeliveryLeg {
  return {
    recipientPubkey,
    event,
    relayUrls: [...route.relayUrls],
    ownerSelectedRelayUrls: [...route.ownerSelectedRelayUrls],
    compatibility: route.route === "compatibility_order",
    relaySources: { ...route.relaySources },
    truncated: route.truncated,
    acknowledged: [],
    failed: [],
  }
}

type PrivateDeliveryContext = Pick<
  PublishPrivateMessageInput,
  | "accountPubkey"
  | "authenticatedPubkey"
  | "accountNetworkLocalStateRepository"
  | "shouldContinue"
  | "refreshRelayLists"
  | "publishFn"
>

/** One transport/ACK policy for fresh sends and domain-owned exact-wrap replay.
 * Callers supply a persisted leg and domain checkpoints, never another publish loop.
 */
export async function publishPrivateDeliveryLeg(
  input: PrivateDeliveryContext & {
    senderPubkey: string
    leg: PrivateDeliveryLeg
    relayAuthentication?: Parameters<
      typeof publishWithPlanner
    >[1]["relayAuthentication"]
    publishProgressiveFn?: typeof publishWithPlannerProgressive
    onAccepted?: (snapshot: ProgressivePublishSnapshot) => void | Promise<void>
    onSettled?: (
      delivery: PublishWithPlannerResult | null
    ) => void | Promise<void>
    onAcceptedCheckpointFailure?: () => void
    requireAck?: boolean
  }
): Promise<PublishWithPlannerResult | ProgressivePublishSnapshot> {
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  const leg = input.leg
  const options: Parameters<typeof publishWithPlanner>[1] = {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    accountPubkey: input.accountPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    recipientPubkeys: [leg.recipientPubkey],
    exclusiveRelayUrls: leg.relayUrls,
    ownerSelectedRelayUrls: leg.ownerSelectedRelayUrls,
    appRelayUrls: leg.compatibility ? leg.relayUrls : [],
    personalRelayUrls: [],
    independentRelayUrls: leg.compatibility ? [] : leg.relayUrls,
    deliveryMode: "critical",
    refreshRelayLists: input.refreshRelayLists,
    shouldContinue: input.shouldContinue,
    relayAuthentication: input.relayAuthentication,
  }
  if (input.publishProgressiveFn) {
    const milestones = await input.publishProgressiveFn(leg.event, options)
    // Attach immediately: terminal persistence can finish before or after first ACK.
    const settled = milestones.settled.then(async (snapshot) => {
      try {
        await input.onSettled?.(snapshot)
        return { error: null }
      } catch (error) {
        console.warn("Failed to persist final private-message relay outcomes", {
          attemptedRelayCount: snapshot.attemptedRelayUrls.length,
          successfulRelayCount: snapshot.successfulRelayUrls.length,
        })
        return { error }
      }
    })
    try {
      const accepted = await milestones.accepted
      await input.onAccepted?.(accepted)
      return accepted
    } catch (error) {
      const final = await settled
      throw final.error ?? error
    }
  }
  let delivery: PublishWithPlannerResult
  try {
    delivery = await (input.publishFn ?? publishWithPlanner)(leg.event, options)
  } catch (error) {
    if (!(error instanceof RelayPublishDiagnosticsError)) {
      await input.onSettled?.(null)
      throw error
    }
    delivery = error.diagnostics
  }
  try {
    await input.onSettled?.(delivery)
  } catch (error) {
    if (
      !delivery.successfulRelayUrls.length ||
      !input.onAcceptedCheckpointFailure
    )
      throw error
    input.onAcceptedCheckpointFailure()
  }
  if (
    input.requireAck !== false &&
    Array.isArray(delivery.successfulRelayUrls) &&
    !delivery.successfulRelayUrls.length
  )
    throw new RelayPublishDiagnosticsError(
      "Recipient delivery completed without a relay ACK.",
      delivery,
      undefined
    )
  return delivery
}

export function privateMessageCounterparty(
  principal: string,
  recipients: readonly string[]
): string {
  const peers = [
    ...new Set(recipients.map((p) => p.trim().toLowerCase())),
  ].filter((p) => p !== principal.trim().toLowerCase())
  if (peers.length !== 1 || !/^[0-9a-f]{64}$/.test(peers[0]!))
    throw new Error(
      "Invalid conversation participants: one explicit counterparty required"
    )
  return peers[0]!
}

/** Revalidate saved targets without rediscovering or widening an exact retry plan.
 * Missing/partial observations do not erase retained signed routing authority.
 */
async function privateDeliveryRetryTargets(
  input: PrivateDeliveryContext & {
    senderPubkey: string
    leg: PrivateDeliveryLeg
    resolveDeclaration?: typeof resolveInboxDeclaration
  }
): Promise<string[]> {
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  const { leg } = input
  const targets = leg.relayUrls.filter((url) => !leg.acknowledged.includes(url))
  if (!targets.length) return []
  const declaration = await (
    input.resolveDeclaration ?? resolveInboxDeclaration
  )(leg.recipientPubkey, {
    requestingAccountPubkey: input.accountPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    allowLocalRelayUrlsForPubkey: input.authenticatedPubkey,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
  })
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  if (
    ["signed_empty", "malformed", "distribution_pending"].includes(
      declaration.state
    )
  )
    return []
  if (leg.compatibility && !isApprovedCompatibilityOrderRelayPlan(targets))
    return []
  if (!leg.compatibility && declaration.state === "declared")
    return targets.filter((url) => declaration.relayUrls.includes(url))
  return targets
}

/** Exact ciphertext replay for domain records. New account sends prefer their
 * staged plan; legacy records without a saved plan use the current declared inbox.
 * Domain validation and persistence must already have succeeded before this call.
 */
export async function retryPrivateMessageWraps(
  input: PrivateDeliveryContext & {
    rumorId: string
    senderPubkey: string
    recipientPubkey: string
    wrappedToRecipient: SignedPublicNostrEvent
    wrappedToSelf?: SignedPublicNostrEvent
    recipientInboxRelays?: readonly string[]
    resolveInboxRelays?: (pubkey: string) => Promise<string[]>
    inboxDeclarationOptions?: ResolveInboxDeclarationOptions
    acknowledged?: (url: string) => boolean
    deliveryStore?: CommerceInboxStore
  }
): Promise<{
  recipientDelivery: PublishWithPlannerResult | null
  selfDelivery: PublishWithPlannerResult | null
  selfCopyError: string | null
}> {
  const authorization =
    input.accountPubkey === input.senderPubkey &&
    input.authenticatedPubkey === input.senderPubkey
      ? getProtectedReadAuthorization(input.senderPubkey)
      : null
  const store =
    input.deliveryStore ??
    (authorization ? new CommerceInboxStore(authorization) : null)
  if (store && store.principal !== input.senderPubkey)
    throw new Error("Private delivery belongs to another account")
  const replay = async (
    recipient: string,
    event: SignedPublicNostrEvent,
    self: boolean
  ) => {
    assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
    const id = `delivery:${input.rumorId}${self ? ":self" : ""}`
    const row =
      store && (await store.database.commerceInboxDeliveries.get(store.key(id)))
    if (store && row) {
      const saved = await store.open<PrivateDeliveryJob>(row.value, id)
      const leg = saved.legs.find(
        (leg) => leg.event.id === event.id && leg.recipientPubkey === recipient
      )
      if (!leg) throw new Error("Saved private delivery bytes changed")
      // A user-requested domain replay resends the same receipt even after an
      // earlier ACK. Generic resume still sends only unfinished targets.
      const replayAcknowledged = !input.acknowledged
      const attempts = await retryPrivateDeliveries(
        store.principal,
        input.publishFn,
        id,
        store,
        (pubkey, options) =>
          input.resolveInboxRelays
            ? resolveDeclarationViaSeam(
                pubkey,
                input.resolveInboxRelays,
                pubkey === input.senderPubkey
              )
            : resolveInboxDeclaration(pubkey, {
                ...input.inboxDeclarationOptions,
                ...options,
              }),
        { replayAcknowledged, shouldContinue: input.shouldContinue }
      )
      if (replayAcknowledged) {
        const delivery = attempts.get(event.id)
        if (!delivery?.successfulRelayUrls.length)
          throw new Error("Exact message replay did not obtain a relay ACK")
        return delivery
      }
      const current = await store.database.commerceInboxDeliveries.get(row.id)
      store.assertCurrent()
      const job =
        current && (await store.open<PrivateDeliveryJob>(current.value, id))
      const result = job?.legs.find((leg) => leg.event.id === event.id)
      if (!result?.delivery || !result.acknowledged.length)
        throw new Error(
          "Saved message is still waiting for recipient relay acceptance"
        )
      return accumulatedDelivery(result)
    }
    const declaration =
      input.resolveInboxRelays || (!self && input.recipientInboxRelays)
        ? await resolveDeclarationForSend(
            recipient,
            self ? undefined : input.recipientInboxRelays,
            input.resolveInboxRelays,
            self,
            input.accountPubkey ?? null,
            input.authenticatedPubkey ?? null,
            input.accountNetworkLocalStateRepository,
            input.shouldContinue
          )
        : await resolveInboxDeclaration(recipient, {
            ...input.inboxDeclarationOptions,
            requestingAccountPubkey: input.accountPubkey,
            authenticatedPubkey: input.authenticatedPubkey,
            allowLocalRelayUrlsForPubkey: self
              ? input.authenticatedPubkey
              : null,
            shouldContinue:
              input.shouldContinue ??
              input.inboxDeclarationOptions?.shouldContinue,
          })
    assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
    const route = selectPrivateMessageDeliveryRoute({
      rumorKind: 14,
      declaration,
      validatedOrder: false,
      authenticatedOwnerPubkey: input.authenticatedPubkey,
      ownerSelectedRelayUrls: self ? declaration.relayUrls : [],
    })
    if (route.route === "blocked")
      throw new Error("Private-message inbox is not currently usable.")
    const leg = deliveryLeg(recipient, event, route)
    leg.relayUrls = leg.relayUrls.filter((url) => !input.acknowledged?.(url))
    if (!leg.relayUrls.length) return null
    return await stageAndPublishPrivateLeg({
      ...input,
      store,
      leg,
      selfCopy: self,
    })
  }
  const recipientDelivery = await replay(
    input.recipientPubkey,
    input.wrappedToRecipient,
    false
  )
  let selfDelivery: PublishWithPlannerResult | null = null
  let selfCopyError: string | null = null
  if (input.wrappedToSelf) {
    try {
      selfDelivery = await replay(input.senderPubkey, input.wrappedToSelf, true)
    } catch (error) {
      selfCopyError =
        error instanceof Error ? error.message : "Self-copy retry failed"
    }
  }
  return { recipientDelivery, selfDelivery, selfCopyError }
}

function accumulatedDelivery(
  leg: PrivateDeliveryLeg
): PublishWithPlannerResult {
  if (!leg.delivery) throw new Error("Saved delivery has no relay outcome")
  return {
    ...leg.delivery,
    successfulRelayUrls: [...leg.acknowledged],
    failedRelayUrls: leg.relayUrls.filter(
      (url) => !leg.acknowledged.includes(url)
    ),
  }
}

export type PrivateDeliveryTargetPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  accountPubkey: string
  appRelayUrls?: readonly string[]
  personalRelayUrls?: readonly string[]
  independentRelayUrls?: readonly string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  shouldContinue?: () => boolean
}) => Promise<OrderRelayDeliveryStatus>

/** Domain-owned checkpoints (order generations/leases) around the same bounded
 * exact-byte delivery policy. Only the checkpoint payload varies by caller.
 */
export async function retryPrivateDeliveryTargets<Checkpoint>(input: {
  leg: PrivateDeliveryLeg
  senderPubkey: string
  accountPubkey: string
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  shouldContinue?: () => boolean
  publisher?: PrivateDeliveryTargetPublisher
  beforePublish: (relayUrl: string) => Promise<Checkpoint | null>
  afterPublish: (
    relayUrl: string,
    status: Exclude<OrderRelayDeliveryStatus, "pending">,
    checkpoint: Checkpoint
  ) => Promise<void>
}): Promise<void> {
  const { leg } = input
  const targets = await privateDeliveryRetryTargets({
    ...input,
    // Order domain records already retain validated signed routing authority;
    // use retained declarations to detect stronger local evidence without a fanout.
    resolveDeclaration: async (pubkey) => {
      try {
        const retained = await readRetainedInboxDeclaration(pubkey)
        if (retained) return retained
      } catch {
        // Retained signed targets remain authority when no newer evidence is available.
      }
      return {
        pubkey,
        state: "lookup_unavailable",
        relayUrls: [],
        stale: true,
        fetchedAt: Date.now(),
      }
    },
  })
  const operations = await orderEquivalentAccountRelayOperations({
    accountPubkey: input.accountPubkey,
    operations: targets.map((relayUrl) => ({
      relayUrl,
      equivalenceKey: "exact-private-delivery-retry",
      value: relayUrl,
    })),
    repository: input.accountNetworkLocalStateRepository,
  })
  for (const { value: relayUrl } of operations) {
    if (input.shouldContinue?.() === false) break
    const appRelayUrls = leg.compatibility ? [relayUrl] : []
    const independentRelayUrls = leg.compatibility ? [] : [relayUrl]
    const eligible = await filterEligibleAccountRelayUrls({
      accountPubkey: input.accountPubkey,
      candidateRelayUrls: [relayUrl],
      appRelayUrls,
      personalRelayUrls: [],
      independentRelayUrls,
      repository: input.accountNetworkLocalStateRepository,
    })
    if (!eligible.length || input.shouldContinue?.() === false) continue
    const checkpoint = await input.beforePublish(relayUrl)
    if (checkpoint === null || input.shouldContinue?.() === false) continue
    let outcome: OrderRelayDeliveryStatus
    try {
      outcome = await (
        input.publisher ??
        ((options) =>
          publishSignedEventToRelay({
            ...options,
            authorPubkey: options.signedEvent.pubkey,
          }))
      )({
        relayUrl,
        signedEvent: leg.event,
        accountPubkey: input.accountPubkey,
        appRelayUrls,
        personalRelayUrls: [],
        independentRelayUrls,
        accountNetworkLocalStateRepository:
          input.accountNetworkLocalStateRepository,
        shouldContinue: input.shouldContinue,
      })
    } catch {
      if (input.shouldContinue?.() === false) break
      outcome = "timed_out"
    }
    await input.afterPublish(
      relayUrl,
      outcome === "pending" ? "timed_out" : outcome,
      checkpoint
    )
  }
}

/** Staging, claim lifetime and durable outcomes are the same for every new leg. */
async function stageAndPublishPrivateLeg(
  input: Parameters<typeof publishPrivateDeliveryLeg>[0] & {
    rumorId: string
    store: CommerceInboxStore | null
    selfCopy?: boolean
    onDeliveryStarting?: () => void | Promise<void>
  }
) {
  const { store, leg } = input
  assertPrivateMessageSignerSessionCurrent(input.shouldContinue)
  store?.assertCurrent()
  await input.onDeliveryStarting?.()
  const id = store
    ? await stagePrivateDelivery(
        store,
        {
          rumorId: input.rumorId,
          senderPubkey: input.senderPubkey,
          createdAt: Date.now(),
          legs: [leg],
        },
        input.selfCopy
      )
    : null
  const claim = store && id ? await holdPrivateDeliveryClaim(store, id) : null
  let acceptedDelivery:
    Awaited<ReturnType<typeof publishPrivateDeliveryLeg>> | undefined
  let publishFailed = false
  let publishError: unknown
  try {
    acceptedDelivery = await publishPrivateDeliveryLeg({
      ...input,
      shouldContinue: () => {
        if (input.shouldContinue?.() === false) return false
        claim?.assertCurrent()
        return true
      },
      onSettled: async (delivery) => {
        await input.onSettled?.(delivery)
        if (store && id)
          await recordPrivateDelivery(store, id, leg.event.id, delivery, {
            holdClaim: true,
          })
      },
    })
  } catch (error) {
    publishFailed = true
    publishError = error
  }
  try {
    await claim?.release()
  } catch (error) {
    if (
      !acceptedDelivery?.successfulRelayUrls.length ||
      !input.onAcceptedCheckpointFailure
    )
      throw error
    input.onAcceptedCheckpointFailure()
  }
  if (publishFailed) throw publishError
  return acceptedDelivery!
}
