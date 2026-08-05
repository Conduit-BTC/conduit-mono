import { describe, expect, it } from "bun:test"

import type { WalletDescriptor } from "@conduit/core"

import {
  cleanupSparkWalletState,
  openRegisteredSparkWallet,
  type SparkWalletOperationRunner,
} from "../apps/market/src/lib/spark-wallet-lifecycle"
import {
  SparkWalletManager,
  type SparkSdkClient,
} from "../apps/market/src/lib/spark-wallet"
import {
  acquireSparkWalletManagerSessionLease,
  assertSparkWalletRegistrationSessionAvailable,
  SparkWalletSessionLeaseUnavailableError,
  type SparkWalletSessionLockManager,
} from "../apps/market/src/lib/spark-wallet-lease"

const WALLET: WalletDescriptor = {
  id: "wallet-personal",
  kind: "portable",
  providerId: "spark",
  label: "Personal",
  network: "mainnet",
  capabilities: ["pay_invoice"],
  status: "registered",
  defaultIntents: [],
  createdAt: 1,
  updatedAt: 1,
}

describe("Spark wallet lifecycle coordination", () => {
  it("keeps removal queued through a delayed password unlock", async () => {
    const operations = new SerializedWalletOperations()
    const password = deferred<{
      mnemonic: string
      accountNumber: number
    }>()
    const authenticationStarted = deferred<void>()
    const refreshStarted = deferred<void>()
    const finishRefresh = deferred<void>()
    const state = createLifecycleState()
    let wallets = [WALLET]

    const unlock = openRegisteredSparkWallet({
      walletId: WALLET.id,
      expectedNetwork: "mainnet",
      runExclusive: operations.run,
      listWallets: async () => wallets,
      resolveOpenInput: async () => {
        authenticationStarted.resolve(undefined)
        return password.promise
      },
      manager: state.manager,
      afterOpen: async () => {
        refreshStarted.resolve(undefined)
        await finishRefresh.promise
      },
    })
    await authenticationStarted.promise

    const removal = operations.run(WALLET.id, async () => {
      wallets = []
      await state.manager.close(WALLET.id)
    })
    expect(await isSettled(removal)).toBe(false)

    password.resolve({
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })
    await refreshStarted.promise
    expect(await isSettled(removal)).toBe(false)
    finishRefresh.resolve(undefined)
    await unlock
    await removal

    expect(state.openWallets.has(WALLET.id)).toBe(false)
    expect(state.closeCalls).toBe(1)
  })

  it("cleans an opened client when a delayed password unlock loses its exact registration", async () => {
    const operations = new SerializedWalletOperations()
    const password = deferred<{
      mnemonic: string
      accountNumber: number
    }>()
    const authenticationStarted = deferred<void>()
    const state = createLifecycleState()
    let wallets = [WALLET]
    let afterOpenCalls = 0
    let validatedCalls = 0

    const unlock = openRegisteredSparkWallet({
      walletId: WALLET.id,
      expectedNetwork: "mainnet",
      runExclusive: operations.run,
      listWallets: async () => wallets,
      resolveOpenInput: async () => {
        authenticationStarted.resolve(undefined)
        return password.promise
      },
      manager: state.manager,
      afterOpen: async () => {
        afterOpenCalls += 1
      },
      onValidated: () => {
        validatedCalls += 1
      },
    })
    await authenticationStarted.promise

    wallets = []
    password.resolve({
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await expect(unlock).rejects.toThrow(
      "Portable Wallet was removed while it was unlocking"
    )
    expect(state.openCalls).toBe(1)
    expect(state.closeCalls).toBe(1)
    expect(afterOpenCalls).toBe(0)
    expect(validatedCalls).toBe(0)
    expect(state.openWallets.has(WALLET.id)).toBe(false)
  })

  it("closes the opened client when post-open registration cannot be read", async () => {
    const operations = new SerializedWalletOperations()
    const state = createLifecycleState()
    let reads = 0

    await expect(
      openRegisteredSparkWallet({
        walletId: WALLET.id,
        expectedNetwork: "mainnet",
        runExclusive: operations.run,
        listWallets: async () => {
          reads += 1
          if (reads > 1) {
            throw new Error("registry temporarily unavailable")
          }
          return [WALLET]
        },
        manager: state.manager,
        resolveOpenInput: async () => ({
          mnemonic: "abandon ".repeat(11) + "about",
          accountNumber: 0,
        }),
      })
    ).rejects.toThrow(
      "Portable Wallet registration could not be verified after unlocking"
    )

    expect(state.openWallets.has(WALLET.id)).toBe(false)
    expect(state.closeCalls).toBe(1)
  })

  it("excludes a second tab until the open wallet session is closed", async () => {
    const operations = new SerializedWalletOperations()
    const sessionLocks = new MemorySessionLockManager()
    const disconnected: string[] = []
    const createManager = (tab: string) =>
      new SparkWalletManager(
        {
          network: "mainnet",
          async open() {
            return createSdkClient(() => disconnected.push(tab))
          },
        },
        (walletId, identityKey) =>
          acquireSparkWalletManagerSessionLease(
            walletId,
            identityKey,
            sessionLocks
          )
      )
    const managerA = createManager("tab-a")
    const managerB = createManager("tab-b")
    const resolveOpenInput = async () => ({
      mnemonic: "abandon ".repeat(11) + "about",
      accountNumber: 0,
    })

    await openRegisteredSparkWallet({
      walletId: WALLET.id,
      expectedNetwork: "mainnet",
      runExclusive: operations.run,
      listWallets: async () => [WALLET],
      resolveOpenInput,
      manager: managerA,
    })

    await expect(
      openRegisteredSparkWallet({
        walletId: WALLET.id,
        expectedNetwork: "mainnet",
        runExclusive: operations.run,
        listWallets: async () => [WALLET],
        resolveOpenInput,
        manager: managerB,
      })
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)
    expect(managerA.isOpen(WALLET.id)).toBe(true)
    expect(managerB.isOpen(WALLET.id)).toBe(false)
    expect(disconnected).toEqual([])

    await expect(
      cleanupSparkWalletState({
        walletId: WALLET.id,
        manager: managerB,
        verifySessionAvailable: (walletId) =>
          assertSparkWalletRegistrationSessionAvailable(walletId, sessionLocks),
      })
    ).rejects.toBeInstanceOf(SparkWalletSessionLeaseUnavailableError)
    expect(managerA.isOpen(WALLET.id)).toBe(true)

    await managerA.close(WALLET.id)
    await expect(
      openRegisteredSparkWallet({
        walletId: WALLET.id,
        expectedNetwork: "mainnet",
        runExclusive: operations.run,
        listWallets: async () => [WALLET],
        resolveOpenInput,
        manager: managerB,
      })
    ).resolves.toBeUndefined()

    expect(managerA.isOpen(WALLET.id)).toBe(false)
    expect(managerB.isOpen(WALLET.id)).toBe(true)
    expect(disconnected).toEqual(["tab-a"])

    await managerB.close(WALLET.id)
    expect(disconnected).toEqual(["tab-a", "tab-b"])
  })

  for (const [registeredNetwork, configuredNetwork] of [
    ["regtest", "mainnet"],
    ["mainnet", "regtest"],
  ] as const) {
    it(`rejects a ${registeredNetwork} registration before opening it on ${configuredNetwork}`, async () => {
      const state = createLifecycleState()
      let recoveryReads = 0

      await expect(
        openRegisteredSparkWallet({
          walletId: WALLET.id,
          expectedNetwork: configuredNetwork,
          listWallets: async () => [{ ...WALLET, network: registeredNetwork }],
          manager: state.manager,
          resolveOpenInput: async () => {
            recoveryReads += 1
            return {
              mnemonic: "abandon ".repeat(11) + "about",
              accountNumber: 0,
            }
          },
        })
      ).rejects.toThrow(
        `uses ${registeredNetwork}, but Market is using ${configuredNetwork}`
      )

      expect(recoveryReads).toBe(0)
      expect(state.openCalls).toBe(0)
      expect(state.closeCalls).toBe(0)
    })
  }
})

function createLifecycleState() {
  const openWallets = new Set<string>()
  const state = {
    openWallets,
    openCalls: 0,
    closeCalls: 0,
    manager: {
      async openWithMnemonic(input: {
        walletId: string
        mnemonic: string
        accountNumber: number
      }): Promise<void> {
        state.openCalls += 1
        openWallets.add(input.walletId)
      },
      async close(walletId: string): Promise<void> {
        state.closeCalls += 1
        openWallets.delete(walletId)
      },
    },
  }
  return state
}

class SerializedWalletOperations {
  readonly #tails = new Map<string, Promise<void>>()

  readonly run: SparkWalletOperationRunner = async <T>(
    walletId: string,
    operation: () => Promise<T>
  ) => {
    const previous = this.#tails.get(walletId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => hold)
    this.#tails.set(walletId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#tails.get(walletId) === tail) {
        this.#tails.delete(walletId)
      }
    }
  }
}

class MemorySessionLockManager implements SparkWalletSessionLockManager {
  readonly #held = new Set<string>()

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T> {
    if (this.#held.has(name)) {
      return callback(null)
    }
    this.#held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.#held.delete(name)
    }
  }
}

function createSdkClient(disconnect: () => void): SparkSdkClient {
  return {
    async disconnect() {
      disconnect()
    },
    async getInfo() {
      return { balanceSats: 0 }
    },
    async listPayments() {
      return { payments: [] }
    },
    async prepareSendPayment() {
      throw new Error("Not needed for this test.")
    },
    async sendPayment() {
      throw new Error("Not needed for this test.")
    },
    async receivePayment() {
      return { paymentRequest: "lnbc1test", fee: 0n }
    },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending")
  return (
    (await Promise.race([
      promise.then(() => true),
      Promise.resolve(pending),
    ])) !== pending
  )
}
