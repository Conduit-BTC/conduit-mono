import type {
  AccountSigner,
  AccountSignerOperationOptions,
  SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { getAccountSigner } from "../protocol/session-signer"
import { getConfiguredIsolatedE2eRelayUrl } from "../protocol/relay-settings"
import { planAccountStorageRelays } from "../protocol/account-storage-relay-policy"
import {
  bindSparkRecoveryAccount,
  SparkRecoveryError,
} from "./spark-recovery-contract"
import {
  type SparkRecoveryDiscovery,
  type SparkRecoveryTransport,
} from "./spark-recovery-service"
import {
  parseWalletNames,
  validateWalletNameEvent,
  walletNamesDTag,
  type WalletNameNetwork,
  type WalletNameSnapshot,
} from "./wallet-name-contract"
import type { WalletNameStore } from "./wallet-name-store"

/** Optional encrypted metadata. Membership always comes from the unchanged registry. */
export class WalletNameService {
  private readonly scope
  private readonly targets: string[]
  constructor(
    private readonly input: {
      signer: AccountSigner
      store: WalletNameStore
      transport: SparkRecoveryTransport
      currentSigner?: () => AccountSigner | undefined
      userRelayUrls?: readonly string[]
      relayTargets?: readonly import("../protocol/account-storage-relay-policy").AccountStorageRelay[]
    }
  ) {
    this.scope = bindSparkRecoveryAccount(
      input.signer,
      input.currentSigner ?? getAccountSigner
    )
    const isolated = getConfiguredIsolatedE2eRelayUrl()
    this.targets = isolated
      ? [isolated]
      : (
          input.relayTargets ?? planAccountStorageRelays(input.userRelayUrls)
        ).map((target) => target.url)
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
    network: WalletNameNetwork,
    options: AccountSignerOperationOptions
  ): Promise<WalletNameSnapshot> {
    validateWalletNameEvent(event, this.scope.owner, network)
    const plaintext = await this.input.signer.decryptNip44(
      this.scope.owner,
      event.content,
      options
    )
    this.scope.assertCurrent()
    return parseWalletNames(plaintext, event, network)
  }
  async sync(
    network: WalletNameNetwork,
    discovery: SparkRecoveryDiscovery,
    options: AccountSignerOperationOptions = {}
  ): Promise<{ ready: boolean; names: Record<string, string> }> {
    this.scope.assertCurrent()
    // No optional metadata can authorize membership or relax registry write checks.
    if (
      discovery.coverage !== "complete" ||
      discovery.invalidCount ||
      discovery.unresolvedObserved ||
      discovery.state === "conflict" ||
      discovery.state === "unresolved" ||
      !discovery.registryMembershipReady ||
      !discovery.registry
    )
      return { ready: false, names: {} }
    const owner = this.scope.owner
    const active = new Set(discovery.registry.activeWalletIds)
    const removed = new Set(discovery.registry.removedWalletIds)
    let state = await this.input.store.load(owner, network)
    const targets =
      state.operation?.relayPolicyTargets ??
      state.operation?.targets ??
      this.targets
    const reads = await Promise.all(
      targets.map((url) =>
        this.input.transport.read(
          url,
          owner,
          undefined,
          this.continues,
          walletNamesDTag(network)
        )
      )
    )
    this.scope.assertCurrent()
    if (
      reads.some((read) => read.status !== "complete" || read.events.length > 1)
    )
      return { ready: false, names: {} }
    const heads = reads.map((read) => read.events[0])
    for (const head of heads)
      if (head) validateWalletNameEvent(head, owner, network)
    const operation = state.operation
    if (operation) {
      const snapshot = await this.decrypt(operation.event, network, options)
      // Never resurrect optional names for a removed wallet, or overwrite another writer.
      if (
        Object.keys(snapshot.names).some((id) => !active.has(id)) ||
        heads.some(
          (head) =>
            head &&
            head.id !== snapshot.parentEventId &&
            head.id !== operation.event.id
        )
      ) {
        await this.input.store.update(owner, network, (current) => ({
          ...current,
          operation: undefined,
        }))
        return { ready: false, names: {} }
      }
      for (const url of targets) {
        this.scope.assertCurrent()
        if (
          (await this.input.transport.publish(
            url,
            operation.event,
            this.continues
          )) !== "acked"
        )
          return { ready: false, names: {} }
        const read = await this.input.transport.read(
          url,
          owner,
          undefined,
          this.continues,
          walletNamesDTag(network)
        )
        this.scope.assertCurrent()
        if (
          read.status !== "complete" ||
          read.events.length !== 1 ||
          validateWalletNameEvent(read.events[0], owner, network).id !==
            operation.event.id
        )
          return { ready: false, names: {} }
      }
      await this.input.store.update(owner, network, (current) => {
        const pending = { ...current.pending }
        for (const [id, token] of Object.entries(operation.intents))
          if (pending[id]?.token === token) delete pending[id]
        return {
          ...current,
          pending,
          observed: operation.event,
          operation: undefined,
        }
      })
      state = await this.input.store.load(owner, network)
      if (Object.keys(state.pending).length)
        return this.sync(network, discovery, options)
      return { ready: true, names: snapshot.names }
    }
    if (heads.some((head) => head?.id !== heads[0]?.id))
      return { ready: false, names: {} }
    const head = heads[0]
    // Relay omission must not erase stronger retained name evidence.
    if (
      state.observed &&
      (!head ||
        head.created_at < state.observed.created_at ||
        (head.created_at === state.observed.created_at &&
          head.id > state.observed.id))
    )
      return { ready: false, names: {} }
    const previous = head
      ? await this.decrypt(head, network, options)
      : undefined
    const confirmed = Object.fromEntries(
      Object.entries(previous?.names ?? {}).filter(([id]) => active.has(id))
    )
    if (head)
      await this.input.store.update(owner, network, (current) => ({
        ...current,
        observed: head,
      }))
    if (!Object.keys(state.pending).length)
      return { ready: true, names: confirmed }
    const pending = Object.fromEntries(
      Object.entries(state.pending).filter(([id]) => active.has(id))
    )
    // Absence can mean an older snapshot or a not-yet-confirmed add. Only
    // explicit removal can discard local intent; names never add membership.
    await this.input.store.update(owner, network, (current) => ({
      ...current,
      pending: Object.fromEntries(
        Object.entries(current.pending).filter(([id]) => !removed.has(id))
      ),
    }))
    if (!Object.keys(pending).length)
      return {
        ready: !Object.keys(
          (await this.input.store.load(owner, network)).pending
        ).length,
        names: confirmed,
      }
    const createdAt = Math.max(
      Math.floor(Date.now() / 1000),
      (head?.created_at ?? 0) + 1
    )
    const snapshot: WalletNameSnapshot = {
      format: "conduit.wallet-names",
      version: 1,
      ownerPubkey: owner,
      network,
      parentEventId: head?.id ?? null,
      names: {
        ...confirmed,
        ...Object.fromEntries(
          Object.entries(pending).map(([id, intent]) => [id, intent.name])
        ),
      },
      createdAt,
    }
    const content = await this.input.signer.encryptNip44(
      owner,
      JSON.stringify(snapshot)
    )
    this.scope.assertCurrent()
    const event = validateWalletNameEvent(
      await this.input.signer.signEvent({
        kind: 30078,
        pubkey: owner,
        created_at: createdAt,
        tags: [["d", walletNamesDTag(network)]],
        content,
      }),
      owner,
      network
    )
    this.scope.assertCurrent()
    const verifiedSnapshot = await this.decrypt(event, network, {
      ...options,
      priority: "foreground",
    })
    if (JSON.stringify(verifiedSnapshot) !== JSON.stringify(snapshot))
      throw new SparkRecoveryError("invalid_record")
    // Persist the exact signed event before sending. New local renames keep their own tokens.
    await this.input.store.update(owner, network, (current) => {
      if (current.operation) throw new SparkRecoveryError("conflict")
      return {
        ...current,
        operation: {
          event,
          targets: [...this.targets],
          intents: Object.fromEntries(
            Object.entries(pending).map(([id, intent]) => [id, intent.token])
          ),
        },
      }
    })
    return this.sync(network, discovery, options)
  }
}
