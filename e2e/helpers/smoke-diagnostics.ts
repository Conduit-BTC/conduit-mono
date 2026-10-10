import type { TestInfo } from "@playwright/test"

type Rule = "number" | "boolean" | readonly string[]
const schemas: Record<string, { file: string; fields: Record<string, Rule> }> =
  {
    "price-interaction": {
      file: "e2e/shared-ui-visual-contract.playwright.ts",
      fields: {
        pointerDown: "boolean",
        pointerUp: "boolean",
        click: "boolean",
        connected: "boolean",
        enabled: "boolean",
        quantity: "number",
      },
    },
    "fallback-upload": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        phase: [
          "setup",
          "open_draft",
          "seed_identity",
          "navigate",
          "catalog",
          "open_dialog",
          "dialog_visible",
          "wrap_signer",
          "invalid_file",
          "valid_file",
          "restore_draft",
          "discard_draft",
          "fresh_file",
          "publish",
          "listing_edit",
          "complete",
        ],
        observationAvailable: "boolean",
        dialogCount: "number",
        inboxPrompt: "boolean",
        invalidControls: "number",
        submitEnabled: "boolean",
      },
    },
    "surface-audit": {
      file: "e2e/shared-ui-surface-audit.playwright.ts",
      fields: {
        phase: [
          "setup",
          "navigate",
          "render",
          "fonts",
          "measure",
          "capture",
          "complete",
        ],
        routeIndex: "number",
        pendingDocuments: "number",
        pendingImages: "number",
        pendingFonts: "number",
        pendingScripts: "number",
        navigationError: ["none", "aborted", "interrupted", "timeout", "other"],
      },
    },
    "cart-stale-action": {
      file: "e2e/market-cart-concurrency.playwright.ts",
      fields: {
        phase: [
          "seed",
          "navigate",
          "ready",
          "remove",
          "stale_decrease",
          "stale_increase",
          "resume",
          "release",
          "reload",
          "complete",
        ],
        tabIndex: "number",
      },
    },
    "order-reply": {
      file: "e2e/merchant-order-inbox.playwright.ts",
      fields: {
        phase: [
          "setup",
          "merchant_catalog",
          "publish_product",
          "buyer_checkout",
          "send_order",
          "merchant_order",
          "merchant_reply",
          "merchant_restore",
          "buyer_delivery",
          "buyer_reply",
          "buyer_restore",
          "merchant_delivery",
          "complete",
        ],
      },
    },
    "fallback-recovery": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        phase: [
          "setup",
          "open_draft",
          "upload",
          "guard_publish",
          "restore_draft",
          "recovery_publish",
          "inbox_setup",
          "listing_edit",
          "complete",
        ],
      },
    },
    "footer-layout": {
      file: "e2e/mobile-safari-baseline.playwright.ts",
      fields: {
        phase: ["initial", "returned"],
        layout: ["missing", "clipped", "intersecting", "disjoint"],
        triggerX: "number",
        triggerY: "number",
        triggerWidth: "number",
        triggerHeight: "number",
        footerX: "number",
        footerY: "number",
        footerWidth: "number",
        footerHeight: "number",
        viewportWidth: "number",
        viewportHeight: "number",
        scrollY: "number",
        measuredFooterHeight: "number",
        footerHidden: "boolean",
        triggerMarginBottom: "number",
        triggerTransformY: "number",
        footerTransformY: "number",
      },
    },
    "product-dialog-open": {
      file: "e2e/commerce.playwright.ts",
      fields: {
        pointerDownOnTrigger: "boolean",
        pointerUpOnTrigger: "boolean",
        clickOnTrigger: "boolean",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
        dialogPresent: "boolean",
        triggerEnabled: "boolean",
        fontsAtClick: ["loading", "loaded", "unknown"],
        triggerX: "number",
        triggerY: "number",
        triggerWidth: "number",
        triggerHeight: "number",
      },
    },
    "product-submit": {
      file: "e2e/merchant-shipping-tables.playwright.ts",
      fields: {
        phase: ["first_product", "second_product"],
        present: "boolean",
        enabled: "boolean",
        signerAvailable: "boolean",
        invalidControls: "number",
        action: [
          "publish",
          "waiting_signer",
          "uploading",
          "reconnect",
          "other",
        ],
        validation: [
          "ready",
          "title",
          "price",
          "stock",
          "images",
          "tags",
          "measurements",
          "shipping_table",
          "other",
        ],
      },
    },
  }

/** Only fixed fields and bounded scalar observations may leave a smoke worker. */
export function safeSmokeDiagnostics(
  file: string,
  annotations: readonly { type: string; description?: string }[] = []
): Array<Record<string, string | number | boolean>> {
  const diagnostics: Array<Record<string, string | number | boolean>> = []
  for (const [kind, schema] of Object.entries(schemas)) {
    if (schema.file !== file) continue
    const raw = annotations.find(
      (item) => item.type === `smoke:${kind}`
    )?.description
    if (!raw || raw.length > 2048) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const safe: Record<string, string | number | boolean> = { kind }
    for (const [key, rule] of Object.entries(schema.fields)) {
      const value = (parsed as Record<string, unknown>)[key]
      if (
        rule === "number" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= 32768
      )
        safe[key] = Math.round(value * 10) / 10
      else if (rule === "boolean" && typeof value === "boolean")
        safe[key] = value
      else if (
        Array.isArray(rule) &&
        typeof value === "string" &&
        rule.includes(value)
      )
        safe[key] = value
    }
    if (Object.keys(safe).length > 1) diagnostics.push(safe)
  }
  return diagnostics
}

export function recordSmokeDiagnostic(
  info: TestInfo,
  kind:
    | "price-interaction"
    | "fallback-upload"
    | "surface-audit"
    | "cart-stale-action"
    | "footer-layout"
    | "product-submit"
    | "product-dialog-open"
    | "order-reply"
    | "fallback-recovery",
  values: Record<string, unknown>
): void {
  const type = `smoke:${kind}`
  const description = JSON.stringify(values)
  const annotation = info.annotations.find((item) => item.type === type)
  if (annotation) annotation.description = description
  else info.annotations.push({ type, description })
}
