import {
  formatNpub,
  getProfileName,
  pubkeyToNpub,
  type Profile,
} from "@conduit/core"

export type EventActorIdentityView = {
  displayName: string
  status: "resolved" | "pending" | "fallback"
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
        lookupSettled: true,
      })
}

export function getEventActorProvenance(pubkey: string): {
  copyValue: string
  displayNpub: string
  profileRef: string
} {
  return {
    copyValue: pubkey,
    displayNpub: formatNpub(pubkey, 8),
    profileRef: pubkeyToNpub(pubkey),
  }
}

export function getEventActorIdentityView(input: {
  pubkey: string
  profile?: Profile
  lookupSettled: boolean
  fallbackPrefix?: string
}): EventActorIdentityView {
  const profileName = getProfileName(input.profile)
  if (profileName) {
    return { displayName: profileName, status: "resolved" }
  }

  const npub = formatNpub(input.pubkey, 8)
  return {
    displayName: input.fallbackPrefix
      ? `${input.fallbackPrefix} ${npub}`
      : npub,
    status: input.lookupSettled ? "fallback" : "pending",
  }
}
