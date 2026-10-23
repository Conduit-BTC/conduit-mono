import { db, type ConduitDB } from "../db"
import {
  validateAddressRequestStates,
  type AddressRequestNetwork,
  type AddressRequestState,
} from "./address-request-metadata"
import { SparkRecoveryError } from "./spark-recovery-contract"

export interface AddressRequestStore {
  load(
    owner: string,
    network: AddressRequestNetwork
  ): Promise<AddressRequestState>
  update(
    owner: string,
    network: AddressRequestNetwork,
    change: (state: AddressRequestState) => AddressRequestState
  ): Promise<void>
}

/** Shares the account journal transaction, without plaintext request storage. */
export class DexieAddressRequestStore implements AddressRequestStore {
  constructor(private readonly database: ConduitDB = db) {}
  async load(
    owner: string,
    network: AddressRequestNetwork
  ): Promise<AddressRequestState> {
    try {
      return await this.database.transaction(
        "rw",
        this.database.sparkRecoveryEvidence,
        async () => {
          const row = await this.database.sparkRecoveryEvidence.get(owner)
          const states = validateAddressRequestStates(
            row?.addressRequestSync,
            owner
          )
          if (
            row &&
            JSON.stringify(states) !== JSON.stringify(row.addressRequestSync)
          ) {
            await this.database.sparkRecoveryEvidence.put({
              ...row,
              addressRequestSync: states,
            })
          }
          return states?.[network] ?? {}
        }
      )
    } catch {
      throw new SparkRecoveryError("invalid_record")
    }
  }
  async update(
    owner: string,
    network: AddressRequestNetwork,
    change: (state: AddressRequestState) => AddressRequestState
  ): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.sparkRecoveryEvidence,
      async () => {
        const row = (await this.database.sparkRecoveryEvidence.get(owner)) ?? {
          ownerPubkey: owner,
          records: [],
          unresolvedObserved: false,
        }
        const states =
          validateAddressRequestStates(row.addressRequestSync, owner) ?? {}
        states[network] = change(states[network] ?? {})
        const next = {
          ...row,
          addressRequestSync: validateAddressRequestStates(states, owner),
        }
        await this.database.sparkRecoveryEvidence.put(next)
        const saved = await this.database.sparkRecoveryEvidence.get(owner)
        if (
          JSON.stringify(saved?.addressRequestSync) !==
          JSON.stringify(next.addressRequestSync)
        )
          throw new SparkRecoveryError("storage_unavailable")
      }
    )
  }
}
