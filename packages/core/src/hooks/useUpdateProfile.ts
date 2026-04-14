import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Profile } from "../types"
import { publishProfile } from "../protocol/profiles"
import type { ConduitAppId } from "../protocol/nip89"

export function useUpdateProfile(appId: ConduitAppId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (profile: Omit<Profile, "pubkey">) => publishProfile(profile, appId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile"] })
    },
  })
}
