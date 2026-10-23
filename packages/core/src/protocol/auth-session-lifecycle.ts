import { removeLocalKeyRecord } from "./local-key"
import {
  cleanupInvalidatedAuthSession,
  writePendingLocalKeyRemoval,
  clearPendingLocalKeyRemoval,
  AuthSessionError,
  readPendingLocalKeyRemoval,
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
    retireCredentialsBeforeMetadata: expected.type === "local",
    retireCredentials: async (session, replacement) => {
      switch (session.type) {
        case "nip07":
          return
        case "local":
          if (
            replacement?.type === "local" &&
            replacement.localKeyRevision === session.localKeyRevision &&
            replacement.userPubkey === session.userPubkey
          )
            return
          // Preserve public retry information even if import failed before
          // active-session metadata was saved. Storage failure is still a
          // deletion failure; live revocation never implies durable removal.
          const journalSaved = writePendingLocalKeyRemoval(
            session,
            options.storage
          )
          const pending = readPendingLocalKeyRemoval(options.storage)
          const durable =
            journalSaved ||
            (pending?.localKeyRevision === session.localKeyRevision &&
              pending.userPubkey === session.userPubkey)
          try {
            await removeLocalKeyRecord(session)
          } catch {
            throw new AuthSessionError(
              "unavailable",
              durable
                ? "Local signer removal is incomplete. Signing is disconnected. Retry removal when site storage is available."
                : "Local signer removal is unresolved. Signing is disconnected in this window, but restart safety could not be secured. Keep this window open and retry removal when site storage is available."
            )
          }
          if (!clearPendingLocalKeyRemoval(session, options.storage))
            throw new AuthSessionError(
              "unavailable",
              "The browser could not complete local signer removal."
            )
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
