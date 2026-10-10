import type { BreezAddressState } from "@conduit/core"

export function walletAddressStatus(value: BreezAddressState | null): string {
  if (!value) return "Checking for your Lightning address…"
  if (value.status === "registered")
    return value.publicLookup === "verified"
      ? value.address
      : "Your address is registered. Receiving availability still needs verification."
  if (value.status === "absent")
    return "Set up a reusable address for this wallet."
  if (value.reason === "unconfigured")
    return "Lightning addresses are not enabled in this build."
  if (value.reason === "unsupported_network")
    return "Lightning addresses are unavailable for this network."
  if (value.reason === "invalid_configuration")
    return "Lightning address setup is unavailable."
  return value.reason === "registration_pending"
    ? "Address setup is pending. Retry to check the same wallet."
    : "Lightning addresses are currently unavailable."
}
