import { describe, expect, it } from "bun:test"

import { RemoteSignerResumeController } from "../packages/core/src/protocol/remote-signer-resume"

describe("remote signer resume lifecycle", () => {
  it("keeps an approval request alive across backgrounding, then gates the next action", () => {
    const lifecycle = new RemoteSignerResumeController()

    const shouldFenceApproval = lifecycle.markBoundary(true)
    expect(shouldFenceApproval).toBe(false)
    expect(lifecycle.requiresVerification).toBe(true)

    // Auth waits for the already-dispatched RPC to become idle before this
    // verification begins. The request is not re-sent by the lifecycle.
    const afterApproval = lifecycle.beginVerification()
    expect(afterApproval).not.toBeNull()
    expect(lifecycle.completeVerification(afterApproval as number)).toBe(true)
    expect(lifecycle.requiresVerification).toBe(false)

    expect(lifecycle.markBoundary(false)).toBe(true)
  })

  it("requires a fresh pass when the browser goes offline during verification", () => {
    const lifecycle = new RemoteSignerResumeController()
    lifecycle.markBoundary()
    const beforeOffline = lifecycle.beginVerification()

    expect(beforeOffline).not.toBeNull()
    lifecycle.markBoundary()

    expect(lifecycle.completeVerification(beforeOffline as number)).toBe(false)
    expect(lifecycle.requiresVerification).toBe(true)

    const afterOnline = lifecycle.beginVerification()
    expect(afterOnline).not.toBeNull()
    expect(lifecycle.completeVerification(afterOnline as number)).toBe(true)
    expect(lifecycle.requiresVerification).toBe(false)
  })

  it("does not reuse a pre-background proof after foreground return", () => {
    const lifecycle = new RemoteSignerResumeController()
    lifecycle.markBoundary()
    const beforeBackground = lifecycle.beginVerification()

    lifecycle.markBoundary()
    expect(lifecycle.beginVerification()).toBeNull()
    lifecycle.markBoundary()

    expect(lifecycle.completeVerification(beforeBackground as number)).toBe(
      false
    )
    const afterForeground = lifecycle.beginVerification()
    expect(afterForeground).not.toBeNull()
    expect(lifecycle.completeVerification(afterForeground as number)).toBe(true)
  })

  it("fences an old completion when the owning session resets", () => {
    const lifecycle = new RemoteSignerResumeController()
    lifecycle.markBoundary()
    const obsolete = lifecycle.beginVerification()

    lifecycle.reset()

    expect(lifecycle.completeVerification(obsolete as number)).toBe(false)
    expect(lifecycle.requiresVerification).toBe(false)
  })
})
