import {
  canMockInvoice,
  db,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  isValidLud16Address,
  mockMakeInvoice,
  normalizeLightningInvoice,
  normalizePubkey,
  nwcGetInfo,
  nwcMakeInvoice,
  publishMerchantOrderMessage,
  validateLightningInvoiceForPayment,
  weblnMakeInvoice,
  type LnurlPayMetadata,
  type MerchantOrderDelivery,
  type NwcConnection,
  type NwcGetInfoResult,
  type PublishMerchantOrderMessageInput,
  type StoredMerchantPendingInvoice,
} from "@conduit/core"

export type MerchantInvoiceSource = StoredMerchantPendingInvoice["source"]
export type MerchantPendingInvoice = StoredMerchantPendingInvoice

export type MerchantInvoiceActionSource = Exclude<MerchantInvoiceSource, "mock">

export type MerchantInvoiceSelection =
  | { type: "profile_lud16" }
  | { type: "webln" }
  | { type: "nwc"; connection: NwcConnection }
  | { type: "manual"; invoice: string }

export type MerchantInvoiceScope = {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
}

export type CreateMerchantInvoiceInput = MerchantInvoiceScope & {
  amountSats: number
  note?: string
  delivery: MerchantOrderDelivery
  source: MerchantInvoiceSelection
}

export type MerchantInvoiceStatus =
  { state: "none" } | { state: "pending" | "sent" }

export interface MerchantPendingInvoiceStore {
  get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null>
  put(invoice: MerchantPendingInvoice): Promise<void>
  delete(merchantPubkey: string, orderId: string): Promise<void>
}

type PendingInvoiceTable = {
  get(id: string): Promise<StoredMerchantPendingInvoice | undefined>
  put(invoice: StoredMerchantPendingInvoice): Promise<unknown>
  delete(id: string): Promise<void>
}

export interface MerchantInvoiceLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

export interface MerchantInvoiceDependencies {
  store: MerchantPendingInvoiceStore
  getProfileLud16(merchantPubkey: string): Promise<string | null>
  fetchLnurlPayMetadata(lud16: string): Promise<LnurlPayMetadata>
  fetchLnurlInvoice(
    callback: string,
    amountMsats: number
  ): Promise<{ invoice: string }>
  makeWeblnInvoice(input: {
    amountSats: number
    memo?: string
  }): Promise<{ invoice: string }>
  getNwcInfo(
    connection: NwcConnection,
    timeoutMs: number
  ): Promise<NwcGetInfoResult>
  makeNwcInvoice(
    connection: NwcConnection,
    input: { amountMsats: number; description?: string }
  ): Promise<{ invoice: string }>
  makeMockInvoice(input: { amountSats: number; memo?: string }): {
    invoice: string
  }
  isMockPayments(): boolean
  publish(input: PublishMerchantOrderMessageInput): Promise<unknown>
  now(): number
  nwcTimeoutMs?: number
  lockManager?: MerchantInvoiceLockManager | null
}

export interface MerchantInvoiceModule {
  getStatus(input: MerchantInvoiceScope): Promise<MerchantInvoiceStatus>
  createAndDeliver(input: CreateMerchantInvoiceInput): Promise<void>
  retryDelivery(input: MerchantInvoiceScope): Promise<void>
}

const MERCHANT_INVOICE_SOURCES: readonly MerchantInvoiceSource[] = [
  "profile_lud16",
  "webln",
  "nwc",
  "manual",
  "mock",
]

function pendingInvoiceId(merchantPubkey: string, orderId: string): string {
  return `${merchantPubkey}:${orderId}`
}

function validateScope(input: MerchantInvoiceScope): MerchantInvoiceScope {
  const merchantPubkey = normalizePubkey(input.merchantPubkey)
  const buyerPubkey = normalizePubkey(input.buyerPubkey)
  const orderId = input.orderId
  if (!merchantPubkey || !buyerPubkey) {
    throw new Error("Valid merchant and buyer pubkeys are required.")
  }
  if (
    typeof orderId !== "string" ||
    !orderId.trim() ||
    orderId !== orderId.trim() ||
    orderId.length > 512
  ) {
    throw new Error("A valid order is required.")
  }
  return { merchantPubkey, buyerPubkey, orderId }
}

function parseStoredPendingInvoice(
  value: StoredMerchantPendingInvoice | undefined,
  expectedId: string
): MerchantPendingInvoice | null {
  if (!value) return null
  const merchantPubkey = normalizePubkey(value.merchantPubkey)
  const buyerPubkey = normalizePubkey(value.buyerPubkey)
  const orderId = value.orderId
  if (
    value.id !== expectedId ||
    !merchantPubkey ||
    !buyerPubkey ||
    typeof orderId !== "string" ||
    !orderId.trim() ||
    orderId !== orderId.trim() ||
    value.id !== pendingInvoiceId(merchantPubkey, orderId) ||
    typeof value.invoice !== "string" ||
    !value.invoice ||
    !Number.isSafeInteger(value.amountMsats) ||
    value.amountMsats <= 0 ||
    (value.note !== undefined && typeof value.note !== "string") ||
    (value.delivery !== "buyer_and_self" && value.delivery !== "self_only") ||
    !MERCHANT_INVOICE_SOURCES.includes(value.source) ||
    !Number.isSafeInteger(value.invoiceExpiresAt) ||
    (value.deliveryState !== "pending" && value.deliveryState !== "sent") ||
    !Number.isSafeInteger(value.updatedAt)
  ) {
    throw new Error("Invalid saved invoice state cannot be replaced.")
  }

  return {
    ...value,
    merchantPubkey,
    buyerPubkey,
    orderId,
  }
}

export class DexieMerchantPendingInvoiceStore implements MerchantPendingInvoiceStore {
  constructor(
    private readonly table: PendingInvoiceTable = db.merchantPendingInvoices
  ) {}

  async get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null> {
    const merchant = normalizePubkey(merchantPubkey)
    const normalizedOrderId = orderId.trim()
    if (!merchant || !normalizedOrderId) return null
    const id = pendingInvoiceId(merchant, normalizedOrderId)
    return parseStoredPendingInvoice(await this.table.get(id), id)
  }

  async put(invoice: MerchantPendingInvoice): Promise<void> {
    const parsed = parseStoredPendingInvoice(invoice, invoice.id)
    if (!parsed)
      throw new Error("Cannot persist invalid pending invoice state.")
    await this.table.put(parsed)
  }

  async delete(merchantPubkey: string, orderId: string): Promise<void> {
    const merchant = normalizePubkey(merchantPubkey)
    const normalizedOrderId = orderId.trim()
    if (!merchant || !normalizedOrderId) return
    await this.table.delete(pendingInvoiceId(merchant, normalizedOrderId))
  }
}

function assertAmount(amountSats: number): number {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Invoice amount must be a positive whole number of sats.")
  }
  const amountMsats = amountSats * 1_000
  if (!Number.isSafeInteger(amountMsats)) {
    throw new Error("Invoice amount is too large.")
  }
  return amountMsats
}

function assertLnurlRange(
  metadata: LnurlPayMetadata,
  amountMsats: number
): void {
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error(
      "The configured Lightning address does not accept this invoice amount."
    )
  }
}

function normalizeLud16(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ""
  return normalized && isValidLud16Address(normalized) ? normalized : null
}

function validateGeneratedInvoice(
  invoice: string,
  expectedAmountMsats: number,
  nowMs: number
): Pick<MerchantPendingInvoice, "invoice" | "invoiceExpiresAt"> {
  const normalizedInvoice = normalizeLightningInvoice(invoice)
  const validation = validateLightningInvoiceForPayment({
    invoice: normalizedInvoice,
    expectedAmountMsats,
    nowSeconds: Math.floor(nowMs / 1_000),
  })
  if (!validation.ok) throw new Error(validation.reason)

  if (validation.metadata.expiresAt === null) {
    throw new Error("The invoice does not have a usable expiry.")
  }

  return {
    invoice: normalizedInvoice,
    invoiceExpiresAt: validation.metadata.expiresAt,
  }
}

function assertNwcDestinationMatch(
  profileLud16: string,
  connection: NwcConnection,
  info: NwcGetInfoResult
): void {
  const profile = normalizeLud16(profileLud16)
  if (!profile) {
    throw new Error(
      "A valid profile Lightning address is required for connected-wallet invoicing."
    )
  }
  if (!info.methods.includes("make_invoice")) {
    throw new Error("The connected wallet cannot create invoices.")
  }

  const reportedDestinations = [connection.lud16, info.lud16]
    .map(normalizeLud16)
    .filter((value): value is string => value !== null)
  if (reportedDestinations.length === 0) {
    throw new Error(
      "The connected wallet does not report a receiving destination."
    )
  }
  if (reportedDestinations.some((destination) => destination !== profile)) {
    throw new Error(
      "The connected wallet destination does not match the profile Lightning address."
    )
  }
}

async function acquireInvoice(
  source: MerchantInvoiceSelection,
  merchantPubkey: string,
  amountSats: number,
  amountMsats: number,
  orderId: string,
  dependencies: MerchantInvoiceDependencies
): Promise<{ invoice: string; source: MerchantInvoiceSource }> {
  const memo = `Conduit order ${orderId}`
  if (dependencies.isMockPayments()) {
    return {
      invoice: dependencies.makeMockInvoice({ amountSats, memo }).invoice,
      source: "mock",
    }
  }

  switch (source.type) {
    case "profile_lud16": {
      const lud16 = normalizeLud16(
        await dependencies.getProfileLud16(merchantPubkey)
      )
      if (!lud16) {
        throw new Error("A valid profile Lightning address is required.")
      }
      const metadata = await dependencies.fetchLnurlPayMetadata(lud16)
      assertLnurlRange(metadata, amountMsats)
      return {
        invoice: (
          await dependencies.fetchLnurlInvoice(metadata.callback, amountMsats)
        ).invoice,
        source: source.type,
      }
    }
    case "webln":
      return {
        // A local timeout cannot cancel a wallet prompt or invoice request. Keep
        // this order exclusive until the original issuer response settles so a
        // late success cannot be followed by a second invoice.
        invoice: (await dependencies.makeWeblnInvoice({ amountSats, memo }))
          .invoice,
        source: source.type,
      }
    case "nwc": {
      const timeoutMs = dependencies.nwcTimeoutMs ?? 15_000
      const info = await dependencies.getNwcInfo(source.connection, timeoutMs)
      const profileLud16 = await dependencies.getProfileLud16(merchantPubkey)
      assertNwcDestinationMatch(profileLud16 ?? "", source.connection, info)
      return {
        invoice: (
          await dependencies.makeNwcInvoice(source.connection, {
            amountMsats,
            description: memo,
          })
        ).invoice,
        source: source.type,
      }
    }
    case "manual":
      return { invoice: source.invoice, source: source.type }
  }
}

function toPublishInput(
  pending: MerchantPendingInvoice
): PublishMerchantOrderMessageInput {
  const amountSats = pending.amountMsats / 1_000
  return {
    merchantPubkey: pending.merchantPubkey,
    buyerPubkey: pending.buyerPubkey,
    orderId: pending.orderId,
    type: "payment_request",
    tags: [
      ["amount", String(amountSats)],
      ["currency", "SATS"],
      ["payment_method", "lightning"],
    ],
    payload: {
      invoice: pending.invoice,
      amount: amountSats,
      currency: "SATS",
      ...(pending.note ? { note: pending.note } : {}),
    },
    delivery: pending.delivery,
    signerInteraction: "external",
  }
}

function getNavigatorLockManager(): MerchantInvoiceLockManager | null {
  if (
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    !navigator.locks
  ) {
    return null
  }
  return navigator.locks as unknown as MerchantInvoiceLockManager
}

function assertSavedInvoiceBuyer(
  saved: MerchantPendingInvoice,
  buyerPubkey: string,
  action: string
): void {
  if (saved.buyerPubkey !== buyerPubkey) {
    throw new Error(
      `The saved invoice belongs to a different buyer and cannot be ${action}.`
    )
  }
}

async function deliverSavedInvoice(
  saved: MerchantPendingInvoice,
  dependencies: MerchantInvoiceDependencies
): Promise<void> {
  if (saved.source !== "mock") {
    validateGeneratedInvoice(
      saved.invoice,
      saved.amountMsats,
      dependencies.now()
    )
  }
  const now = dependencies.now()
  const attempting: MerchantPendingInvoice = {
    ...saved,
    deliveryState: "pending",
    updatedAt: now,
  }
  await dependencies.store.put(attempting)

  await dependencies.publish(toPublishInput(attempting))

  const sentAt = dependencies.now()
  await dependencies.store.put({
    ...attempting,
    deliveryState: "sent",
    updatedAt: sentAt,
  })
}

// Navigator locks coordinate tabs where supported. This JavaScript-realm
// fallback also coordinates module instances created by route remounts.
const inFlightInvoiceOrders = new Set<string>()

export function createMerchantInvoiceModule(
  dependencies: MerchantInvoiceDependencies
): MerchantInvoiceModule {
  const lockManager =
    dependencies.lockManager === undefined
      ? getNavigatorLockManager()
      : dependencies.lockManager

  async function runExclusive<T>(
    scopeId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const localAction = async (): Promise<T> => {
      if (inFlightInvoiceOrders.has(scopeId)) {
        throw new Error("Another invoice action is already in progress.")
      }
      inFlightInvoiceOrders.add(scopeId)
      try {
        return await action()
      } finally {
        inFlightInvoiceOrders.delete(scopeId)
      }
    }

    if (!lockManager) return localAction()
    return lockManager.request(
      `conduit:merchant-invoice:${scopeId}`,
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (!lock) {
          throw new Error("Another invoice action is already in progress.")
        }
        return localAction()
      }
    )
  }

  return {
    async getStatus(input): Promise<MerchantInvoiceStatus> {
      const scope = validateScope(input)
      const saved = await dependencies.store.get(
        scope.merchantPubkey,
        scope.orderId
      )
      if (!saved) return { state: "none" }
      assertSavedInvoiceBuyer(saved, scope.buyerPubkey, "used")
      const expired =
        saved.invoiceExpiresAt <= Math.floor(dependencies.now() / 1_000)
      return expired ? { state: "none" } : { state: saved.deliveryState }
    },

    async createAndDeliver(input): Promise<void> {
      const scope = validateScope(input)
      const scopeId = pendingInvoiceId(scope.merchantPubkey, scope.orderId)
      return runExclusive(scopeId, async () => {
        const existing = await dependencies.store.get(
          scope.merchantPubkey,
          scope.orderId
        )
        if (existing) {
          assertSavedInvoiceBuyer(existing, scope.buyerPubkey, "replaced")
          if (
            existing.invoiceExpiresAt <= Math.floor(dependencies.now() / 1_000)
          ) {
            await dependencies.store.delete(scope.merchantPubkey, scope.orderId)
          } else {
            throw new Error(
              existing.deliveryState === "pending"
                ? "A saved invoice still needs delivery. Retry it before creating another."
                : "An invoice was already sent for this order."
            )
          }
        }

        const amountMsats = assertAmount(input.amountSats)
        const acquired = await acquireInvoice(
          input.source,
          scope.merchantPubkey,
          input.amountSats,
          amountMsats,
          scope.orderId,
          dependencies
        )
        const now = dependencies.now()
        const validated =
          acquired.source === "mock"
            ? {
                invoice: acquired.invoice.trim(),
                invoiceExpiresAt: Math.floor(now / 1_000) + 3_600,
              }
            : validateGeneratedInvoice(acquired.invoice, amountMsats, now)
        const pending: MerchantPendingInvoice = {
          id: scopeId,
          ...scope,
          ...validated,
          amountMsats,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
          delivery: input.delivery,
          source: acquired.source,
          deliveryState: "pending",
          updatedAt: now,
        }

        return deliverSavedInvoice(pending, dependencies)
      })
    },

    async retryDelivery(input): Promise<void> {
      const scope = validateScope(input)
      const scopeId = pendingInvoiceId(scope.merchantPubkey, scope.orderId)
      return runExclusive(scopeId, async () => {
        const saved = await dependencies.store.get(
          scope.merchantPubkey,
          scope.orderId
        )
        if (!saved) throw new Error("No saved invoice is available for retry.")
        assertSavedInvoiceBuyer(saved, scope.buyerPubkey, "retried")
        return deliverSavedInvoice(saved, dependencies)
      })
    },
  }
}

export function getAuthoritativeMerchantProfileLud16(profile: {
  rawContent?: unknown
}): string | null {
  if (typeof profile.rawContent !== "string") return null
  try {
    const raw = JSON.parse(profile.rawContent) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    return normalizeLud16(
      typeof (raw as Record<string, unknown>).lud16 === "string"
        ? ((raw as Record<string, unknown>).lud16 as string)
        : null
    )
  } catch {
    return null
  }
}

async function getStoredMerchantProfileLud16(
  merchantPubkey: string
): Promise<string | null> {
  const merchant = normalizePubkey(merchantPubkey)
  if (!merchant) return null
  const profile = await db.profiles.get(merchant)
  if (!profile) return null
  return getAuthoritativeMerchantProfileLud16(profile)
}

export function createDefaultMerchantInvoiceModule(
  store: MerchantPendingInvoiceStore = new DexieMerchantPendingInvoiceStore()
): MerchantInvoiceModule {
  return createMerchantInvoiceModule({
    store,
    getProfileLud16: getStoredMerchantProfileLud16,
    fetchLnurlPayMetadata,
    fetchLnurlInvoice,
    makeWeblnInvoice: weblnMakeInvoice,
    getNwcInfo: (connection, timeoutMs) =>
      nwcGetInfo(connection, timeoutMs, "merchant"),
    // Invoice issuance is not safely retryable after a client-side timeout.
    // Keep awaiting the original NWC response while the per-order lock is held.
    makeNwcInvoice: (connection, input) =>
      nwcMakeInvoice(connection, input, null, "merchant"),
    makeMockInvoice: mockMakeInvoice,
    isMockPayments: canMockInvoice,
    publish: publishMerchantOrderMessage,
    now: Date.now,
  })
}
