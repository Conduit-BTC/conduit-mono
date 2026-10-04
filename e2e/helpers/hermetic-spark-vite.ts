import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HERMETIC_SPARK_BINDING } from "./hermetic-spark-transport-types"

const rootId = "\0conduit:hermetic-spark-sdk"
const pureId = "\0conduit:hermetic-spark-pure"
const pureImport = "virtual:conduit-hermetic-spark-pure"
export const HERMETIC_SPARK_SDK_VERSION = "0.12.1"
const pureExports = [
  ["DefaultSparkSigner", "signer/signer.ts"],
  ["UUID", "utils/transfer-id.ts"],
  ["SparkWalletEvent", "spark-wallet/types.ts"],
  ["SparkValidationError", "errors/types.ts"],
  ["Network, NetworkToProto", "utils/network.ts"],
  ["parseCompressedPublicKeyHex", "utils/keys.ts"],
  [
    "manifestGrossSats, manifestNetSatsFor, manifestFeeSats, ReceiveQuoteAmountBasis",
    "utils/receive-quote.ts",
  ],
  [
    "encodeSparkAddress, decodeSparkAddress, getNetworkFromSparkAddress, isValidSparkAddress",
    "utils/address.ts",
  ],
] as const

function modulePath(path: string) {
  return `/@fs/${path.replace(/\\/g, "/")}`
}

/** Only dedicated local E2E configs install this external-SDK replacement. */
export function createHermeticSparkVitePlugin(appDir: string) {
  const sdkEntry = createRequire(resolve(appDir, "package.json")).resolve(
    "@buildonspark/spark-sdk"
  )
  const sdkDir = dirname(dirname(sdkEntry))
  const metadata = JSON.parse(
    readFileSync(resolve(sdkDir, "package.json"), "utf8")
  ) as { version?: string }
  if (metadata.version !== HERMETIC_SPARK_SDK_VERSION)
    throw new Error("Hermetic Spark facade requires the pinned SDK version")
  const facade = modulePath(
    fileURLToPath(new URL("./hermetic-spark-sdk-facade.ts", import.meta.url))
  )
  let pureBundle: Promise<string> | undefined
  async function bundlePureSdk(): Promise<string> {
    // Resolve the bundler already installed with this app's Vite. Bundling the
    // explicit pure entry preserves SDK-local Noble versions; serving its TS
    // files separately lets Vite reuse the app's incompatible bare-import
    // prebundle. No SDK wallet class or provider entry is imported here.
    const viteEntry = createRequire(resolve(appDir, "package.json")).resolve(
      "vite"
    )
    const bundlerPath = createRequire(viteEntry).resolve("rolldown")
    const { rolldown } = await import(pathToFileURL(bundlerPath).href)
    const bundle = await rolldown({
      input: pureId,
      platform: "browser",
      plugins: [
        {
          name: "conduit-hermetic-spark-pure-entry",
          resolveId(source: string) {
            return source === pureId ? pureId : undefined
          },
          load(id: string) {
            if (id !== pureId) return undefined
            return pureExports
              .map(
                ([names, path]) =>
                  `export { ${names} } from ${JSON.stringify(resolve(sdkDir, "src", path).replace(/\\/g, "/"))};`
              )
              .join("\n")
          },
        },
      ],
    })
    try {
      const result = await bundle.generate({
        format: "esm",
        codeSplitting: false,
      })
      const output = result.output as Array<{
        type: string
        code?: string
        imports?: string[]
        dynamicImports?: string[]
        modules?: Record<string, unknown>
      }>
      const chunk = output[0]
      if (
        output.length !== 1 ||
        chunk?.type !== "chunk" ||
        !chunk.code ||
        chunk.imports?.length ||
        chunk.dynamicImports?.length
      ) {
        throw new Error(
          "The isolated pure SDK must be one self-contained module"
        )
      }
      if (
        Object.keys(chunk.modules ?? {}).some((id) =>
          /\/spark-sdk\/src\/(?:spark-wallet\/(?!types\.ts$)|services\/|index[^/]*\.)/.test(
            id.replace(/\\/g, "/")
          )
        )
      ) {
        throw new Error(
          "The isolated pure SDK must not include a native wallet entry"
        )
      }
      return chunk.code
    } finally {
      await bundle.close()
    }
  }
  return {
    name: "conduit-hermetic-spark-sdk",
    enforce: "pre" as const,
    config() {
      return { optimizeDeps: { exclude: ["@buildonspark/spark-sdk"] } }
    },
    configResolved(config: {
      command: "serve" | "build"
      mode: string
      isProduction: boolean
      server: { host?: string | boolean; port?: number; strictPort?: boolean }
      env: Record<string, unknown>
    }) {
      if (
        config.command !== "serve" ||
        config.mode !== "mock" ||
        config.isProduction ||
        !["127.0.0.1", "::1"].includes(String(config.server.host)) ||
        !config.server.strictPort ||
        !config.server.port ||
        [3000, 3001, 3002].includes(config.server.port) ||
        config.env.VITE_LIGHTNING_NETWORK !== "mock" ||
        config.env.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY !== "true" ||
        config.env.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL !== "true"
      ) {
        throw new Error(
          "Hermetic Spark facade requires the isolated loopback router test configuration"
        )
      }
    },
    resolveId(source: string) {
      if (source === "@buildonspark/spark-sdk") return rootId
      if (source === pureImport) return pureId
      return undefined
    },
    load(id: string) {
      if (id === pureId) {
        return (pureBundle ??= bundlePureSdk())
      }
      if (id !== rootId) return undefined
      return `
import { createHermeticSparkSdkFacade } from ${JSON.stringify(facade)};
import * as pureSdk from ${JSON.stringify(pureImport)};
const sdk = createHermeticSparkSdkFacade({ pureSdk, request(command) {
  const binding = globalThis[${JSON.stringify(HERMETIC_SPARK_BINDING)}];
  if (typeof window === "undefined" || window.location.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(window.location.hostname) ||
      !window.location.port || ["3000", "3001", "3002"].includes(window.location.port) ||
      typeof binding !== "function") throw new Error("Hermetic Spark SDK transport unavailable");
  return binding(command);
} });
export const { SparkWallet, SparkReadonlyClient, DefaultSparkSigner, UUID,
  SparkWalletEvent, SparkValidationError, Network, NetworkToProto,
  parseCompressedPublicKeyHex, manifestGrossSats, manifestNetSatsFor,
  manifestFeeSats, ReceiveQuoteAmountBasis, decodeSparkAddress, encodeSparkAddress,
  getNetworkFromSparkAddress, isValidSparkAddress } = sdk;
`
    },
  }
}
