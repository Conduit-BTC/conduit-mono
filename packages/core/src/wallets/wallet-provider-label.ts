import type { WalletDescriptor, WalletNetwork } from "@conduit/core"

const PROVIDER_NAMES: Record<string, string> = {
  spark: "Spark",
  nwc: "NWC",
}

export function getWalletProviderName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? toTitleCase(providerId)
}

export function getWalletProviderDescription(
  wallet: Pick<WalletDescriptor, "kind" | "providerId" | "network">
): string {
  const providerName = getWalletProviderName(wallet.providerId)
  if (wallet.providerId === "spark") {
    return `Spark wallet · ${getWalletNetworkContextLabel(wallet.network)}`
  }
  return wallet.kind === "portable"
    ? `${providerName} Portable Wallet`
    : `Connected via ${providerName}`
}

export function getWalletNetworkLabel(network: WalletNetwork): string {
  switch (network) {
    case "mainnet":
      return "Bitcoin Mainnet"
    case "testnet":
      return "Bitcoin Testnet"
    case "signet":
      return "Bitcoin Signet"
    case "regtest":
      return "Regtest"
  }
}

function getWalletNetworkContextLabel(network: WalletNetwork): string {
  switch (network) {
    case "mainnet":
      return "Mainnet"
    case "testnet":
      return "Testnet"
    case "signet":
      return "Signet"
    case "regtest":
      return "Regtest"
  }
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
