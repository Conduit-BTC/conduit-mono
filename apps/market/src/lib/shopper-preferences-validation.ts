import { SHIPPING_COUNTRIES, type ShopperShippingPreset } from "@conduit/core"

export const SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS = 8
export const SHOPPER_PRESET_PASSWORD_MAX_BYTES = 1_024

export type ShopperPreferencesRelayState =
  "disconnected" | "syncing" | "ready" | "synced" | "unavailable" | "error"

export type ShopperPreferencesSaveBlocker = {
  id: string
  message: string
}

const countryCodes = new Set(SHIPPING_COUNTRIES.map(({ code }) => code))

export function getShopperPresetPasswordByteLength(password: string): number {
  return new TextEncoder().encode(password).byteLength
}

export function getShopperPreferencesSaveBlockers(input: {
  shipping: ShopperShippingPreset
  password: string
  confirmPassword: string
  identityConnected: boolean
  relayState: ShopperPreferencesRelayState
}): ShopperPreferencesSaveBlocker[] {
  const blockers: ShopperPreferencesSaveBlocker[] = []
  const requiredFields: Array<{
    id: string
    label: string
    value: string
  }> = [
    {
      id: "recipient-name",
      label: "Recipient name",
      value: input.shipping.recipientName,
    },
    {
      id: "address-line-1",
      label: "Address line 1",
      value: input.shipping.addressLine1,
    },
    { id: "city", label: "City", value: input.shipping.city },
    {
      id: "postal-code",
      label: "Postal / ZIP code",
      value: input.shipping.postalCode,
    },
  ]

  for (const field of requiredFields) {
    if (!field.value.trim()) {
      blockers.push({ id: field.id, message: `${field.label} is required.` })
    }
  }

  if (!countryCodes.has(input.shipping.country.trim().toUpperCase())) {
    blockers.push({ id: "country", message: "Select a supported country." })
  }

  const passwordCharacters = Array.from(input.password).length
  const passwordBytes = getShopperPresetPasswordByteLength(input.password)
  if (passwordCharacters < SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS) {
    blockers.push({
      id: "password-length",
      message: `Password must contain ${SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS} or more characters.`,
    })
  } else if (passwordBytes > SHOPPER_PRESET_PASSWORD_MAX_BYTES) {
    blockers.push({ id: "password-length", message: "Password is too long." })
  }
  if (!input.confirmPassword) {
    blockers.push({
      id: "password-confirmation",
      message: "Confirm the encryption password.",
    })
  } else if (input.password !== input.confirmPassword) {
    blockers.push({
      id: "password-match",
      message: "Password confirmation must match.",
    })
  }

  if (!input.identityConnected) {
    blockers.push({ id: "identity", message: "Connect your Nostr signer." })
  } else if (input.relayState === "syncing") {
    blockers.push({
      id: "relay-syncing",
      message: "Wait for relay sync to finish.",
    })
  } else if (input.relayState !== "ready" && input.relayState !== "synced") {
    blockers.push({
      id: "relay-access",
      message: "Relay access is required. Refresh relays and try again.",
    })
  }

  return blockers
}
