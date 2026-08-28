import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"

import {
  createMerchantInvoiceMutationFn,
  createMerchantInvoiceRetryMutationFn,
  getMerchantInvoiceHistoryReadState,
  createMerchantPendingInvoiceQueryFn,
  createMerchantPendingInvoiceQueryScope,
  merchantPendingInvoiceQueryKey,
  type DeliverMerchantInvoiceResult,
  type MerchantInvoiceMutationErrorCode,
  type MerchantPendingInvoice,
  type MerchantInvoiceSelection,
} from "./merchant-invoice"

declare function describe(name: string, fn: () => void): void
declare function test(name: string, fn: () => Promise<void>): void
declare function expect(actual: unknown): {
  toEqual(expected: unknown): void
  not: { toContain(expected: string): void }
}

const PRIVATE_INVOICE = "private BOLT11 test sentinel"
const PRIVATE_SECRET = "private NWC secret test sentinel"
const PRIVATE_URI = "private NWC URI test sentinel"
const PRIVATE_PROFILE_ADDRESS = "merchant-private@example.test"
const PRIVATE_PROVIDER_BODY = "private provider response test sentinel"
const PRIVATE_RELAY_RESPONSE = "private relay response test sentinel"
const PRIVATE_WALLET_PUBKEY = "private wallet pubkey test sentinel"
const PRIVATE_RELAY_URL = "wss://private-relay.example"

describe("merchant invoice history availability", () => {
  test("keeps settled complete history available during a background refresh", async () => {
    const meta = {
      decryptFailures: [],
      inbox: {
        declarationEvidenceCurrent: true,
        declaredWritePlan: {
          coverage: "complete" as const,
          capped: false,
        },
      },
    }

    expect(
      getMerchantInvoiceHistoryReadState({
        error: null,
        meta,
        fetching: false,
      })
    ).toEqual("complete")
    expect(
      getMerchantInvoiceHistoryReadState({
        error: null,
        meta,
        fetching: true,
      })
    ).toEqual("complete")
  })

  test("keeps initial and genuinely unsafe refreshes blocked", async () => {
    expect(
      getMerchantInvoiceHistoryReadState({
        error: null,
        meta: null,
        fetching: true,
      })
    ).toEqual("incomplete")
    expect(
      getMerchantInvoiceHistoryReadState({
        error: new Error("read failed"),
        meta: {
          decryptFailures: [],
          inbox: {
            declarationEvidenceCurrent: true,
            declaredWritePlan: { coverage: "complete", capped: false },
          },
        },
        fetching: true,
      })
    ).toEqual("incomplete")
    expect(
      getMerchantInvoiceHistoryReadState({
        error: null,
        meta: {
          decryptFailures: [],
          inbox: {
            declarationEvidenceCurrent: false,
            declaredWritePlan: { coverage: "complete", capped: false },
          },
        },
        fetching: true,
      })
    ).toEqual("incomplete")
  })
})

function acceptedResult(
  source: DeliverMerchantInvoiceResult["source"],
  reused = false
): DeliverMerchantInvoiceResult {
  return {
    invoice: PRIVATE_INVOICE,
    source,
    reused,
    relayAcceptance: "accepted",
  }
}

function sensitiveFailure(message: string): Error {
  const error = new Error(message) as Error & { cause?: unknown }
  error.cause = new Error(PRIVATE_PROVIDER_BODY)
  return error
}

async function settleRejected(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    return
  }
  throw new Error("Expected the mutation to reject.")
}

describe("merchant invoice React Query privacy boundary", () => {
  test("keeps NWC, manual, and retry payment content out of cached mutation state", async () => {
    const connection = {
      walletPubkey: "c".repeat(64),
      secret: PRIVATE_SECRET,
      relays: ["wss://relay.example"],
      uri: PRIVATE_URI,
    }
    const resolvedSelections: MerchantInvoiceSelection[] = []
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
        },
      },
    })
    const createObserver = new MutationObserver(queryClient, {
      mutationFn: createMerchantInvoiceMutationFn({
        resolveSource: (source) => {
          const selection: MerchantInvoiceSelection =
            source === "nwc"
              ? { type: "nwc", connection }
              : source === "manual"
                ? { type: "manual", invoice: PRIVATE_INVOICE }
                : { type: source }
          resolvedSelections.push(selection)
          return selection
        },
        deliver: async (selection) => acceptedResult(selection.type),
      }),
    })
    const retryObserver = new MutationObserver(queryClient, {
      mutationFn: createMerchantInvoiceRetryMutationFn(async () =>
        acceptedResult("manual", true)
      ),
    })

    await createObserver.mutate("nwc")
    await createObserver.mutate("manual")
    await retryObserver.mutate(undefined)

    expect(resolvedSelections).toEqual([
      { type: "nwc", connection },
      { type: "manual", invoice: PRIVATE_INVOICE },
    ])

    const cachedState = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => ({
        variables: mutation.state.variables,
        data: mutation.state.data,
      }))
    expect(cachedState).toEqual([
      {
        variables: "nwc",
        data: {
          source: "nwc",
          reused: false,
          relayAcceptance: "accepted",
        },
      },
      {
        variables: "manual",
        data: {
          source: "manual",
          reused: false,
          relayAcceptance: "accepted",
        },
      },
      {
        variables: undefined,
        data: {
          source: "manual",
          reused: true,
          relayAcceptance: "accepted",
        },
      },
    ])

    const diagnosticsVisibleState = JSON.stringify(cachedState)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_SECRET)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_URI)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_INVOICE)
  })

  test("replaces rejected provider and delivery errors with content-free cached errors", async () => {
    const connection = {
      walletPubkey: PRIVATE_WALLET_PUBKEY,
      secret: PRIVATE_SECRET,
      relays: [PRIVATE_RELAY_URL],
      uri: PRIVATE_URI,
    }
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
        },
      },
    })
    const createObserver = new MutationObserver(queryClient, {
      mutationFn: createMerchantInvoiceMutationFn({
        resolveSource: (source): MerchantInvoiceSelection => {
          if (source === "nwc") {
            throw sensitiveFailure(
              [
                connection.walletPubkey,
                connection.secret,
                connection.relays.join(","),
                connection.uri,
              ].join(" ")
            )
          }
          return source === "manual"
            ? { type: "manual", invoice: PRIVATE_INVOICE }
            : { type: source }
        },
        deliver: async (selection) => {
          throw sensitiveFailure(
            [
              selection.type,
              PRIVATE_PROFILE_ADDRESS,
              PRIVATE_INVOICE,
              PRIVATE_SECRET,
              PRIVATE_URI,
              PRIVATE_WALLET_PUBKEY,
              PRIVATE_RELAY_URL,
              PRIVATE_RELAY_RESPONSE,
            ].join(" ")
          )
        },
      }),
    })
    const retryObserver = new MutationObserver(queryClient, {
      mutationFn: createMerchantInvoiceRetryMutationFn(async () => {
        throw sensitiveFailure(
          `${PRIVATE_INVOICE} ${PRIVATE_RELAY_RESPONSE} ${PRIVATE_PROFILE_ADDRESS}`
        )
      }),
    })

    await settleRejected(createObserver.mutate("profile_lud16"))
    await settleRejected(createObserver.mutate("webln"))
    await settleRejected(createObserver.mutate("nwc"))
    await settleRejected(createObserver.mutate("manual"))
    await settleRejected(retryObserver.mutate(undefined))

    const snapshotError = (value: unknown) => {
      if (!(value instanceof Error)) return value
      const error = value as Error & {
        code?: MerchantInvoiceMutationErrorCode
        cause?: unknown
      }
      return {
        name: error.name,
        message: error.message,
        code: error.code,
        cause: error.cause,
        stack: error.stack,
      }
    }
    const cachedErrors = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => ({
        variables: mutation.state.variables,
        data: mutation.state.data,
        context: mutation.state.context,
        status: mutation.state.status,
        error: snapshotError(mutation.state.error),
        failureReason: snapshotError(mutation.state.failureReason),
      }))
    const withoutStacks = cachedErrors.map((state) => ({
      ...state,
      error:
        state.error && typeof state.error === "object"
          ? { ...state.error, stack: undefined }
          : state.error,
      failureReason:
        state.failureReason && typeof state.failureReason === "object"
          ? { ...state.failureReason, stack: undefined }
          : state.failureReason,
    }))

    const expectedErrors: Array<{
      variables: string | undefined
      code: MerchantInvoiceMutationErrorCode
      message: string
    }> = [
      {
        variables: "profile_lud16",
        code: "profile_invoice_failed",
        message:
          "Could not complete the profile Lightning invoice action. If a saved invoice is shown, retry it; otherwise try again or choose another invoice source.",
      },
      {
        variables: "webln",
        code: "browser_wallet_invoice_failed",
        message:
          "Could not complete the browser-wallet invoice action. If a saved invoice is shown, retry it; otherwise try again or choose another invoice source.",
      },
      {
        variables: "nwc",
        code: "connected_wallet_invoice_failed",
        message:
          "Could not complete the connected-wallet invoice action. If a saved invoice is shown, retry it; otherwise check the wallet connection and try again.",
      },
      {
        variables: "manual",
        code: "manual_invoice_failed",
        message:
          "Could not complete the pasted-invoice action. If a saved invoice is shown, retry it; otherwise check the invoice and try again.",
      },
      {
        variables: undefined,
        code: "invoice_retry_failed",
        message:
          "Could not complete the saved-invoice action. Refresh its status and try again.",
      },
    ]
    expect(withoutStacks).toEqual(
      expectedErrors.map(({ variables, code, message }) => {
        const error = {
          name: "MerchantInvoiceMutationError",
          message,
          code,
          cause: undefined,
          stack: undefined,
        }
        return {
          variables,
          data: undefined,
          context: undefined,
          status: "error",
          error,
          failureReason: error,
        }
      })
    )

    const diagnosticsVisibleState = JSON.stringify(cachedErrors)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_PROFILE_ADDRESS)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_PROVIDER_BODY)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_RELAY_RESPONSE)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_SECRET)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_URI)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_INVOICE)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_WALLET_PUBKEY)
    expect(diagnosticsVisibleState).not.toContain(PRIVATE_RELAY_URL)
  })

  test("keeps persisted invoice content out of real QueryCache data and errors", async () => {
    const privateMerchant = "private merchant pubkey test sentinel"
    const privateBuyer = "private buyer pubkey test sentinel"
    const privateOrderId = "private order id test sentinel"
    const privatePaymentHash = "private payment hash test sentinel"
    const privateNote = "private invoice note test sentinel"
    const pending: MerchantPendingInvoice = {
      id: `${privateMerchant}:${privateOrderId}`,
      merchantPubkey: privateMerchant,
      buyerPubkey: privateBuyer,
      orderId: privateOrderId,
      invoice: PRIVATE_INVOICE,
      paymentHash: privatePaymentHash,
      amountMsats: 21_000,
      note: privateNote,
      delivery: "buyer_and_self",
      source: "profile_lud16",
      invoiceCreatedAt: 1_000,
      invoiceExpiresAt: 4_600,
      deliveryState: "pending",
      deliveryAttemptCount: 1,
      savedAt: 1_000_000,
    }
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
        },
      },
    })
    const successScope = createMerchantPendingInvoiceQueryScope()
    const errorScope = createMerchantPendingInvoiceQueryScope()
    const successObserver = new QueryObserver(queryClient, {
      queryKey: merchantPendingInvoiceQueryKey(successScope),
      queryFn: createMerchantPendingInvoiceQueryFn(async () => pending),
    })
    const errorObserver = new QueryObserver(queryClient, {
      queryKey: merchantPendingInvoiceQueryKey(errorScope),
      queryFn: createMerchantPendingInvoiceQueryFn(async () => {
        throw sensitiveFailure(
          `${PRIVATE_INVOICE} ${privatePaymentHash} ${privateNote} ${privateMerchant} ${privateBuyer} ${privateOrderId}`
        )
      }),
    })

    await successObserver.refetch()
    await errorObserver.refetch()

    const cachedState = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({
        queryKey: query.queryKey,
        queryHash: query.queryHash,
        status: query.state.status,
        data: query.state.data,
        error:
          query.state.error instanceof Error
            ? {
                name: query.state.error.name,
                message: query.state.error.message,
                cause: (query.state.error as Error & { cause?: unknown }).cause,
                stack: query.state.error.stack,
              }
            : query.state.error,
        fetchFailureReason:
          query.state.fetchFailureReason instanceof Error
            ? {
                name: query.state.fetchFailureReason.name,
                message: query.state.fetchFailureReason.message,
                cause: (
                  query.state.fetchFailureReason as Error & { cause?: unknown }
                ).cause,
                stack: query.state.fetchFailureReason.stack,
              }
            : query.state.fetchFailureReason,
      }))
    expect(
      cachedState.map((state) => ({
        ...state,
        error:
          state.error && typeof state.error === "object"
            ? { ...state.error, stack: undefined }
            : state.error,
        fetchFailureReason:
          state.fetchFailureReason &&
          typeof state.fetchFailureReason === "object"
            ? { ...state.fetchFailureReason, stack: undefined }
            : state.fetchFailureReason,
      }))
    ).toEqual([
      {
        queryKey: ["merchant-pending-invoice", successScope],
        queryHash: JSON.stringify(["merchant-pending-invoice", successScope]),
        status: "success",
        data: {
          deliveryState: "pending",
          invoiceExpiresAt: 4_600,
        },
        error: null,
        fetchFailureReason: null,
      },
      {
        queryKey: ["merchant-pending-invoice", errorScope],
        queryHash: JSON.stringify(["merchant-pending-invoice", errorScope]),
        status: "error",
        data: undefined,
        error: {
          name: "MerchantPendingInvoiceQueryError",
          message:
            "Could not load the saved invoice status. Refresh and try again.",
          cause: undefined,
          stack: undefined,
        },
        fetchFailureReason: {
          name: "MerchantPendingInvoiceQueryError",
          message:
            "Could not load the saved invoice status. Refresh and try again.",
          cause: undefined,
          stack: undefined,
        },
      },
    ])

    const diagnosticsVisibleState = JSON.stringify(cachedState)
    for (const sentinel of [
      PRIVATE_INVOICE,
      PRIVATE_PROVIDER_BODY,
      privatePaymentHash,
      privateNote,
      privateMerchant,
      privateBuyer,
      privateOrderId,
    ]) {
      expect(diagnosticsVisibleState).not.toContain(sentinel)
    }
  })
})
