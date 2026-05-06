import type { Profile, ProfileFormValues } from "@conduit/core"

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

const PROFILE_FORM_FIELDS = [
  "name",
  "displayName",
  "about",
  "picture",
  "banner",
  "nip05",
  "lud16",
  "website",
] as const satisfies readonly (keyof ProfileFormValues)[]

function emptyToUndefined(value: string | undefined): string | undefined {
  return value || undefined
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
  form: ProfileFormValues
): Omit<Profile, "pubkey"> {
  return Object.fromEntries(
    PROFILE_FORM_FIELDS.map((field) => [field, emptyToUndefined(form[field])])
  ) as Omit<Profile, "pubkey">
}
