import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"

import { prepareControlledWallet } from "../e2e/helpers/wallet-fixture"

test("controlled Spark module fetch failures preserve their error and fixed diagnostic", async () => {
  const sentinel = "private-" + crypto.randomUUID()
  const originalError = new Error("net::ERR_CONNECTION_RESET " + sentinel)
  let handler!: (route: Route) => Promise<void>
  const diagnostics: unknown[] = []
  const page = {
    addInitScript: async () => {},
    on: () => {},
    isClosed: () => false,
    route: async (_match: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as unknown as Page

  await prepareControlledWallet(page, (diagnostic) => {
    diagnostics.push(diagnostic)
  })
  await expect(
    handler({
      fetch: async () => {
        throw originalError
      },
      request: () => ({ isNavigationRequest: () => false }),
    } as unknown as Route)
  ).rejects.toBe(originalError)

  expect(diagnostics).toEqual([
    {
      routeFetchBoundary: "spark_factory",
      routeFetchCategory: "network",
      routeFetchPageClosed: false,
      routeFetchNavigationRequest: false,
      routeFetchNavigations: 0,
      routeFetchStarts: 1,
      routeFetchCompletes: 0,
      routeFetchStartNavigations: 0,
      routeFetchStartNavRequests: 0,
      routeFetchFailureNavRequests: 0,
      routeFetchNewNavRequested: false,
    },
  ])
  expect(JSON.stringify(diagnostics)).not.toContain(sentinel)
})

test("failed diagnostic recording cannot replace a controlled Spark module fetch error", async () => {
  const originalError = new Error("controlled transport failure")
  let handler!: (route: Route) => Promise<void>
  const page = {
    addInitScript: async () => {},
    on: () => {},
    isClosed: () => true,
    route: async (_match: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as unknown as Page
  await prepareControlledWallet(page, () => {
    throw new Error("diagnostic unavailable")
  })

  await expect(
    handler({
      fetch: async () => {
        throw originalError
      },
      request: () => ({ isNavigationRequest: () => false }),
    } as unknown as Route)
  ).rejects.toBe(originalError)
})

test("controlled Spark module fetch observation distinguishes navigation requested after fetch start", async () => {
  const originalError = new Error("request cancelled")
  let handler!: (route: Route) => Promise<void>
  let onRequest!: (request: { isNavigationRequest(): boolean }) => void
  const diagnostics: unknown[] = []
  const page = {
    addInitScript: async () => {},
    isClosed: () => false,
    on: (event: string, callback: typeof onRequest) => {
      if (event === "request") onRequest = callback
    },
    route: async (_match: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as unknown as Page
  await prepareControlledWallet(page, (diagnostic) =>
    diagnostics.push(diagnostic)
  )

  await expect(
    handler({
      fetch: async () => {
        onRequest({ isNavigationRequest: () => true })
        throw originalError
      },
      request: () => ({ isNavigationRequest: () => false }),
    } as unknown as Route)
  ).rejects.toBe(originalError)

  expect(diagnostics[0]).toMatchObject({
    routeFetchBoundary: "spark_factory",
    routeFetchCategory: "aborted",
    routeFetchStartNavRequests: 0,
    routeFetchFailureNavRequests: 1,
    routeFetchNewNavRequested: true,
  })
})

test("successful controlled Spark module fetch retains the original response and exact rewrite", async () => {
  let handler!: (route: Route) => Promise<void>
  let fulfilled: { response: unknown; body: string } | undefined
  const diagnostics: unknown[] = []
  const response = {
    text: async () => "export const factory = new FirstPartySparkSdkFactory()",
  }
  const page = {
    addInitScript: async () => {},
    on: () => {},
    route: async (_match: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as unknown as Page
  await prepareControlledWallet(page, (diagnostic) => {
    diagnostics.push(diagnostic)
  })

  await handler({
    fetch: async () => response,
    request: () => ({ isNavigationRequest: () => false }),
    fulfill: async (value: typeof fulfilled) => {
      fulfilled = value
    },
  } as unknown as Route)

  expect(fulfilled?.response).toBe(response)
  expect(fulfilled?.body).toBe(
    "export const factory = window.__walletFixtureFactory ?? new FirstPartySparkSdkFactory()"
  )
  expect(diagnostics).toEqual([])
})
