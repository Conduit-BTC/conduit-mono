export type WalletRuntimeState =
  | { status: "locked" | "connecting"; balanceMsats: null; error: null }
  | { status: "ready"; balanceMsats: number | null; error: null }
  | {
      status: "unavailable" | "error"
      balanceMsats: number | null
      error: string
    }

export function lockedWalletRuntime(): WalletRuntimeState {
  return { status: "locked", balanceMsats: null, error: null }
}

/** The live provider session can advance while descriptor/credential reads await. */
export function reconcileSparkWalletRuntime(input: {
  nativeOpen: boolean
  opening: boolean
  sampled?: WalletRuntimeState
  current?: WalletRuntimeState
}): WalletRuntimeState {
  return input.nativeOpen
    ? (input.sampled ??
        (input.current?.status === "ready" || input.current?.status === "error"
          ? input.current
          : { status: "ready", balanceMsats: null, error: null }))
    : input.opening
      ? { status: "connecting", balanceMsats: null, error: null }
      : input.current?.status === "error"
        ? input.current
        : lockedWalletRuntime()
}
