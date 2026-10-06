// Only these content-free categories may cross the smoke output boundary.
export const productSubmitBlockers = [
  "account-missing",
  "signer-unready",
  "save-pending",
  "upload-busy",
  "shipping-policy-unavailable",
  "form-invalid",
  "draft-unchanged",
  "unavailable",
] as const

export type ProductSubmitBlocker = (typeof productSubmitBlockers)[number]
export const productSubmitDiagnosticAttachment = "product-submit-readiness"

export function safeProductSubmitBlockers(
  value: unknown
): ProductSubmitBlocker[] | null {
  if (
    !Array.isArray(value) ||
    value.length > productSubmitBlockers.length ||
    !value.every((entry) =>
      productSubmitBlockers.some((allowed) => entry === allowed)
    )
  ) {
    return null
  }
  return productSubmitBlockers.filter((entry) => value.includes(entry))
}

export function decodeProductSubmitDiagnostic(
  body: Uint8Array | undefined
): ProductSubmitBlocker[] | null {
  if (!body || body.byteLength > 256) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 1 ||
      !("blockers" in value)
    ) {
      return null
    }
    return safeProductSubmitBlockers(value.blockers)
  } catch {
    return null
  }
}
