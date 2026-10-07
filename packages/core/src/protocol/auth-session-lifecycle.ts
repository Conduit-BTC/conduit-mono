import {
  cleanupInvalidatedAuthSession,
  type AuthSession,
  type InvalidatedAuthSessionCleanupOptions,
} from "./auth-session"
import { retireRemoteSignerCredentials } from "./remote-signer"
import type { RemoteSignerKeyVault } from "./remote-signer-vault"

/** Provider credential handling is separate from shared metadata retirement. */
export function retireAuthSession(
  expected: AuthSession,
  options: Omit<InvalidatedAuthSessionCleanupOptions, "retireCredentials"> & {
    keyVault?: RemoteSignerKeyVault
  } = {}
) {
  return cleanupInvalidatedAuthSession(expected, {
    ...options,
    retireCredentials: async (session, replacement) => {
      switch (session.type) {
        case "nip07":
          return
        case "nip46":
          return retireRemoteSignerCredentials(
            session,
            replacement,
            options.keyVault
          )
      }
    },
  })
}
