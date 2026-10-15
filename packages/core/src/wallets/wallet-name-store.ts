import type { MarketWalletStore } from "./wallet-storage"
import { db, type ConduitDB } from "../db"
import {
  walletNameSchema,
  validateWalletNameStates,
  type WalletNameNetwork,
  type WalletNameState,
} from "./wallet-name-contract"

export interface WalletNameStore {
  load(owner: string, network: WalletNameNetwork): Promise<WalletNameState>
  update(
    owner: string,
    network: WalletNameNetwork,
    change: (state: WalletNameState) => WalletNameState
  ): Promise<void>
}
/** Shares the descriptor transaction without a database-version migration. */
export class DexieWalletNameStore implements WalletNameStore {
  constructor(private readonly database: ConduitDB = db) {}
  async load(
    owner: string,
    network: WalletNameNetwork
  ): Promise<WalletNameState> {
    const row = await this.database.sparkRecoveryEvidence.get(owner)
    return (
      validateWalletNameStates(row?.walletNameSync, owner)?.[network] ?? {
        pending: {},
      }
    )
  }
  async update(
    owner: string,
    network: WalletNameNetwork,
    change: (state: WalletNameState) => WalletNameState
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
        const states = validateWalletNameStates(row.walletNameSync, owner) ?? {}
        states[network] = change(states[network] ?? { pending: {} })
        await this.database.sparkRecoveryEvidence.put({
          ...row,
          walletNameSync: validateWalletNameStates(states, owner),
        })
      }
    )
  }
  async queue(
    owner: string,
    network: WalletNameNetwork,
    walletId: string,
    name: string
  ): Promise<void> {
    const normalized = walletNameSchema.parse(name)
    await this.update(owner, network, (state) => ({
      ...state,
      pending: {
        ...state.pending,
        [walletId]: { name: normalized, token: crypto.randomUUID() },
      },
    }))
  }
}

export async function saveWalletNameLocally(input: {
  walletId: string
  name: string
  store: Pick<
    MarketWalletStore,
    "transaction" | "getSparkRecovery" | "list" | "rename"
  >
  names: DexieWalletNameStore
}) {
  const name = walletNameSchema.parse(input.name)
  return input.store.transaction(async () => {
    const wallet = (await input.store.list()).find(
      (wallet) => wallet.id === input.walletId
    )
    if (!wallet) throw new Error("Wallet is no longer available.")
    const recovery = await input.store.getSparkRecovery(input.walletId)
    await input.store.rename(input.walletId, name)
    if (recovery?.type === "signer")
      await input.names.queue(
        recovery.ownerPubkey,
        wallet.network,
        wallet.id,
        name
      )
    return { wallet, recovery }
  })
}
