import type { Profile } from "@conduit/core"
import {
  EMPTY_PROFILE_FORM,
  profileFormToUpdatePayload,
  profileToFormValues,
} from "./profileForm"

declare function test(name: string, fn: () => void): void
declare function expect(actual: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}

test("maps missing profile fields to editable empty strings", () => {
  expect(profileToFormValues(null)).toEqual(EMPTY_PROFILE_FORM)
  expect(
    profileToFormValues({ pubkey: "abc", displayName: "Merchant" })
  ).toEqual({
    ...EMPTY_PROFILE_FORM,
    displayName: "Merchant",
  })
})

test("maps profile form values to publish payload", () => {
  const profile = {
    pubkey: "abc",
    displayName: "Merchant",
    about: "",
    picture: "https://example.com/avatar.png",
  } as Profile

  expect(profileFormToUpdatePayload(profileToFormValues(profile))).toEqual({
    name: undefined,
    displayName: "Merchant",
    about: undefined,
    picture: "https://example.com/avatar.png",
    banner: undefined,
    nip05: undefined,
    lud16: undefined,
    website: undefined,
  })
})
