import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  formatNpub,
  type Nip05TrustStatus,
  type ShopperTrustEvidence,
  type ShopperTrustSignal,
} from "@conduit/core"
import { ShopperTrustCard } from "../apps/merchant/src/components/ShopperTrustCard"

const shopperPubkey = "b".repeat(64)

function signal<T>(
  value: T,
  state: ShopperTrustSignal<T>["state"] = "available"
): ShopperTrustSignal<T> {
  return {
    state,
    value,
    source: state === "stale" ? "cache" : "network",
    observedAt: 1_700_000_000_000,
    coverage: {
      attemptedRelays: 4,
      responsiveRelays: 3,
      transportComplete: state === "available",
      completeForPlan: state === "available",
      truncated: state === "partial",
    },
  }
}

function fullEvidence(): ShopperTrustEvidence {
  return {
    merchantPubkey: "a".repeat(64),
    shopperPubkey,
    oldestEvent: signal({ timestamp: 1_577_836_800 }),
    followersObserved: signal({ count: 1_234 }),
    followsInCommon: signal({ count: 18 }),
    zapsSent: signal({ count: 42 }),
    zapsReceived: signal({ count: 27 }),
    reportsFromNetwork: signal({
      count: 2,
      reporterCount: 2,
      byType: { spam: 2 },
    }),
    source: "network",
    degraded: false,
    refreshedAt: 1_700_000_000_000,
  }
}

function unavailableSignal<T>(): ShopperTrustSignal<T> {
  return {
    state: "unavailable",
    value: null,
    source: "none",
    coverage: {
      attemptedRelays: 0,
      responsiveRelays: 0,
      transportComplete: false,
      completeForPlan: false,
      truncated: false,
    },
  }
}

function renderNip05State(
  nip05Status: Nip05TrustStatus,
  nip05?: string
): string {
  return renderToStaticMarkup(
    <ShopperTrustCard
      shopperPubkey={shopperPubkey}
      profile={{ pubkey: shopperPubkey, nip05 }}
      profileState="loaded"
      isHydrating={false}
      nip05Status={nip05Status}
      statusDisplay={{ label: "Pending", tone: "warning" }}
      messageCount={0}
      messageLabel="Message buyer"
      onRefresh={() => undefined}
      onOpenMessages={() => undefined}
    />
  )
}

describe("ShopperTrustCard", () => {
  it("renders a fully hydrated buyer context with bounded evidence", () => {
    const html = renderToStaticMarkup(
      <ShopperTrustCard
        shopperPubkey={shopperPubkey}
        profile={{
          pubkey: shopperPubkey,
          displayName: "Alice Buyer",
          picture: "https://cdn.conduit.market/alice.png",
          nip05: "alice@example.com",
        }}
        profileState="loaded"
        evidence={fullEvidence()}
        isHydrating={false}
        nip05Status="valid"
        statusDisplay={{ label: "Payment Proof Received", tone: "success" }}
        messageCount={4}
        messageLabel="Messages"
        onRefresh={() => undefined}
        onOpenMessages={() => undefined}
      />
    )

    expect(html).toContain("Buyer context")
    expect(html).toContain("Buyer context observations loaded")
    expect(html).toContain("Alice Buyer")
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain("alice@example.com")
    expect(html).toContain("NIP-05 matches")
    expect(html).toContain("Oldest signed event")
    expect(html).toContain("Event dated")
    expect(html).toContain("Author-provided timestamp")
    expect(html).toContain("Followers observed")
    expect(html).toContain("1,234")
    expect(html).toContain("Follows in common")
    expect(html).toContain("18")
    expect(html).toContain("Zap requests observed sent")
    expect(html).toContain("42")
    expect(html).toContain("Zap requests observed received")
    expect(html).toContain("27")
    expect(html).toContain("Reports from your network")
    expect(html).toContain("2 reports from 2 profiles in your network")
    expect(html).toContain("Payment Proof Received")
    expect(html).toContain("max-w-full justify-center text-center capitalize")
    expect(html).toContain("About these observations")
    expect(html).toContain("Messages")
    expect(html).toContain("(4)")
  })

  it("keeps identity and signal rows stable while profile and evidence hydrate", () => {
    const html = renderToStaticMarkup(
      <ShopperTrustCard
        shopperPubkey={shopperPubkey}
        profile={{ pubkey: shopperPubkey }}
        profileState="loading"
        isHydrating
        nip05Status="absent"
        statusDisplay={{ label: "Pending", tone: "warning" }}
        messageCount={0}
        messageLabel="Message buyer"
        onRefresh={() => undefined}
        onOpenMessages={() => undefined}
      />
    )

    expect(html).toContain(formatNpub(shopperPubkey, 8))
    expect(html).toContain("Profile loading")
    expect(html.match(/<dt/g)).toHaveLength(6)
    expect(html.match(/>Loading</g)).toHaveLength(6)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("Buyer context is updating")
    expect(html).toContain("Message buyer")
  })

  it("announces unavailable observations without claiming freshness", () => {
    const evidence = fullEvidence()
    evidence.oldestEvent = unavailableSignal()
    evidence.followersObserved = unavailableSignal()
    evidence.followsInCommon = unavailableSignal()
    evidence.zapsSent = unavailableSignal()
    evidence.zapsReceived = unavailableSignal()
    evidence.reportsFromNetwork = unavailableSignal()
    evidence.source = "none"
    evidence.degraded = true
    const html = renderToStaticMarkup(
      <ShopperTrustCard
        shopperPubkey={shopperPubkey}
        profile={{ pubkey: shopperPubkey }}
        profileState="loaded"
        evidence={evidence}
        isHydrating={false}
        nip05Status="absent"
        statusDisplay={{ label: "Pending", tone: "warning" }}
        messageCount={0}
        messageLabel="Message buyer"
        onRefresh={() => undefined}
        onOpenMessages={() => undefined}
      />
    )

    expect(html).toContain("Buyer context observations unavailable")
    expect(html).toContain("Retry observations")
    expect(html).not.toContain("Buyer context is up to date")
  })

  it("qualifies partial and stale observations without overstating missing evidence", () => {
    const evidence = fullEvidence()
    evidence.oldestEvent = signal({ timestamp: 1_577_836_800 }, "stale")
    evidence.followersObserved = signal({ count: 73 }, "partial")
    evidence.followsInCommon = unavailableSignal()
    evidence.reportsFromNetwork = signal({
      count: 0,
      reporterCount: 0,
      byType: {},
    })
    evidence.degraded = true

    const html = renderToStaticMarkup(
      <ShopperTrustCard
        shopperPubkey={shopperPubkey}
        profile={{
          pubkey: shopperPubkey,
          displayName: "Alice Buyer",
          nip05: "alice@example.com",
        }}
        profileState="loaded"
        evidence={evidence}
        isHydrating={false}
        nip05Status="invalid"
        statusDisplay={{ label: "Review", tone: "neutral" }}
        messageCount={1}
        messageLabel="Message buyer"
        onRefresh={() => undefined}
        onOpenMessages={() => undefined}
      />
    )
    const visibleText = html.replace(/<[^>]+>/g, " ")

    expect(html).toContain("Cached, may be stale")
    expect(html).toContain("Author-provided timestamp")
    expect(html).toContain("Partial observation")
    expect(html).toContain("can be backdated")
    expect(html).toContain("not proof of account creation or account age")
    expect(html).toContain("not proof of payment or wallet-provider authority")
    expect(html).toContain(">Unavailable<")
    expect(html).toContain("No reports found in this relay scan")
    expect(html).toContain("NIP-05 does not match")
    expect(visibleText).not.toMatch(/\b(score|verdict|trusted|safe)\b/i)
    expect(visibleText).not.toContain("Account created")
    expect(visibleText).not.toContain("Seen since")
    expect(visibleText).not.toContain("Seen for at least")
    expect(visibleText).not.toMatch(/[–—]/)
  })

  it("describes each NIP-05 state as identity evidence", () => {
    expect(renderNip05State("valid", "alice@example.com")).toContain(
      "alice@example.com · NIP-05 matches"
    )
    expect(renderNip05State("invalid", "alice@example.com")).toContain(
      "alice@example.com · NIP-05 does not match"
    )
    expect(renderNip05State("checking", "alice@example.com")).toContain(
      "alice@example.com · Checking NIP-05"
    )
    expect(renderNip05State("unknown", "alice@example.com")).toContain(
      "alice@example.com · NIP-05 status unavailable"
    )
    expect(renderNip05State("absent")).toContain(
      "No NIP-05 identifier in observed profile"
    )
  })

  it("does not claim NIP-05 absence when profile lookup is unavailable", () => {
    const html = renderToStaticMarkup(
      <ShopperTrustCard
        shopperPubkey={shopperPubkey}
        profile={{ pubkey: shopperPubkey }}
        profileState="unavailable"
        isHydrating={false}
        nip05Status="absent"
        statusDisplay={{ label: "Pending", tone: "warning" }}
        messageCount={0}
        messageLabel="Message buyer"
        onRefresh={() => undefined}
        onOpenMessages={() => undefined}
      />
    )

    expect(html).toContain("Profile unavailable; NIP-05 not checked")
    expect(html).not.toContain("No NIP-05 identifier in observed profile")
  })
})
