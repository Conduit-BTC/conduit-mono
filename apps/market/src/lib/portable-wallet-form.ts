import { isValidSparkAccountNumber } from "./spark-recovery"

export type PortableWalletMode = "create" | "restore"

export interface PortableWalletFormInput {
  mode: PortableWalletMode
  label: string
  password: string
  mnemonic: string
  accountNumber: string
}

export function getPortableWalletFormError({
  mode,
  label,
  password,
  mnemonic,
  accountNumber,
}: PortableWalletFormInput): string | null {
  if (!label.trim()) {
    return "Enter a wallet label."
  }
  if (mode === "restore" && !mnemonic.trim()) {
    return "Enter the recovery phrase."
  }
  if (mode === "restore" && !accountNumber.trim()) {
    return "Enter the Spark account number from the recovery bundle."
  }
  if (mode === "restore" && !isValidSparkAccountNumberInput(accountNumber)) {
    return "Enter a valid Spark account number."
  }
  if (password.length < 10) {
    return "Use at least 10 characters for the local wallet password."
  }
  return null
}

function isValidSparkAccountNumberInput(value: string): boolean {
  const accountNumber = Number(value)
  return isValidSparkAccountNumber(accountNumber)
}
