import { withBrowserAuthOperationLock } from "./auth-operation-lock"
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
export async function retireAuthSession(
  expected: AuthSession,
  options: Omit<InvalidatedAuthSessionCleanupOptions, "retireCredentials"> & {
    keyVault?: RemoteSignerKeyVault
  } = {}
) {
  const withLock = options.withLock ?? withBrowserAuthOperationLock
  return withLock(async () => {
    const result = await cleanupInvalidatedAuthSession(expected, {
      ...options,
      withLock: async (task) => task(),
      retireCredentialsBeforeMetadata: expected.type === "local",
      retireCredentials: async (session, replacement, metadataVerified) => {
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
              await removeLocalKeyRecord(session, {
                predecessor: metadataVerified ? "retire" : "unverified",
                replacement:
                  replacement?.type === "local" ? replacement : undefined,
              })
            } catch {
              throw new AuthSessionError(
                "unavailable",
                durable
                  ? "Local signer removal is incomplete. Signing is disconnected. Retry removal when site storage is available."
                  : "Local signer removal is unresolved. Signing is disconnected in this window, but restart safety could not be secured. Keep this window open and retry removal when site storage is available."
              )
            }
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
    // Retain public retry identity until both credential and metadata cleanup
    // finish. A metadata failure must not make a cancelled import restorable.
    if (
      expected.type === "local" &&
      !clearPendingLocalKeyRemoval(expected, options.storage)
    )
      throw new AuthSessionError(
        "unavailable",
        "The browser could not complete local signer removal."
      )
    return result
  })
}
