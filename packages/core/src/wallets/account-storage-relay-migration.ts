import { ACCOUNT_STORAGE_RELAY_POLICY_VERSION } from "../config"
import {
  accountStorageRelayOperator,
  transitionAccountStorageRelayUrls,
} from "../protocol/account-storage-relay-policy"
import {
  validateSparkRecoveryState,
  type SparkRecoveryState,
} from "./spark-recovery-service"

/** Local bookkeeping only. Original signed events and delivery receipts remain intact. */
export function migrateAccountStorageRelayState(
  input: SparkRecoveryState
): SparkRecoveryState {
  // Validation also computes a compact read projection. A policy transition
  // must not persist that compaction or rewrite historical record metadata.
  const state = structuredClone(input)
  validateSparkRecoveryState(state, state.ownerPubkey)
  for (const record of state.records) {
    if (record.activeRelayPolicy) continue
    const urls = transitionAccountStorageRelayUrls(
      record.targets.map((target) => target.url)
    )
    if (!urls) continue
    record.activeRelayPolicy = {
      version: ACCOUNT_STORAGE_RELAY_POLICY_VERSION,
      targets: urls.map((url) => ({
        url,
        operator: accountStorageRelayOperator(url),
      })),
      delivery: urls.map((url) => {
        const existing = record.delivery.find(
          (evidence) => evidence.url === url
        )
        return existing
          ? { ...existing }
          : {
              url,
              status: "pending",
              accepted: false,
              readBack: false,
              lastRead: "not_queried",
              checkedAt: 0,
            }
      }),
    }
  }
  // Optional journals retain their existing strict validators and migration owners.
  return state
}
