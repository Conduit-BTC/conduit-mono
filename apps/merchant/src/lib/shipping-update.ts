export interface ShippingUpdateInput {
  trackingNumber: string
  carrier: string
  trackingUrl: string
  note: string
}

export interface PreparedShippingUpdate {
  trackingNumber: string
  carrier: string
  trackingUrl: string | undefined
  note: string | undefined
}

function normalizeTrackingUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("Tracking URL must be a valid http(s) link.")
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Tracking URL must start with http:// or https://.")
  }

  return parsed.toString()
}

export function prepareShippingUpdate(
  input: ShippingUpdateInput
): PreparedShippingUpdate {
  const trackingNumber = input.trackingNumber.trim()
  if (!trackingNumber) throw new Error("Tracking code is required.")

  const carrier = input.carrier.trim()
  if (!carrier) throw new Error("Carrier is required.")

  return {
    trackingNumber,
    carrier,
    trackingUrl: normalizeTrackingUrl(input.trackingUrl),
    note: input.note.trim() || undefined,
  }
}
