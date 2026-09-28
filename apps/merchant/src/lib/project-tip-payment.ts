import {
  classifyNwcPaymentError,
  getNwcErrorCode,
  isNwcPrePublishDiagnosticCode,
  isNwcWalletRefusalErrorCode,
  type NwcConnection,
} from "@conduit/core"

export function classifyMerchantTipPaymentError(
  error: unknown,
  connection: NwcConnection
): { status: "manual" | "ambiguous"; reason: string } {
  const diagnostic = classifyNwcPaymentError(error, connection)
  if (
    isNwcWalletRefusalErrorCode(getNwcErrorCode(error)) ||
    isNwcPrePublishDiagnosticCode(diagnostic.code)
  ) {
    return { status: "manual", reason: diagnostic.detail }
  }
  return {
    status: "ambiguous",
    reason:
      "The connected wallet did not confirm the result. Check it before trying another payment path.",
  }
}
