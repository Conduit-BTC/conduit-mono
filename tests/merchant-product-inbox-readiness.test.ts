import { describe, expect, it } from "bun:test"
import type { InboxDeclarationStatus } from "@conduit/core"
import {
  getProductInboxPublishGuidance,
  needsProductInboxPublishGuidance,
} from "../apps/merchant/src/lib/productInboxReadiness"

const NON_READY_STATUSES: InboxDeclarationStatus[] = [
  "loading",
  "distribution_pending",
  "not_observed",
  "signed_empty",
  "malformed",
  "lookup_partial",
  "lookup_unavailable",
]

describe("merchant product private-inbox guidance", () => {
  it("warns for every non-ready state while the readiness check is enabled", () => {
    for (const status of NON_READY_STATUSES) {
      expect(needsProductInboxPublishGuidance(status, false, true)).toBe(true)
    }
    expect(needsProductInboxPublishGuidance("ready", false, true)).toBe(false)
  })

  it("does not interrupt publish before the readiness check is enabled", () => {
    expect(needsProductInboxPublishGuidance("loading", false, false)).toBe(
      false
    )
  })

  it("does not interrupt an existing listing update", () => {
    for (const status of ["ready", ...NON_READY_STATUSES] as const) {
      expect(needsProductInboxPublishGuidance(status, true, true)).toBe(false)
    }
  })

  it("keeps missing, explicit, malformed, and degraded states distinct", () => {
    expect(getProductInboxPublishGuidance("not_observed")).toMatchObject({
      action: "setup",
      title: "Set up your private inbox",
    })
    expect(getProductInboxPublishGuidance("signed_empty")).toMatchObject({
      action: "setup",
      title: "Restore your private inbox",
    })
    expect(getProductInboxPublishGuidance("malformed")).toMatchObject({
      action: "setup",
      title: "Repair your private inbox",
    })
    expect(
      getProductInboxPublishGuidance("distribution_pending")
    ).toMatchObject({
      action: "setup",
      title: "Finish private inbox setup",
    })
    expect(getProductInboxPublishGuidance("lookup_partial")).toMatchObject({
      action: "retry",
      title: "Private inbox check incomplete",
    })
    expect(getProductInboxPublishGuidance("lookup_unavailable")).toMatchObject({
      action: "retry",
      title: "Private inbox could not be checked",
    })
  })

  it("does not describe a degraded lookup as missing setup", () => {
    for (const status of ["lookup_partial", "lookup_unavailable"] as const) {
      const guidance = getProductInboxPublishGuidance(status)
      expect(guidance.body).toContain("does not mean your setup is missing")
      expect(guidance.actionLabel).toBe("Retry check")
    }
  })

  it("keeps declaration repair in Network and publication permissive", async () => {
    const routeSource = await Bun.file(
      "apps/merchant/src/routes/products.tsx"
    ).text()
    const dialogSource = await Bun.file(
      "apps/merchant/src/components/ProductInboxReadinessDialog.tsx"
    ).text()

    expect(routeSource).toContain("useInboxDeclaration")
    expect(routeSource).toContain("session.relaySettingsReady")
    expect(routeSource).toContain('navigate({ to: "/network" })')
    expect(routeSource).not.toContain("publishPrivateMessageRelayDeclaration")
    expect(dialogSource).toContain("Publish anyway")
    expect(dialogSource).toContain("AlertDialogContent")
  })
})
