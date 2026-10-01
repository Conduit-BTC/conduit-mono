import { expect, test } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

for (const app of ["market", "merchant"] as const) {
  test(`${app} account uses one revision for signing, encryption and protected reads @${app}`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const port =
      app === "market"
        ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
        : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
    const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
    await installRealTestSigner(page, identity, relayUrl)
    try {
      await page.goto(
        `http://127.0.0.1:${port}/${app === "market" ? "products" : ""}`
      )
      await expect(
        page.getByLabel(
          app === "merchant"
            ? "Open merchant account menu"
            : "Open account menu"
        )
      ).toBeVisible({
        timeout: 15_000,
      })
      const result = await page.evaluate(async (root) => {
        const authorizationModule = await import(
          `${root}/protected-read-authorization.ts`
        )
        const authModule = await import(`${root}/remote-signer.ts`)
        const signedModule = await import(`${root}/signed-event.ts`)
        const session = authModule.readAuthSession()
        const authorization = authorizationModule.getProtectedReadAuthorization(
          session.userPubkey
        )
        if (!authorization) throw new Error("E2E_ACCOUNT_SESSION_MISSING")
        const signer = authorization.signer
        const draft = {
          pubkey: session.userPubkey,
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "synthetic",
        }
        const signed = await signer.signEvent(draft)
        const ciphertext = await signer.encryptNip44(
          session.userPubkey,
          "synthetic"
        )
        const plaintext = await signer.decryptNip44(
          session.userPubkey,
          ciphertext
        )
        const current = {
          samePrincipal:
            signer.pubkey === session.userPubkey &&
            signed.pubkey === session.userPubkey,
          sameRevision: signer.revision === session.authClaim,
          plainEvent: signed.constructor === Object,
          validSignature: signedModule.isValidSignedPublicNostrEvent(signed),
          exactTemplate:
            signed.content === draft.content &&
            signed.kind === draft.kind &&
            JSON.stringify(signed.tags) === JSON.stringify(draft.tags),
          roundTrip: plaintext === "synthetic",
        }
        authModule.revokeAuthSessionAuthority(session)
        let staleOutcome = "unexpected_success"
        try {
          await signer.signEvent(draft)
        } catch (error) {
          staleOutcome =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "unexpected_failure"
        }
        return {
          ...current,
          staleOutcome,
          grantRetired:
            authorizationModule.getProtectedReadAuthorization(
              session.userPubkey
            ) === null,
        }
      }, `/@fs${process.cwd()}/packages/core/src/protocol`)
      expect(result).toEqual({
        samePrincipal: true,
        sameRevision: true,
        plainEvent: true,
        validSignature: true,
        exactTemplate: true,
        roundTrip: true,
        staleOutcome: "authority_changed",
        grantRetired: true,
      })
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
