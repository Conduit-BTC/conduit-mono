import { afterEach, describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey } from "nostr-tools/pure"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
  subscribeToAccountSignerChanges,
} from "@conduit/core"
import { plainTestSigner } from "./helpers/plain-signer"
import { generateSparkMnemonic } from "../apps/market/src/lib/spark-recovery"
import {
  openSignerSparkRecovery,
  sealSignerSparkRecovery,
  isWalletSignerCurrent,
} from "../apps/market/src/lib/signer-spark-recovery"
import {
  parseStoredSparkWalletRecovery,
  serializeStoredSparkWalletRecovery,
} from "../apps/market/src/lib/wallet-storage"
import {
  SparkWalletManager,
  type SparkSdkClient,
} from "../apps/market/src/lib/spark-wallet"

const binding = {
  walletId: "signer-wallet",
  providerId: "spark" as const,
  network: "mainnet" as const,
  accountNumber: 7,
}
let active: SessionSigner | undefined
function install(
  method: "nip07" | "nip46" = "nip07",
  provider = new NDKPrivateKeySigner(
    Buffer.from(generateSecretKey()).toString("hex")
  ),
  nip44 = true
) {
  const signer = new SessionSigner(plainTestSigner(provider), {
    expectedPubkey: provider.pubkey,
    revision: crypto.randomUUID(),
    authMethod: method,
    getCapabilities: () => ({ signEvent: true, nip44, nip04Decrypt: false }),
    hasAuthority: () => true,
  })
  activateAccountSigner(signer)
  active = signer
  return { signer, provider }
}
afterEach(() => {
  if (active) retireAccountSigner(active)
  active = undefined
})
for (const method of ["nip07", "nip46"] as const) {
  it(`${method} account boundary reopens ciphertext with a fresh session and no wallet password`, async () => {
    const { signer, provider } = install(method)
    const mnemonic = generateSparkMnemonic()
    const sealed = await sealSignerSparkRecovery(mnemonic, binding)
    expect(JSON.stringify(sealed)).not.toContain(mnemonic)
    expect(
      parseStoredSparkWalletRecovery(serializeStoredSparkWalletRecovery(sealed))
    ).toEqual(sealed)
    retireAccountSigner(signer)
    await expect(openSignerSparkRecovery(sealed, binding)).rejects.toThrow()
    install(method, provider)
    expect(await openSignerSparkRecovery(sealed, binding)).toBe(mnemonic)
    for (const changed of [
      { ...binding, walletId: "other" },
      { ...binding, accountNumber: 1 },
      { ...binding, network: "regtest" as const },
    ])
      await expect(openSignerSparkRecovery(sealed, changed)).rejects.toThrow(
        "does not match"
      )
    install(method)
    await expect(openSignerSparkRecovery(sealed, binding)).rejects.toThrow(
      "Nostr identity"
    )
  })
}

describe("wallet signer authority", () => {
  it("refuses signing-only providers before creating any wallet credentials", async () => {
    install("nip07", undefined, false)
    await expect(
      sealSignerSparkRecovery(generateSparkMnemonic(), binding)
    ).rejects.toThrow("NIP-44")
  })
  it("refuses failed encryption round trips", async () => {
    const { signer } = install()
    signer.decryptNip44 = async () => "{}"
    await expect(
      sealSignerSparkRecovery(generateSparkMnemonic(), binding)
    ).rejects.toThrow("does not match")
  })
  it("fences an account switch while encryption is pending", async () => {
    const { signer } = install()
    const encrypt = signer.encryptNip44.bind(signer)
    signer.encryptNip44 = async (peer, value) => {
      const result = await encrypt(peer, value)
      install()
      return result
    }
    await expect(
      sealSignerSparkRecovery(generateSparkMnemonic(), binding, signer)
    ).rejects.toThrow("sign-in changed")
  })
  it("closes signer-owned sessions on revocation even without a mounted wallet page", async () => {
    const { signer } = install()
    let disconnects = 0
    const client = {
      disconnect: async () => {
        disconnects++
      },
      getInfo: async () => ({ balanceSats: 0 }),
    } as SparkSdkClient
    const manager = new SparkWalletManager(
      { network: "mainnet", open: async () => client },
      async () => ({ release: async () => {} })
    )
    await manager.openWithMnemonic({
      walletId: binding.walletId,
      mnemonic: generateSparkMnemonic(),
      accountNumber: binding.accountNumber,
      shouldContinue: () => isWalletSignerCurrent(signer),
      subscribeRevocation: (listener) =>
        subscribeToAccountSignerChanges(() => {
          if (!isWalletSignerCurrent(signer)) listener()
        }),
    })
    expect(manager.isOpen(binding.walletId)).toBe(true)
    retireAccountSigner(signer)
    expect(manager.isOpen(binding.walletId)).toBe(false)
    await expect(manager.getBalance(binding.walletId)).rejects.toThrow("locked")
    await manager.close(binding.walletId)
    expect(disconnects).toBeGreaterThan(0)
  })
  it("refuses to attach a wallet initialized after its account was revoked", async () => {
    const { signer } = install()
    let disconnected = false
    const client = {
      disconnect: async () => {
        disconnected = true
      },
    } as SparkSdkClient
    const manager = new SparkWalletManager(
      {
        network: "mainnet",
        open: async () => {
          retireAccountSigner(signer)
          return client
        },
      },
      async () => ({ release: async () => {} })
    )
    await expect(
      manager.openWithMnemonic({
        walletId: binding.walletId,
        mnemonic: generateSparkMnemonic(),
        accountNumber: 7,
        shouldContinue: () => isWalletSignerCurrent(signer),
      })
    ).rejects.toThrow("sign-in changed")
    expect(disconnected).toBe(true)
    expect(manager.isOpen(binding.walletId)).toBe(false)
  })
})

it("retains a verified legacy encrypted copy as a same-account migration fallback", async () => {
  const { encryptSparkMnemonic } =
    await import("../apps/market/src/lib/spark-recovery")
  const { recoverStoredSparkMnemonic } =
    await import("../apps/market/src/lib/signer-spark-recovery")
  const { signer, provider } = install()
  const mnemonic = generateSparkMnemonic()
  const password = crypto.randomUUID()
  const legacyRecovery = {
    ...binding,
    type: "password" as const,
    recovery: await encryptSparkMnemonic(mnemonic, password, binding, {
      iterations: 100000,
    }),
  }
  const migrated = {
    ...(await sealSignerSparkRecovery(mnemonic, binding, signer)),
    legacyRecovery,
  }
  const saved = parseStoredSparkWalletRecovery(
    serializeStoredSparkWalletRecovery(migrated)
  )!
  expect(saved).toEqual(migrated)
  install("nip07", provider, false)
  expect(
    (await recoverStoredSparkMnemonic(saved, binding, password)).mnemonic
  ).toBe(mnemonic)
  install()
  await expect(
    recoverStoredSparkMnemonic(saved, binding, password)
  ).rejects.toThrow("Nostr identity")
})
