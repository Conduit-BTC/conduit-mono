import {
  NostrSignerError,
  type AccountSigner,
  type SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { getAccountSigner } from "../protocol/session-signer"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { generateId } from "../utils"
import {
  bindSparkRecoveryAccount,
  isSparkRecoveryAddress,
  parseAddySparkMnemonic,
  validateAddySparkMnemonic,
  parseSparkPrimaryPointer,
  parseSparkRecoveryEnvelope,
  proveSparkRecoveryCapability,
  sparkRecoveryEnvelopeSchema,
  SparkRecoveryError,
  SPARK_PRIMARY_D_TAG,
  SPARK_RECOVERY_KIND,
  SPARK_RECOVERY_PREFIX,
  validateSparkCiphertext,
  validateSparkRecoveryEvent,
  type SparkIdentityDeriver,
  type SparkPrimaryPointer,
  type SparkRecoveryBundle,
  type SparkRecoveryEnvelope,
} from "./spark-recovery-contract"

// Operator identities are curated facts, never inferred from hostnames or NIP-11 claims.
// Unknown user relays participate in discovery/delivery but cannot inflate redundancy.
export const SPARK_RECOVERY_RENDEZVOUS = Object.freeze([
  { url: "wss://relay.conduit.market", operator: "conduit" },
  { url: "wss://relay.damus.io", operator: "damus" },
  { url: "wss://nos.lol", operator: "nos.lol" },
])
export interface SparkRecoveryRelay {
  url: string
  operator: string | null
}
export type SparkRecoveryWriteStatus =
  | "acked"
  | "rejected"
  | "timed_out"
  | "auth_required"
  | "cancelled"
  | "policy_blocked"
  | "error"
export interface SparkRecoveryRead {
  status: "complete" | "partial" | "unavailable"
  events: SignedNostrEvent[]
}
/** Transport must fence authority immediately before socket sends, including retries. */
export interface SparkRecoveryTransport {
  read(
    url: string,
    owner: string,
    eventId: string | undefined,
    shouldContinue: () => boolean
  ): Promise<SparkRecoveryRead>
  publish(
    url: string,
    event: SignedNostrEvent,
    shouldContinue: () => boolean
  ): Promise<SparkRecoveryWriteStatus>
}
export interface SparkRecoveryDelivery {
  url: string
  status: SparkRecoveryWriteStatus | "pending"
  accepted: boolean
  readBack: boolean
  lastRead: "not_queried" | "present" | "absent" | "unavailable"
  checkedAt: number
}
export interface SparkRecoveryRecord {
  event: SignedNostrEvent
  targets: SparkRecoveryRelay[]
  delivery: SparkRecoveryDelivery[]
  exported: boolean
}
export interface SparkRecoveryState {
  unresolvedObserved: boolean
  ownerPubkey: string
  records: SparkRecoveryRecord[]
}
/** Ciphertext-only account journal; merge never removes a retained signed candidate. */
export interface SparkRecoveryStore {
  load(owner: string): Promise<SparkRecoveryState>
  retain(
    owner: string,
    records: SparkRecoveryRecord[],
    unresolvedObserved?: boolean
  ): Promise<void>
}
export interface SparkRecoveryCandidate {
  eventId: string
  walletId?: string
  source: "conduit_v1" | "addy"
}
export interface SparkRecoveryDiscovery {
  coverage: "complete" | "partial" | "unavailable"
  state: "absent_within_scope" | "recoverable" | "conflict" | "unresolved"
  candidates: SparkRecoveryCandidate[]
  primary?: SparkRecoveryCandidate
  invalidCount: number
  sources: { url: string; status: SparkRecoveryRead["status"] }[]
  /** Only a bounded prerequisite for a later explicit lifecycle; never global absence. */
  creationEligible: boolean
}
const MAX_RECORDS = 128

export function planSparkRecoveryRelays(
  userRelayUrls: readonly string[] = []
): SparkRecoveryRelay[] {
  const result = SPARK_RECOVERY_RENDEZVOUS.map((r) => ({
    ...r,
  })) as SparkRecoveryRelay[]
  for (const candidate of userRelayUrls) {
    const url = normalizePublicWebSocketUrl(candidate)
    if (url && !result.some((r) => r.url === url))
      result.push({ url, operator: null })
    if (result.length >= 8) break
  }
  return result
}
function clone<T>(value: T): T {
  return structuredClone(value)
}
function validatePlan(targets: SparkRecoveryRelay[]): SparkRecoveryRelay[] {
  if (
    !targets.length ||
    targets.length > 8 ||
    new Set(targets.map((t) => t.url)).size !== targets.length ||
    targets.some((t) => !normalizePublicWebSocketUrl(t.url))
  )
    throw new SparkRecoveryError("invalid_record")
  // Caller-supplied labels cannot manufacture independently operated backups.
  return targets.map((t) => ({
    url: t.url,
    operator:
      SPARK_RECOVERY_RENDEZVOUS.find((r) => r.url === t.url)?.operator ?? null,
  }))
}
export function validateSparkRecoveryState(
  input: SparkRecoveryState,
  owner: string
): SparkRecoveryState {
  try {
    if (
      input.ownerPubkey !== owner ||
      typeof input.unresolvedObserved !== "boolean" ||
      input.records.length > MAX_RECORDS
    )
      throw new SparkRecoveryError("invalid_record")
    const records = input.records.map((r) => {
      const event = validateSparkRecoveryEvent(r.event, owner)
      const targets = validatePlan(r.targets)
      if (
        typeof r.exported !== "boolean" ||
        r.delivery.length !== targets.length ||
        new Set(r.delivery.map((d) => d.url)).size !== targets.length ||
        r.delivery.some(
          (d) =>
            !targets.some((t) => t.url === d.url) ||
            typeof d.accepted !== "boolean" ||
            typeof d.readBack !== "boolean" ||
            !["not_queried", "present", "absent", "unavailable"].includes(
              d.lastRead
            ) ||
            !Number.isSafeInteger(d.checkedAt) ||
            d.checkedAt < 0 ||
            ![
              "pending",
              "acked",
              "rejected",
              "timed_out",
              "auth_required",
              "cancelled",
              "policy_blocked",
              "error",
            ].includes(d.status)
        )
      )
        throw new SparkRecoveryError("invalid_record")
      return {
        event,
        targets,
        delivery: r.delivery.map((d) => ({
          url: d.url,
          status: d.status,
          accepted: d.accepted,
          readBack: d.readBack,
          lastRead: d.lastRead,
          checkedAt: d.checkedAt,
        })),
        exported: r.exported,
      }
    })
    if (new Set(records.map((r) => r.event.id)).size !== records.length)
      throw new SparkRecoveryError("invalid_record")
    return {
      ownerPubkey: owner,
      records,
      unresolvedObserved: input.unresolvedObserved,
    }
  } catch {
    throw new SparkRecoveryError("invalid_record")
  }
}
export function mergeSparkRecoveryRecords(
  current: SparkRecoveryState,
  incoming: SparkRecoveryRecord[],
  unresolvedObserved = false
): SparkRecoveryState {
  const next = validateSparkRecoveryState(
    { ownerPubkey: current.ownerPubkey, records: incoming, unresolvedObserved },
    current.ownerPubkey
  )
  const records = new Map(
    validateSparkRecoveryState(current, current.ownerPubkey).records.map(
      (r) => [r.event.id, r]
    )
  )
  for (const record of next.records) {
    const old = records.get(record.event.id)
    if (!old) {
      records.set(record.event.id, record)
      continue
    }
    if (
      JSON.stringify(old.event) !== JSON.stringify(record.event) ||
      JSON.stringify(old.targets) !== JSON.stringify(record.targets)
    )
      throw new SparkRecoveryError("conflict")
    records.set(record.event.id, {
      ...old,
      exported: old.exported || record.exported,
      delivery: old.delivery.map((d) => {
        const update = record.delivery.find((u) => u.url === d.url)!
        return {
          ...(update.checkedAt >= d.checkedAt ? update : d),
          accepted: d.accepted || update.accepted,
          readBack: d.readBack || update.readBack,
        }
      }),
    })
  }
  return validateSparkRecoveryState(
    {
      ownerPubkey: current.ownerPubkey,
      records: [...records.values()],
      unresolvedObserved: current.unresolvedObserved || unresolvedObserved,
    },
    current.ownerPubkey
  )
}

export class SparkRecoveryService {
  private readonly scope: ReturnType<typeof bindSparkRecoveryAccount>
  private readonly current: () => AccountSigner | undefined
  private readonly plan: SparkRecoveryRelay[]
  constructor(
    private readonly input: {
      signer: AccountSigner
      store: SparkRecoveryStore
      transport: SparkRecoveryTransport
      deriveIdentity: SparkIdentityDeriver
      currentSigner?: () => AccountSigner | undefined
      userRelayUrls?: readonly string[]
    }
  ) {
    this.current = input.currentSigner ?? getAccountSigner
    this.scope = bindSparkRecoveryAccount(input.signer, this.current)
    this.plan = planSparkRecoveryRelays(input.userRelayUrls)
  }
  private async load(): Promise<SparkRecoveryState> {
    this.scope.assertCurrent()
    const state = await this.input.store.load(this.scope.owner)
    this.scope.assertCurrent()
    return validateSparkRecoveryState(state, this.scope.owner)
  }
  private async retain(
    records: SparkRecoveryRecord[],
    unresolvedObserved = false
  ): Promise<void> {
    this.scope.assertCurrent()
    await this.input.store.retain(
      this.scope.owner,
      clone(records),
      unresolvedObserved
    )
    this.scope.assertCurrent()
  }
  private continues = (): boolean => {
    try {
      this.scope.assertCurrent()
      return true
    } catch {
      return false
    }
  }
  private async decrypt(event: SignedNostrEvent): Promise<string> {
    const verified = validateSparkRecoveryEvent(event, this.scope.owner)
    this.scope.assertCurrent()
    const plaintext = await this.input.signer.decryptNip44(
      this.scope.owner,
      verified.content
    )
    this.scope.assertCurrent()
    return plaintext
  }
  private async identity(bundle: SparkRecoveryBundle): Promise<string> {
    this.scope.assertCurrent()
    let identity: string
    try {
      identity = await this.input.deriveIdentity(bundle)
    } catch {
      throw new SparkRecoveryError("identity_mismatch")
    }
    this.scope.assertCurrent()
    if (!/^(02|03)[0-9a-f]{64}$/.test(identity))
      throw new SparkRecoveryError("identity_mismatch")
    return identity
  }
  private record(event: SignedNostrEvent): SparkRecoveryRecord {
    return {
      event,
      targets: clone(this.plan),
      delivery: this.plan.map((t) => ({
        url: t.url,
        status: "pending",
        accepted: false,
        readBack: false,
        lastRead: "not_queried",
        checkedAt: 0,
      })),
      exported: false,
    }
  }
  private async sign(
    d: string,
    payload: object,
    createdAt: number
  ): Promise<SignedNostrEvent> {
    this.scope.assertCurrent()
    const plaintext = JSON.stringify(payload)
    const content = await this.input.signer.encryptNip44(
      this.scope.owner,
      plaintext
    )
    this.scope.assertCurrent()
    validateSparkCiphertext(content)
    const event = await this.input.signer.signEvent({
      kind: SPARK_RECOVERY_KIND,
      pubkey: this.scope.owner,
      created_at: createdAt,
      tags: [["d", d]],
      content,
    })
    this.scope.assertCurrent()
    const verified = validateSparkRecoveryEvent(event, this.scope.owner)
    if ((await this.decrypt(verified)) !== plaintext)
      throw new SparkRecoveryError("invalid_record")
    return verified
  }

  /** Explicit creation/import preparation only. No seed generation or primary rollout. */
  async prepare(bundle: SparkRecoveryBundle): Promise<SparkRecoveryCandidate> {
    await proveSparkRecoveryCapability(this.input.signer, this.current)
    const createdAt = Math.floor(Date.now() / 1000)
    // Validate mnemonic/network/account before any provider call or encryption.
    const parsed = sparkRecoveryEnvelopeSchema.safeParse({
      ...bundle,
      format: "conduit.spark.recovery",
      version: 1,
      ownerPubkey: this.scope.owner,
      walletId: generateId(),
      provider: "spark",
      identityPublicKey: "02" + "0".repeat(64),
      createdAt,
    })
    if (!parsed.success) throw new SparkRecoveryError("invalid_record")
    const envelope = parsed.data
    envelope.identityPublicKey = await this.identity(envelope)
    const backup = await this.sign(
      SPARK_RECOVERY_PREFIX + envelope.walletId,
      envelope,
      createdAt
    )
    // Persist the backup before asking for another approval. A pointer failure never loses it.
    await this.retain([this.record(backup)])
    return {
      eventId: backup.id,
      walletId: envelope.walletId,
      source: "conduit_v1",
    }
  }

  /** A separate explicit operation; never deletes another wallet's backup. */
  async preparePrimary(candidate: SparkRecoveryCandidate): Promise<string> {
    const state = await this.load()
    const record = state.records.find((r) => r.event.id === candidate.eventId)
    if (!record || candidate.source !== "conduit_v1")
      throw new SparkRecoveryError("invalid_record")
    const envelope = await this.restore(candidate)
    if (!("walletId" in envelope))
      throw new SparkRecoveryError("invalid_record")
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      ...state.records
        .filter((r) =>
          r.event.tags.some((t) => t[0] === "d" && t[1] === SPARK_PRIMARY_D_TAG)
        )
        .map((r) => r.event.created_at + 1)
    )
    const pointer: SparkPrimaryPointer = {
      format: "conduit.spark.primary",
      version: 1,
      ownerPubkey: this.scope.owner,
      walletId: envelope.walletId,
      backupEventId: candidate.eventId,
      createdAt,
    }
    const event = await this.sign(SPARK_PRIMARY_D_TAG, pointer, createdAt)
    await this.retain([this.record(event)])
    return event.id
  }

  async restore(
    candidate: SparkRecoveryCandidate,
    addySource?: Pick<SparkRecoveryBundle, "network" | "accountNumber">
  ): Promise<SparkRecoveryEnvelope | SparkRecoveryBundle> {
    const state = await this.load()
    const record = state.records.find((r) => r.event.id === candidate.eventId)
    if (!record) throw new SparkRecoveryError("invalid_record")
    const plaintext = await this.decrypt(record.event)
    const d = record.event.tags.find((t) => t[0] === "d")![1]
    if (d.startsWith("spark-wallet-backup")) {
      if (!addySource) throw new SparkRecoveryError("invalid_record")
      const bundle = parseAddySparkMnemonic(plaintext, record.event, addySource)
      await this.identity(bundle)
      return bundle
    }
    const envelope = parseSparkRecoveryEnvelope(plaintext, record.event)
    if ((await this.identity(envelope)) !== envelope.identityPublicKey)
      throw new SparkRecoveryError("identity_mismatch")
    return envelope
  }

  async discover(hasLocalWallet = false): Promise<SparkRecoveryDiscovery> {
    const saved = await this.load()
    const records = new Map(saved.records.map((r) => [r.event.id, r]))
    const sources: SparkRecoveryDiscovery["sources"] = []
    let invalidCount = 0
    for (const target of this.plan) {
      this.scope.assertCurrent()
      let read: SparkRecoveryRead
      try {
        read = await this.input.transport.read(
          target.url,
          this.scope.owner,
          undefined,
          this.continues
        )
      } catch {
        this.scope.assertCurrent()
        read = { status: "unavailable", events: [] }
      }
      this.scope.assertCurrent()
      const status = read.events.length >= MAX_RECORDS ? "partial" : read.status
      sources.push({ url: target.url, status })
      for (const input of read.events.slice(0, MAX_RECORDS)) {
        // NIP-01 has exact #d matching, no namespace prefix filter. Never decrypt unrelated app records.
        if (
          !input.tags?.some(
            (t) =>
              t[0] === "d" &&
              (isSparkRecoveryAddress(t[1]) ||
                t[1]?.startsWith("conduit:spark:"))
          )
        )
          continue
        try {
          const event = validateSparkRecoveryEvent(input, this.scope.owner)
          if (!records.has(event.id)) records.set(event.id, this.record(event))
        } catch {
          invalidCount++
        }
      }
    }
    if (records.size > MAX_RECORDS) throw new SparkRecoveryError("conflict")
    await this.retain([...records.values()], invalidCount > 0)
    const candidates: SparkRecoveryCandidate[] = []
    const pointers: SparkPrimaryPointer[] = []
    for (const record of records.values()) {
      const event = record.event
      const d = event.tags.find((t) => t[0] === "d")![1]
      try {
        const plaintext = await this.decrypt(event)
        // Validate the legacy phrase/address now. Actual source parameters remain required at restore.
        if (d.startsWith("spark-wallet-backup")) {
          validateAddySparkMnemonic(plaintext, event)
          candidates.push({ eventId: event.id, source: "addy" })
          continue
        }
        if (d === SPARK_PRIMARY_D_TAG)
          pointers.push(parseSparkPrimaryPointer(plaintext, event))
        else {
          const envelope = parseSparkRecoveryEnvelope(plaintext, event)
          if ((await this.identity(envelope)) !== envelope.identityPublicKey)
            throw new SparkRecoveryError("identity_mismatch")
          candidates.push({
            eventId: event.id,
            walletId: envelope.walletId,
            source: "conduit_v1",
          })
        }
      } catch (error) {
        this.scope.assertCurrent()
        // Denial/timeout/unsupported remain actionable signer failures, not malformed data.
        if (
          error instanceof NostrSignerError &&
          error.code !== "invalid_response" &&
          error.code !== "unavailable"
        )
          throw error
        invalidCount++
      }
    }
    const coverage = sources.every((s) => s.status === "complete")
      ? "complete"
      : sources.every((s) => s.status === "unavailable")
        ? "unavailable"
        : "partial"
    const pointerTargets = new Set(
      pointers.map((p) => `${p.backupEventId}:${p.walletId}`)
    )
    const primary =
      pointers.length && pointerTargets.size === 1
        ? candidates.find(
            (c) =>
              c.eventId === pointers[0].backupEventId &&
              c.walletId === pointers[0].walletId
          )
        : undefined
    const conflict =
      pointerTargets.size > 1 || (!primary && candidates.length > 1)
    const creationEligible =
      coverage === "complete" &&
      records.size === 0 &&
      !saved.unresolvedObserved &&
      invalidCount === 0 &&
      !hasLocalWallet
    return {
      coverage,
      state: conflict
        ? "conflict"
        : candidates.length
          ? "recoverable"
          : creationEligible
            ? "absent_within_scope"
            : "unresolved",
      candidates,
      primary: conflict ? undefined : primary,
      invalidCount,
      sources,
      creationEligible,
    }
  }

  /** Repair uses stored bytes and targets. It never encrypts, signs, widens, or creates. */
  async deliver(
    eventId: string
  ): Promise<{ ready: boolean; independentCopies: number }> {
    const saved = await this.load()
    const record = saved.records.find((r) => r.event.id === eventId)
    if (!record) throw new SparkRecoveryError("invalid_record")
    for (const target of record.targets) {
      this.scope.assertCurrent()
      const evidence = record.delivery.find((d) => d.url === target.url)!
      if (!evidence.accepted || evidence.lastRead === "absent") {
        try {
          evidence.status = await this.input.transport.publish(
            target.url,
            clone(record.event),
            this.continues
          )
        } catch {
          this.scope.assertCurrent()
          evidence.status = "error"
        }
        this.scope.assertCurrent()
        evidence.accepted ||= evidence.status === "acked"
        await this.retain([record])
      }
      if (!evidence.accepted) continue
      try {
        const read = await this.input.transport.read(
          target.url,
          this.scope.owner,
          record.event.id,
          this.continues
        )
        this.scope.assertCurrent()
        // Positive exact-event evidence survives partial coverage; EOSE is not required to prove presence.
        const present = read.events.some((e) => {
          try {
            return (
              validateSparkRecoveryEvent(e, this.scope.owner).id ===
              record.event.id
            )
          } catch {
            return false
          }
        })
        evidence.readBack ||= present
        evidence.lastRead = present
          ? "present"
          : read.status === "complete"
            ? "absent"
            : "unavailable"
        evidence.checkedAt = Date.now()
      } catch {
        this.scope.assertCurrent()
        evidence.lastRead = "unavailable"
        evidence.checkedAt = Date.now()
      }
      await this.retain([record])
    }
    return recoveryReadiness(record)
  }

  /** Call only after the user explicitly received and acknowledged the exact recovery bundle. */
  async acknowledgeExport(eventId: string): Promise<void> {
    const state = await this.load()
    const record = state.records.find((r) => r.event.id === eventId)
    if (
      !record ||
      !record.event.tags.some(
        (t) => t[0] === "d" && t[1].startsWith(SPARK_RECOVERY_PREFIX)
      )
    )
      throw new SparkRecoveryError("invalid_record")
    await this.restore({ eventId, source: "conduit_v1" })
    record.exported = true
    await this.retain([record])
  }
}
export function recoveryReadiness(record: SparkRecoveryRecord): {
  ready: boolean
  independentCopies: number
} {
  const operators = new Set(
    record.targets.flatMap((t) => {
      const known = SPARK_RECOVERY_RENDEZVOUS.find((r) => r.url === t.url)
      const evidence = record.delivery.find((d) => d.url === t.url)
      return known &&
        evidence?.accepted &&
        evidence.readBack &&
        evidence.lastRead === "present" &&
        Date.now() - evidence.checkedAt < 300_000 &&
        evidence.checkedAt <= Date.now()
        ? [known.operator]
        : []
    })
  )
  return {
    ready: operators.size >= 2 || record.exported,
    independentCopies: operators.size,
  }
}
