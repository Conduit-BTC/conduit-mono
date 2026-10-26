import { z } from "zod"
import {
  privateSettingsDocumentSchema,
  publicSettingsDocumentSchema,
  savedShippingAddressSchema,
  parsePrivateSettingsDocument,
  parsePublicSettingsDocument,
  SettingsError,
  type PrivateSettingsDocument,
  type PublicSettingsDocument,
} from "./documents"

export type SettingsDocument = PrivateSettingsDocument | PublicSettingsDocument
export interface SettingsChange {
  path: string
  value: unknown
}
export interface SettingsDraft<D extends SettingsDocument> {
  baseline: D
  changes: SettingsChange[]
  reviewedPendingEventId?: string
}
export const privateEditUnits = [
  "display.currency",
  "display.bitcoinUnit",
  "display.language",
  "display.locale",
  "appearance.theme",
  "appearance.reducedMotion",
  "shipping",
  "notifications.orders",
  "notifications.messages",
  "notifications.quietHours",
  "working.weightUnit",
  "working.orderSort",
  "payments.preferredMethod",
] as const
export const publicEditUnits = [
  "storefront.theme",
  "storefront.layout",
  "storefront.tokens.accent",
  "merchant.generalLocation",
  "merchant.businessHours",
  "merchant.serviceLanguages",
  "merchant.notice",
  "shipping.defaultPolicy",
] as const
function field(doc: SettingsDocument, path: string): unknown {
  let value: unknown = doc.settings
  for (const key of path.split("."))
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined
  return value
}
function canonical(value: unknown): string {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`
  return JSON.stringify(value)
}
/** Only explicit schema fields may enter an authored patch; opaque baseline data is retained. */
function assertKnownInput(
  value: unknown,
  schema: z.ZodType,
  baseline?: unknown
): void {
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    schema = schema.unwrap() as z.ZodType
  if (value === undefined || value === null) return
  if (
    schema instanceof z.ZodObject &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    for (const [key, child] of Object.entries(value)) {
      const previous =
        baseline && typeof baseline === "object"
          ? (baseline as Record<string, unknown>)[key]
          : undefined
      if (!Object.hasOwn(schema.shape, key)) {
        if (canonical(child) !== canonical(previous))
          throw new SettingsError("invalid")
        continue
      }
      assertKnownInput(child, schema.shape[key], previous)
    }
  } else if (schema instanceof z.ZodRecord && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      assertKnownInput(
        child,
        schema.valueType as z.ZodType,
        baseline && typeof baseline === "object"
          ? (baseline as Record<string, unknown>)[key]
          : undefined
      )
  } else if (schema instanceof z.ZodArray && Array.isArray(value))
    value.forEach((child, index) =>
      assertKnownInput(
        child,
        schema.element as z.ZodType,
        Array.isArray(baseline) ? baseline[index] : undefined
      )
    )
}
function schemaAt(publicDocument: boolean, path: string): z.ZodType {
  let schema: z.ZodType = (
    publicDocument
      ? publicSettingsDocumentSchema
      : privateSettingsDocumentSchema
  ).shape.settings
  for (const key of path.split(".")) {
    while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
      schema = schema.unwrap() as z.ZodType
    if (!(schema instanceof z.ZodObject) || !Object.hasOwn(schema.shape, key))
      throw new SettingsError("invalid")
    schema = schema.shape[key]
  }
  return schema
}
function preserveNested(
  previous: unknown,
  update: unknown,
  schema: z.ZodType
): unknown {
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    schema = schema.unwrap() as z.ZodType
  if (update === null || typeof update !== "object") return update
  if (schema instanceof z.ZodArray && Array.isArray(update)) {
    const element = schema.element as z.ZodType
    return update.map((item, index) =>
      preserveNested(
        Array.isArray(previous) ? previous[index] : undefined,
        item,
        element
      )
    )
  }
  const old =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {}
  if (schema instanceof z.ZodRecord) {
    const valueSchema = schema.valueType as z.ZodType
    return Object.fromEntries(
      Object.entries(update).map(([key, value]) => [
        key,
        preserveNested(old[key], value, valueSchema),
      ])
    )
  }
  if (!(schema instanceof z.ZodObject)) return update
  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(old).filter(([key]) => !Object.hasOwn(schema.shape, key))
  )
  for (const [key, value] of Object.entries(update))
    if (value !== undefined && Object.hasOwn(schema.shape, key))
      result[key] = preserveNested(old[key], value, schema.shape[key])
  return result
}
export function rebaseSettings<D extends SettingsDocument>(
  draft: SettingsDraft<D>,
  current: D,
  owner: string
): D {
  if (draft.baseline.format !== current.format)
    throw new SettingsError("invalid")
  const isPublic = current.format === "openmarkets.public-settings"
  const units = new Set<string>(isPublic ? publicEditUnits : privateEditUnits)
  const next = structuredClone(current)
  const seen = new Set<string>()
  for (const change of draft.changes) {
    if (!units.has(change.path) || seen.has(change.path))
      throw new SettingsError("invalid")
    seen.add(change.path)
    const schema = schemaAt(isPublic, change.path)
    assertKnownInput(change.value, schema, field(current, change.path))
    if (change.value !== undefined && !schema.safeParse(change.value).success)
      throw new SettingsError("invalid")
    const baseValue = field(draft.baseline, change.path),
      currentValue = field(current, change.path)
    if (
      canonical(baseValue) !== canonical(currentValue) &&
      canonical(change.value) !== canonical(currentValue)
    )
      throw new SettingsError("conflict")
    const keys = change.path.split(".")
    let target = next.settings as Record<string, unknown>
    for (const key of keys.slice(0, -1)) {
      target[key] ??= {}
      target = target[key] as Record<string, unknown>
    }
    const key = keys.at(-1)!
    if (change.value === undefined) delete target[key]
    else if (change.path === "shipping" && !isPublic) {
      // Removing an address must not resurrect it while preserving unknown fields
      // on retained addresses and on the address-book container.
      const update = change.value as {
        savedAddresses: Record<string, unknown>
        defaultAddressId: string | null
      }
      const old = currentValue as typeof update | undefined
      target[key] = {
        ...(old ?? {}),
        ...update,
        savedAddresses: Object.fromEntries(
          Object.entries(update.savedAddresses).map(([id, address]) => [
            id,
            preserveNested(
              old?.savedAddresses[id],
              address,
              savedShippingAddressSchema
            ),
          ])
        ),
      }
    } else target[key] = preserveNested(currentValue, change.value, schema)
  }
  return (
    isPublic
      ? parsePublicSettingsDocument(next, owner)
      : parsePrivateSettingsDocument(next)
  ) as D
}
export function changedSettingsUnits(
  base: SettingsDocument,
  candidate: SettingsDocument
): SettingsChange[] {
  const units =
    candidate.format === "openmarkets.public-settings"
      ? publicEditUnits
      : privateEditUnits
  return units
    .filter(
      (path) =>
        canonical(field(base, path)) !== canonical(field(candidate, path))
    )
    .map((path) => ({ path, value: field(candidate, path) }))
}
