import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { createSelectedProfileContext } from "../packages/core/src/protocol/profile-cache"
import { encodeLnurl } from "../packages/core/src/protocol/lightning"
import { parseCheckoutSparkReceiverContracts } from "../packages/core/src/protocol/checkout-spark-receiver-capability"
import { EventMarketOrganizerFeeForm } from "../apps/merchant/src/components/EventMarketOrganizerFeeEditor"
import {
  createEventMarketOrganizerFeeFormValues,
  formatOrganizerFeePercent,
  getOrganizerFeeProfileAddress,
  observeOrganizerFeeProfileReceiver,
  parseEventMarketOrganizerFeeForm,
  withOrganizerFeeProfileDefault,
  type OrganizerFeeProfileReceiver,
} from "../apps/merchant/src/lib/event-market-organizer-fee-form"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

describe("organizer fee form", () => {
  it("authors percentage-only terms with exact basis points without floating-point rounding", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const values = createEventMarketOrganizerFeeFormValues(fee)
    expect(values).toMatchObject({
      state: "active",
      percent: "2.5",
      lightningAddress: "organizer@example.test",
    })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "2.15" })
    ).toMatchObject({ basisPoints: 215, minimumSats: 0 })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, percent: "0.01" })
    ).toMatchObject({ basisPoints: 1 })
    expect(formatOrganizerFeePercent(200)).toBe("2")
    expect(formatOrganizerFeePercent(1)).toBe("0.01")
    expect(
      parseEventMarketOrganizerFeeForm({
        ...values,
        percent: "0",
        lightningAddress: "",
      })
    ).toEqual({ state: "disabled" })
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "revoked" })
    ).toEqual({ state: "revoked" })
    for (const change of [
      { percent: "-1" },
      { percent: "2.151" },
      { percent: "NaN" },
      { percent: "1e2" },
      { percent: String(Number.MAX_SAFE_INTEGER) },
      { lightningAddress: "not-an-address" },
    ])
      expect(() =>
        parseEventMarketOrganizerFeeForm({ ...values, ...change })
      ).toThrow()
  })

  it("keeps unknown or malformed current terms unselected until the organizer explicitly decides", () => {
    const values = createEventMarketOrganizerFeeFormValues({ state: "invalid" })
    expect(values.state).toBe("")
    expect(() => parseEventMarketOrganizerFeeForm(values)).toThrow("Choose")
    expect(
      parseEventMarketOrganizerFeeForm({ ...values, state: "disabled" })
    ).toEqual({ state: "disabled" })
  })

  it("leaves existing signed terms untouched while an explicit edit authors no minimum or expiry", () => {
    const original = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    if (original.state !== "active") throw new Error("Expected active")
    const expiresAt = AT / 1_000 + 3_601
    const current = {
      ...original,
      expiresAt,
    }
    const snapshot = structuredClone(current)
    const values = createEventMarketOrganizerFeeFormValues(current)
    expect(values).not.toHaveProperty("minimumSats")
    expect(values).not.toHaveProperty("expiresAtUtc")
    expect(current).toEqual(snapshot)
    expect(parseEventMarketOrganizerFeeForm(values)).toEqual({
      state: "active",
      basisPoints: current.basisPoints,
      minimumSats: 0,
      lightningAddress: current.lightningAddress,
    })
    expect(current).toEqual(snapshot)
  })

  it("uses the selected organizer profile address, not display data or another account", () => {
    const event = finalizeEvent(
      {
        kind: 0,
        created_at: AT / 1_000,
        tags: [],
        content: JSON.stringify({ lud16: "organizer@example.test" }),
      },
      generateSecretKey()
    )
    const context = createSelectedProfileContext({
      pubkey: event.pubkey,
      row: {
        pubkey: event.pubkey,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        rawContent: event.content,
        cachedAt: AT,
      },
    })
    context.profile.lud16 = "display-only@example.test"
    expect(getOrganizerFeeProfileAddress(context, event.pubkey)).toBe(
      "organizer@example.test"
    )
    expect(
      getOrganizerFeeProfileAddress(context, "another-account")
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(undefined, event.pubkey)
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        createSelectedProfileContext({
          pubkey: event.pubkey,
          profile: { pubkey: event.pubkey, lud16: "display-only@example.test" },
        }),
        event.pubkey
      )
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        { ...context, frontier: { ...context.frontier!, rawContent: "{}" } },
        event.pubkey
      )
    ).toBeUndefined()
    expect(
      getOrganizerFeeProfileAddress(
        {
          ...context,
          frontier: {
            ...context.frontier!,
            rawContent: JSON.stringify({ lud16: "not-an-address" }),
          },
        },
        event.pubkey
      )
    ).toBeUndefined()
  })
})

describe("qualified organizer fee profile defaults", () => {
  const fee = { state: "absent" } as const
  const blank = {
    ...createEventMarketOrganizerFeeFormValues(fee),
    state: "active" as const,
    percent: "2.5",
  }
  const receiver = {
    status: "supported",
    address: "saved@example.test",
  } as const
  const apply = (
    values = blank,
    profile: OrganizerFeeProfileReceiver = receiver,
    addressEdited = false
  ) =>
    withOrganizerFeeProfileDefault({
      fee,
      values,
      receiver: profile,
      addressEdited,
    })

  it("defaults only a qualified receiver on a new blank fee draft", () => {
    expect(apply()).toEqual({ ...blank, lightningAddress: receiver.address })
    for (const status of [
      "none",
      "checking",
      "unsupported",
      "unavailable",
      "conflicting",
    ] as const)
      expect(apply(blank, { status })).toBe(blank)
    expect(blank.lightningAddress).toBe("")
  })

  it("never replaces typed/custom or signed destinations, including deliberate clearing", () => {
    const custom = { ...blank, lightningAddress: "custom@example.test" }
    expect(apply(custom)).toBe(custom)
    expect(apply(blank, receiver, true)).toBe(blank)
    const signed = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const values = createEventMarketOrganizerFeeFormValues(signed)
    expect(
      withOrganizerFeeProfileDefault({
        fee: signed,
        values,
        receiver,
        addressEdited: false,
      })
    ).toBe(values)
    expect(values.lightningAddress).toBe("organizer@example.test")
  })

  it("keeps no-fee and revoked choices unchanged without any receiving setup", () => {
    for (const state of ["disabled", "revoked"] as const) {
      const values = { ...blank, state }
      const result = withOrganizerFeeProfileDefault({
        fee,
        values,
        receiver,
        addressEdited: false,
      })
      expect(result).toBe(values)
      expect(parseEventMarketOrganizerFeeForm(result)).toEqual({ state })
    }
  })

  it("uses the current draft after delayed qualification instead of a captured blank draft", async () => {
    let finish!: (receiver: OrganizerFeeProfileReceiver) => void
    const pending = new Promise<OrganizerFeeProfileReceiver>((resolve) => {
      finish = resolve
    })
    let current = blank
    const check = pending.then((observed) => apply(current, observed))
    current = {
      ...blank,
      lightningAddress: "typed-while-checking@example.test",
    }
    finish(receiver)
    expect(await check).toBe(current)
  })
})

describe("organizer profile receiver qualification", () => {
  const address = "saved@fee-receiver-e2e.conduit.market"
  const origin = "https://fee-receiver-e2e.conduit.market"
  const contracts = parseCheckoutSparkReceiverContracts([
    {
      schemaVersion: 1,
      contractId: "synthetic-fee-private-v1",
      qualification: "accepted",
      payRequestOrigins: [origin],
      callbackOrigins: [origin],
      verifyOrigins: [origin],
      verifyPathPrefix: "/verify/",
      modes: ["private"],
      binding: "metadata_hash",
    },
  ])
  function profile() {
    const event = finalizeEvent(
      {
        kind: 0,
        created_at: AT / 1_000,
        tags: [],
        content: JSON.stringify({ lud16: address }),
      },
      generateSecretKey()
    )
    return createSelectedProfileContext({
      pubkey: event.pubkey,
      row: {
        pubkey: event.pubkey,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        rawContent: event.content,
        cachedAt: AT,
      },
    })
  }
  const metadata = () => {
    const payRequestUrl = `${origin}/.well-known/lnurlp/saved`
    return {
      payRequestUrl,
      lnurl: encodeLnurl(payRequestUrl),
      callback: `${origin}/callback`,
      minSendable: 1_000,
      maxSendable: 1_000_000,
      tag: "payRequest",
      allowsNostr: false,
      metadata: JSON.stringify([
        ["text/plain", "Synthetic receiver"],
        ["text/identifier", address],
      ]),
    }
  }

  it("does not treat a syntactically valid address or another account as qualified", async () => {
    const context = profile()
    const input = {
      context,
      organizerPubkey: context.profile.pubkey,
      assertCurrent: () => undefined,
    }
    let fetched = 0
    const fetchMetadata = async () => {
      fetched++
      return metadata()
    }
    expect(
      await observeOrganizerFeeProfileReceiver(input, {
        contracts: [],
        fetchMetadata,
      })
    ).toEqual({ status: "unsupported" })
    expect(
      await observeOrganizerFeeProfileReceiver(
        { ...input, organizerPubkey: "different-account" },
        { contracts, fetchMetadata }
      )
    ).toEqual({ status: "none" })
    expect(fetched).toBe(0)
    expect(
      await observeOrganizerFeeProfileReceiver(input, {
        contracts,
        fetchMetadata,
      })
    ).toEqual({ status: "supported", address })
    expect(fetched).toBe(1)
  })

  it("keeps provider failure distinct from an unsupported or conflicting address", async () => {
    const context = profile()
    const input = {
      context,
      organizerPubkey: context.profile.pubkey,
      assertCurrent: () => undefined,
    }
    expect(
      await observeOrganizerFeeProfileReceiver(input, {
        contracts,
        fetchMetadata: async () => {
          throw new Error("synthetic unavailable")
        },
      })
    ).toEqual({ status: "unavailable" })
    expect(
      await observeOrganizerFeeProfileReceiver(input, {
        contracts,
        fetchMetadata: async () => ({
          ...metadata(),
          callback: "https://different.example.test/callback",
        }),
      })
    ).toEqual({ status: "conflicting" })
  })

  it("rejects delayed qualification when the active organizer session changes", async () => {
    const context = profile()
    let current = true
    let finish!: () => void
    const response = new Promise<void>((resolve) => {
      finish = resolve
    })
    const check = observeOrganizerFeeProfileReceiver(
      {
        context,
        organizerPubkey: context.profile.pubkey,
        assertCurrent: () => {
          if (!current) throw new Error("Organizer session changed")
        },
      },
      {
        contracts,
        fetchMetadata: async () => {
          await response
          return metadata()
        },
      }
    )
    current = false
    finish()
    await expect(check).rejects.toThrow("Organizer session changed")
  })
})

describe("organizer fee shared-control presentation", () => {
  const noChange = () => undefined
  it("shows percentage-only fields, a qualified saved-address choice and editable custom address", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    let actions = 0
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry
        editing
        busy={false}
        profileReceiver={{ status: "supported", address: "saved@example.test" }}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={() => {
          actions++
        }}
        onRetry={() => {
          actions++
        }}
      />
    )
    expect(html).toContain("Organizer fee")
    expect(html).toContain("2.5%, minimum 5 sats")
    for (const label of [
      "Fee setting",
      "Percentage",
      "Organizer Lightning address",
    ])
      expect(html).toContain(label)
    expect(html).toContain("Save fee settings")
    expect(html).toContain("Retry current signed settings")
    expect(html).not.toContain("Minimum (sats)")
    expect(html).not.toContain("Expiry (UTC, optional)")
    expect(html).toContain("Use my Lightning address")
    expect(html).toContain("saved@example.test")
    expect(html).toContain('value="organizer@example.test"')
    expect(html).toContain(
      "This does not change your profile or wallet settings"
    )
    expect(html).toContain("Saving replaces the current minimum and expiry")
    expect(html).toContain('inputMode="decimal"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('<select aria-hidden="true"')
    expect(actions).toBe(0)
  })

  it("shows invalid terms as a blocker rather than claiming the fee is zero", () => {
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={{ state: "invalid" }}
        values={createEventMarketOrganizerFeeFormValues({ state: "invalid" })}
        canEdit
        canRetry
        editing
        busy={false}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("could not be verified")
    expect(html).toContain("explicitly replace")
    expect(html).not.toContain("No organizer fee has been set")
    expect(html).toContain('disabled=""')
  })

  it("does not expose editing or publication controls to a non-organizer", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit={false}
        canRetry={false}
        editing={false}
        busy={false}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("organizer@example.test")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("<button")
    expect(html).toContain("Only the authenticated organizer")
  })

  it("shows a compact saved summary with explicit editing and retains legacy expiry", () => {
    const original = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    if (original.state !== "active") throw new Error("Expected active")
    const fee = { ...original, expiresAt: AT / 1_000 + 3_601 }
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry={false}
        editing={false}
        busy={false}
        notice="Fee settings saved and published."
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).not.toContain("<form")
    expect(html).toContain("Edit fee settings")
    expect(html).toContain("2.5%, minimum 5 sats")
    expect(html).toContain("Expires")
    expect(html).toContain("Fee settings saved and published.")
    expect(html).not.toContain("Only the authenticated organizer")
    expect(html).not.toContain("Retry current signed settings")
  })

  it("keeps custom entry available without saved profile evidence and exposes failed-delivery retry", () => {
    const fee = checkoutSparkEventMarketFixture().eventMarket.organizerFee
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={createEventMarketOrganizerFeeFormValues(fee)}
        canEdit
        canRetry
        editing
        editLocked
        busy={false}
        error="Publication could not be confirmed. Retry the saved update."
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("No usable saved profile address is available here")
    expect(html).not.toContain("Use my Lightning address")
    expect(html).toContain("Organizer Lightning address")
    expect(html).toContain('role="alert"')
    expect(html).toContain("Retry current signed settings")
    expect(html).not.toContain("saved and published")
    expect(html).toContain('disabled=""')
  })

  it("shows the prefilled receiver without requiring another use-address click", () => {
    const fee = { state: "absent" } as const
    const values = {
      state: "active" as const,
      percent: "2.5",
      lightningAddress: "saved@example.test",
    }
    const html = renderToStaticMarkup(
      <EventMarketOrganizerFeeForm
        fee={fee}
        values={values}
        canEdit
        canRetry={false}
        editing
        busy={false}
        profileReceiver={{
          status: "supported",
          address: values.lightningAddress,
        }}
        onChange={noChange}
        onEdit={noChange}
        onCancel={noChange}
        onSave={noChange}
        onRetry={noChange}
      />
    )
    expect(html).toContain("Using your saved Lightning address")
    expect(html).not.toContain("Use my Lightning address")
    expect(html).toContain('value="saved@example.test"')
  })

  it("distinguishes setup from temporary checks without blocking the no-fee choice", () => {
    for (const [status, message] of [
      ["checking", "Checking your saved Lightning address"],
      ["unsupported", "not supported for event routing"],
      ["unavailable", "could not be checked right now"],
      ["conflicting", "did not pass the receiving-wallet check"],
    ] as const) {
      const fee = { state: "absent" } as const
      const html = renderToStaticMarkup(
        <EventMarketOrganizerFeeForm
          fee={fee}
          values={{ state: "active", percent: "2.5", lightningAddress: "" }}
          canEdit
          canRetry={false}
          editing
          busy={false}
          profileReceiver={{ status }}
          onChange={noChange}
          onEdit={noChange}
          onCancel={noChange}
          onSave={noChange}
          onRetry={noChange}
        />
      )
      expect(html).toContain(message)
      expect(html).not.toContain("Use my Lightning address")
      expect(html).toContain("You can leave the organizer fee disabled")
      expect(html.includes('href="/wallet"')).toBe(status !== "checking")
    }
  })
})
