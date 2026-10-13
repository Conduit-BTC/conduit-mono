import { z } from "zod"
import type { WalletNetwork } from "./index"

export const sparkRecoveryNetworkSchema = z.enum([
  "mainnet",
  "testnet",
  "signet",
  "regtest",
])

export const SPARK_PRIMARY_D_TAG = "conduit:spark:primary:v1"
export const SPARK_MAIN_D_TAG = "conduit:spark:main:v1"
export function sparkWalletRegistryDTag(network: WalletNetwork): string {
  return `conduit:spark:registry:v1:${network}`
}
export function isSparkWalletRegistryDTag(value: string): boolean {
  return (
    value === sparkWalletRegistryDTag("mainnet") ||
    value === sparkWalletRegistryDTag("testnet") ||
    value === sparkWalletRegistryDTag("signet") ||
    value === sparkWalletRegistryDTag("regtest")
  )
}
export type SparkRecoveryChoiceDTag =
  | typeof SPARK_PRIMARY_D_TAG
  | typeof SPARK_MAIN_D_TAG
  | `${typeof SPARK_PRIMARY_D_TAG | typeof SPARK_MAIN_D_TAG}:${WalletNetwork}`

/** Legacy coordinates remain readable; new choices replace only their network. */
export function sparkRecoveryChoiceDTag(
  type: "primary" | "main",
  choiceNetwork: WalletNetwork
): SparkRecoveryChoiceDTag {
  return `${type === "primary" ? SPARK_PRIMARY_D_TAG : SPARK_MAIN_D_TAG}:${choiceNetwork}`
}
export function parseSparkRecoveryChoiceAddress(
  value: string | undefined
): { type: "primary" | "main"; network?: WalletNetwork } | undefined {
  for (const [type, legacy] of [
    ["primary", SPARK_PRIMARY_D_TAG],
    ["main", SPARK_MAIN_D_TAG],
  ] as const) {
    if (value === legacy) return { type }
    if (!value?.startsWith(legacy + ":")) continue
    const parsed = sparkRecoveryNetworkSchema.safeParse(
      value.slice(legacy.length + 1)
    )
    if (parsed.success) return { type, network: parsed.data }
  }
}

/** Optional metadata deliberately outside the deployed recovery namespace. */
export function walletNamesDTag(network: WalletNetwork): string {
  return `conduit:wallet-names:v1:${network}`
}
/** Optional request progress has its own NIP-78 coordinate. */
export function addressRequestsDTag(network: WalletNetwork): string {
  return `conduit:address-requests:v1:${network}`
}
export function isWalletNamesDTag(value: string): boolean {
  return ["mainnet", "testnet", "signet", "regtest"].some(
    (network) => value === walletNamesDTag(network as WalletNetwork)
  )
}
export function isAddressRequestsDTag(value: string): boolean {
  return ["mainnet", "testnet", "signet", "regtest"].some(
    (network) => value === addressRequestsDTag(network as WalletNetwork)
  )
}
