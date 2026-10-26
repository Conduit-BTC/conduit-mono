import { z } from "zod"
import { SHIPPING_COUNTRIES } from "../protocol/countries"

import { PUBLIC_SETTINGS_ID, PRIVATE_SETTINGS_ID } from "./identifiers"
export * from "./identifiers"
export const SETTINGS_MAX_BYTES = 32768
const text = (max: number) =>
  z
    .string()
    .refine((value) => [...value].length <= max)
    .meta({ maxLength: max })
const language = text(64).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
const timezone = text(80)
const time = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)
const interval = z
  .object({
    start: time,
    end: z.string().regex(/^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/),
  })
  .loose()
const intervals = z.array(interval).max(8)
const hours = z
  .object({
    timezone,
    weekly: z
      .object(
        Object.fromEntries(
          ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
            day,
            intervals.optional(),
          ])
        )
      )
      .loose(),
    exceptions: z
      .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), intervals)
      .optional(),
  })
  .loose()
export const savedShippingAddressSchema = z
  .object({
    recipientName: text(100).min(1),
    addressLine1: text(200).min(1),
    addressLine2: text(200).optional(),
    city: text(100),
    stateOrRegion: text(100).optional(),
    postalCode: text(32),
    country: z.string().regex(/^[A-Z]{2}$/),
    email: text(320).optional(),
    phone: text(80).optional(),
    label: text(80).optional(),
  })
  .loose()
const extensions = z
  .record(
    z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
    z
      .object({
        version: z.number().int().positive(),
        data: z.json(),
      })
      .loose()
  )
  .optional()
export const privateSettingsDocumentSchema = z
  .object({
    format: z.literal(PRIVATE_SETTINGS_ID),
    version: z.literal(1),
    settings: z
      .object({
        display: z
          .object({
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .optional(),
            bitcoinUnit: z.enum(["bitcoin", "sats"]).optional(),
            language: language.optional(),
            locale: language.optional(),
          })
          .loose()
          .optional(),
        appearance: z
          .object({
            theme: z.enum(["system", "day-market", "night-market"]).optional(),
            reducedMotion: z.boolean().optional(),
          })
          .loose()
          .optional(),
        shipping: z
          .object({
            savedAddresses: z.record(z.uuid(), savedShippingAddressSchema),
            defaultAddressId: z.uuid().nullable(),
          })
          .loose()
          .optional(),
        notifications: z
          .object({
            orders: z.boolean().optional(),
            messages: z.boolean().optional(),
            quietHours: z
              .object({ start: time, end: time, timezone })
              .loose()
              .optional(),
          })
          .loose()
          .optional(),
        working: z
          .object({
            weightUnit: z.enum(["g", "kg", "lb", "oz"]).optional(),
            orderSort: z.enum(["newest", "priority", "recent"]).optional(),
          })
          .loose()
          .optional(),
        payments: z
          .object({
            preferredMethod: z.enum(["automatic", "nwc", "webln", "manual"]),
          })
          .loose()
          .optional(),
      })
      .loose(),
    extensions,
  })
  .loose()
export const publicSettingsDocumentSchema = z
  .object({
    format: z.literal(PUBLIC_SETTINGS_ID),
    version: z.literal(1),
    settings: z
      .object({
        storefront: z
          .object({
            theme: z.enum(["day-market", "night-market"]).optional(),
            layout: z.enum(["grid", "list"]).optional(),
            tokens: z
              .object({
                accent: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/)
                  .optional(),
              })
              .loose()
              .optional(),
          })
          .loose()
          .optional(),
        merchant: z
          .object({
            generalLocation: z
              .object({
                location: text(240).min(1),
                geohash: z
                  .string()
                  .regex(/^[0123456789bcdefghjkmnpqrstuvwxyz]{4}$/)
                  .optional(),
              })
              .loose()
              .nullable()
              .optional(),
            businessHours: hours.optional(),
            serviceLanguages: z.array(language).max(32).optional(),
            notice: text(2000).nullable().optional(),
          })
          .loose()
          .optional(),
        shipping: z
          .object({
            defaultPolicy: text(512)
              .regex(/^30406:[0-9a-f]{64}:.+$/)
              .nullable(),
          })
          .loose()
          .optional(),
      })
      .loose(),
    extensions,
  })
  .loose()
export type PrivateSettingsDocument = z.infer<
  typeof privateSettingsDocumentSchema
>
export type PublicSettingsDocument = z.infer<
  typeof publicSettingsDocumentSchema
>
export type SavedShippingAddress = z.infer<typeof savedShippingAddressSchema>
export class SettingsError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "unsupported"
      | "conflict"
      | "storage"
      | "session"
      | "clock"
      | "signer"
      | "unavailable"
  ) {
    super(`Settings: ${code}`)
  }
}
const forbidden = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "visibility",
  "mnemonic",
  "seed",
  "nsec",
  "privateKey",
  "walletId",
  "wallets",
  "walletRecords",
  "recovery",
  "defaultWalletId",
  "paySelectedAt",
  "receiveSelectedAt",
  "credentials",
  "nwcUri",
  "rates",
  "countries",
  "restrictTo",
  "exclude",
  "originCountry",
  "price",
  "weightBands",
])
const privateKeys = new Set([
  "display",
  "appearance",
  "notifications",
  "working",
  "payments",
  "savedAddresses",
  "defaultAddressId",
  "recipientName",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "email",
  "phone",
  "preferredMethod",
])
function bounded(value: unknown, publicDocument: boolean, depth = 0): void {
  if (depth > 12) throw new SettingsError("invalid")
  if (value === null || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value === "string" && [...value].length <= 4096) {
    if (publicDocument && value === PRIVATE_SETTINGS_ID)
      throw new SettingsError("invalid")
    return
  }
  if (!value || typeof value !== "object") throw new SettingsError("invalid")
  if (Array.isArray(value)) {
    if (value.length > 128) throw new SettingsError("invalid")
    value.forEach((item) => bounded(item, publicDocument, depth + 1))
    return
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new SettingsError("invalid")
  const entries = Object.entries(value)
  if (entries.length > 128) throw new SettingsError("invalid")
  for (const [key, item] of entries) {
    if (
      [...key].length > 128 ||
      forbidden.has(key) ||
      (publicDocument && privateKeys.has(key))
    )
      throw new SettingsError("invalid")
    bounded(item, publicDocument, depth + 1)
  }
}
/** JSON.parse accepts duplicate members. Reject them before losing that evidence. */
function decode(input: unknown): unknown {
  if (typeof input !== "string") return input
  if (new TextEncoder().encode(input).length > SETTINGS_MAX_BYTES)
    throw new SettingsError("invalid")
  const stack: Array<Set<string> | null> = []
  const tokens =
    input.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "{") stack.push(new Set())
    else if (token === "[") stack.push(null)
    else if (token === "}" || token === "]") stack.pop()
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1),
        key = JSON.parse(token) as string
      if (keys?.has(key)) throw new SettingsError("invalid")
      keys?.add(key)
    }
  }
  return JSON.parse(input) as unknown
}
function validate(input: unknown, publicDocument: boolean): unknown {
  const value = decode(input)
  bounded(value, publicDocument)
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length
  if (bytes > SETTINGS_MAX_BYTES) throw new SettingsError("invalid")
  const doc = value as {
    format?: unknown
    version?: unknown
    extensions?: Record<string, { data: unknown }>
  }
  if (
    doc.format !== (publicDocument ? PUBLIC_SETTINGS_ID : PRIVATE_SETTINGS_ID)
  )
    throw new SettingsError("invalid")
  if (!Number.isSafeInteger(doc.version) || (doc.version as number) < 1)
    throw new SettingsError("invalid")
  if (doc.version !== 1) throw new SettingsError("unsupported")
  if (doc.extensions) {
    if (Object.keys(doc.extensions).length > 16)
      throw new SettingsError("invalid")
    for (const extension of Object.values(doc.extensions))
      if (
        new TextEncoder().encode(JSON.stringify(extension?.data)).length > 4096
      )
        throw new SettingsError("invalid")
  }
  return value
}
function checkLanguage(value: string | undefined): void {
  if (!value) return
  try {
    Intl.getCanonicalLocales(value)
  } catch {
    throw new SettingsError("invalid")
  }
}
function checkTimezone(value: string | undefined): void {
  if (!value) return
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
  } catch {
    throw new SettingsError("invalid")
  }
}
export function parsePrivateSettingsDocument(
  input: unknown
): PrivateSettingsDocument {
  try {
    const doc = privateSettingsDocumentSchema.parse(validate(input, false))
    const shipping = doc.settings.shipping
    if (shipping) {
      if (
        Object.keys(shipping.savedAddresses).length > 32 ||
        (shipping.defaultAddressId !== null &&
          !Object.hasOwn(shipping.savedAddresses, shipping.defaultAddressId))
      )
        throw new SettingsError("invalid")
      for (const address of Object.values(shipping.savedAddresses))
        if (!SHIPPING_COUNTRIES.some((c) => c.code === address.country))
          throw new SettingsError("invalid")
    }
    checkLanguage(doc.settings.display?.language)
    checkLanguage(doc.settings.display?.locale)
    const currency = doc.settings.display?.currency
    if (
      currency &&
      currency !== "BTC" &&
      !Intl.supportedValuesOf("currency").includes(currency)
    )
      throw new SettingsError("invalid")
    checkTimezone(doc.settings.notifications?.quietHours?.timezone)
    return doc
  } catch (error) {
    throw error instanceof SettingsError ? error : new SettingsError("invalid")
  }
}
export function parsePublicSettingsDocument(
  input: unknown,
  owner?: string
): PublicSettingsDocument {
  try {
    const doc = publicSettingsDocumentSchema.parse(validate(input, true))
    const policy = doc.settings.shipping?.defaultPolicy
    if (policy && owner && policy.split(":")[1] !== owner)
      throw new SettingsError("invalid")
    doc.settings.merchant?.serviceLanguages?.forEach(checkLanguage)
    const hoursValue = doc.settings.merchant?.businessHours
    if (hoursValue) {
      checkTimezone(hoursValue.timezone)
      for (const [date, ranges] of Object.entries(
        hoursValue.exceptions ?? {}
      )) {
        if (
          new Date(date).toISOString().slice(0, 10) !== date ||
          !Array.isArray(ranges)
        )
          throw new SettingsError("invalid")
      }
      for (const ranges of [
        ...["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(
          (day) => hoursValue.weekly[day]
        ),
        ...Object.values(hoursValue.exceptions ?? {}),
      ]) {
        if (!Array.isArray(ranges)) continue
        let end = "00:00"
        for (const range of ranges as Array<{ start: string; end: string }>) {
          if (range.start < end || range.start >= range.end)
            throw new SettingsError("invalid")
          end = range.end
        }
      }
    }
    return doc
  } catch (error) {
    throw error instanceof SettingsError ? error : new SettingsError("invalid")
  }
}
export const emptyPrivateSettings = (): PrivateSettingsDocument => ({
  format: PRIVATE_SETTINGS_ID,
  version: 1,
  settings: {},
})
export const emptyPublicSettings = (): PublicSettingsDocument => ({
  format: PUBLIC_SETTINGS_ID,
  version: 1,
  settings: {},
})

export type ShopperShippingPreset = SavedShippingAddress
export type ShopperPaymentRail = "automatic" | "nwc" | "webln" | "manual"
