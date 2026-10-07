import {
  finalizeEvent,
  getPublicKey,
  generateSecretKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../../packages/core/src/db"
import { CommerceInbox } from "../../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../../packages/core/src/protocol/commerce-inbox-store"
import { __setCommerceTestOverrides } from "../../packages/core/src/protocol/commerce"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "../../packages/core/src/protocol/protected-read-authorization"
import {
  SessionSigner,
  activateAccountSigner,
  retireAccountSigner,
} from "../../packages/core/src/protocol/session-signer"
import type { PrivateMessageEvent } from "../../packages/core/src/protocol/messaging"

const fixtures: Array<{
  owner: CommerceInbox
  signer: SessionSigner
  database: ConduitDB
}> = []

/** Real crypto through the current owner; only relay observations are controlled. */
export function installPrivateInboxTestRead(input: {
  principalSecret: Uint8Array
  authorSecrets: Uint8Array[]
  rumors: PrivateMessageEvent[]
  coverage?: "complete" | "partial" | "capped" | "unavailable"
}) {
  const pubkey = getPublicKey(input.principalSecret)
  const signer = new SessionSigner(
    {
      pubkey,
      authMethod: "nip07",
      getPublicKey: async () => pubkey,
      signEvent: async (event) => finalizeEvent(event, input.principalSecret),
      encryptNip44: async (peer, value) =>
        v2.encrypt(
          value,
          v2.utils.getConversationKey(input.principalSecret, peer)
        ),
      decryptNip44: async (peer, value) =>
        v2.decrypt(
          value,
          v2.utils.getConversationKey(input.principalSecret, peer)
        ),
      decryptLegacy: async () => "",
    },
    {
      expectedPubkey: pubkey,
      revision: crypto.randomUUID(),
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: true,
      }),
      hasAuthority: () => true,
    }
  )
  activateAccountSigner(signer)
  installProtectedReadSigner(signer, pubkey, () => true)
  const database = new ConduitDB(`private-read-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const authorization = getProtectedReadAuthorization(pubkey)!
  const owner = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  fixtures.push({ owner, signer, database })
  const events = input.rumors.map((rumor) => {
    const author = input.authorSecrets.find(
      (secret) => getPublicKey(secret) === rumor.pubkey
    )
    if (!author) throw new Error("Missing synthetic author")
    const created_at = Math.floor(Date.now() / 1000)
    const seal = finalizeEvent(
      {
        kind: 13,
        created_at,
        tags: [],
        content: v2.encrypt(
          JSON.stringify(rumor),
          v2.utils.getConversationKey(author, pubkey)
        ),
      },
      author
    )
    const ephemeral = generateSecretKey()
    return finalizeEvent(
      {
        kind: 1059,
        created_at,
        tags: [["p", pubkey]],
        content: v2.encrypt(
          JSON.stringify(seal),
          v2.utils.getConversationKey(ephemeral, pubkey)
        ),
      },
      ephemeral
    )
  })
  const coverage = input.coverage ?? "complete"
  __setCommerceTestOverrides({
    getCommerceInbox: () => owner,
    resolveInboxRelayUrls: async () => [
      "wss://private-inbox.synthetic.example",
    ],
    readProtectedInbox: async () => {
      const available = coverage !== "unavailable"
      return {
        events: available ? events : [],
        coverage: available
          ? coverage === "complete"
            ? "complete"
            : "partial"
          : "unavailable",
        auth: {
          state: "not_challenged",
          challengedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
        relayResult: {
          status: available ? "success" : "failed",
          observations: available ? [{ type: "eose", relayIndex: 0 }] : [],
          relays: [
            {
              relayIndex: 0,
              status: available ? "success" : "failed",
              auth: "not_challenged",
              eventCount: available ? events.length : 0,
              duplicateCount: 0,
              malformedCount: 0,
              unusableCount: 0,
            },
          ],
          attemptedCount: 1,
          completedCount: available ? 1 : 0,
          failedCount: available ? 0 : 1,
          authoritativeEmpty: available && events.length === 0,
        },
      }
    },
  })
  return owner
}

export async function cleanupPrivateInboxTestReads() {
  for (const fixture of fixtures.splice(0)) {
    fixture.owner.stop()
    retireAccountSigner(fixture.signer)
    await fixture.database.delete()
  }
  __resetProtectedReadSigner()
}
