import { installProtectedReadSigner } from "../../packages/core/src/protocol/protected-read-authorization"

/** Synthetic external-account lease; local encryption must never request a signature. */
export function installMerchantAcceptanceTestSession(pubkey: string) {
  return installProtectedReadSigner(
    {
      authMethod: "nip07",
      getPublicKey: async () => pubkey,
      signEvent: async () => {
        throw new Error("Acceptance persistence must not request a signature")
      },
    },
    pubkey,
    () => true
  )
}
