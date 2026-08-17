import {
  buildProfileUpdatePayload,
  type Profile,
  type ProfileFormValues,
} from "@conduit/core"

export const EMPTY_PROFILE_FORM: ProfileFormValues = {
  name: "",
  displayName: "",
  about: "",
  picture: "",
  banner: "",
  nip05: "",
  lud16: "",
  website: "",
}

export function profileToFormValues(
  profile: Profile | null | undefined
): ProfileFormValues {
  if (!profile) return { ...EMPTY_PROFILE_FORM }

  return {
    name: profile.name ?? "",
    displayName: profile.displayName ?? "",
    about: profile.about ?? "",
    picture: profile.picture ?? "",
    banner: profile.banner ?? "",
    nip05: profile.nip05 ?? "",
    lud16: profile.lud16 ?? "",
    website: profile.website ?? "",
  }
}

export function profileFormToUpdatePayload(
  form: ProfileFormValues,
  latestProfile?: Profile | null
): Omit<Profile, "pubkey"> {
  return buildProfileUpdatePayload(form, latestProfile)
}
