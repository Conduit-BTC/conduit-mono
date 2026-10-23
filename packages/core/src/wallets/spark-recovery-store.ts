import { db, type ConduitDB } from "../db"
import { SparkRecoveryError } from "./spark-recovery-contract"
import { migrateAccountStorageRelayState } from "./account-storage-relay-migration"
import {
  mergeSparkRecoveryRecords,
  validateSparkRecoveryState,
  type SparkRecoveryRecord,
  type SparkRecoveryState,
  type SparkRecoveryStore,
} from "./spark-recovery-service"

/** Dedicated, account-scoped ciphertext journal; never a generic cache or plaintext credential store. */
export class DexieSparkRecoveryStore implements SparkRecoveryStore {
  constructor(private readonly database: ConduitDB = db) {}
  private async readStoredState(owner: string): Promise<SparkRecoveryState> {
    let state: SparkRecoveryState | undefined
    try {
      state = await this.database.sparkRecoveryEvidence.get(owner)
    } catch {
      throw new SparkRecoveryError("storage_unavailable")
    }
    return (
      state ?? { ownerPubkey: owner, records: [], unresolvedObserved: false }
    )
  }
  async load(owner: string): Promise<SparkRecoveryState> {
    return validateSparkRecoveryState(await this.readStoredState(owner), owner)
  }
  /** Transactional, restart-safe policy transition with no signing or network access. */
  async migrateRelayPolicy(
    owner: string,
    shouldContinue: () => boolean
  ): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.sparkRecoveryEvidence,
      async () => {
        if (!shouldContinue()) throw new SparkRecoveryError("conflict")
        const current = await this.readStoredState(owner)
        if (current.ownerPubkey !== owner)
          throw new SparkRecoveryError("invalid_record")
        const next = migrateAccountStorageRelayState(current)
        if (!shouldContinue()) throw new SparkRecoveryError("conflict")
        if (JSON.stringify(current) === JSON.stringify(next)) return
        await this.database.sparkRecoveryEvidence.put(next)
        if (
          !shouldContinue() ||
          JSON.stringify(await this.readStoredState(owner)) !==
            JSON.stringify(next)
        )
          throw new SparkRecoveryError("conflict")
      }
    )
  }
  /** Compare the entire checked journal inside one transaction; never discard newer evidence. */
  async repairUnresolved(
    owner: string,
    expected: SparkRecoveryState,
    backupEventId: string,
    shouldContinue: () => boolean
  ): Promise<void> {
    const checked = validateSparkRecoveryState(expected, owner)
    await this.database.transaction(
      "rw",
      this.database.sparkRecoveryEvidence,
      async () => {
        const current = await this.load(owner)
        if (
          !shouldContinue() ||
          JSON.stringify(current) !== JSON.stringify(checked) ||
          !current.unresolvedObserved ||
          !!current.unresolvedEventId
        )
          throw new SparkRecoveryError("conflict")
        const next = validateSparkRecoveryState(
          {
            ...current,
            unresolvedObserved: false,
            legacyUnresolvedRepair: { backupEventId, repairedAt: Date.now() },
          },
          owner
        )
        await this.database.sparkRecoveryEvidence.put(next)
        if (
          !shouldContinue() ||
          JSON.stringify(await this.load(owner)) !== JSON.stringify(next)
        )
          throw new SparkRecoveryError("conflict")
      }
    )
  }
  /** Shares the wallet-removal transaction; relay writes preserve these decisions. */
  async setDeviceRemoved(
    owner: string,
    walletId: string,
    removed: boolean
  ): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.sparkRecoveryEvidence,
      async () => {
        const current = await this.load(owner)
        const ids = new Set(current.removedWalletIds ?? [])
        if (removed) ids.add(walletId)
        else ids.delete(walletId)
        const next = validateSparkRecoveryState(
          { ...current, removedWalletIds: [...ids] },
          owner
        )
        await this.database.sparkRecoveryEvidence.put(next)
        if (JSON.stringify(await this.load(owner)) !== JSON.stringify(next))
          throw new SparkRecoveryError("storage_unavailable")
      }
    )
  }
  async setRegistryExcluded(
    owner: string,
    scopedWalletIds: readonly string[],
    excludedWalletIds: readonly string[]
  ): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.sparkRecoveryEvidence,
      async () => {
        const current = await this.load(owner)
        const scope = new Set(scopedWalletIds)
        const ids = new Set(
          (current.registryExcludedWalletIds ?? []).filter(
            (id) => !scope.has(id)
          )
        )
        for (const id of excludedWalletIds) ids.add(id)
        const next = validateSparkRecoveryState(
          { ...current, registryExcludedWalletIds: [...ids] },
          owner
        )
        await this.database.sparkRecoveryEvidence.put(next)
        if (JSON.stringify(await this.load(owner)) !== JSON.stringify(next))
          throw new SparkRecoveryError("storage_unavailable")
      }
    )
  }
  async retain(
    owner: string,
    records: SparkRecoveryRecord[],
    unresolvedObserved = false,
    unresolvedEventId?: string
  ): Promise<void> {
    const incoming = validateSparkRecoveryState(
      {
        ownerPubkey: owner,
        records,
        unresolvedObserved,
        ...(unresolvedEventId ? { unresolvedEventId } : {}),
      },
      owner
    )
    try {
      await this.database.transaction(
        "rw",
        this.database.sparkRecoveryEvidence,
        async () => {
          const current = await this.readStoredState(owner)
          // The merger validates the complete state, but against its own owner.
          if (current.ownerPubkey !== owner)
            throw new SparkRecoveryError("invalid_record")
          const next = mergeSparkRecoveryRecords(
            current,
            incoming.records,
            unresolvedObserved,
            unresolvedEventId
          )
          await this.database.sparkRecoveryEvidence.put(next)
          const saved = await this.load(owner)
          if (JSON.stringify(saved) !== JSON.stringify(next))
            throw new SparkRecoveryError("storage_unavailable")
        }
      )
    } catch (error) {
      if (error instanceof SparkRecoveryError) throw error
      throw new SparkRecoveryError("storage_unavailable")
    }
  }
}
