import type { AccountSigner } from "../protocol/nostr-event-signer"
import type { ConduitAppId } from "../protocol/nip89"
import {
  fetchProfileContext,
  getProfileLightningAddress,
  publishProfileContext,
} from "../protocol/profiles"
import { assertWalletSignerCurrent } from "./signer-spark-recovery"
import { getSparkWalletManager } from "./spark-sdk"
import {
  getPortableWalletSync,
  runAccountWalletSetup,
} from "./portable-wallet-sync"
import {
  createAddressRequestWorkflow,
  type AddressRequestWorkflow,
} from "./address-request-workflow"
import {
  mergeAddressRequestRecord,
  requestEvidence,
  type AddressRequestRecord,
} from "./address-request-record"

/** Request progress is part of the encrypted wallet, never provider approval authority. */
export function accountAddressRequests(
  signer: AccountSigner,
  appId: ConduitAppId
): AddressRequestWorkflow {
  const writesEnabled =
    import.meta.env?.VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED !== "false"
  const assertWritesEnabled = () => {
    if (!writesEnabled)
      throw new Error("Name requests are temporarily unavailable.")
  }
  const service = getPortableWalletSync(signer)
  const current = () => assertWalletSignerCurrent(signer)
  const manager = () => {
    current()
    const manager = getSparkWalletManager()
    if (!manager) throw new Error("Open this wallet to continue.")
    return manager
  }
  const makeWorkflow = (priority: "foreground" | "background") => {
    const authorize = async (
      walletId: string,
      request?: AddressRequestRecord
    ) => {
      const wallet = await service.get(walletId, { priority })
      current()
      if (
        wallet.lifecycle !== "active" ||
        wallet.network !== "mainnet" ||
        (await manager().getAddressIdentity(walletId)) !==
          wallet.identityPublicKey ||
        (request &&
          requestEvidence(request).sparkIdentity !== wallet.identityPublicKey)
      )
        throw new Error("Wallet identity does not match the request.")
      return wallet
    }
    return createAddressRequestWorkflow({
      owner: signer.pubkey,
      assertCurrent: current,
      authorize: async (walletId, request) => {
        const before = await authorize(walletId, request)
        return async () => {
          const after = await authorize(walletId, request)
          if (JSON.stringify(before) !== JSON.stringify(after))
            throw new Error("Wallet authorization changed.")
        }
      },
      async load(walletId) {
        const wallet = await authorize(walletId)
        return wallet.addressRequest
          ? {
              record: wallet.addressRequest,
              publication:
                service.snapshot.status === "ready" ? "confirmed" : "local",
            }
          : undefined
      },
      async save(walletId, record) {
        assertWritesEnabled()
        const wallet = await authorize(walletId, record)
        const merged = mergeAddressRequestRecord(wallet.addressRequest, record)
        await service.update(walletId, { addressRequest: merged }, { priority })
        return { record: merged, publication: "local" }
      },
      async signWallet(walletId, input) {
        await authorize(walletId)
        return manager().signAddressNameRequest(walletId, {
          ...input,
          timestamp: Math.floor(Date.now() / 1000),
        })
      },
      signAccount: (draft) => signer.signEvent(draft, { priority }),
      fetch: (...args) => fetch(...args),
      async address(walletId, register, name) {
        await authorize(walletId)
        const state = await manager().getLightningAddress(
          walletId,
          register,
          name,
          "conduit.cash"
        )
        if (state.status === "registered")
          await service.update(
            walletId,
            { lightningAddress: state.address },
            { priority }
          )
        return state
      },
      async publishProfile(address) {
        const options = {
          accountPubkey: signer.pubkey,
          authenticatedPubkey: signer.pubkey,
          shouldContinue: () => {
            current()
            return true
          },
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "profile_edit" as const,
        }
        const before = await fetchProfileContext(signer.pubkey, options)
        current()
        if (
          before.frontier?.validity === "valid" &&
          before.freshness === "observed" &&
          getProfileLightningAddress(JSON.parse(before.frontier.rawContent)) ===
            address
        )
          return before.frontier.eventId
        const published = await publishProfileContext(
          { lud16: address },
          appId,
          {
            ...options,
            expectedLightningAddress: getProfileLightningAddress(
              before.profile
            ),
          }
        )
        const after = await fetchProfileContext(signer.pubkey, options)
        current()
        if (
          after.freshness !== "observed" ||
          after.frontier?.validity !== "valid" ||
          after.frontier.eventId !== published.frontier?.eventId ||
          getProfileLightningAddress(JSON.parse(after.frontier.rawContent)) !==
            address
        )
          throw new Error(
            "Address activated. Profile publication still needs confirmation."
          )
        return after.frontier.eventId
      },
    })
  }
  const run = async <T>(operation: () => Promise<T>) => {
    const result = await runAccountWalletSetup(signer, operation)
    void service.sync().catch(() => {
      /* The shared wallet status owns the actionable signer error. */
    })
    return result
  }
  return {
    writesEnabled,
    load: (id) => run(() => makeWorkflow("background").load(id)),
    submit: (id, input) => {
      assertWritesEnabled()
      return run(() => makeWorkflow("foreground").submit(id, input))
    },
    check: (id) => run(() => makeWorkflow("foreground").check(id)),
    activate: (id) => {
      assertWritesEnabled()
      return run(() => makeWorkflow("foreground").activate(id))
    },
  }
}
