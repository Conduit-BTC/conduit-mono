import { admitFixture } from "./public-event"
import {
  createInMemoryInboxDeclarationEvidenceRepository,
  mergeInboxDeclarationEvidence,
} from "../../packages/core/src/protocol/inbox-declaration-evidence"
import {
  primeInboxDeclarationEvidence,
  sharedInboxDiscoveryRelayUrls,
} from "../../packages/core/src/protocol/private-message-routing"

/** Admit the exact signed declaration; never repair bytes or infer authority from URLs. */
export async function createInboxDeclarationFixtureEvidence(
  raw: unknown,
  options: { prime?: boolean } = {}
) {
  const signedEvent = await admitFixture(raw)
  const repository = createInMemoryInboxDeclarationEvidenceRepository()
  const evidence = await mergeInboxDeclarationEvidence(
    {
      pubkey: signedEvent.pubkey,
      signedEvent,
      sourceRelayUrls: sharedInboxDiscoveryRelayUrls(),
      sharedSourceRelayUrls: sharedInboxDiscoveryRelayUrls(),
    },
    repository
  )
  if (options.prime) primeInboxDeclarationEvidence(evidence)
  return repository
}
