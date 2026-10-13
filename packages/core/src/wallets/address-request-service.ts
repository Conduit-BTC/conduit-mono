import type {
  AccountSigner,
  AccountSignerOperationOptions,
  SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { getAccountSigner } from "../protocol/session-signer"
import { getConfiguredIsolatedE2eRelayUrl } from "../protocol/relay-settings"
import {
  mergeAddressRequestRecord,
  requestEvidence,
  type AddressRequestRecord,
} from "./address-request-record"
import {
  parseAddressRequests,
  validateAddressRequestEvent,
  type AddressRequestNetwork,
  type AddressRequestSnapshot,
  type AddressRequestState,
} from "./address-request-metadata"
import type { AddressRequestStore } from "./address-request-store"
import {
  addressRequestsDTag,
  sparkWalletRegistryDTag,
} from "./spark-recovery-address"
import {
  bindSparkRecoveryAccount,
  SparkRecoveryError,
} from "./spark-recovery-contract"
import {
  planSparkRecoveryRelays,
  type SparkRecoveryDiscovery,
  type SparkRecoveryTransport,
} from "./spark-recovery-service"

type Records = Record<string, AddressRequestRecord>
function combine(
  into: Records,
  incoming: Records,
  active: Set<string>
): Records {
  for (const [id, record] of Object.entries(incoming)) {
    if (!active.has(id)) continue
    into[id] = mergeAddressRequestRecord(into[id], record)
  }
  return into
}

/** Optional progress: it can never create membership or approve a request. */
export class AddressRequestService {
  private readonly scope
  private readonly targets: string[]
  constructor(
    private readonly input: {
      signer: AccountSigner
      store: AddressRequestStore
      transport: SparkRecoveryTransport
      currentSigner?: () => AccountSigner | undefined
      userRelayUrls?: readonly string[]
    }
  ) {
    this.scope = bindSparkRecoveryAccount(
      input.signer,
      input.currentSigner ?? getAccountSigner
    )
    const isolated = getConfiguredIsolatedE2eRelayUrl()
    this.targets = isolated
      ? [isolated]
      : planSparkRecoveryRelays(input.userRelayUrls).map((target) => target.url)
  }
  private continues = () => {
    try {
      this.scope.assertCurrent()
      return true
    } catch {
      return false
    }
  }
  private async decrypt(
    event: SignedNostrEvent,
    network: AddressRequestNetwork,
    options: AccountSignerOperationOptions
  ): Promise<AddressRequestSnapshot> {
    validateAddressRequestEvent(event, this.scope.owner, network)
    const plaintext = await this.input.signer.decryptNip44(
      this.scope.owner,
      event.content,
      options
    )
    this.scope.assertCurrent()
    return parseAddressRequests(plaintext, event, network)
  }
  private membership(discovery: SparkRecoveryDiscovery): Set<string> {
    if (
      discovery.state === "conflict" ||
      discovery.state === "unresolved" ||
      !discovery.registry
    )
      throw new SparkRecoveryError("incomplete_discovery")
    const removed = new Set(discovery.registry.removedWalletIds)
    return new Set(
      discovery.registry.activeWalletIds.filter((id) => !removed.has(id))
    )
  }
  private async read(
    network: AddressRequestNetwork,
    options: AccountSignerOperationOptions
  ): Promise<{ heads: (SignedNostrEvent | undefined)[]; complete: boolean }> {
    const reads = await Promise.all(
      this.targets.map(async (url) => {
        this.scope.assertCurrent()
        try {
          const result = await this.input.transport.read(
            url,
            this.scope.owner,
            undefined,
            this.continues,
            addressRequestsDTag(network)
          )
          this.scope.assertCurrent()
          return result
        } catch {
          this.scope.assertCurrent()
          return { status: "unavailable" as const, events: [] }
        }
      })
    )
    const complete = reads.every(
      (read) => read.status === "complete" && read.events.length <= 1
    )
    const heads = reads.map((read) => read.events[0])
    for (const head of heads)
      if (head) await this.decrypt(head, network, options)
    return { heads, complete }
  }
  private async membershipHeadUnchanged(
    network: AddressRequestNetwork,
    eventId: string | undefined
  ): Promise<boolean> {
    if (!eventId) return false
    for (const url of this.targets) {
      this.scope.assertCurrent()
      const membership = await this.input.transport.read(
        url,
        this.scope.owner,
        undefined,
        this.continues,
        sparkWalletRegistryDTag(network)
      )
      this.scope.assertCurrent()
      if (
        membership.status !== "complete" ||
        membership.events.length !== 1 ||
        membership.events[0].id !== eventId
      )
        return false
    }
    return true
  }
  private async collect(
    network: AddressRequestNetwork,
    discovery: SparkRecoveryDiscovery,
    options: AccountSignerOperationOptions
  ): Promise<{
    active: Set<string>
    records: Records
    state: AddressRequestState
    heads: (SignedNostrEvent | undefined)[]
    readComplete: boolean
    complete: boolean
    head?: SignedNostrEvent
  }> {
    this.scope.assertCurrent()
    const active = this.membership(discovery)
    const state = await this.input.store.load(this.scope.owner, network)
    this.scope.assertCurrent()
    const { heads, complete } = await this.read(network, options)
    const records = combine(
      {},
      discovery.registry?.addressNameRequests ?? {},
      active
    )
    if (state.observed)
      combine(
        records,
        (await this.decrypt(state.observed, network, options)).requests,
        active
      )
    if (state.operation)
      combine(
        records,
        (await this.decrypt(state.operation.event, network, options)).requests,
        active
      )
    for (const head of heads)
      if (head)
        combine(
          records,
          (await this.decrypt(head, network, options)).requests,
          active
        )
    const same = heads.every((head) => head?.id === heads[0]?.id)
    return {
      active,
      records,
      state,
      heads,
      readComplete: complete,
      complete: complete && same,
      head: same ? heads[0] : undefined,
    }
  }
  async load(
    network: AddressRequestNetwork,
    discovery: SparkRecoveryDiscovery,
    options: AccountSignerOperationOptions = {}
  ): Promise<{ records: Records; confirmed: boolean }> {
    const collected = await this.collect(network, discovery, options)
    const confirmed =
      discovery.coverage === "complete" &&
      !discovery.invalidCount &&
      !discovery.unresolvedObserved &&
      discovery.registryMembershipReady === true &&
      collected.complete &&
      !collected.state.operation &&
      (!Object.keys(collected.records).length ||
        (!!collected.head &&
          JSON.stringify(
            (await this.decrypt(collected.head, network, options)).requests
          ) === JSON.stringify(collected.records)))
    if (
      confirmed &&
      collected.head &&
      collected.state.observed?.id !== collected.head.id
    )
      await this.input.store.update(this.scope.owner, network, (current) => ({
        ...current,
        observed: collected.head,
      }))
    return { records: collected.records, confirmed }
  }
  async save(
    network: AddressRequestNetwork,
    discovery: SparkRecoveryDiscovery,
    walletId: string,
    record: AddressRequestRecord,
    options: AccountSignerOperationOptions = {}
  ): Promise<{ records: Records; confirmed: boolean }> {
    if (
      discovery.coverage !== "complete" ||
      discovery.invalidCount ||
      discovery.unresolvedObserved ||
      !discovery.registryMembershipReady
    )
      throw new SparkRecoveryError("incomplete_discovery")
    const collected = await this.collect(network, discovery, options)
    if (!collected.active.has(walletId) || network !== "mainnet")
      throw new SparkRecoveryError("conflict")
    const evidence = requestEvidence(record)
    if (evidence.ownerPubkey !== this.scope.owner)
      throw new SparkRecoveryError("identity_mismatch")
    combine(collected.records, { [walletId]: record }, collected.active)
    const { head, state, heads } = collected
    let event = state.operation?.event
    const replacedOperationId = event?.id
    if (event) {
      const pending = await this.decrypt(event, network, options)
      const changed =
        JSON.stringify(pending.requests) !== JSON.stringify(collected.records)
      const foreign = heads.some(
        (candidate) =>
          candidate &&
          candidate.id !== event!.id &&
          candidate.id !== pending.parentEventId
      )
      if ((changed || foreign) && !collected.complete)
        throw new SparkRecoveryError("conflict")
      // A new agreed head may have won while the immutable local event was pending.
      // Rebase its exact request bytes after merging the signed heads.
      if (changed || foreign) event = undefined
      else if (!collected.readComplete)
        return { records: collected.records, confirmed: false }
    }
    if (
      !event &&
      state.observed &&
      collected.complete &&
      head?.id !== state.observed.id
    ) {
      const retained = await this.decrypt(state.observed, network, options)
      if (
        JSON.stringify(retained.requests) ===
          JSON.stringify(collected.records) &&
        (!head || head.created_at < state.observed.created_at)
      ) {
        event = state.observed
        await this.input.store.update(this.scope.owner, network, (current) => {
          if (current.operation?.event.id !== replacedOperationId)
            throw new SparkRecoveryError("conflict")
          return {
            ...current,
            operation: { event: state.observed!, targets: [...this.targets] },
          }
        })
      }
    }
    if (!event) {
      if (collected.readComplete && !collected.complete)
        throw new SparkRecoveryError("conflict")
      if (head) {
        const prior = await this.decrypt(head, network, options)
        if (
          JSON.stringify(prior.requests) === JSON.stringify(collected.records)
        ) {
          if (
            !(await this.membershipHeadUnchanged(
              network,
              discovery.registryEventId
            ))
          )
            return { records: collected.records, confirmed: false }
          await this.input.store.update(
            this.scope.owner,
            network,
            (current) => {
              if (current.operation?.event.id !== replacedOperationId)
                throw new SparkRecoveryError("conflict")
              return { ...current, observed: head, operation: undefined }
            }
          )
          return { records: collected.records, confirmed: true }
        }
        if (
          state.observed &&
          head.id !== state.observed.id &&
          head.created_at === state.observed.created_at
        )
          throw new SparkRecoveryError("conflict")
      }
      const createdAt = Math.max(
        Math.floor(Date.now() / 1000),
        (head?.created_at ?? 0) + 1,
        (state.observed?.created_at ?? 0) + 1
      )
      const snapshot: AddressRequestSnapshot = {
        format: "conduit.address-requests",
        version: 1,
        ownerPubkey: this.scope.owner,
        network,
        parentEventId: head?.id ?? state.observed?.id ?? null,
        requests: collected.records,
        createdAt,
      }
      const content = await this.input.signer.encryptNip44(
        this.scope.owner,
        JSON.stringify(snapshot),
        options
      )
      this.scope.assertCurrent()
      event = validateAddressRequestEvent(
        await this.input.signer.signEvent(
          {
            kind: 30078,
            pubkey: this.scope.owner,
            created_at: createdAt,
            tags: [["d", addressRequestsDTag(network)]],
            content,
          },
          options
        ),
        this.scope.owner,
        network
      )
      if (
        JSON.stringify(await this.decrypt(event, network, options)) !==
        JSON.stringify(snapshot)
      )
        throw new SparkRecoveryError("invalid_record")
      // Signed immutable bytes reach disk before any relay or HTTP write.
      await this.input.store.update(this.scope.owner, network, (current) => {
        if (current.operation?.event.id !== replacedOperationId)
          throw new SparkRecoveryError("conflict")
        return {
          ...current,
          operation: { event: event!, targets: [...this.targets] },
        }
      })
      if (!collected.complete)
        return { records: collected.records, confirmed: false }
    }
    // Optional progress may be sent only while the frozen membership head is
    // still confirmed at every target. A removal must win before the send.
    if (
      !(await this.membershipHeadUnchanged(network, discovery.registryEventId))
    )
      return { records: collected.records, confirmed: false }
    for (const url of this.targets) {
      this.scope.assertCurrent()
      if (
        (await this.input.transport.publish(url, event, this.continues)) !==
        "acked"
      )
        return { records: collected.records, confirmed: false }
      const read = await this.input.transport.read(
        url,
        this.scope.owner,
        undefined,
        this.continues,
        addressRequestsDTag(network)
      )
      this.scope.assertCurrent()
      if (
        read.status !== "complete" ||
        read.events.length !== 1 ||
        validateAddressRequestEvent(read.events[0], this.scope.owner, network)
          .id !== event.id
      )
        return { records: collected.records, confirmed: false }
    }
    await this.input.store.update(this.scope.owner, network, (current) => ({
      ...current,
      observed: event,
      operation: undefined,
    }))
    return { records: collected.records, confirmed: true }
  }
  /** Confirm legacy progress before an ordinary registry successor drops its extension. */
  async migrateLegacy(
    network: AddressRequestNetwork,
    discovery: SparkRecoveryDiscovery,
    options: AccountSignerOperationOptions = {}
  ): Promise<void> {
    const entries = Object.entries(
      discovery.registry?.addressNameRequests ?? {}
    )
    if (!entries.length) return
    const [walletId, record] = entries[0]
    const saved = await this.save(network, discovery, walletId, record, options)
    if (!saved.confirmed) throw new SparkRecoveryError("incomplete_discovery")
  }
}
