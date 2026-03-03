import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Profile } from "../types"
import { publishProfile } from "../protocol/profiles"

export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) => publishProfile(profile),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] })
    },
  })
}
