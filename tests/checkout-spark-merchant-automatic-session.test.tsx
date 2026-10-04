import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  captureMerchantCheckoutSparkRecoveryAction,
  createMerchantCheckoutSparkAutomaticSession,
} from "../apps/merchant/src/lib/checkout-spark-automatic-session"
import { CheckoutSparkRecoveryPanel } from "../apps/merchant/src/components/CheckoutSparkRecoveryPanel"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

describe("Merchant automatic recovery session activation", () => {
  it("attaches early handoff feedback to the affected order without activating recovery", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
    ).text()
    for (const action of [
      "verifyCandidate",
      "checkCredit",
      "inspectPayoutHistory",
      "reviewPayout",
    ]) {
      const start = source.indexOf(`async function ${action}(`)
      const denial = source.slice(
        source.indexOf("if (Date.now() < candidate.takeoverAt)", start),
        source.indexOf("const current = beginManualAction", start)
      )
      expect(denial).toContain("setNoticeOrderId(candidate.orderId)")
      expect(denial).toContain("setNotice(")
      expect(denial).not.toContain("setAutomaticPayouts")
      expect(denial).not.toContain("await ")
    }
  })

  it("keeps background recovery hidden until an order is selected", () => {
    const base = {
      principalPubkey: "a".repeat(64),
      isSessionCurrent: () => true,
    }
    const automatic = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel
        {...base}
        allowAutomaticPayouts
        startAutomatically
      />
    )
    expect(automatic).toBe("")
    const disabled = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel
        {...base}
        selectedOrderId="fixture-order"
        startAutomatically
      />
    )
    expect(disabled).toContain("Checking payment")
    expect(disabled).not.toContain("Verify recovery key")
  })

  it("starts off without starting a drain or consulting storage", () => {
    let drains = 0
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {
        drains += 1
      },
    })
    expect(session.capture()).toThrow("session changed")
    expect(drains).toBe(0)
  })

  it("grants a new phase only after Start drains existing work", async () => {
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
    })
    const starting = session.change(true)
    expect(session.capture()).toThrow("session changed")
    held.resolve()
    expect(await starting).toBe(true)
    expect(session.capture()).not.toThrow()
  })

  it("Pause synchronously invalidates captured authority and waits for cleanup", async () => {
    let drain = Promise.resolve()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => drain,
    })
    await session.change(true)
    const assertHeldCurrent = session.capture()
    assertHeldCurrent()
    const held = deferred()
    drain = held.promise
    let finished = false
    const pausing = session.change(false).then((enabled) => {
      finished = true
      return enabled
    })
    expect(assertHeldCurrent).toThrow("session changed")
    await Promise.resolve()
    expect(finished).toBe(false)
    held.resolve()
    expect(await pausing).toBe(false)
    expect(session.capture()).toThrow("session changed")
    await session.change(true)
    expect(session.capture()).not.toThrow()
    expect(assertHeldCurrent).toThrow("session changed")
  })

  it("Pause cancels a pending Start without a stale completion enabling it", async () => {
    const held = deferred()
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: () => held.promise,
    })
    const starting = session.change(true)
    const pausing = session.change(false)
    held.resolve()
    expect(await starting).toBe(false)
    expect(await pausing).toBe(false)
    expect(session.capture()).toThrow("session changed")
  })

  it.each(["account", "signer", "unmount", "manual"] as const)(
    "does not grant late activation after %s revocation",
    async (reason) => {
      let current = true
      const held = deferred()
      const session = createMerchantCheckoutSparkAutomaticSession({
        isCurrent: () => current,
        stopAndDrain: () => held.promise,
      })
      const starting = session.change(true)
      if (reason === "account" || reason === "signer") current = false
      else session.revoke()
      held.resolve()
      expect(await starting).toBe(false)
      expect(session.capture()).toThrow("session changed")
    }
  )

  it("a changed account immediately invalidates enabled work and a new session is off", async () => {
    let current = true
    const input = {
      isCurrent: () => current,
      stopAndDrain: async () => {},
    }
    const session = createMerchantCheckoutSparkAutomaticSession(input)
    await session.change(true)
    const assertCurrent = session.capture()
    current = false
    expect(assertCurrent).toThrow("session changed")
    current = true
    const remounted = createMerchantCheckoutSparkAutomaticSession(input)
    expect(remounted.capture()).toThrow("session changed")
  })

  it("failed drain or throwing authority cannot enable automatic work", async () => {
    const session = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => true,
      stopAndDrain: async () => {
        throw new Error("cleanup unresolved")
      },
    })
    await expect(session.change(true)).rejects.toThrow("cleanup unresolved")
    expect(session.capture()).toThrow("session changed")
    const unavailable = createMerchantCheckoutSparkAutomaticSession({
      isCurrent: () => {
        throw new Error("session unavailable")
      },
      stopAndDrain: async () => {},
    })
    expect(await unavailable.change(true)).toBe(false)
    expect(unavailable.capture()).toThrow("session changed")
  })

  it("a live auth revocation during a held drain prevents an admitted manual action", async () => {
    let current = true
    const held = deferred()
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => current,
    })
    let opened = false
    const attempt = (async () => {
      await held.promise
      action.assertCurrent()
      opened = true
    })()
    current = false
    held.resolve()
    await expect(attempt).rejects.toThrow("session changed")
    expect(opened).toBe(false)
  })

  it.each(["auth", "generation"] as const)(
    "suppresses held local read results after %s revocation",
    async (reason) => {
      let current = true
      let generation = 1
      const action = captureMerchantCheckoutSparkRecoveryAction({
        generation: () => generation,
        isCurrent: () => current,
      })
      const held = deferred()
      let displayed = false
      const read = (async () => {
        await held.promise
        if (!action.isCurrent()) return
        displayed = true
      })()
      if (reason === "auth") current = false
      else generation += 1
      held.resolve()
      await read
      expect(displayed).toBe(false)
      expect(action.assertCurrent).toThrow("session changed")
    }
  )

  it("fails closed when manual session authority becomes unavailable", () => {
    const action = captureMerchantCheckoutSparkRecoveryAction({
      generation: () => 1,
      isCurrent: () => {
        throw new Error("unavailable")
      },
    })
    expect(action.isCurrent()).toBe(false)
    expect(action.assertCurrent).toThrow("session changed")
  })

  it("renders availability without activating or restoring a prior preference", () => {
    const base = {
      principalPubkey: "a".repeat(64),
      isSessionCurrent: () => true,
      selectedOrderId: "fixture-order",
    }
    const unavailable = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel {...base} />
    )
    expect(unavailable).not.toContain("Resume payment processing")
    const available = renderToStaticMarkup(
      <CheckoutSparkRecoveryPanel {...base} allowAutomaticPayouts />
    )
    expect(available).toContain("Resume payment processing")
    expect(available).not.toContain(">Pause<")
    expect(available).toContain("Checking payment")
    expect(available).not.toContain("Verify recovery key")
  })

  it("keeps route admission and synchronous manual serialization explicit", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx"
    ).text()
    const route = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const mounted = route.slice(
      route.indexOf("{signerConnected && pubkey && quantumRouterEnabled"),
      route.indexOf(
        "{hasAccount &&",
        route.indexOf("<CheckoutSparkRecoveryPanel")
      )
    )
    expect(mounted).toContain("key={`${pubkey}:${authGeneration}`}")
    expect(mounted).toContain("allowAutomaticPayouts={quantumRouterEnabled}")
    expect(mounted).toContain(
      "isSessionCurrent={() => isAuthGenerationCurrent(authGeneration)}"
    )
    expect(source).toContain(
      "const [automaticPayouts, setAutomaticPayouts] = useState(false)"
    )
    expect(source).not.toMatch(/localStorage|sessionStorage/)
    const manual = source.slice(
      source.indexOf("function beginManualAction"),
      source.indexOf("async function refreshVerifiedStatus")
    )
    expect(manual).toContain("busyRef.current")
    expect(manual).toContain("automaticTransitionRef.current !== null")
    expect(manual).toContain("automaticSession.revoke()")
    expect(manual).toContain("void stopDiscovery()")
    expect(manual).toContain("captureMerchantCheckoutSparkRecoveryAction")
    expect(manual).toContain("isCurrent: hasCurrentSession")
    expect(
      source.match(
        /const current = beginManualAction\((?:reviewed\.)?candidate\.orderId\)/g
      )
    ).toHaveLength(8)
    expect(source).toContain("if (automaticPayouts) assertAutomaticCurrent()")
    const actions = source.slice(
      source.indexOf("async function refreshVerifiedStatus"),
      source.indexOf("return (", source.indexOf("async function confirmPayout"))
    )
    expect(actions).not.toContain("generation.current === current")
    expect(actions).not.toContain("generation.current !== current")
    expect(
      actions.match(
        /await stopDiscovery\(\)\s+if \(!current.isCurrent\(\)\) return/g
      )
    ).toHaveLength(7)
    expect(actions.match(/assertActive: current.assertCurrent/g)).toHaveLength(
      2
    )
    expect(actions.match(/shouldContinue: current.isCurrent/g)).toHaveLength(3)
    const nativeAction = actions.slice(
      actions.indexOf("async function finalizeNativeTreasury"),
      actions.indexOf(
        "async function reviewPayout",
        actions.indexOf("async function finalizeNativeTreasury")
      )
    )
    expect(nativeAction).toContain(
      "continueMerchantCheckoutSparkNativeTreasury"
    )
    expect(nativeAction).toContain("await stopDiscovery()")
    expect(nativeAction).toContain("shouldContinue: current.isCurrent")
    expect(nativeAction).toContain("if (!current.isCurrent()) return")
    expect(nativeAction).not.toContain(
      "reviewMerchantCheckoutSparkSettledPayout"
    )
    const refresh = actions.slice(0, actions.indexOf("function inspect"))
    expect(refresh.match(/if \(!current.isCurrent\(\)\) return/g)).toHaveLength(
      2
    )
    expect(refresh).toContain(
      "if (current.isCurrent()) setVerificationReadUnavailable(true)"
    )
  })
})
