import type { WalletLightningAddressState } from "@conduit/core/wallets/resolve-spark-lightning-address"

export function walletAddressStatus(
  value: WalletLightningAddressState | null
): string {
  if (!value) return "Checking for your Lightning address…"
  if (value.status === "saved") {
    if (value.availability === "checking") return "Checking availability…"
    if (value.reason === "rate_limited")
      return "Address checks are temporarily limited. Your saved address is unchanged. Try again later."
    if (value.availability === "conflicting")
      return "The service returned a different address. Your saved address is unchanged."
    if (value.availability === "not_found")
      return "The service did not find your saved address. Check again before requesting payment."
    return "Availability could not be checked. Your saved address is unchanged."
  }
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
  if (value.reason === "invalid_username")
    return "Choose 3–64 letters, numbers, dots, hyphens or underscores. Protected names are unavailable."
  if (value.reason === "name_unavailable")
    return "That name is unavailable. Choose another name."
  if (value.reason === "rate_limited")
    return "Address lookups are temporarily limited. Wait a minute before checking again."
  return value.reason === "registration_pending"
    ? "Address setup is pending. Retry to check the same wallet."
    : "Lightning addresses are currently unavailable."
}
