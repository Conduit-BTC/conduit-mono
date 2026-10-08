import type { TestInfo } from "@playwright/test"

type Rule = "number" | "boolean" | readonly string[]
const schemas: Record<string, { file: string; fields: Record<string, Rule> }> =
  {
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
        widgetMarginBottom: "number",
        widgetTransformY: "number",
        footerTransformY: "number",
        widgetHiddenShift: "number",
        widgetBottomOffset: "number",
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
  kind: "footer-layout" | "product-submit",
  values: Record<string, unknown>
): void {
  const type = `smoke:${kind}`
  const description = JSON.stringify(values)
  const annotation = info.annotations.find((item) => item.type === type)
  if (annotation) annotation.description = description
  else info.annotations.push({ type, description })
}
