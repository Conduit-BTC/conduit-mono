import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("account Network hook authority timing", () => {
  it("aborts stale reconciliation before passive effects run", async () => {
    const [hook, session] = await Promise.all([
      source("packages/core/src/hooks/useAccountNetworkPreferences.ts"),
      source("packages/core/src/context/ConduitSessionContext.tsx"),
    ])

    expect(hook).toContain("useLayoutEffect(() => {")
    expect(hook).toContain("reconciliationControllerRef.current?.abort()")
    expect(hook).toContain("signal: controller.signal")
    expect(hook).toContain("controller.signal.aborted")
    expect(hook).toContain("authGenerationRef.current = authGeneration")
    expect(hook).toContain("authGenerationRef.current === authGeneration")
    expect(hook).toContain(
      "reconciliationControllerRef.current = null\n    }\n  }, [authGeneration, contextKey])"
    )
    const reconciliationEffect = hook.slice(
      hook.indexOf("void reconcileAccountNetworkPreferences"),
      hook.indexOf("const refetch")
    )
    expect(reconciliationEffect).toContain("authGeneration,")
    expect(session).toContain(
      "const { authGeneration, pubkey, status } = useAuth()"
    )
    expect(session).toMatch(
      /useAccountNetworkPreferences\([\s\S]{0,180}authGeneration\s*\)/
    )
  })

  it("updates profile and Network guard refs during the layout phase", async () => {
    const [session, networkSettings, inboxDeclaration] = await Promise.all([
      source("packages/core/src/context/ConduitSessionContext.tsx"),
      source("packages/core/src/hooks/useAccountNetworkSettings.ts"),
      source("packages/core/src/hooks/useInboxDeclaration.ts"),
    ])

    expect(session).toContain("useLayoutEffect(() => {")
    expect(session).toContain(
      "profileAuthorityRef.current.authGeneration === authGeneration"
    )
    expect(session).toContain(
      "profileAuthorityRef.current.pubkey === signedInPubkey"
    )
    expect(networkSettings).toMatch(
      /useLayoutEffect\(\(\) => \{\s*authRef\.current = auth/
    )
    expect(networkSettings).toMatch(
      /useLayoutEffect\(\(\) => \{\s*revisionRef\.current = revision/
    )
    expect(networkSettings).not.toMatch(
      /useEffect\(\(\) => \{\s*authRef\.current = auth/
    )
    expect(inboxDeclaration).toMatch(
      /useLayoutEffect\(\(\) => \{\s*authorityRef\.current = \{/
    )
    expect(inboxDeclaration).not.toMatch(
      /useEffect\(\(\) => \{\s*authorityRef\.current = \{/
    )
  })
})
