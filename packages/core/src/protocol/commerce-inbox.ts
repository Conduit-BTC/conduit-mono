import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  parseCheckoutSparkRecoveryRumor,
  checkoutRecoveryPayloadDigest,
  type CheckoutRecoveryDescriptor,
} from "./checkout-spark-recovery"
import { sendPrivateAttachment } from "./private-file-upload"
import { sendAccountInboxRumor } from "./inbox-send"
import { retryPrivateDeliveries } from "./private-message-delivery"
import { liveQuery } from "dexie"
import {
  decodeCommerceMessageRumor,
  commerceMessageSearchText,
  commerceReplyCounterparty,
  type DecodedCommerceMessage,
} from "./commerce-message-codec"
import {
  CommerceInboxStore,
  INBOX_DECODE_RULES_VERSION,
  readRetainedInboxProjections,
  type InboxProjectionRow,
  type InboxDecodeState,
  type InboxProjection,
  type InboxRangeRow,
} from "./commerce-inbox-store"
import {
  unwrapPrivateMessageEnvelope,
  getOrderCompanionNotificationIdentity,
  type ParsedDirectMessage,
  type DecryptFailure,
  type LegacyDmDecryptFailure,
  type PrivateMessageRumor,
  createLegacyDmDecrypt,
  decryptLegacyDirectMessage,
} from "./messaging"
import {
  NostrSignerError,
  classifyNostrSignerError,
  type NostrKeySigner,
  type SignedNostrEvent,
} from "./nostr-event-signer"
import {
  parseOrderMessageRumorEvent,
  type ParsedEventMarketPrivateMessage,
  type ParsedOrderMessage,
} from "./orders"
import {
  assertProtectedReadAuthorization,
  getProtectedReadAuthorization,
  subscribeProtectedReadSignerRevocation,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
  type ReadProtectedInboxOptions,
} from "./protected-inbox-read"
import {
  visitProtectedInboxHistoryPage,
  bindProtectedInboxHistoryCursor,
  isCompleteProtectedInboxRead,
} from "./protected-inbox-history"
import {
  planInboxReadRelays,
  resolveInboxDeclaration,
  type InboxDeclarationResolution,
} from "./private-message-routing"
import { getAccountSigner, SessionSigner } from "./session-signer"

interface InboxReadRelayPlan {
  relayUrls: string[]
  ownerSelectedRelayUrls: readonly string[]
  appRelayUrls: readonly string[]
  personalRelayUrls?: readonly string[]
  independentRelayUrls?: readonly string[]
}

async function transportReadPlans(
  principal: string,
  declaration: InboxDeclarationResolution,
  assertCurrent: () => void,
  includeLegacy = true,
  legacyRelayPlan?: InboxReadRelayPlan
) {
  const secure = planInboxReadRelays({
    declaration,
    authenticatedPubkey: principal,
  })
  const plans: Array<
    InboxReadRelayPlan & {
      transport: NonNullable<ReadProtectedInboxOptions["transport"]>
    }
  > = [
    {
      ...secure,
      transport: "nip17",
      appRelayUrls: secure.relayUrls.filter(
        (url) => secure.relaySources[url] === "compatibility"
      ),
    },
  ]
  if (includeLegacy) {
    // Resolve lazily: the commerce gateway also consumes this inbox owner.
    const legacy =
      legacyRelayPlan ??
      (await (
        await import("./commerce")
      ).planLegacyDirectMessageRead(principal, () => {
        assertCurrent()
        return true
      }))
    assertCurrent()
    plans.push(
      { ...legacy, transport: "nip04_incoming" },
      { ...legacy, transport: "nip04_outgoing" }
    )
  }
  return plans
}

export interface CommerceInboxReadEvidence {
  sourceIndex: number
  transport: NonNullable<ReadProtectedInboxOptions["transport"]>
  observedAt: number
  coverage: "complete" | "partial" | "unavailable"
  authentication: ProtectedInboxReadResult["auth"]["state"]
  status: ProtectedInboxReadResult["relayResult"]["status"]
  received: number
  malformed: number
  unusable: number
}
export interface CommerceInboxDiagnostic {
  states: Partial<Record<InboxDecodeState, number>>
  transportStates: Record<
    "nip17" | "nip04",
    Partial<Record<InboxDecodeState, number>>
  >
  sources: CommerceInboxReadEvidence[]
  historyRanges: Array<{
    sourceIndex: number
    transport: NonNullable<ReadProtectedInboxOptions["transport"]>
    status: InboxRangeRow["status"]
    observedAt: number
    observedCount: number
  }>
  received: number
  observedAt: number | null
  coverage: "complete" | "partial" | "unavailable"
  authentication: ProtectedInboxReadResult["auth"] | null
  historyUnresolved: number
  outgoingPending: number
  legacyReceived: number
  clientSealMetadataAccepted: number
  storageUnavailable: boolean
}
export interface CommerceInboxSnapshot {
  /** Account-local labels; excluded from exported diagnostics. */
  sourceRelays: Array<{ sourceIndex: number; relayUrl: string }>
  decryptFailures: DecryptFailure[]
  legacyDecryptFailures: LegacyDmDecryptFailure[]
  directMessages: ParsedDirectMessage[]
  orderMessages: ParsedOrderMessage[]
  externalRecords: DecodedCommerceMessage[]
  unreadIds: ReadonlySet<string>
  diagnostics: CommerceInboxDiagnostic
  pending: boolean
  declaration?: InboxDeclarationResolution
}
const emptySnapshot = (): CommerceInboxSnapshot => ({
  sourceRelays: [],
  decryptFailures: [],
  legacyDecryptFailures: [],
  directMessages: [],
  orderMessages: [],
  externalRecords: [],
  unreadIds: new Set(),
  pending: false,
  diagnostics: {
    states: {},
    transportStates: { nip17: {}, nip04: {} },
    sources: [],
    historyRanges: [],
    received: 0,
    observedAt: null,
    coverage: "unavailable",
    authentication: null,
    historyUnresolved: 0,
    outgoingPending: 0,
    legacyReceived: 0,
    clientSealMetadataAccepted: 0,
    storageUnavailable: false,
  },
})
function projectRetainedInboxRecords(
  projections: Array<{ row: InboxProjectionRow; projection: InboxProjection }>
) {
  const directMessages: ParsedDirectMessage[] = []
  const orderMessages: ParsedOrderMessage[] = []
  const externalRecords: DecodedCommerceMessage[] = []
  const unreadIds = new Set<string>()
  for (const { row, projection } of projections) {
    if (projection.kind === "direct") directMessages.push(projection.message)
    else if (projection.kind === "order") orderMessages.push(projection.message)
    else if (
      projection.kind === "record" &&
      projection.record.category !== "machine" &&
      projection.record.category !== "unrelated"
    )
      externalRecords.push(projection.record)
    if (row.read === 0) unreadIds.add(row.logicalId)
  }
  // Advisory companion is suppressed only by its exact authenticated order.
  const orders = new Set(
    orderMessages
      .filter((m) => m.type === "order")
      .map((m) => `${m.id}:${m.orderId}:${m.senderPubkey}:${m.recipientPubkey}`)
  )
  const visibleDirect = directMessages.filter((m) => {
    const c = m.orderCompanionIdentity
    return (
      !c ||
      !orders.has(
        `${c.orderRumorId}:${c.orderId}:${c.senderPubkey}:${c.recipientPubkey}`
      )
    )
  })
  return {
    directMessages: visibleDirect.sort((a, b) => a.createdAt - b.createdAt),
    orderMessages: orderMessages.sort((a, b) => a.createdAt - b.createdAt),
    externalRecords,
    unreadIds,
  }
}

/** Retained account identity permits local reading only; coverage stays unavailable. */
export async function readRetainedCommerceInbox(
  ...args: Parameters<typeof readRetainedInboxProjections>
): Promise<CommerceInboxSnapshot> {
  const projections = await readRetainedInboxProjections(...args)
  return { ...emptySnapshot(), ...projectRetainedInboxRecords(projections) }
}

const owners = new Map<string, CommerceInbox>()

/** One account/session owner. Domain projections share ingestion, not authority. */
export class CommerceInbox {
  readonly store: CommerceInboxStore
  private snapshot = emptySnapshot()
  private sourceIndexes = new Map<string, number>()
  private sourceIndex(relayUrl: string): number {
    const previous = this.sourceIndexes.get(relayUrl)
    if (previous !== undefined) return previous
    const index = this.sourceIndexes.size + 1
    this.sourceIndexes.set(relayUrl, index)
    return index
  }
  private sourceRelays() {
    return [...this.sourceIndexes].map(([relayUrl, sourceIndex]) => ({
      relayUrl,
      sourceIndex,
    }))
  }
  private listeners = new Set<() => void>()
  private initialized?: Promise<void>
  private work?: Promise<void>
  private syncing?: Promise<CommerceInboxSnapshot>
  private refreshing?: Promise<void>
  private lastPaint = 0
  private stopped = false
  private backgroundPaused = false
  private readonly claimOwner = crypto.randomUUID()
  private readonly unsubscribeStorage: () => void
  constructor(
    readonly authorization: ProtectedReadAuthorization,
    readonly signer: NostrKeySigner,
    store?: CommerceInboxStore
  ) {
    this.store = store ?? new CommerceInboxStore(authorization)
    const subscription = liveQuery(() =>
      Promise.all([
        this.store.database.commerceInboxRecords
          .where("accountPubkey")
          .equals(this.store.principal)
          .toArray(),
        this.store.database.commerceInboxWrappers
          .where("accountPubkey")
          .equals(this.store.principal)
          .toArray(),
        this.store.database.commerceInboxDeliveries
          .where("accountPubkey")
          .equals(this.store.principal)
          .toArray(),
        this.store.database.commerceInboxRanges
          .where("accountPubkey")
          .equals(this.store.principal)
          .toArray(),
      ])
    ).subscribe({
      next: () => {
        if (this.initialized && !this.stopped)
          void this.refresh().catch(() => this.storageFailed())
      },
      error: () => this.storageFailed(),
    })
    this.unsubscribeStorage = () => subscription.unsubscribe()
  }
  getSnapshot = (): CommerceInboxSnapshot => {
    try {
      this.assertCurrent()
      return this.snapshot
    } catch {
      return emptySnapshot()
    }
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void {
    for (const listener of this.listeners) listener()
  }
  assertCurrent(): void {
    if (this.stopped) throw new Error("Inbox session ended")
    assertProtectedReadAuthorization(this.authorization, this.store.principal)
  }
  stop(): void {
    this.stopped = true
    this.unsubscribeStorage()
    this.store.clearOpenedViews()
    this.snapshot = emptySnapshot()
    this.sourceIndexes.clear()
    this.emit()
    this.listeners.clear()
  }
  private storageFailed(): void {
    if (this.stopped) return
    this.snapshot = {
      ...this.snapshot,
      diagnostics: { ...this.snapshot.diagnostics, storageUnavailable: true },
    }
    this.emit()
  }
  async initialize(): Promise<void> {
    this.assertCurrent()
    if (!this.initialized)
      this.initialized = (async () => {
        await this.store.migrateLegacy()
        await this.refresh()
      })().catch((error: unknown) => {
        this.initialized = undefined
        this.storageFailed()
        throw error
      })
    await this.initialized
    this.assertCurrent()
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return await this.refreshing
    this.refreshing = this.refreshView().finally(() => {
      this.refreshing = undefined
    })
    return await this.refreshing
  }
  private async refreshView(): Promise<void> {
    this.assertCurrent()
    const [projections, wrappers, ranges, deliveries] = await Promise.all([
      this.store.projections(),
      this.store.wrappers(),
      this.store.database.commerceInboxRanges
        .where("accountPubkey")
        .equals(this.store.principal)
        .toArray(),
      this.store.database.commerceInboxDeliveries
        .where("accountPubkey")
        .equals(this.store.principal)
        .toArray(),
    ])
    this.assertCurrent()
    const decryptFailures: DecryptFailure[] = []
    const legacyDecryptFailures: LegacyDmDecryptFailure[] = []
    const states: CommerceInboxDiagnostic["states"] = {}
    const transportStates: CommerceInboxDiagnostic["transportStates"] = {
      nip17: {},
      nip04: {},
    }
    for (const row of wrappers) {
      if (
        [
          "permission_declined",
          "provider_unavailable",
          "retryable_failure",
          "invalid_envelope",
          "malformed",
        ].includes(row.state)
      ) {
        const malformed =
          row.state === "invalid_envelope" || row.state === "malformed"
        if (row.event.kind === 4)
          legacyDecryptFailures.push({
            eventId: row.event.id,
            reason: malformed ? "malformed" : "decrypt_failed",
            retryable: !malformed,
          })
        else
          decryptFailures.push({
            wrapId: row.event.id,
            reason: malformed ? "malformed" : "nip44_failed",
          })
      }
      states[row.state] = (states[row.state] ?? 0) + 1
      const transport = row.event.kind === 4 ? "nip04" : "nip17"
      transportStates[transport][row.state] =
        (transportStates[transport][row.state] ?? 0) + 1
    }
    const historyRanges = ranges.map((range) => ({
      sourceIndex: this.sourceIndex(range.relayUrl),
      transport: range.id.endsWith(":nip17")
        ? ("nip17" as const)
        : range.id.endsWith(":nip04_outgoing")
          ? ("nip04_outgoing" as const)
          : ("nip04_incoming" as const),
      status: range.status,
      observedAt: range.observedAt,
      observedCount: range.observedCount,
    }))
    this.snapshot = {
      ...this.snapshot,
      sourceRelays: this.sourceRelays(),
      decryptFailures,
      legacyDecryptFailures,
      ...projectRetainedInboxRecords(projections),
      diagnostics: {
        ...this.snapshot.diagnostics,
        states,
        transportStates,
        historyRanges,
        received: wrappers.filter((row) => row.event.kind === 1059).length,
        legacyReceived: wrappers.filter((row) => row.event.kind === 4).length,
        clientSealMetadataAccepted: wrappers.filter(
          (row) => row.clientSealMetadata
        ).length,
        outgoingPending: deliveries.filter((row) => row.state !== "accepted")
          .length,
        historyUnresolved: ranges.filter((r) => r.status !== "source_eose")
          .length,
      },
    }
    this.lastPaint = Date.now()
    this.emit()
  }
  async ingest(
    event: SignedNostrEvent,
    sources: readonly string[] = []
  ): Promise<void> {
    this.assertCurrent()
    await this.initialize()
    try {
      await this.store.receive(event, sources)
    } catch (error) {
      if (!(error instanceof NostrSignerError)) this.storageFailed()
      throw error
    }
    this.assertCurrent()
    this.kick()
  }
  private kick(retry = false): void {
    if (this.work || this.stopped || (this.backgroundPaused && !retry)) return
    this.work = this.drain(retry).finally(() => {
      this.work = undefined
    })
    void this.work.catch(() => {
      if (!this.stopped) this.storageFailed()
    })
  }
  private async drain(retry: boolean): Promise<void> {
    this.snapshot = { ...this.snapshot, pending: true }
    this.emit()
    try {
      for (;;) {
        this.assertCurrent()
        const candidates = await this.store.wrappers()
        let claimed = false
        for (const candidate of candidates) {
          if (
            !retry &&
            candidate.rulesVersion === INBOX_DECODE_RULES_VERSION &&
            !["queued", "waiting_for_signer", "opening"].includes(
              candidate.state
            )
          )
            continue
          const row = await this.store.claim(
            candidate.id,
            this.claimOwner,
            retry
          )
          if (!row) continue
          claimed = true
          const heartbeat = setInterval(() => {
            void this.store
              .heartbeat(row.id, this.claimOwner)
              .catch(() => this.storageFailed())
          }, 10_000)
          let phase: "opening" | "classifying" | "persisting" = "opening"
          try {
            if (row.event.kind === 4) {
              const outcome = await decryptLegacyDirectMessage(
                row.event,
                this.store.principal,
                createLegacyDmDecrypt(this.signer)
              )
              this.assertCurrent()
              await this.store.commit(
                row,
                this.claimOwner,
                outcome.status === "ok"
                  ? "opened"
                  : outcome.status === "ignored"
                    ? "unrelated"
                    : "retryable_failure",
                outcome.status === "ok"
                  ? { kind: "direct", message: outcome.message }
                  : undefined
              )
              continue
            }
            const rumor = await unwrapPrivateMessageEnvelope(
              row.event,
              this.signer,
              {
                onClientSealMetadataAccepted: () => {
                  row.clientSealMetadata = true
                },
              }
            )
            this.assertCurrent()
            if (rumor.kind === 5) {
              await this.store.deleteRecords(
                rumor.tags.filter((t) => t[0] === "e").map((t) => t[1] ?? ""),
                rumor.pubkey
              )
              await this.store.commit(row, this.claimOwner, "opened")
              continue
            }
            phase = "classifying"
            const record = decodeCommerceMessageRumor(
              rumor as PrivateMessageRumor
            )
            let projection: InboxProjection | undefined
            let state: InboxDecodeState = "opened"
            if (record.category === "machine") {
              state = "machine"
              const type = rumor.tags.find((tag) => tag[0] === "type")?.[1]
              if (type === "checkout_spark_recovery") {
                const payload = parseCheckoutSparkRecoveryRumor(rumor)
                projection = {
                  kind: "checkout_recovery",
                  message: {
                    id: rumor.id,
                    senderPubkey: rumor.pubkey,
                    createdAt: (rumor.created_at ?? 0) * 1000,
                    wrapId: row.event.id,
                    checkoutId: payload.plan.checkoutId,
                    orderId: payload.plan.orderId,
                    planDigest: payload.plan.planDigest,
                    takeoverAt: payload.plan.takeoverAt,
                    preparedAt: payload.preparedAt,
                    payloadDigest: checkoutRecoveryPayloadDigest(payload),
                  },
                }
              } else if (
                type?.startsWith("organizer_") ||
                type?.startsWith("future_market_")
              ) {
                const message = parseOrderMessageRumorEvent(rumor)
                if (
                  [
                    "organizer_fulfillment_receipt",
                    "organizer_fulfillment_revocation",
                    "organizer_handoff_ack",
                    "future_market_ready",
                    "future_market_revoked",
                    "future_market_handed_out",
                  ].includes(message.type)
                )
                  projection = {
                    kind: "recovery",
                    message: message as ParsedEventMarketPrivateMessage,
                  }
              }
            } else if (record.category === "unrelated") state = "unrelated"
            else if (record.category === "commerce") {
              if (record.parsedOrderMessage)
                projection = {
                  kind: "order",
                  message: record.parsedOrderMessage,
                }
              else {
                projection = { kind: "record", record }
                state =
                  record.status === "malformed" ? "malformed" : "unsupported"
              }
            } else {
              const participants = record.participants
              const counterparties = participants.filter(
                (p) => p !== this.store.principal
              )
              const message: ParsedDirectMessage = {
                id: rumor.id,
                senderPubkey: rumor.pubkey,
                recipientPubkey:
                  rumor.pubkey === this.store.principal
                    ? (counterparties[0] ?? this.store.principal)
                    : this.store.principal,
                createdAt: (rumor.created_at ?? 0) * 1000,
                content:
                  record.category === "direct" ? record.text : "Encrypted file",
                transport: "nip17",
                participants,
                conversationId: `nip17:${participants.join(":")}`,
                replyTo: record.replyTo,
                file: record.category === "file" ? record : undefined,
              }
              const companion = getOrderCompanionNotificationIdentity(rumor)
              if (companion) message.orderCompanionIdentity = companion
              projection = { kind: "direct", message }
            }
            phase = "persisting"
            const expiry = rumor.tags.find(
              (tag) => tag[0] === "expiration"
            )?.[1]
            await this.store.commit(
              row,
              this.claimOwner,
              state,
              projection,
              expiry && /^\d+$/.test(expiry) ? Number(expiry) * 1000 : undefined
            )
          } catch (error) {
            this.assertCurrent()
            const code =
              error && typeof error === "object" && "code" in error
                ? String(error.code)
                : classifyNostrSignerError(error).code
            if (phase === "persisting") this.storageFailed()
            const state: InboxDecodeState =
              phase === "classifying"
                ? "malformed"
                : phase === "persisting"
                  ? "retryable_failure"
                  : code === "authorization_denied" ||
                      code === "background_paused"
                    ? "permission_declined"
                    : code === "unavailable" ||
                        code === "provider_unavailable" ||
                        code === "timeout"
                      ? "provider_unavailable"
                      : code === "invalid_response"
                        ? "invalid_envelope"
                        : "retryable_failure"
            await this.store.commit(row, this.claimOwner, state)
            if (state === "permission_declined") {
              this.backgroundPaused = true
              return
            }
            if (state === "provider_unavailable") return
          } finally {
            clearInterval(heartbeat)
            if (Date.now() - this.lastPaint >= 100) await this.refresh()
          }
        }
        retry = false
        if (!claimed) break
      }
    } finally {
      if (!this.stopped) {
        await this.refresh()
        this.snapshot = { ...this.snapshot, pending: false }
        this.emit()
      }
    }
  }
  async waitForDecode(): Promise<CommerceInboxSnapshot> {
    await this.initialize()
    this.kick()
    if (this.work) await this.work
    this.assertCurrent()
    return this.snapshot
  }
  async retryDecode(): Promise<CommerceInboxSnapshot> {
    this.assertCurrent()
    this.backgroundPaused = false
    if (this.signer instanceof SessionSigner)
      this.signer.resumeBackgroundOperations()
    await this.initialize()
    this.kick(true)
    if (this.work) await this.work
    return this.snapshot
  }
  private async reconcileRecentHistory(
    relayUrl: string,
    transport: NonNullable<ReadProtectedInboxOptions["transport"]>,
    result: ProtectedInboxReadResult
  ): Promise<void> {
    const complete = isCompleteProtectedInboxRead(
      result,
      50,
      this.store.principal,
      undefined,
      undefined,
      transport
    )
    const restart = !complete || result.events.length >= 50
    const recentReadKey = bytesToHex(
      sha256(
        new TextEncoder().encode(
          `${complete}:${result.events
            .map((event) => event.id)
            .sort()
            .join(":")}`
        )
      )
    )
    const ranges = this.store.database.commerceInboxRanges
    const id = this.store.key(`${relayUrl}:${transport}`)
    await this.store.database.transaction("rw", ranges, async () => {
      this.assertCurrent()
      const stored = await ranges.get(id)
      if (stored?.recentReadKey === recentReadKey || (!stored && !restart))
        return
      // A changed capped/incomplete window may conceal a gap above the saved
      // cursor. Revisit from the top; unchanged windows preserve paging progress.
      await ranges.put({
        ...(stored ?? {
          id,
          accountPubkey: this.store.principal,
          relayUrl,
          status: "partial" as const,
          observedAt: Date.now(),
          observedCount: 0,
        }),
        ...(restart
          ? {
              until: undefined,
              status: "partial" as const,
              pageCount: 0,
              observedAt: Date.now(),
              observedCount: result.events.length,
            }
          : {}),
        recentReadKey,
        revision: (stored?.revision ?? 0) + 1,
      })
      this.assertCurrent()
    })
  }
  async syncRecent(
    options: {
      includeLegacy?: boolean
      legacyRelayPlan?: InboxReadRelayPlan
      declaration?: InboxDeclarationResolution
      read?: (
        options: ReadProtectedInboxOptions
      ) => Promise<ProtectedInboxReadResult>
    } = {}
  ): Promise<CommerceInboxSnapshot> {
    if (this.syncing) return await this.syncing
    this.syncing = (async () => {
      await this.initialize()
      const declaration =
        options.declaration ??
        (await resolveInboxDeclaration(this.store.principal, {
          requestingAccountPubkey: this.store.principal,
          authenticatedPubkey: this.store.principal,
          allowLocalRelayUrlsForPubkey: this.store.principal,
          shouldContinue: () => {
            this.assertCurrent()
            return true
          },
        }))
      const plans = await transportReadPlans(
        this.store.principal,
        declaration,
        () => this.assertCurrent(),
        options.includeLegacy,
        options.legacyRelayPlan
      )
      const results: ProtectedInboxReadResult[] = []
      const sources: CommerceInboxReadEvidence[] = []
      for (const plan of plans)
        for (const relayUrl of plan.relayUrls) {
          const { transport } = plan
          const pending: Promise<void>[] = []
          const result = await (options.read ?? readProtectedInbox)({
            principalPubkey: this.store.principal,
            transport,
            authorization: this.authorization,
            relayUrls: [relayUrl],
            ownerSelectedRelayUrls: plan.ownerSelectedRelayUrls.filter(
              (url) => url === relayUrl
            ),
            appRelayUrls: plan.appRelayUrls.filter((url) => url === relayUrl),
            personalRelayUrls: plan.personalRelayUrls?.filter(
              (url) => url === relayUrl
            ),
            independentRelayUrls: plan.independentRelayUrls?.filter(
              (url) => url === relayUrl
            ),
            limit: 50,
            onEvent: (event) => {
              pending.push(this.ingest(event, [relayUrl]))
            },
          })
          await Promise.all(pending)
          for (const event of result.events)
            await this.ingest(event, [relayUrl])
          await this.reconcileRecentHistory(relayUrl, transport, result)
          results.push(result)
          sources.push({
            sourceIndex: this.sourceIndex(relayUrl),
            transport,
            observedAt: Date.now(),
            coverage:
              result.coverage === "complete" &&
              result.relayResult.relays.some((r) => r.eventCount >= 50)
                ? "partial"
                : result.coverage,
            authentication: result.auth.state,
            status: result.relayResult.status,
            received: result.events.length,
            malformed: result.relayResult.relays.reduce(
              (n, r) => n + r.malformedCount,
              0
            ),
            unusable: result.relayResult.relays.reduce(
              (n, r) => n + r.unusableCount,
              0
            ),
          })
          this.assertCurrent()
          this.snapshot = {
            ...this.snapshot,
            sourceRelays: this.sourceRelays(),
            diagnostics: {
              ...this.snapshot.diagnostics,
              sources: [...sources],
            },
          }
          this.emit()
        }
      const challengedCount = results.reduce(
        (n, r) => n + r.auth.challengedCount,
        0
      )
      const succeededCount = results.reduce(
        (n, r) => n + r.auth.succeededCount,
        0
      )
      const failedCount = results.reduce((n, r) => n + r.auth.failedCount, 0)
      const authentication: ProtectedInboxReadResult["auth"] = {
        challengedCount,
        succeededCount,
        failedCount,
        state: failedCount
          ? succeededCount
            ? "partial"
            : "unavailable"
          : succeededCount
            ? "authenticated"
            : "not_challenged",
        failure: results.find((r) => r.auth.failure)?.auth.failure,
      }
      const coverage =
        results.length &&
        results.every(
          (r) =>
            r.coverage === "complete" &&
            r.relayResult.relays.every((relay) => relay.eventCount < 50)
        )
          ? "complete"
          : results.some((r) => r.coverage !== "unavailable")
            ? "partial"
            : "unavailable"
      this.assertCurrent()
      this.snapshot = {
        ...this.snapshot,
        declaration,
        diagnostics: {
          ...this.snapshot.diagnostics,
          coverage,
          authentication,
          observedAt: Date.now(),
        },
      }
      this.emit()
      return await this.waitForDecode()
    })()
      .catch((error: unknown) => {
        this.assertCurrent()
        this.snapshot = {
          ...this.snapshot,
          diagnostics: {
            ...this.snapshot.diagnostics,
            coverage: "unavailable",
          },
        }
        this.emit()
        throw error
      })
      .finally(() => {
        this.syncing = undefined
      })
    return await this.syncing
  }
  async loadOlder(
    options: {
      includeLegacy?: boolean
      legacyRelayPlan?: InboxReadRelayPlan
      declaration?: InboxDeclarationResolution
      relayUrls?: string[]
      read?: (
        options: ReadProtectedInboxOptions
      ) => Promise<ProtectedInboxReadResult>
    } = {}
  ): Promise<CommerceInboxSnapshot> {
    await this.initialize()
    const declaration =
      options.declaration ??
      this.snapshot.declaration ??
      (await resolveInboxDeclaration(this.store.principal, {
        requestingAccountPubkey: this.store.principal,
        authenticatedPubkey: this.store.principal,
        allowLocalRelayUrlsForPubkey: this.store.principal,
      }))
    const plans = await transportReadPlans(
      this.store.principal,
      declaration,
      () => this.assertCurrent(),
      options.includeLegacy,
      options.legacyRelayPlan
    )
    for (const plan of plans)
      for (const relayUrl of plan.relayUrls.filter(
        (url) => !options.relayUrls || options.relayUrls.includes(url)
      )) {
        const { transport } = plan
        this.assertCurrent()
        const id = this.store.key(`${relayUrl}:${transport}`)
        const stored = await this.store.database.commerceInboxRanges.get(id)
        const page = await visitProtectedInboxHistoryPage({
          principalPubkey: this.store.principal,
          transport,
          relayUrl,
          authorizedRelayUrls: plan.relayUrls,
          declaredRelayUrls: plan.ownerSelectedRelayUrls,
          appRelayUrls: plan.appRelayUrls.filter((url) => url === relayUrl),
          personalRelayUrls: plan.personalRelayUrls?.filter(
            (url) => url === relayUrl
          ),
          independentRelayUrls: plan.independentRelayUrls?.filter(
            (url) => url === relayUrl
          ),
          authorization: this.authorization,
          read: options.read,
          cursor:
            stored?.status === "source_eose" || stored?.until === undefined
              ? undefined
              : bindProtectedInboxHistoryCursor(
                  { relayUrl, until: stored.until },
                  this.authorization
                ),
          visit: async (event) => {
            await this.ingest(event, [relayUrl])
            await this.waitForDecode()
          },
        })
        this.assertCurrent()
        const ranges = this.store.database.commerceInboxRanges
        await this.store.database.transaction("rw", ranges, async () => {
          this.assertCurrent()
          const current = await ranges.get(id)
          // Another tab or a recent sync may have replaced this frontier while
          // the page was in flight. Keep its observations, but not its cursor.
          if ((current?.revision ?? 0) !== (stored?.revision ?? 0)) return
          await ranges.put({
            ...stored,
            id,
            accountPubkey: this.store.principal,
            relayUrl,
            until:
              page.status === "source_eose"
                ? undefined
                : (page.nextCursor?.until ?? stored?.until),
            pageCount:
              stored?.status === "source_eose"
                ? 1
                : (stored?.pageCount ?? 0) +
                  (page.status === "advanced" || page.status === "source_eose"
                    ? 1
                    : 0),
            status: page.status,
            observedAt: Date.now(),
            observedCount: page.range.observedCount,
            revision: (stored?.revision ?? 0) + 1,
          })
          this.assertCurrent()
        })
      }
    await this.refresh()
    return this.snapshot
  }
  async recoveryEvidence(relayUrls?: readonly string[]): Promise<{
    messages: ParsedEventMarketPrivateMessage[]
    authenticatedWraps: Record<string, SignedNostrEvent>
  }> {
    await this.initialize()
    this.assertCurrent()
    const permitted = new Map(
      (await this.store.wrappers())
        .filter(
          (row) =>
            !relayUrls || row.sources.some((url) => relayUrls.includes(url))
        )
        .map((row) => [row.event.id, row.event])
    )
    const messages: ParsedEventMarketPrivateMessage[] = []
    const authenticatedWraps: Record<string, SignedNostrEvent> = {}
    for (const { row, projection } of await this.store.projections()) {
      if (projection.kind !== "recovery" || !row.wrapId) continue
      const wrap = permitted.get(row.wrapId)
      if (!wrap) continue
      messages.push(projection.message)
      authenticatedWraps[projection.message.id] = wrap
    }
    this.assertCurrent()
    return { messages, authenticatedWraps }
  }
  async recoveryMessages(
    relayUrls?: readonly string[]
  ): Promise<ParsedEventMarketPrivateMessage[]> {
    return (await this.recoveryEvidence(relayUrls)).messages
  }
  async checkoutRecoveryDescriptors(
    relayUrls: readonly string[]
  ): Promise<CheckoutRecoveryDescriptor[]> {
    await this.initialize()
    const wrappers = await this.store.wrappers()
    const permitted = new Set(
      wrappers
        .filter((row) => row.sources.some((url) => relayUrls.includes(url)))
        .map((row) => row.event.id)
    )
    return (await this.store.projections()).flatMap(({ projection }) =>
      projection.kind === "checkout_recovery" &&
      permitted.has(projection.message.wrapId)
        ? [projection.message]
        : []
    )
  }
  async search(query: string): Promise<DecodedCommerceMessage[]> {
    await this.initialize()
    this.assertCurrent()
    const term = query.trim().toLocaleLowerCase()
    return this.snapshot.externalRecords.filter((r) =>
      commerceMessageSearchText(r).toLocaleLowerCase().includes(term)
    )
  }
  async reply(record: DecodedCommerceMessage, content: string): Promise<void> {
    if (record.category !== "commerce")
      throw new Error("Only authenticated commerce records can be replied to")
    await sendAccountInboxRumor({
      principal: this.store.principal,
      recipients: [
        commerceReplyCounterparty(this.store.principal, record.provenance),
      ],
      content,
      tags: [
        ["e", record.provenance.rumorId, "", "reply"],
        ["subject", "Commerce reply"],
        ...(record.fields.orderId ? [["order", record.fields.orderId]] : []),
      ],
    })
    await this.waitForDecode()
  }
  async associate(
    record: DecodedCommerceMessage,
    orderId: string
  ): Promise<void> {
    if (
      record.category !== "commerce" ||
      !orderId.trim() ||
      orderId.length > 128
    )
      throw new Error("Invalid local association")
    await this.store.putProjection({
      kind: "record",
      record: { ...record, association: orderId.trim() },
    })
    await this.refresh()
  }
  async attach(recipients: string[], file: File): Promise<void> {
    await sendPrivateAttachment(this.store.principal, recipients, file)
    await this.waitForDecode()
  }
  async retrySends(): Promise<void> {
    await retryPrivateDeliveries(this.store.principal)
    await this.waitForDecode()
    await this.refresh()
  }
  async markRead(ids: readonly string[]): Promise<void> {
    await this.store.markRead(ids)
    await this.refresh()
  }
}

export function getCommerceInbox(principalPubkey: string): CommerceInbox {
  const authorization = getProtectedReadAuthorization(principalPubkey)
  const signer = getAccountSigner()
  if (!authorization || !signer || signer.pubkey !== principalPubkey)
    throw new Error("Connect the intended account to open its inbox")
  const key = authorization.sessionScope
  let owner = owners.get(key)
  if (!owner) {
    owner = new CommerceInbox(authorization, signer)
    owners.set(key, owner)
  }
  owner.assertCurrent()
  return owner
}
subscribeProtectedReadSignerRevocation((scope) => {
  owners.get(scope)?.stop()
  owners.delete(scope)
})

/** Content/identifier-free export suitable for shared diagnostic surfaces. */
export function exportCommerceInboxDiagnostics(
  snapshot: CommerceInboxSnapshot
): CommerceInboxDiagnostic {
  return structuredClone(snapshot.diagnostics)
}
