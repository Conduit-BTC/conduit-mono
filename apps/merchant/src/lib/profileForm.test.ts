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

test("maps only changed profile form values to the publish payload", () => {
  const profile = {
    pubkey: "abc",
    displayName: "Merchant",
    about: "",
    picture: "https://cdn.conduit.market/avatar.png",
  } as Profile

  expect(
    profileFormToUpdatePayload(
      { ...profileToFormValues(profile), displayName: "Updated Merchant" },
      profile
    )
  ).toEqual({ displayName: "Updated Merchant" })
})
