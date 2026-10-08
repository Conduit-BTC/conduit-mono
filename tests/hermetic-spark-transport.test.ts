import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import type { BrowserContext } from "@playwright/test"
import { DefaultSparkSigner } from "../apps/market/node_modules/@buildonspark/spark-sdk/src/signer/signer"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import {
  createHermeticSparkTransport,
  installHermeticSparkTransport,
} from "../e2e/helpers/hermetic-spark-transport"

const MNEMONIC = createRuntimeMnemonic()

async function signerFor(accountNumber: number) {
  const signer = new DefaultSparkSigner()
  const seed = await signer.mnemonicToSeed(MNEMONIC)
  try {
    await signer.createSparkWalletFromSeed(seed, accountNumber)
  } finally {
    seed.fill(0)
  }
  return signer
}

function createTransportFixture() {
  const fixture = createHermeticSparkNative({
    async deriveIdentity(mnemonic, accountNumber) {
      const signer = new DefaultSparkSigner()
      const seed = await signer.mnemonicToSeed(mnemonic)
      try {
        return await signer.createSparkWalletFromSeed(seed, accountNumber)
      } finally {
        seed.fill(0)
      }
    },
    async issueFundingInvoice() {
      throw new Error("This test does not issue invoices")
    },
  })
  return { fixture, transport: createHermeticSparkTransport(fixture) }
}

function createTransport() {
  return createTransportFixture().transport
}

it("opens a credential-authenticated native wallet through the test transport", async () => {
  const transport = createTransport()
  try {
    const opened = (await transport.request({
      type: "wallet.open",
      input: {
        mnemonicOrSeed: MNEMONIC,
        accountNumber: 0,
        options: { network: "REGTEST", log: false },
      },
    })) as { handle: string }
    const expected = await signerFor(0)
    const identity = await transport.request({
      type: "wallet.call",
      handle: opened.handle,
      method: "getIdentityPublicKey",
      args: [],
    })
    expect(
      identity ===
        Buffer.from(await expected.getIdentityPublicKey()).toString("hex")
    ).toBe(true)
    expect(
      await transport.request({
        type: "wallet.call",
        handle: opened.handle,
        method: "getBalance",
        args: [],
      })
    ).toMatchObject({ balance: 0n })
    await transport.request({ type: "wallet.close", handle: opened.handle })
    await expect(
      transport.request({
        type: "wallet.call",
        handle: opened.handle,
        method: "getBalance",
        args: [],
      })
    ).rejects.toThrow("unavailable")
  } finally {
    await transport.close()
  }
})

it("opens a readonly handle only after a one-use proof by the exact initialized signer", async () => {
  const transport = createTransport()
  try {
    const { handle } = (await transport.request({
      type: "wallet.open",
      input: {
        mnemonicOrSeed: MNEMONIC,
        accountNumber: 0,
        options: { network: "REGTEST", log: false },
      },
    })) as { handle: string }
    const signer = await signerFor(0)
    const identityPublicKey = Buffer.from(
      await signer.getIdentityPublicKey()
    ).toString("hex")
    const challenge = (await transport.request({
      type: "reader.challenge",
      identityPublicKey,
      network: "REGTEST",
    })) as { challengeId: string; digest: string }
    const signature = Buffer.from(
      await signer.signSchnorrWithIdentityKey(
        Buffer.from(challenge.digest, "hex")
      )
    ).toString("hex")
    const reader = (await transport.request({
      type: "reader.open",
      challengeId: challenge.challengeId,
      signature,
    })) as { handle: string; sparkAddress: string }
    await transport.request({ type: "wallet.close", handle })
    expect(
      await transport.request({
        type: "reader.call",
        handle: reader.handle,
        method: "getOwnedBalance",
        args: [reader.sparkAddress],
      })
    ).toBe(0n)
    await expect(
      transport.request({
        type: "reader.open",
        challengeId: challenge.challengeId,
        signature,
      })
    ).rejects.toThrow("unavailable")
    const other = await signerFor(1)
    const denied = (await transport.request({
      type: "reader.challenge",
      identityPublicKey,
      network: "REGTEST",
    })) as { challengeId: string; digest: string }
    const wrongSignature = Buffer.from(
      await other.signSchnorrWithIdentityKey(Buffer.from(denied.digest, "hex"))
    ).toString("hex")
    await expect(
      transport.request({
        type: "reader.open",
        challengeId: denied.challengeId,
        signature: wrongSignature,
      })
    ).rejects.toThrow("unavailable")
    await transport.request({ type: "reader.close", handle: reader.handle })
    await expect(
      transport.request({
        type: "reader.call",
        handle: reader.handle,
        method: "getOwnedBalance",
        args: [reader.sparkAddress],
      })
    ).rejects.toThrow("unavailable")
  } finally {
    await transport.close()
  }
})

it("rejects mainnet and never exposes runner funding controls over native RPC", async () => {
  const transport = createTransport()
  try {
    await expect(
      transport.request({
        type: "wallet.open",
        input: {
          mnemonicOrSeed: MNEMONIC,
          accountNumber: 0,
          options: { network: "MAINNET", log: false },
        },
      })
    ).rejects.toThrow("unavailable")
    await expect(
      transport.request({
        type: "reader.challenge",
        identityPublicKey: "not-authenticated",
        network: "MAINNET",
      })
    ).rejects.toThrow("unavailable")
    const { handle } = (await transport.request({
      type: "wallet.open",
      input: {
        mnemonicOrSeed: MNEMONIC,
        accountNumber: 0,
        options: { network: "REGTEST", log: false },
      },
    })) as { handle: string }
    await expect(
      transport.request({
        type: "wallet.call",
        handle,
        method: "completeFunding",
        args: [],
      } as unknown as Parameters<typeof transport.request>[0])
    ).rejects.toThrow("unavailable")
    expect(
      await transport.request({
        type: "wallet.call",
        handle,
        method: "getBalance",
        args: [],
      })
    ).toMatchObject({ balance: 0n })
  } finally {
    await transport.close()
  }
})

it("authenticates a distinct exact-query session without opening an RPC wallet or gaining write capabilities", async () => {
  const { fixture, transport } = createTransportFixture()
  // Populate only the independent runner registry; the observation path cannot
  // submit a mnemonic or initialize/register native accounts over browser RPC.
  const { wallet } = await fixture.module.initialize({
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST", log: false },
  })
  const identityPublicKey = await wallet.getIdentityPublicKey()
  await wallet.cleanup()
  const before = fixture.control.forIdentity(identityPublicKey).snapshot()
  const signer = await signerFor(0)
  const challenge = (await transport.request({
    type: "observation.challenge",
    identityPublicKey,
    network: "REGTEST",
  })) as { challengeId: string; digest: string }
  const signature = Buffer.from(
    await signer.signMessageWithIdentityKey(
      Buffer.from(challenge.digest, "hex")
    )
  ).toString("hex")
  try {
    await expect(
      transport.request({
        type: "reader.open",
        challengeId: challenge.challengeId,
        signature,
      })
    ).rejects.toThrow("unavailable")
    const { handle } = (await transport.request({
      type: "observation.open",
      challengeId: challenge.challengeId,
      signature,
    })) as { handle: string }
    expect(
      await transport.request({
        type: "observation.call",
        handle,
        method: "getIdentityPublicKey",
        args: [],
      })
    ).toBe(identityPublicKey)
    expect(
      await transport.request({
        type: "observation.call",
        handle,
        method: "getLightningReceiveRequest",
        args: ["unknown-exact-request"],
      })
    ).toBeNull()
    for (const method of [
      "initialize",
      "syncWallet",
      "claimTransfer",
      "setPrivacyEnabled",
      "getBalance",
      "getTransfers",
      "getLeaves",
      "createLightningInvoice",
      "payLightningInvoice",
      "transfer",
      "fulfillSparkInvoice",
    ]) {
      await expect(
        transport.request({
          type: "observation.call",
          handle,
          method,
          args: [],
        } as unknown as Parameters<typeof transport.request>[0])
      ).rejects.toThrow("unavailable")
    }
    await expect(
      transport.request({
        type: "wallet.call",
        handle,
        method: "getIdentityPublicKey",
        args: [],
      })
    ).rejects.toThrow("unavailable")
    await expect(
      transport.request({
        type: "observation.call",
        handle,
        method: "getTransfer",
        args: [],
      })
    ).rejects.toThrow("unavailable")
    await expect(
      transport.request({
        type: "observation.open",
        challengeId: challenge.challengeId,
        signature,
      })
    ).rejects.toThrow("unavailable")
    const denied = (await transport.request({
      type: "observation.challenge",
      identityPublicKey,
      network: "REGTEST",
    })) as { challengeId: string; digest: string }
    const other = await signerFor(1)
    await expect(
      transport.request({
        type: "observation.open",
        challengeId: denied.challengeId,
        signature: Buffer.from(
          await other.signMessageWithIdentityKey(
            Buffer.from(denied.digest, "hex")
          )
        ).toString("hex"),
      })
    ).rejects.toThrow("unavailable")
    await transport.request({ type: "observation.close", handle })
    await expect(
      transport.request({
        type: "observation.call",
        handle,
        method: "getIdentityPublicKey",
        args: [],
      })
    ).rejects.toThrow("unavailable")
    expect(fixture.control.forIdentity(identityPublicKey).snapshot()).toEqual(
      before
    )
  } finally {
    await transport.close()
  }
})

it("installs native RPC for only the exact isolated app main frame", async () => {
  const transport = createTransport()
  let handler: Parameters<BrowserContext["exposeBinding"]>[1] | undefined
  const context: Pick<BrowserContext, "exposeBinding"> = {
    async exposeBinding(_name, callback) {
      handler = callback
    },
  }
  const source = (url: string, child = false) =>
    ({
      frame: { url: () => url, parentFrame: () => (child ? {} : null) },
    }) as unknown as Parameters<NonNullable<typeof handler>>[0]
  const request = {
    type: "wallet.open",
    input: {
      mnemonicOrSeed: MNEMONIC,
      accountNumber: 0,
      options: { network: "REGTEST", log: false },
    },
  }
  try {
    await expect(
      installHermeticSparkTransport(context, transport, {
        appUrl: "http://127.0.0.1:3000",
      })
    ).rejects.toThrow("unavailable")
    expect(handler).toBeUndefined()
    await installHermeticSparkTransport(context, transport, {
      appUrl: "http://127.0.0.1:7100",
    })
    await expect(
      handler!(source("http://127.0.0.1:7101/checkout"), request)
    ).rejects.toThrow("unavailable")
    await expect(
      handler!(source("https://example.com/checkout"), request)
    ).rejects.toThrow("unavailable")
    await expect(
      handler!(source("http://127.0.0.1:7100/checkout", true), request)
    ).rejects.toThrow("unavailable")
    expect(
      await handler!(source("http://127.0.0.1:7100/checkout"), request)
    ).toHaveProperty("handle")
  } finally {
    await transport.close()
  }
})
