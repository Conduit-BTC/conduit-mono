import { getEventHash } from "nostr-tools"
import type { NDKSigner, NostrEvent } from "@nostr-dev-kit/ndk"
import type { NostrKeySigner } from "../../packages/core/src/protocol/nostr-event-signer"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../../packages/core/src/protocol/session-signer"

let installed: SessionSigner | null = null

export function clearTestAccountSigner(): void {
  if (installed) retireAccountSigner(installed)
  installed = null
}

export function setTestAccountSigner(legacy: NDKSigner): SessionSigner {
  const provider = plainTestSigner(legacy)
  const signer = new SessionSigner(provider, {
    expectedPubkey: legacy.pubkey,
    revision: "synthetic-revision",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => true,
  })
  activateAccountSigner(signer)
  installed = signer
  return signer
}

export function removeTestAccountSigner(signer: SessionSigner): void {
  retireAccountSigner(signer)
  if (installed === signer) installed = null
}

/** Test-only bridge for retained NDK fixtures and independent interoperability. */
export function plainTestSigner<T extends NDKSigner>(
  legacy: T
): T & NostrKeySigner {
  return Object.assign(legacy, {
    getPublicKey: async () => (await legacy.user()).pubkey,
    signEvent: async (draft: Parameters<NostrKeySigner["signEvent"]>[0]) => {
      const event: NostrEvent = {
        ...draft,
        tags: draft.tags.map((tag) => [...tag]),
      }
      const sig = await legacy.sign(event)
      return { ...draft, id: getEventHash(draft), sig }
    },
    encryptNip44: (peer: string, value: string) =>
      legacy.encrypt({ pubkey: peer } as never, value, "nip44"),
    decryptNip44: (peer: string, value: string) =>
      legacy.decrypt({ pubkey: peer } as never, value, "nip44"),
    decryptLegacy: (peer: string, value: string) =>
      legacy.decrypt({ pubkey: peer } as never, value, "nip04"),
  })
}
