import { isValidSparkAccountNumber } from "./spark-recovery"

export type PortableWalletMode = "create" | "restore"

export interface PortableWalletFormInput {
  mode: PortableWalletMode
  password: string
  mnemonic: string
  accountNumber: string
}

const DEFAULT_SPARK_WALLET_LABEL = "Spark wallet"

export function getPortableWalletFormError({
  mode,
  password,
  mnemonic,
  accountNumber,
}: PortableWalletFormInput): string | null {
  if (mode === "restore" && !mnemonic.trim()) {
    return "Enter the recovery phrase."
  }
  if (
    mode === "restore" &&
    accountNumber.trim() &&
    !isValidSparkAccountNumberInput(accountNumber)
  ) {
    return "Enter a valid Spark account number."
  }
  if (password.length < 10) {
    return "Use at least 10 characters for the local wallet password."
  }
  return null
}

export function getPortableWalletLabel(nickname: string): string {
  return nickname.trim() || DEFAULT_SPARK_WALLET_LABEL
}

export function resolvePortableWalletAccountNumber(
  accountNumber: string,
  defaultAccountNumber: number
): number {
  const normalizedAccountNumber = accountNumber.trim()
  return normalizedAccountNumber
    ? Number(normalizedAccountNumber)
    : defaultAccountNumber
}

function isValidSparkAccountNumberInput(value: string): boolean {
  const accountNumber = Number(value)
  return isValidSparkAccountNumber(accountNumber)
}
