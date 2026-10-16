import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"

export interface CheckoutSparkTreasuryConfiguration {
  mainnetAddress?: string
  regtestAddress?: string
  /** Previously approved public destinations retained for immutable recovery. */
  retiredAddresses?: string
}

/** Public receive addresses only. Treasury signing material never enters a build. */
export function readCheckoutSparkTreasuryConfiguration(): CheckoutSparkTreasuryConfiguration {
  return {
    mainnetAddress: import.meta.env?.VITE_CONDUIT_SPARK_TREASURY_ADDRESS,
    regtestAddress: import.meta.env
      ?.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS,
    retiredAddresses: import.meta.env
      ?.VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES,
  }
}

/** Absence retains Lightning for new plans; malformed configured data is not absence. */
export function selectCheckoutSparkTreasuryAddress(
  network: CheckoutSparkNetwork,
  configuration = readCheckoutSparkTreasuryConfiguration()
): string | null {
  const value =
    network === "mainnet"
      ? configuration.mainnetAddress
      : configuration.regtestAddress
  if (value === undefined || value.trim() === "") return null
  const address = value.trim()
  if (address.length > 2048 || /\s/.test(address)) {
    throw new Error("Checkout Spark treasury configuration is invalid.")
  }
  return address
}

/** Rotation never redirects a funded plan; old approved addresses remain explicit. */
export function assertCheckoutSparkTreasuryAddressAllowed(
  network: CheckoutSparkNetwork,
  address: string,
  configuration = readCheckoutSparkTreasuryConfiguration()
): void {
  const current = selectCheckoutSparkTreasuryAddress(network, configuration)
  const retired = (configuration.retiredAddresses ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (retired.length > 16 || ![current, ...retired].includes(address)) {
    throw new Error(
      "Checkout Spark treasury destination is unavailable in this deployment."
    )
  }
}
