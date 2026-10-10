export type WalletSetupRollbackResult =
  { status: "removed" } | { status: "kept"; reason: string }

export async function rollbackFailedWalletSetup(input: {
  closeWallet: () => Promise<void>
  removeRegistration: () => Promise<void>
}): Promise<WalletSetupRollbackResult> {
  try {
    await input.closeWallet()
  } catch {
    return {
      status: "kept",
      reason:
        "Conduit could not confirm that the wallet session closed, so its encrypted recovery record was kept on this device.",
    }
  }

  try {
    await input.removeRegistration()
  } catch {
    return {
      status: "kept",
      reason:
        "The wallet session closed, but Conduit could not remove the local wallet registration.",
    }
  }

  return { status: "removed" }
}
