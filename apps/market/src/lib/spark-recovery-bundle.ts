import type { WalletNetwork } from "@conduit/core"

export interface SparkRecoveryBundle {
  mnemonic: string
  accountNumber: number
  network: WalletNetwork
}

export function formatSparkRecoveryBundleForClipboard({
  mnemonic,
  accountNumber,
  network,
}: SparkRecoveryBundle): string {
  return `${mnemonic}\nSpark account number: ${accountNumber}\nSpark network: ${network}`
}
