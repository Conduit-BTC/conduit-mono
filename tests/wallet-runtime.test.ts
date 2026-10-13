import { expect, test } from "bun:test"
import {
  lockedWalletRuntime,
  reconcileSparkWalletRuntime,
  type WalletRuntimeState,
} from "../packages/core/src/wallets/wallet-runtime"

test("an open completed by another consumer during reload cannot retain a locked card", async () => {
  let nativeOpen = false
  const current = lockedWalletRuntime()
  // Descriptor reload samples provider state before awaiting credential metadata.
  const sampled: WalletRuntimeState | undefined = nativeOpen
    ? { status: "ready", balanceMsats: 0, error: null }
    : undefined
  const metadataRead = Promise.resolve().then(() => {
    nativeOpen = true
  })
  await metadataRead
  expect(
    reconcileSparkWalletRuntime({
      nativeOpen,
      opening: false,
      sampled,
      current,
    })
  ).toEqual({ status: "ready", balanceMsats: null, error: null })
})
test("closing during metadata reads invalidates sampled ready state", () => {
  expect(
    reconcileSparkWalletRuntime({
      nativeOpen: false,
      opening: false,
      sampled: { status: "ready", balanceMsats: 0, error: null },
    })
  ).toEqual(lockedWalletRuntime())
})
test("an unfinished native open remains connecting", () => {
  expect(
    reconcileSparkWalletRuntime({
      nativeOpen: false,
      opening: true,
      current: lockedWalletRuntime(),
    }).status
  ).toBe("connecting")
})
test("an open wallet retains sampled balance failure and newer ready state", () => {
  const error: WalletRuntimeState = {
    status: "error",
    balanceMsats: null,
    error: "Balance unavailable",
  }
  expect(
    reconcileSparkWalletRuntime({
      nativeOpen: true,
      opening: false,
      sampled: error,
    })
  ).toEqual(error)
  const ready: WalletRuntimeState = {
    status: "ready",
    balanceMsats: 0,
    error: null,
  }
  expect(
    reconcileSparkWalletRuntime({
      nativeOpen: true,
      opening: false,
      current: ready,
    })
  ).toEqual(ready)
})
