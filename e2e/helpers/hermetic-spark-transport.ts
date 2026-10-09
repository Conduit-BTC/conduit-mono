import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  schnorr,
  secp256k1,
} from "../../packages/core/node_modules/@noble/curves/secp256k1.js"
import type { BrowserContext } from "@playwright/test"
import type { SparkNativeWallet } from "../../apps/market/src/lib/spark-sdk"
import type { CheckoutSparkNativeRetirementReader } from "@conduit/core"
import type { createHermeticSparkNative } from "./hermetic-spark-native"
import type {
  HermeticSparkRequest,
  WalletMethod,
} from "./hermetic-spark-transport-types"
import {
  HERMETIC_SPARK_BINDING,
  OBSERVATION_METHODS,
} from "./hermetic-spark-transport-types"

const walletMethods = new Set<WalletMethod>([
  "setPrivacyEnabled",
  "getWalletSettings",
  "getBalance",
  "getTransfers",
  "getSparkAddress",
  "getTransfer",
  "querySparkInvoices",
  "fulfillSparkInvoice",
  "getTransferFromSsp",
  "queryHTLC",
  "getLeaves",
  "createLightningInvoice",
  "getIdentityPublicKey",
  "getLightningReceiveRequest",
  "getLightningSendFeeEstimate",
  "payLightningInvoice",
  "getLightningSendRequest",
])

function unavailable(): never {
  throw new Error("Hermetic Spark transport unavailable")
}

function serializeParticipant(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw
  const participant = raw as { identityPublicKey?: unknown }
  return participant.identityPublicKey instanceof Uint8Array
    ? { ...participant, identityPublicKey: [...participant.identityPublicKey] }
    : raw
}

/** Runner-owned native sessions only; never receives application proof records. */
export function createHermeticSparkTransport(
  fixture: ReturnType<typeof createHermeticSparkNative>
) {
  const wallets = new Map<string, SparkNativeWallet>()
  const credentials = new Map<
    string,
    { mnemonic: string; accountNumber: number; network: "regtest" }
  >()
  const challenges = new Map<
    string,
    { identityPublicKey: string; digest: Uint8Array; expiresAt: number }
  >()
  const readers = new Map<
    string,
    Awaited<ReturnType<typeof fixture.openAuthenticatedRetirementReader>>
  >()
  const observationChallenges = new Map<
    string,
    { identityPublicKey: string; digest: Uint8Array; expiresAt: number }
  >()
  const observations = new Map<
    string,
    ReturnType<typeof fixture.openAuthenticatedObservation>
  >()
  const observationMethods = new Set<string>(OBSERVATION_METHODS)
  const readerMethods = new Set([
    "getTransfers",
    "getPendingTransfers",
    "getAvailableBalance",
    "getOwnedBalance",
  ])
  let closed = false
  return {
    async request(command: HermeticSparkRequest): Promise<unknown> {
      try {
        if (closed || !command || typeof command !== "object") unavailable()
        switch (command.type) {
          case "wallet.open": {
            if (
              command.input?.options?.network !== "REGTEST" ||
              command.input.options.log !== false
            )
              unavailable()
            const { wallet } = await fixture.module.initialize(command.input)
            const identity = await wallet.getIdentityPublicKey()
            if (closed) {
              await wallet.cleanup()
              unavailable()
            }
            credentials.set(identity, {
              mnemonic: command.input.mnemonicOrSeed,
              accountNumber: command.input.accountNumber,
              network: "regtest",
            })
            const handle = randomUUID()
            wallets.set(handle, wallet)
            return { handle }
          }
          case "wallet.call": {
            const wallet = wallets.get(command.handle)
            if (
              !wallet ||
              !walletMethods.has(command.method) ||
              !Array.isArray(command.args)
            )
              unavailable()
            if (command.method === "payLightningInvoice") {
              const [request] = command.args as [{ transferId?: string }]
              if (!request || typeof request.transferId !== "string")
                unavailable()
              return await Reflect.apply(wallet[command.method], wallet, [
                {
                  ...request,
                  transferId: fixture.module.parseTransferId(
                    request.transferId
                  ),
                },
              ])
            }
            if (command.method === "fulfillSparkInvoice") {
              const [invoices] = command.args as [
                Array<{ invoice: string; amount: string }>,
              ]
              if (
                !Array.isArray(invoices) ||
                invoices.length !== 1 ||
                invoices.some(
                  (item) =>
                    typeof item?.invoice !== "string" ||
                    typeof item.amount !== "string" ||
                    !/^[1-9][0-9]*$/.test(item.amount)
                )
              )
                unavailable()
              return await wallet.fulfillSparkInvoice!([
                {
                  invoice: invoices[0]!.invoice,
                  amount: BigInt(invoices[0]!.amount),
                },
              ])
            }
            if (command.method === "querySparkInvoices") {
              const result = await wallet.querySparkInvoices!(
                command.args[0] as string[]
              )
              return {
                ...result,
                invoiceStatuses: result.invoiceStatuses.map((entry) => ({
                  ...entry,
                  ...(entry.transferType?.$case === "satsTransfer"
                    ? {
                        transferType: {
                          $case: "satsTransfer",
                          satsTransfer: {
                            transferId: [
                              ...entry.transferType.satsTransfer.transferId,
                            ],
                          },
                        },
                      }
                    : {}),
                })),
              }
            }
            const method = wallet[command.method]
            if (typeof method !== "function") unavailable()
            return await Reflect.apply(method, wallet, command.args)
          }
          case "wallet.close": {
            const wallet = wallets.get(command.handle)
            wallets.delete(command.handle)
            await wallet?.cleanup()
            return null
          }
          case "reader.challenge": {
            if (
              command.network !== "REGTEST" ||
              !credentials.has(command.identityPublicKey)
            )
              unavailable()
            for (const [id, challenge] of challenges) {
              if (challenge.expiresAt <= Date.now()) challenges.delete(id)
            }
            if (challenges.size >= 128) unavailable()
            const challengeId = randomUUID()
            const digest = createHash("sha256")
              .update("conduit-hermetic-spark-reader-v1:REGTEST:")
              .update(command.identityPublicKey)
              .update(randomBytes(32))
              .digest()
            challenges.set(challengeId, {
              identityPublicKey: command.identityPublicKey,
              digest,
              expiresAt: Date.now() + 30_000,
            })
            return { challengeId, digest: digest.toString("hex") }
          }
          case "reader.open": {
            const challenge = challenges.get(command.challengeId)
            challenges.delete(command.challengeId)
            if (
              !challenge ||
              challenge.expiresAt <= Date.now() ||
              !/^[0-9a-f]{128}$/.test(command.signature) ||
              !schnorr.verify(
                Buffer.from(command.signature, "hex"),
                challenge.digest,
                Buffer.from(challenge.identityPublicKey.slice(2), "hex")
              )
            )
              unavailable()
            const credential = credentials.get(challenge.identityPublicKey)
            if (!credential) unavailable()
            const reader =
              await fixture.openAuthenticatedRetirementReader(credential)
            if (closed) {
              await reader.cleanup()
              unavailable()
            }
            const handle = randomUUID()
            readers.set(handle, reader)
            return { handle, sparkAddress: reader.sparkAddress }
          }
          case "reader.call": {
            const opened = readers.get(command.handle)
            if (
              !opened ||
              !readerMethods.has(command.method) ||
              !Array.isArray(command.args)
            )
              unavailable()
            const method = opened.reader[command.method]
            if (typeof method !== "function") unavailable()
            const result = await Reflect.apply(
              method,
              opened.reader,
              command.args
            )
            if (command.method !== "getTransfers") return result
            const page = result as Awaited<
              ReturnType<CheckoutSparkNativeRetirementReader["getTransfers"]>
            >
            return {
              ...page,
              transfers: page.transfers.map((transfer) => ({
                ...transfer,
                ...(Array.isArray(transfer.senders)
                  ? { senders: transfer.senders.map(serializeParticipant) }
                  : {}),
                ...(Array.isArray(transfer.receivers)
                  ? { receivers: transfer.receivers.map(serializeParticipant) }
                  : {}),
              })),
            }
          }
          case "reader.close": {
            const reader = readers.get(command.handle)
            readers.delete(command.handle)
            await reader?.cleanup()
            return null
          }
          case "observation.challenge": {
            if (
              command.network !== "REGTEST" ||
              !/^(02|03)[0-9a-f]{64}$/.test(command.identityPublicKey)
            )
              unavailable()
            // Only independently registered native data can be queried. The
            // browser supplies identity proof, never application ledger facts.
            fixture.control.forIdentity(command.identityPublicKey)
            for (const [id, challenge] of observationChallenges) {
              if (challenge.expiresAt <= Date.now())
                observationChallenges.delete(id)
            }
            if (observationChallenges.size >= 128) unavailable()
            const challengeId = randomUUID()
            const digest = createHash("sha256")
              .update("conduit-hermetic-spark-observation-v1:REGTEST:")
              .update(command.identityPublicKey)
              .update(randomBytes(32))
              .digest()
            observationChallenges.set(challengeId, {
              identityPublicKey: command.identityPublicKey,
              digest,
              expiresAt: Date.now() + 30_000,
            })
            return { challengeId, digest: digest.toString("hex") }
          }
          case "observation.open": {
            const challenge = observationChallenges.get(command.challengeId)
            observationChallenges.delete(command.challengeId)
            if (
              !challenge ||
              challenge.expiresAt <= Date.now() ||
              // Canonical DER integers are variable-width; verification, not a
              // near-fixed signature length, establishes signer possession.
              !/^[0-9a-f]{16,144}$/.test(command.signature) ||
              command.signature.length % 2 !== 0 ||
              !secp256k1.verify(
                Buffer.from(command.signature, "hex"),
                challenge.digest,
                Buffer.from(challenge.identityPublicKey, "hex"),
                { format: "der", prehash: false }
              ) ||
              observations.size >= 128
            )
              unavailable()
            const observation = fixture.openAuthenticatedObservation({
              identityPublicKey: challenge.identityPublicKey,
              network: "regtest",
            })
            if (closed) {
              await observation.cleanup()
              unavailable()
            }
            const handle = randomUUID()
            observations.set(handle, observation)
            return { handle }
          }
          case "observation.call": {
            const observation = observations.get(command.handle)
            if (
              !observation ||
              !observationMethods.has(command.method) ||
              !Array.isArray(command.args) ||
              (command.method === "getIdentityPublicKey"
                ? command.args.length !== 0
                : command.args.length !== 1 ||
                  typeof command.args[0] !== "string" ||
                  command.args[0].length === 0 ||
                  command.args[0].length > 1_024)
            )
              unavailable()
            return await Reflect.apply(
              observation[command.method],
              observation,
              command.args
            )
          }
          case "observation.close": {
            const observation = observations.get(command.handle)
            observations.delete(command.handle)
            await observation?.cleanup()
            return null
          }
          default:
            unavailable()
        }
      } catch {
        unavailable()
      }
    },
    async close() {
      closed = true
      const sessions = [...wallets.values()]
      const readerSessions = [...readers.values()]
      const observationSessions = [...observations.values()]
      wallets.clear()
      readers.clear()
      observations.clear()
      challenges.clear()
      observationChallenges.clear()
      credentials.clear()
      await Promise.all(
        [...sessions, ...readerSessions, ...observationSessions].map(
          (session) => session.cleanup()
        )
      )
    },
  }
}

/** Install before app navigation; the retained transport belongs to the runner. */
export async function installHermeticSparkTransport(
  context: Pick<BrowserContext, "exposeBinding">,
  transport: Pick<ReturnType<typeof createHermeticSparkTransport>, "request">,
  options: { appUrl: string }
): Promise<void> {
  const app = new URL(options.appUrl)
  if (
    app.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(app.hostname) ||
    !app.port ||
    ["0", "3000", "3001", "3002"].includes(app.port) ||
    app.username ||
    app.password ||
    app.pathname !== "/" ||
    app.search ||
    app.hash
  )
    unavailable()
  await context.exposeBinding(
    HERMETIC_SPARK_BINDING,
    async ({ frame }, command: HermeticSparkRequest) => {
      if (
        frame.parentFrame() !== null ||
        new URL(frame.url()).origin !== app.origin
      )
        unavailable()
      return transport.request(command)
    }
  )
}
