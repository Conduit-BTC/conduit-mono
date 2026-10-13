export type WalletRuntimeState =
  | { status: "locked" | "connecting"; balanceMsats: null; error: null }
  | { status: "ready"; balanceMsats: number | null; error: null }
  | {
      status: "unavailable" | "error"
      balanceMsats: number | null
      error: string
      errorSource?: "opening" | "balance"
    }

export function lockedWalletRuntime(): WalletRuntimeState {
  return { status: "locked", balanceMsats: null, error: null }
}

/** A live session supersedes old opening errors, while balance failures remain visible. */
export function reconcileSparkWalletRuntime(input: {
  nativeOpen: boolean
  opening: boolean
  sampled?: WalletRuntimeState
  current?: WalletRuntimeState
}): WalletRuntimeState {
  return input.nativeOpen
    ? (input.sampled ??
        (input.current?.status === "ready" ||
        (input.current?.status === "error" &&
          input.current.errorSource !== "opening")
          ? input.current
          : { status: "ready", balanceMsats: null, error: null }))
    : input.opening
      ? { status: "connecting", balanceMsats: null, error: null }
      : input.current?.status === "error"
        ? input.current
        : lockedWalletRuntime()
}
