import { formatNpub, getProfileName, type Profile } from "@conduit/core"

export type EventActorIdentityView = {
  displayName: string
}

export function selectEventHandoffIdentity(input: {
  mode: "merchant_handoff" | "organizer_handoff"
  handlerPubkey: string
  merchant: { pubkey: string; identity: EventActorIdentityView }
  organizer: { pubkey: string; identity: EventActorIdentityView }
}): EventActorIdentityView {
  const expected =
    input.mode === "organizer_handoff" ? input.organizer : input.merchant
  return expected.pubkey === input.handlerPubkey
    ? expected.identity
    : getEventActorIdentityView({
        pubkey: input.handlerPubkey,
      })
}

export function getEventActorIdentityView(input: {
  pubkey: string
  profile?: Profile
}): EventActorIdentityView {
  return {
    displayName:
      getProfileName(
        input.profile?.pubkey === input.pubkey ? input.profile : undefined
      ) ?? formatNpub(input.pubkey, 8),
  }
}
