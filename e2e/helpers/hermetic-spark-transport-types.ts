import type {
  SparkNativeModule,
  SparkNativeWallet,
} from "../../apps/market/src/lib/spark-sdk"
import type { CheckoutSparkNativeRetirementReader } from "@conduit/core"

export const HERMETIC_SPARK_BINDING = "__conduitHermeticSparkNative"

export type WalletMethod = Exclude<
  keyof SparkNativeWallet,
  "on" | "off" | "cleanup" | "openRetirementReader"
>
export type ReaderMethod = keyof CheckoutSparkNativeRetirementReader

export type HermeticSparkRequest =
  | {
      type: "wallet.open"
      input: Parameters<SparkNativeModule["initialize"]>[0]
    }
  | {
      type: "wallet.call"
      handle: string
      method: WalletMethod
      args: unknown[]
    }
  | { type: "wallet.close"; handle: string }
  | { type: "reader.challenge"; identityPublicKey: string; network: string }
  | { type: "reader.open"; challengeId: string; signature: string }
  | {
      type: "reader.call"
      handle: string
      method: ReaderMethod
      args: unknown[]
    }
  | { type: "reader.close"; handle: string }

export type HermeticSparkRequestFn = (
  command: HermeticSparkRequest
) => Promise<unknown>
