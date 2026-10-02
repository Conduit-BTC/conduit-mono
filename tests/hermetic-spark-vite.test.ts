import { expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  createHermeticSparkVitePlugin,
  HERMETIC_SPARK_SDK_VERSION,
} from "../e2e/helpers/hermetic-spark-vite"

it("explicitly aligns the hermetic SDK adapter with both app dependency pins", async () => {
  for (const app of ["market", "merchant"]) {
    const manifest = await Bun.file(`apps/${app}/package.json`).json()
    expect(manifest.dependencies["@buildonspark/spark-sdk"]).toBe(
      HERMETIC_SPARK_SDK_VERSION
    )
    expect(() =>
      createHermeticSparkVitePlugin(
        fileURLToPath(new URL(`../apps/${app}/`, import.meta.url))
      )
    ).not.toThrow()
  }
})

it("replaces only the SDK root and retains the real pure protobuf subpath", () => {
  const plugin = createHermeticSparkVitePlugin(
    fileURLToPath(new URL("../apps/market/", import.meta.url))
  )
  expect(plugin.resolveId("@buildonspark/spark-sdk")).toBeTruthy()
  expect(
    plugin.resolveId("@buildonspark/spark-sdk/proto/spark")
  ).toBeUndefined()
  expect(
    plugin.resolveId("../lib/checkout-spark-settled-recovery")
  ).toBeUndefined()
})

it("links the pinned pure SDK as self-contained browser ESM without app crypto resolution", async () => {
  const plugin = createHermeticSparkVitePlugin(
    fileURLToPath(new URL("../apps/market/", import.meta.url))
  )
  const code = await plugin.load(
    plugin.resolveId("virtual:conduit-hermetic-spark-pure")!
  )!
  // A blob module has no package-relative resolution. Linking it exercises the
  // complete pure graph instead of Bun silently resolving a missing browser
  // export against the SDK's dependency tree.
  const moduleUrl = URL.createObjectURL(
    new Blob([code!], { type: "text/javascript" })
  )
  const module = await import(moduleUrl)
    .catch(() => {
      throw new Error("The isolated pure SDK browser module did not link")
    })
    .finally(() => URL.revokeObjectURL(moduleUrl))
  expect(Object.keys(module).sort()).toEqual(
    [
      "DefaultSparkSigner",
      "UUID",
      "SparkWalletEvent",
      "SparkValidationError",
      "Network",
      "NetworkToProto",
      "parseCompressedPublicKeyHex",
      "manifestGrossSats",
      "manifestNetSatsFor",
      "manifestFeeSats",
      "ReceiveQuoteAmountBasis",
      "decodeSparkAddress",
      "getNetworkFromSparkAddress",
      "isValidSparkAddress",
    ].sort()
  )
  const signer = new module.DefaultSparkSigner()
  const seed = new Uint8Array(64).fill(1)
  try {
    await signer.createSparkWalletFromSeed(seed, 0)
    expect((await signer.getIdentityPublicKey()).length).toBe(33)
  } finally {
    seed.fill(0)
  }
  expect(
    module.UUID.parse("01234567-89ab-7def-8123-456789abcdef").toString()
  ).toBe("01234567-89ab-7def-8123-456789abcdef")
})

it("permits only isolated loopback serve mode with both router flags", () => {
  const plugin = createHermeticSparkVitePlugin(
    fileURLToPath(new URL("../apps/merchant/", import.meta.url))
  )
  const config = {
    command: "serve" as const,
    mode: "mock",
    isProduction: false,
    server: { host: "127.0.0.1", port: 7101, strictPort: true },
    env: {
      BASE_URL: "/",
      MODE: "mock",
      DEV: true,
      PROD: false,
      VITE_LIGHTNING_NETWORK: "mock",
      VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY: "true",
      VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL: "true",
    },
  }
  expect(() => plugin.configResolved(config)).not.toThrow()
  expect(() => plugin.configResolved({ ...config, command: "build" })).toThrow()
  expect(() =>
    plugin.configResolved({ ...config, mode: "production" })
  ).toThrow()
  expect(() =>
    plugin.configResolved({ ...config, isProduction: true })
  ).toThrow()
  expect(() =>
    plugin.configResolved({
      ...config,
      server: { ...config.server, host: "0.0.0.0" },
    })
  ).toThrow()
  expect(() =>
    plugin.configResolved({
      ...config,
      server: { ...config.server, port: 3001 },
    })
  ).toThrow()
  expect(() =>
    plugin.configResolved({
      ...config,
      server: { ...config.server, strictPort: false },
    })
  ).toThrow()
  for (const name of [
    "VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY",
    "VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL",
  ]) {
    expect(() =>
      plugin.configResolved({
        ...config,
        env: { ...config.env, [name]: "false" },
      })
    ).toThrow()
  }
  expect(() =>
    plugin.configResolved({
      ...config,
      env: { ...config.env, VITE_LIGHTNING_NETWORK: "mainnet" },
    })
  ).toThrow()
})
