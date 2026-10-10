import { db, type ConduitDB } from "../db"
import { SparkRecoveryError } from "./spark-recovery-contract"
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
  async load(owner: string): Promise<SparkRecoveryState> {
    let state: SparkRecoveryState | undefined
    try {
      state = await this.database.sparkRecoveryEvidence.get(owner)
    } catch {
      throw new SparkRecoveryError("storage_unavailable")
    }
    return validateSparkRecoveryState(
      state ?? { ownerPubkey: owner, records: [], unresolvedObserved: false },
      owner
    )
  }
  async retain(
    owner: string,
    records: SparkRecoveryRecord[],
    unresolvedObserved = false
  ): Promise<void> {
    const incoming = validateSparkRecoveryState(
      { ownerPubkey: owner, records, unresolvedObserved },
      owner
    )
    try {
      await this.database.transaction(
        "rw",
        this.database.sparkRecoveryEvidence,
        async () => {
          const current = await this.load(owner)
          const next = mergeSparkRecoveryRecords(
            current,
            incoming.records,
            unresolvedObserved
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
