import { expect, type Locator, type TestInfo } from "@playwright/test"
import {
  productSubmitDiagnosticAttachment,
  safeProductSubmitBlockers,
} from "../../scripts/ci/product_submit_diagnostics"

export async function expectProductSubmitReady(
  control: Locator,
  testInfo: TestInfo
): Promise<void> {
  try {
    await expect(control).toBeEnabled()
  } catch (error) {
    // Diagnostic collection must never replace the original failure.
    let blockers = safeProductSubmitBlockers(["unavailable"])!
    try {
      const value = await control.getAttribute("data-product-submit-blockers", {
        timeout: 1_000,
      })
      blockers =
        value === null
          ? blockers
          : (safeProductSubmitBlockers(value ? value.split(" ") : []) ??
            blockers)
      await testInfo.attach(productSubmitDiagnosticAttachment, {
        body: Buffer.from(JSON.stringify({ blockers })),
        contentType: "application/json",
      })
    } catch {
      // Report this optional diagnostic failure without hiding the failed assertion.
      console.warn(
        "Product submit readiness diagnostics could not be collected."
      )
    }
    throw error
  }
}
