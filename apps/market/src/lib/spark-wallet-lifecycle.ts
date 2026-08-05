import type { WalletDescriptor } from "@conduit/core"

import {
  assertSparkWalletRegistrationSessionAvailable,
  runWithSparkWalletOperationLock,
} from "./spark-wallet-lease"

export type SparkWalletOperationRunner = <T>(
  walletId: string,
  operation: () => Promise<T>
) => Promise<T>

export interface SparkWalletLifecycleManager {
  openWithMnemonic(input: {
    walletId: string
    mnemonic: string
    accountNumber: number
  }): Promise<void>
  close(walletId: string): Promise<void>
}

export type SparkWalletRegistrationSessionVerifier = (
  walletId: string
) => Promise<void>

interface SparkWalletLifecycleDependencies {
  walletId: string
  listWallets(): Promise<WalletDescriptor[]>
  manager: SparkWalletLifecycleManager | null
  runExclusive?: SparkWalletOperationRunner
}

export async function openRegisteredSparkWallet(
  input: SparkWalletLifecycleDependencies & {
    manager: SparkWalletLifecycleManager
    expectedNetwork: WalletDescriptor["network"]
    resolveOpenInput(registration: WalletDescriptor): Promise<{
      mnemonic: string
      accountNumber: number
    }>
    afterOpen?(): Promise<void>
    onValidated?(): void | Promise<void>
  }
): Promise<void> {
  const runExclusive = input.runExclusive ?? runWithSparkWalletOperationLock
  await runExclusive(input.walletId, async () => {
    const registration = findSparkRegistration(
      await input.listWallets(),
      input.walletId
    )
    if (!registration) {
      throw new Error("Portable Wallet is no longer registered on this device.")
    }
    if (registration.network !== input.expectedNetwork) {
      throw new Error(
        `This Portable Wallet uses ${registration.network}, but Market is using ${input.expectedNetwork}. Switch networks before unlocking it.`
      )
    }

    const openInput = await input.resolveOpenInput(registration)
    await input.manager.openWithMnemonic({
      walletId: input.walletId,
      ...openInput,
    })

    await validateOpenRegistration(input, registration)
    await input.afterOpen?.()
    await validateOpenRegistration(input, registration)
    await input.onValidated?.()
  })
}

export async function cleanupSparkWalletState(
  input: Pick<SparkWalletLifecycleDependencies, "walletId" | "manager"> & {
    verifySessionAvailable?: SparkWalletRegistrationSessionVerifier
  }
): Promise<void> {
  await input.manager?.close(input.walletId)
  await (
    input.verifySessionAvailable ??
    assertSparkWalletRegistrationSessionAvailable
  )(input.walletId)
}

async function validateOpenRegistration(
  input: SparkWalletLifecycleDependencies & {
    manager: SparkWalletLifecycleManager
  },
  expected: WalletDescriptor
): Promise<void> {
  let current: WalletDescriptor | null
  try {
    current = findSparkRegistration(await input.listWallets(), input.walletId)
  } catch (error) {
    try {
      await input.manager.close(input.walletId)
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Portable Wallet registration could not be verified and its client could not be closed.",
        { cause: closeError }
      )
    }
    throw new Error(
      "Portable Wallet registration could not be verified after unlocking.",
      { cause: error }
    )
  }

  if (current && isSameSparkRegistration(expected, current)) {
    return
  }
  try {
    await cleanupSparkWalletState(input)
  } catch (cleanupError) {
    const registrationError = new Error(
      "Portable Wallet was removed while it was unlocking."
    )
    throw new AggregateError(
      [registrationError, cleanupError],
      "Portable Wallet registration changed during unlock and cleanup could not be completed.",
      { cause: cleanupError }
    )
  }
  throw new Error("Portable Wallet was removed while it was unlocking.")
}

function findSparkRegistration(
  wallets: readonly WalletDescriptor[],
  walletId: string
): WalletDescriptor | null {
  return (
    wallets.find(
      (wallet) =>
        wallet.id === walletId &&
        wallet.kind === "portable" &&
        wallet.providerId === "spark"
    ) ?? null
  )
}

function isSameSparkRegistration(
  expected: WalletDescriptor,
  current: WalletDescriptor
): boolean {
  return (
    current.id === expected.id &&
    current.kind === expected.kind &&
    current.providerId === expected.providerId &&
    current.network === expected.network &&
    current.createdAt === expected.createdAt
  )
}
