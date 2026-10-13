import { type WalletNameStates } from "./wallet-name-contract"
import {
  mergeAddressRequestRecord,
  requestEvidence,
  type AddressRequestRecord,
} from "./address-request-record"
import {
  NostrSignerError,
  type AccountSigner,
  type AccountSignerOperationOptions,
  type SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import {
  SessionSignerError,
  getAccountSigner,
} from "../protocol/session-signer"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { generateId } from "../utils"
import { getConfiguredIsolatedE2eRelayUrl } from "../protocol/relay-settings"
import {
  bindSparkRecoveryAccount,
  isSparkRecoveryAddress,
  parseAddySparkMnemonic,
  validateAddySparkMnemonic,
  parseSparkPrimaryPointer,
  parseSparkMainWallet,
  parseSparkRecoveryChoiceAddress,
  sparkRecoveryChoiceDTag,
  parseSparkRecoveryEnvelope,
  proveSparkRecoveryCapability,
  sparkRecoveryEnvelopeSchema,
  SparkRecoveryError,
  SPARK_PRIMARY_D_TAG,
  SPARK_MAIN_D_TAG,
  SPARK_RECOVERY_KIND,
  SPARK_RECOVERY_PREFIX,
  validateSparkCiphertext,
  validateSparkRecoveryEvent,
  type SparkIdentityDeriver,
  type SparkRecoveryChoiceDTag,
  type SparkPrimaryPointer,
  type SparkMainWallet,
  type SparkRecoveryBundle,
  type SparkRecoveryEnvelope,
} from "./spark-recovery-contract"
import {
  isSparkWalletRegistryDTag,
  parseSparkWalletRegistrySnapshot,
  resolveSparkWalletRegistry,
  sparkWalletRegistryDTag,
  type SparkWalletRegistrySnapshot,
} from "./spark-wallet-registry"

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
    shouldContinue: () => boolean,
    dTag?: string
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
  /** Device-local decisions; never published or merged from relay events. */
  removedWalletIds?: string[]
  /** Derived visibility cache from the last complete account registry read. */
  registryExcludedWalletIds?: string[]
  /** Local display-name intents and their separate encrypted delivery evidence. */
  walletNameSync?: WalletNameStates
}
/** Ciphertext-only account journal; backups survive replacement of scoped choices. */
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
  network?: SparkRecoveryBundle["network"]
  /** A Conduit backup of the same phrase records the explicit source import. */
  resolved?: boolean
}
export interface SparkRecoveryDiscovery {
  coverage: "complete" | "partial" | "unavailable"
  state: "absent_within_scope" | "recoverable" | "conflict" | "unresolved"
  candidates: SparkRecoveryCandidate[]
  /** Validated Conduit backups before account membership filtering. */
  validatedBackupWalletIds?: string[]
  otherNetworkCandidates?: SparkRecoveryCandidate[]
  lineageRootEventId?: string
  primaryPointerEventId?: string
  primary?: SparkRecoveryCandidate
  main?: SparkRecoveryCandidate
  /** Verified explicit main-wallet choice, separate from registry defaults. */
  mainChoiceWalletId?: string
  invalidCount: number
  sources: { url: string; status: SparkRecoveryRead["status"] }[]
  /** Only a bounded prerequisite for a later explicit lifecycle; never global absence. */
  unresolvedObserved: boolean
  creationEligible: boolean
  registry?: SparkWalletRegistrySnapshot
  registryEventId?: string
  /** The selected snapshot was read back from every frozen registry target. */
  registryMembershipReady?: boolean
  /** Removals in snapshots whose delivery was confirmed, including older heads. */
  confirmedRemovedWalletIds?: string[]
}
const MAX_RECORDS = 128
// Backups and networkless legacy evidence have separate bounded budgets.
// Network-scoped choices retain at most one revision per NIP-01 coordinate.
const MAX_JOURNAL_INPUT_RECORDS = MAX_RECORDS * 16

function compactSparkRecoveryChoices(
  records: SparkRecoveryRecord[]
): SparkRecoveryRecord[] {
  const retained: SparkRecoveryRecord[] = []
  const choices = new Map<string, SparkRecoveryRecord>()
  let backups = 0
  let legacyChoices = 0
  for (const record of records) {
    const dTag = record.event.tags.find((tag) => tag[0] === "d")?.[1]
    if (dTag && isSparkWalletRegistryDTag(dTag)) {
      retained.push(record)
      continue
    }
    const choice = parseSparkRecoveryChoiceAddress(dTag)
    if (!choice?.network) {
      // A legacy coordinate can reference different networks. Preserve that
      // evidence until it has an explicit network; never discard wallet backups.
      if (choice) legacyChoices++
      else backups++
      retained.push(record)
      continue
    }
    const current = choices.get(dTag!)
    if (
      !current ||
      record.event.created_at > current.event.created_at ||
      (record.event.created_at === current.event.created_at &&
        record.event.id < current.event.id)
    )
      choices.set(dTag!, record)
  }
  if (
    backups > MAX_RECORDS ||
    legacyChoices > MAX_RECORDS ||
    retained.length > MAX_RECORDS * 2
  )
    throw new SparkRecoveryError("invalid_record")
  return [...retained, ...choices.values()]
}

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
    targets.some(
      (t) =>
        t.url !== getConfiguredIsolatedE2eRelayUrl() &&
        !normalizePublicWebSocketUrl(t.url)
    )
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
      input.records.length > MAX_JOURNAL_INPUT_RECORDS ||
      (input.removedWalletIds !== undefined &&
        (!Array.isArray(input.removedWalletIds) ||
          input.removedWalletIds.length > MAX_RECORDS ||
          new Set(input.removedWalletIds).size !==
            input.removedWalletIds.length ||
          input.removedWalletIds.some(
            (id) => typeof id !== "string" || !id.length || id.length > 128
          ))) ||
      (input.registryExcludedWalletIds !== undefined &&
        (!Array.isArray(input.registryExcludedWalletIds) ||
          input.registryExcludedWalletIds.length > MAX_RECORDS ||
          new Set(input.registryExcludedWalletIds).size !==
            input.registryExcludedWalletIds.length ||
          input.registryExcludedWalletIds.some(
            (id) => typeof id !== "string" || !id.length || id.length > 128
          )))
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
      // Optional name evidence is validated only by its own boundary. A damaged
      // name journal must not invalidate otherwise valid recovery membership.
      ...(input.walletNameSync
        ? { walletNameSync: structuredClone(input.walletNameSync) }
        : {}),
      records: compactSparkRecoveryChoices(records),
      unresolvedObserved: input.unresolvedObserved,
      ...(input.removedWalletIds
        ? { removedWalletIds: [...input.removedWalletIds] }
        : {}),
      ...(input.registryExcludedWalletIds
        ? { registryExcludedWalletIds: [...input.registryExcludedWalletIds] }
        : {}),
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
      walletNameSync: current.walletNameSync,
      records: [...records.values()],
      unresolvedObserved: current.unresolvedObserved || unresolvedObserved,
      ...(current.removedWalletIds
        ? { removedWalletIds: current.removedWalletIds }
        : {}),
      ...(current.registryExcludedWalletIds
        ? { registryExcludedWalletIds: current.registryExcludedWalletIds }
        : {}),
    },
    current.ownerPubkey
  )
}

export class SparkRecoveryService {
  private readonly scope: ReturnType<typeof bindSparkRecoveryAccount>
  private readonly current: () => AccountSigner | undefined
  private readonly plan: SparkRecoveryRelay[]
  private readonly verifiedPrimaryPointers = new Map<
    SparkRecoveryBundle["network"],
    string | undefined
  >()
  private readonly verifiedMainChoices = new Map<
    SparkRecoveryBundle["network"],
    string | undefined
  >()
  getVerifiedMainChoiceEventId(
    network: SparkRecoveryBundle["network"]
  ): string | undefined {
    this.scope.assertCurrent()
    return this.verifiedMainChoices.get(network)
  }
  getVerifiedPrimaryPointerEventId(
    network: SparkRecoveryBundle["network"]
  ): string | undefined {
    this.scope.assertCurrent()
    return this.verifiedPrimaryPointers.get(network)
  }
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
    const isolated = getConfiguredIsolatedE2eRelayUrl()
    this.plan = isolated
      ? [{ url: isolated, operator: null }]
      : planSparkRecoveryRelays(input.userRelayUrls)
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
  private async decrypt(
    event: SignedNostrEvent,
    options: AccountSignerOperationOptions = {}
  ): Promise<string> {
    const verified = validateSparkRecoveryEvent(event, this.scope.owner)
    this.scope.assertCurrent()
    const plaintext = await this.input.signer.decryptNip44(
      this.scope.owner,
      verified.content,
      options
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
    createdAt: number,
    options: AccountSignerOperationOptions = { priority: "foreground" }
  ): Promise<SignedNostrEvent> {
    this.scope.assertCurrent()
    const plaintext = JSON.stringify(payload)
    const content = await this.input.signer.encryptNip44(
      this.scope.owner,
      plaintext,
      options
    )
    this.scope.assertCurrent()
    validateSparkCiphertext(content)
    const event = await this.input.signer.signEvent(
      {
        kind: SPARK_RECOVERY_KIND,
        pubkey: this.scope.owner,
        created_at: createdAt,
        tags: [["d", d]],
        content,
      },
      options
    )
    this.scope.assertCurrent()
    const verified = validateSparkRecoveryEvent(event, this.scope.owner)
    if ((await this.decrypt(verified, options)) !== plaintext)
      throw new SparkRecoveryError("invalid_record")
    return verified
  }

  /** Explicit creation/import preparation only. No seed generation or primary rollout. */
  async prepare(
    bundle: SparkRecoveryBundle,
    walletId = generateId(),
    rootBackupEventId?: string
  ): Promise<SparkRecoveryCandidate> {
    await proveSparkRecoveryCapability(this.input.signer, this.current)
    const createdAt = Math.floor(Date.now() / 1000)
    // Validate mnemonic/network/account before any provider call or encryption.
    const parsed = sparkRecoveryEnvelopeSchema.safeParse({
      ...bundle,
      format: "conduit.spark.recovery",
      version: 1,
      ownerPubkey: this.scope.owner,
      ...(rootBackupEventId ? { rootBackupEventId } : {}),
      walletId,
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
    const envelope = await this.restore(candidate, undefined, {
      priority: "foreground",
    })
    if (!("walletId" in envelope))
      throw new SparkRecoveryError("invalid_record")
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      ...state.records
        .filter((r) =>
          r.event.tags.some((t) => {
            const choice =
              t[0] === "d" ? parseSparkRecoveryChoiceAddress(t[1]) : undefined
            return (
              choice?.type === "primary" &&
              (!choice.network || choice.network === envelope.network)
            )
          })
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
    const event = await this.sign(
      sparkRecoveryChoiceDTag("primary", envelope.network),
      pointer,
      createdAt
    )
    await this.retain([this.record(event)])
    this.verifiedPrimaryPointers.set(envelope.network, event.id)
    return event.id
  }

  /** Explicit account main-wallet choice, independent of immutable backup roots. */
  async prepareMain(
    candidate: SparkRecoveryCandidate,
    commit?: (retain: () => Promise<void>) => Promise<void>
  ): Promise<string> {
    const state = await this.load()
    const envelope = await this.restore(candidate, undefined, {
      priority: "foreground",
    })
    if (!("walletId" in envelope))
      throw new SparkRecoveryError("invalid_record")
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      ...state.records
        .filter((r) =>
          r.event.tags.some((t) => {
            const choice =
              t[0] === "d" ? parseSparkRecoveryChoiceAddress(t[1]) : undefined
            return (
              choice?.type === "main" &&
              (!choice.network || choice.network === envelope.network)
            )
          })
        )
        .map((r) => r.event.created_at + 1)
    )
    const selection: SparkMainWallet = {
      format: "conduit.spark.main",
      version: 1,
      ownerPubkey: this.scope.owner,
      walletId: envelope.walletId,
      backupEventId: candidate.eventId,
      createdAt,
    }
    const event = await this.sign(
      sparkRecoveryChoiceDTag("main", envelope.network),
      selection,
      createdAt
    )
    const record = this.record(event)
    // Signer consent finishes before the caller's local transaction. Only the
    // successful commit may activate this choice for future recovery retries.
    const retain = () => this.retain([record])
    if (commit) await commit(retain)
    else await retain()
    this.verifiedMainChoices.set(envelope.network, event.id)
    return event.id
  }

  /** Replace one encrypted account/network snapshot after a complete bounded read. */
  async prepareRegistry(
    network: SparkRecoveryBundle["network"],
    change:
      | { type: "bootstrap" }
      | { type: "add"; walletId: string }
      | {
          type: "remove"
          walletId: string
          replacementPayWalletId?: string
        }
      | { type: "main"; walletId: string }
      | {
          type: "address_request"
          walletId: string
          record: AddressRequestRecord
        },
    commit?: (retain: () => Promise<void>) => Promise<void>,
    options: AccountSignerOperationOptions = { priority: "foreground" }
  ): Promise<string> {
    const discovery = await this.discover(false, network, options)
    if (
      discovery.coverage !== "complete" ||
      discovery.invalidCount ||
      discovery.unresolvedObserved ||
      discovery.state === "conflict" ||
      discovery.state === "unresolved" ||
      discovery.candidates.some(
        (candidate) => candidate.source === "addy" && !candidate.resolved
      )
    )
      throw new SparkRecoveryError("incomplete_discovery")
    const local = await this.load()
    const validatedWalletIds = new Set(
      discovery.validatedBackupWalletIds ??
        discovery.candidates.flatMap((candidate) =>
          candidate.source === "conduit_v1" &&
          candidate.network === network &&
          candidate.walletId
            ? [candidate.walletId]
            : []
        )
    )
    const localRemoved = (local.removedWalletIds ?? []).filter((walletId) =>
      validatedWalletIds.has(walletId)
    )
    const previous = discovery.registry
    if (change.type === "bootstrap" && previous)
      throw new SparkRecoveryError("conflict")
    if (previous && discovery.registryEventId) {
      const head = local.records.find(
        (record) => record.event.id === discovery.registryEventId
      )
      if (!head) throw new SparkRecoveryError("conflict")
      const storedHead = parseSparkWalletRegistrySnapshot(
        await this.decrypt(head.event, options),
        head.event
      )
      const metadataNeedsRepair =
        JSON.stringify(storedHead.addressNameRequests ?? {}) !==
          JSON.stringify(previous.addressNameRequests ?? {}) ||
        JSON.stringify(storedHead.walletNames ?? {}) !==
          JSON.stringify(previous.walletNames ?? {})
      const applied =
        change.type === "remove"
          ? previous.removedWalletIds.includes(change.walletId) &&
            !previous.activeWalletIds.includes(change.walletId)
          : change.type === "address_request"
            ? JSON.stringify(
                previous.addressNameRequests?.[change.walletId]
              ) ===
              JSON.stringify(
                mergeAddressRequestRecord(
                  previous.addressNameRequests?.[change.walletId],
                  change.record
                )
              )
            : change.type === "add"
              ? previous.activeWalletIds.includes(change.walletId)
              : change.type === "bootstrap"
                ? false
                : previous.payInvoiceWalletId === change.walletId &&
                  previous.receiveWalletId === change.walletId
      if (
        applied &&
        !metadataNeedsRepair &&
        localRemoved.every((walletId) =>
          previous.removedWalletIds.includes(walletId)
        )
      ) {
        if (commit) await commit(async () => undefined)
        return discovery.registryEventId
      }
    }
    // A retained snapshot is not a committed head. Repair its exact signed
    // bytes before signing a successor, even if the current relay reads agree.
    if (previous && !discovery.registryMembershipReady)
      throw new SparkRecoveryError("conflict")
    const dTag = sparkWalletRegistryDTag(network)
    // A local lock does not serialize another app or device. Require every
    // planned relay to agree with the frozen head before signing a mutation.
    for (const target of this.plan) {
      this.scope.assertCurrent()
      const read = await this.input.transport.read(
        target.url,
        this.scope.owner,
        undefined,
        this.continues,
        dTag
      )
      this.scope.assertCurrent()
      if (
        read.status !== "complete" ||
        read.events.length > 1 ||
        (read.events[0]?.id ?? undefined) !== discovery.registryEventId
      )
        throw new SparkRecoveryError("conflict")
    }
    const active = new Set(
      previous?.activeWalletIds ??
        discovery.candidates.flatMap((candidate) =>
          candidate.source === "conduit_v1" && candidate.walletId
            ? [candidate.walletId]
            : []
        )
    )
    const removed = new Set([
      ...(previous?.removedWalletIds ?? []),
      ...localRemoved,
    ])
    for (const walletId of removed) active.delete(walletId)
    if (removed.size > MAX_RECORDS) throw new SparkRecoveryError("conflict")
    if (change.type === "remove") {
      active.delete(change.walletId)
      removed.add(change.walletId)
    } else if (change.type === "add") {
      if (removed.has(change.walletId)) throw new SparkRecoveryError("conflict")
      const knownBackup = local.records.some((record) =>
        record.event.tags.some(
          (tag) =>
            tag[0] === "d" && tag[1] === SPARK_RECOVERY_PREFIX + change.walletId
        )
      )
      if (!knownBackup) throw new SparkRecoveryError("incomplete_discovery")
      active.add(change.walletId)
    } else if (change.type !== "bootstrap" && !active.has(change.walletId)) {
      throw new SparkRecoveryError("conflict")
    }
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      (previous?.createdAt ?? 0) + 1
    )
    const firstWallet = active.size === 1 ? [...active][0] : null
    const deterministicReplacement = [...active].sort()[0] ?? null
    if (
      change.type === "remove" &&
      change.replacementPayWalletId &&
      !active.has(change.replacementPayWalletId)
    )
      throw new SparkRecoveryError("conflict")
    const legacyPay = discovery.main?.walletId ?? discovery.primary?.walletId
    const legacyReceive = discovery.main?.walletId
    const payFallback = previous?.payInvoiceWalletId ?? legacyPay ?? firstWallet
    const receiveFallback =
      previous?.receiveWalletId ?? legacyReceive ?? firstWallet
    const addressNameRequests = { ...previous?.addressNameRequests }
    for (const walletId of removed) delete addressNameRequests[walletId]
    if (change.type === "address_request") {
      const evidence = requestEvidence(change.record)
      const backup = local.records.find((record) =>
        record.event.tags.some(
          (tag) =>
            tag[0] === "d" && tag[1] === SPARK_RECOVERY_PREFIX + change.walletId
        )
      )
      if (!backup || network !== "mainnet")
        throw new SparkRecoveryError("invalid_record")
      const envelope = parseSparkRecoveryEnvelope(
        await this.decrypt(backup.event, options),
        backup.event
      )
      if (
        envelope.identityPublicKey !== evidence.sparkIdentity ||
        evidence.ownerPubkey !== this.scope.owner
      )
        throw new SparkRecoveryError("identity_mismatch")
      addressNameRequests[change.walletId] = mergeAddressRequestRecord(
        addressNameRequests[change.walletId],
        change.record
      )
    }
    const snapshot: SparkWalletRegistrySnapshot = {
      ...previous,
      ...(previous?.walletNames
        ? {
            walletNames: Object.fromEntries(
              Object.entries(previous.walletNames).filter(([walletId]) =>
                active.has(walletId)
              )
            ),
          }
        : {}),
      addressNameRequests: Object.keys(addressNameRequests).length
        ? addressNameRequests
        : undefined,
      format: "conduit.spark.registry",
      version: 1,
      ownerPubkey: this.scope.owner,
      network,
      revision: (previous?.revision ?? 0) + 1,
      parentEventId: discovery.registryEventId ?? null,
      activeWalletIds: [...active].sort(),
      removedWalletIds: [...removed].sort(),
      payInvoiceWalletId:
        change.type === "main"
          ? change.walletId
          : active.has(payFallback ?? "")
            ? payFallback
            : change.type === "remove" || localRemoved.length > 0
              ? ((change.type === "remove"
                  ? change.replacementPayWalletId
                  : undefined) ?? deterministicReplacement)
              : null,
      receiveWalletId:
        change.type === "main"
          ? change.walletId
          : active.has(receiveFallback ?? "")
            ? receiveFallback
            : change.type === "remove" || localRemoved.length > 0
              ? deterministicReplacement
              : null,
      createdAt,
    }
    if (
      snapshot.activeWalletIds.length > MAX_RECORDS ||
      snapshot.removedWalletIds.length > MAX_RECORDS
    )
      throw new SparkRecoveryError("conflict")
    const event = await this.sign(dTag, snapshot, createdAt, options)
    parseSparkWalletRegistrySnapshot(await this.decrypt(event, options), event)
    const retain = () => this.retain([this.record(event)])
    if (commit) await commit(retain)
    else await retain()
    return event.id
  }

  async restore(
    candidate: SparkRecoveryCandidate,
    addySource?: Pick<SparkRecoveryBundle, "network" | "accountNumber">,
    options: AccountSignerOperationOptions = {}
  ): Promise<SparkRecoveryEnvelope | SparkRecoveryBundle> {
    const state = await this.load()
    const record = state.records.find((r) => r.event.id === candidate.eventId)
    if (!record) throw new SparkRecoveryError("invalid_record")
    const plaintext = await this.decrypt(record.event, options)
    const d = record.event.tags.find((t) => t[0] === "d")?.[1]
    if (!d) throw new SparkRecoveryError("invalid_record")
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

  async discover(
    hasLocalWallet = false,
    network?: SparkRecoveryBundle["network"],
    options: AccountSignerOperationOptions = {}
  ): Promise<SparkRecoveryDiscovery> {
    const saved = await this.load()
    const records = new Map(saved.records.map((r) => [r.event.id, r]))
    const sources: SparkRecoveryDiscovery["sources"] = []
    let invalidCount = 0
    let unresolvedObserved = saved.unresolvedObserved
    const admit = (results: SparkRecoveryRead[]) => {
      for (const input of results.flatMap((read) =>
        read.events.slice(0, MAX_RECORDS)
      )) {
        // NIP-01 has exact #d matching, no namespace prefix filter.
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
          // Only authenticated owner recovery evidence can outlive this read.
          // Malformed plaintext is never retained, but its signed existence
          // still blocks duplicate creation after a relay omits it.
          if (
            input.pubkey === this.scope.owner &&
            input.kind === SPARK_RECOVERY_KIND &&
            isValidSignedPublicNostrEvent(input)
          )
            unresolvedObserved = true
        }
      }
    }
    const retainObserved = async () => {
      let retained: SparkRecoveryRecord[]
      try {
        retained = validateSparkRecoveryState(
          {
            ownerPubkey: this.scope.owner,
            records: [...records.values()],
            unresolvedObserved,
          },
          this.scope.owner
        ).records
      } catch {
        throw new SparkRecoveryError("conflict")
      }
      await this.retain(retained, unresolvedObserved)
      return retained
    }
    // Primary coordinates cannot be crowded out by unrelated NIP-78 records.
    // Broad coverage still governs creation; exact positive evidence only restores.
    const readAt = async (
      url: string,
      eventId?: string,
      dTag?: string
    ): Promise<SparkRecoveryRead> => {
      this.scope.assertCurrent()
      try {
        const read = await this.input.transport.read(
          url,
          this.scope.owner,
          eventId,
          this.continues,
          dTag
        )
        this.scope.assertCurrent()
        return read
      } catch {
        this.scope.assertCurrent()
        return { status: "unavailable", events: [] }
      }
    }
    const reads = await Promise.all(
      this.plan.map(async (target) => {
        const networks = network
          ? [network]
          : (["mainnet", "testnet", "signet", "regtest"] as const)
        const coordinates: SparkRecoveryChoiceDTag[] = [
          SPARK_PRIMARY_D_TAG,
          SPARK_MAIN_D_TAG,
          ...networks.flatMap((n) => [
            sparkRecoveryChoiceDTag("primary", n),
            sparkRecoveryChoiceDTag("main", n),
          ]),
        ]
        const choiceReads = Promise.all(
          coordinates.map(async (dTag) => {
            const read = await readAt(target.url, undefined, dTag)
            if (read.events.length > 1) read.status = "partial"
            return read
          })
        )
        const [broad, choices] = await Promise.all([
          readAt(target.url),
          choiceReads,
        ])
        const registryRead = network
          ? [
              await readAt(
                target.url,
                undefined,
                sparkWalletRegistryDTag(network)
              ),
            ]
          : []
        return {
          target,
          results: [broad, ...choices, ...registryRead],
          registryRead: registryRead[0],
        }
      })
    )
    const references = new Set<string>()
    for (const { results } of reads) admit(results)
    // Retain positive evidence before asking the signer. Denial, pause, or a
    // provider outage must neither erase it nor become a permanent data verdict.
    await retainObserved()
    // Serialize signer decryption. Signed references survive omissions and are
    // followed across the whole bounded plan, not only their source relay.
    for (const { event: input } of records.values()) {
      if (
        !input.tags.some(
          (tag) => tag[0] === "d" && !!parseSparkRecoveryChoiceAddress(tag[1])
        )
      )
        continue
      try {
        const event = validateSparkRecoveryEvent(input, this.scope.owner)
        const plaintext = await this.decrypt(event, options)
        const pointer = event.tags.some(
          (t) =>
            t[0] === "d" &&
            parseSparkRecoveryChoiceAddress(t[1])?.type === "primary"
        )
          ? parseSparkPrimaryPointer(plaintext, event)
          : parseSparkMainWallet(plaintext, event)
        references.add(pointer.backupEventId)
      } catch (error) {
        this.scope.assertCurrent()
        if (
          error instanceof SessionSignerError ||
          (error instanceof NostrSignerError &&
            error.code !== "invalid_response" &&
            error.code !== "unavailable")
        )
          throw error
        invalidCount++
      }
    }
    if (references.size > MAX_RECORDS) throw new SparkRecoveryError("conflict")
    await Promise.all(
      reads.map(async ({ target, results }) => {
        const referenced = await Promise.all(
          [...references].map((eventId) => readAt(target.url, eventId))
        )
        admit(referenced)
        results.push(...referenced)
      })
    )
    for (const { target, results } of reads) {
      const statuses = results.map((read) =>
        read.events.length >= MAX_RECORDS ? "partial" : read.status
      )
      const status = statuses.every((value) => value === "complete")
        ? "complete"
        : statuses.every((value) => value === "unavailable")
          ? "unavailable"
          : "partial"
      sources.push({ url: target.url, status })
    }
    const retainedRecords = await retainObserved()
    records.clear()
    for (const record of retainedRecords) records.set(record.event.id, record)
    const candidates: SparkRecoveryCandidate[] = []
    const envelopes = new Map<string, SparkRecoveryEnvelope>()
    const addyPhrases = new Map<string, string>()
    const pointers: SparkPrimaryPointer[] = []
    const pointerEvents = new Map<SparkPrimaryPointer, SignedNostrEvent>()
    const pointerScopes = new Map<
      SparkPrimaryPointer,
      SparkRecoveryBundle["network"] | undefined
    >()
    const mainChoices: Array<{
      event: SignedNostrEvent
      selection: SparkMainWallet
      network?: SparkRecoveryBundle["network"]
    }> = []
    const registryChoices: Array<{
      event: SignedNostrEvent
      snapshot: SparkWalletRegistrySnapshot
    }> = []
    for (const record of records.values()) {
      const event = record.event
      const d = event.tags.find((t) => t[0] === "d")?.[1]
      if (!d) {
        invalidCount++
        continue
      }
      try {
        const plaintext = await this.decrypt(event, options)
        // Validate the legacy phrase/address now. Actual source parameters remain required at restore.
        if (isSparkWalletRegistryDTag(d)) {
          registryChoices.push({
            event,
            snapshot: parseSparkWalletRegistrySnapshot(plaintext, event),
          })
          continue
        }
        if (d.startsWith("spark-wallet-backup")) {
          addyPhrases.set(event.id, validateAddySparkMnemonic(plaintext, event))
          candidates.push({ eventId: event.id, source: "addy" })
          continue
        }
        const choice = parseSparkRecoveryChoiceAddress(d)
        if (choice?.type === "primary") {
          const pointer = parseSparkPrimaryPointer(plaintext, event)
          pointers.push(pointer)
          pointerEvents.set(pointer, event)
          pointerScopes.set(pointer, choice.network)
        } else if (choice?.type === "main")
          mainChoices.push({
            event,
            selection: parseSparkMainWallet(plaintext, event),
            network: choice.network,
          })
        else {
          const envelope = parseSparkRecoveryEnvelope(plaintext, event)
          if ((await this.identity(envelope)) !== envelope.identityPublicKey)
            throw new SparkRecoveryError("identity_mismatch")
          envelopes.set(event.id, envelope)
          candidates.push({
            eventId: event.id,
            walletId: envelope.walletId,
            source: "conduit_v1",
            network: envelope.network,
          })
        }
      } catch (error) {
        this.scope.assertCurrent()
        // Denial/timeout/unsupported remain actionable signer failures, not malformed data.
        if (
          error instanceof SessionSignerError ||
          (error instanceof NostrSignerError &&
            error.code !== "invalid_response" &&
            error.code !== "unavailable")
        )
          throw error
        invalidCount++
      }
    }
    const registryObserved = network
      ? resolveSparkWalletRegistry(
          registryChoices.filter(
            (choice) => choice.snapshot.network === network
          )
        )
      : undefined
    const hasExactRegistryReadback = (eventId: string): boolean =>
      !!network &&
      reads.every(({ registryRead: exact }) => {
        return (
          exact?.status === "complete" &&
          exact.events.length === 1 &&
          exact.events[0]?.id === eventId &&
          isValidSignedPublicNostrEvent(exact.events[0])
        )
      })
    const hasHistoricalRegistryReadback = (eventId: string): boolean => {
      const record = records.get(eventId)
      return (
        !!record?.targets.length &&
        record.targets.every((target) => {
          const evidence = record.delivery.find(
            (item) => item.url === target.url
          )
          return evidence?.accepted === true && evidence.readBack === true
        })
      )
    }
    const registryMembershipReady = registryObserved
      ? hasHistoricalRegistryReadback(registryObserved.eventId) ||
        hasExactRegistryReadback(registryObserved.eventId)
      : false
    const confirmedRemovedWalletIds = [
      ...new Set(
        registryChoices
          .filter(({ snapshot }) => !network || snapshot.network === network)
          .filter(
            ({ event }) =>
              hasHistoricalRegistryReadback(event.id) ||
              hasExactRegistryReadback(event.id)
          )
          .flatMap(({ snapshot }) => snapshot.removedWalletIds)
      ),
    ]
    const coverage = sources.every((s) => s.status === "complete")
      ? "complete"
      : sources.every((s) => s.status === "unavailable")
        ? "unavailable"
        : "partial"
    // Retain every backup and the current scoped choices, but decide restoration/
    // creation for the configured network. Unknown targets and Addy stay relevant.
    const inScope = (candidate: SparkRecoveryCandidate) =>
      !network || candidate.source === "addy" || candidate.network === network
    const scopedCandidates = candidates.filter(
      (candidate) =>
        inScope(candidate) &&
        (!registryObserved ||
          candidate.source === "addy" ||
          (!!candidate.walletId &&
            registryObserved.snapshot.activeWalletIds.includes(
              candidate.walletId
            )))
    )
    for (const candidate of scopedCandidates) {
      if (candidate.source !== "addy") continue
      candidate.resolved = [...envelopes.values()].some(
        (envelope) =>
          (!network || envelope.network === network) &&
          envelope.mnemonic === addyPhrases.get(candidate.eventId)
      )
    }
    const findTarget = (pointer: SparkPrimaryPointer | SparkMainWallet) =>
      candidates.find(
        (c) =>
          c.eventId === pointer.backupEventId && c.walletId === pointer.walletId
      )
    const validChoiceScope = (
      pointer: SparkPrimaryPointer | SparkMainWallet,
      declared?: SparkRecoveryBundle["network"]
    ) => {
      const target = findTarget(pointer)
      if (declared && target && target.network !== declared) {
        invalidCount++
        return false
      }
      return true
    }
    const scopedPointers = pointers
      .filter((pointer) =>
        validChoiceScope(pointer, pointerScopes.get(pointer))
      )
      .filter((pointer) => {
        const target = findTarget(pointer)
        return !target || inScope(target)
      })
      .sort((a, b) => {
        const left = pointerEvents.get(a)!
        const right = pointerEvents.get(b)!
        return (
          right.created_at - left.created_at || left.id.localeCompare(right.id)
        )
      })
    const roots = new Set(
      scopedCandidates.flatMap((candidate) => {
        const envelope = envelopes.get(candidate.eventId)
        return envelope ? [envelope.rootBackupEventId ?? candidate.eventId] : []
      })
    )
    const pointerTargets = new Set(
      scopedPointers.map((p) => `${p.backupEventId}:${p.walletId}`)
    )
    const primary =
      scopedPointers.length && pointerTargets.size === 1
        ? findTarget(scopedPointers[0])
        : undefined
    // A verified root backup or primary on another network can identify the
    // common lineage without selecting or opening a wallet on that network.
    const knownRoot =
      [...roots].some((root) => envelopes.has(root)) ||
      pointers.some((pointer) => {
        const target = findTarget(pointer)
        return target && roots.has(target.eventId)
      })
    const relevantCandidates = scopedCandidates.filter(
      (candidate) => candidate.source !== "addy" || !candidate.resolved
    )
    const legacyConflict =
      roots.size > 1 ||
      pointerTargets.size > 1 ||
      (!primary && !knownRoot && relevantCandidates.length > 1)
    const conflict = registryObserved
      ? registryObserved.conflict
      : legacyConflict
    // NIP-01 addressable revision order. Legacy history remains evidence,
    // not permission to create a wallet or substitute another network's choice.
    const latestMainChoice = mainChoices
      .filter((choice) => validChoiceScope(choice.selection, choice.network))
      .filter((choice) => {
        const target = findTarget(choice.selection)
        return !target || inScope(target)
      })
      .sort(
        (a, b) =>
          b.event.created_at - a.event.created_at ||
          a.event.id.localeCompare(b.event.id)
      )[0]
    const latestMain = latestMainChoice?.selection
    const latestMainTarget = latestMain ? findTarget(latestMain) : undefined
    const mainInScope =
      latestMain && (!latestMainTarget || inScope(latestMainTarget))
    const legacyMain = mainInScope ? latestMainTarget : undefined
    const main = registryObserved
      ? scopedCandidates.find(
          (candidate) =>
            candidate.walletId === registryObserved.snapshot.receiveWalletId
        )
      : legacyMain
    const creationEligible =
      coverage === "complete" &&
      (registryObserved
        ? registryObserved.snapshot.activeWalletIds.length === 0
        : network
          ? relevantCandidates.length === 0 &&
            !scopedPointers.length &&
            !mainInScope
          : records.size === 0) &&
      !unresolvedObserved &&
      invalidCount === 0 &&
      !hasLocalWallet
    const primaryPointerEventId =
      !conflict && primary
        ? pointerEvents.get(scopedPointers[0])?.id
        : undefined
    if (network) {
      this.verifiedPrimaryPointers.set(network, primaryPointerEventId)
      this.verifiedMainChoices.set(
        network,
        !conflict && main ? latestMainChoice?.event.id : undefined
      )
    }
    const registryMissingBackup =
      registryObserved?.snapshot.activeWalletIds.some(
        (id) => !scopedCandidates.some((candidate) => candidate.walletId === id)
      ) ?? false
    return {
      coverage,
      state: conflict
        ? "conflict"
        : registryMissingBackup
          ? "unresolved"
          : registryObserved
            ? scopedCandidates.length
              ? "recoverable"
              : "absent_within_scope"
            : (scopedPointers.length && !primary) || (mainInScope && !main)
              ? "unresolved"
              : relevantCandidates.length
                ? "recoverable"
                : creationEligible
                  ? "absent_within_scope"
                  : "unresolved",
      candidates: scopedCandidates,
      validatedBackupWalletIds: candidates.flatMap((candidate) =>
        candidate.source === "conduit_v1" &&
        (!network || candidate.network === network) &&
        candidate.walletId
          ? [candidate.walletId]
          : []
      ),
      otherNetworkCandidates: candidates.filter(
        (candidate) => !inScope(candidate)
      ),
      lineageRootEventId: roots.size === 1 ? [...roots][0] : undefined,
      primaryPointerEventId,
      primary: conflict
        ? undefined
        : registryObserved
          ? scopedCandidates.find(
              (candidate) =>
                candidate.walletId ===
                registryObserved.snapshot.payInvoiceWalletId
            )
          : primary,
      main: conflict ? undefined : main,
      mainChoiceWalletId:
        !conflict &&
        latestMainChoice &&
        latestMainTarget?.walletId &&
        (!registryObserved ||
          registryObserved.snapshot.activeWalletIds.includes(
            latestMainTarget.walletId
          ))
          ? latestMainTarget.walletId
          : undefined,
      invalidCount,
      sources,
      unresolvedObserved,
      creationEligible,
      registry: registryObserved?.snapshot,
      registryEventId: registryObserved?.eventId,
      registryMembershipReady,
      confirmedRemovedWalletIds,
    }
  }

  /** Repair uses stored bytes and targets. It never encrypts, signs, widens, or creates. */
  async deliver(
    eventId: string,
    options: AccountSignerOperationOptions = {}
  ): Promise<{ ready: boolean; independentCopies: number }> {
    const saved = await this.load()
    const record = saved.records.find((r) => r.event.id === eventId)
    if (!record) throw new SparkRecoveryError("invalid_record")
    const address = record.event.tags.find((tag) => tag[0] === "d")?.[1]
    if (address && isSparkWalletRegistryDTag(address)) {
      const snapshot = parseSparkWalletRegistrySnapshot(
        await this.decrypt(record.event, options),
        record.event
      )
      // Recheck all relay heads before a retry can replace another writer's
      // newer snapshot. The signed event itself remains byte-identical.
      for (const target of record.targets) {
        this.scope.assertCurrent()
        const read = await this.input.transport.read(
          target.url,
          this.scope.owner,
          undefined,
          this.continues,
          address
        )
        this.scope.assertCurrent()
        if (read.status !== "complete" || read.events.length > 1)
          throw new SparkRecoveryError("conflict")
        const head = read.events[0]
        if (head) validateSparkRecoveryEvent(head, this.scope.owner)
        if (
          (head?.id ?? null) !== snapshot.parentEventId &&
          head?.id !== record.event.id
        )
          throw new SparkRecoveryError("conflict")
      }
    }
    const deliveryByUrl = new Map(
      record.delivery.map((evidence) => [evidence.url, evidence])
    )
    for (const target of record.targets) {
      this.scope.assertCurrent()
      const evidence = deliveryByUrl.get(target.url)
      if (!evidence) throw new SparkRecoveryError("invalid_record")
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
    return address && isSparkWalletRegistryDTag(address)
      ? accountRegistryReadiness(record)
      : recoveryReadiness(record)
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
      return known && hasFreshReadback(evidence) ? [known.operator] : []
    })
  )
  return {
    ready: operators.size >= 2 || record.exported,
    independentCopies: operators.size,
  }
}

function hasFreshReadback(
  evidence: SparkRecoveryDelivery | undefined
): boolean {
  return (
    !!evidence?.accepted &&
    evidence.readBack &&
    evidence.lastRead === "present" &&
    Date.now() - evidence.checkedAt < 300_000 &&
    evidence.checkedAt <= Date.now()
  )
}

/** Account snapshots require delivery across the whole frozen relay plan. */
export function accountRegistryReadiness(record: SparkRecoveryRecord): {
  ready: boolean
  independentCopies: number
} {
  return {
    ready:
      record.targets.length > 0 &&
      record.targets.every((target) =>
        hasFreshReadback(
          record.delivery.find((evidence) => evidence.url === target.url)
        )
      ),
    independentCopies: recoveryReadiness(record).independentCopies,
  }
}
