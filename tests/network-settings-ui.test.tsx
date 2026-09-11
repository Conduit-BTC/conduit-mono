import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  AccountNetworkRelayRowView,
  AccountNetworkSettingsController,
} from "@conduit/core"
import { RelaySettingsPanel } from "@conduit/ui"
import {
  getRelayRemovalReviewCopy,
  persistRelayOrderPreference,
} from "../packages/ui/src/components/RelaySettingsPanel"

const EMPTY_FRONTIER = {
  state: "not_observed",
  stale: false,
  retained: false,
  coverage: "complete" as const,
  eventCreatedAt: null,
  observedAt: null,
  sourceRelayCount: 0,
}

function relayRow(
  url: string,
  overrides: Partial<AccountNetworkRelayRowView> = {}
): AccountNetworkRelayRowView {
  return {
    url,
    readEnabled: true,
    publishEnabled: true,
    privateInboxEnabled: true,
    readState: "published",
    publishState: "published",
    privateInboxState: "published",
    signedPosition: 0,
    candidate: false,
    recoveryReadOnly: false,
    reachability: "responded",
    capability: {
      configuredUses: [],
      observedCommerce: false,
      nip11: "available",
      searchAdvertised: false,
      authEvidence: "untested",
    },
    ...overrides,
  }
}

function controller(
  input: {
    rows?: AccountNetworkRelayRowView[]
    pendingExactDeliveries?: AccountNetworkSettingsController["view"]["pendingExactDeliveries"]
    validation?: ReturnType<AccountNetworkSettingsController["validate"]>
    exactInboxRedistributionAvailable?: boolean
  } = {}
): AccountNetworkSettingsController {
  return {
    view: {
      rows: input.rows ?? [],
      relayList: EMPTY_FRONTIER,
      inbox: EMPTY_FRONTIER,
      pendingExactDeliveries: input.pendingExactDeliveries ?? [],
    },
    status: "ready",
    error: null,
    revision: "test-revision",
    operation: { kind: null, phase: "idle", message: null },
    relayInformationRefreshing: false,
    exactInboxRedistributionAvailable:
      input.exactInboxRedistributionAvailable ?? false,
    mediaServers: null,
    addRelay: async () => relayRow("wss://added.example"),
    validate: () =>
      input.validation ?? { valid: true, errors: [], warnings: [] },
    prepareChange: () => ({
      summary: {
        signerRequestCount: 2,
        changedObjects: [
          "Read and Publish relay preferences",
          "Private inbox relay preferences",
        ],
        warnings: [],
      },
      execute: async () => undefined,
    }),
    retryPendingUpdate: async () => undefined,
    redistributeExactInboxDeclaration: async () => undefined,
    reorderRelays: async () => undefined,
    refresh: async () => undefined,
    clearOperation: () => undefined,
  }
}

describe("RelaySettingsPanel account Network review", () => {
  it("accepts a one-relay setup and describes the actual minimum", () => {
    const emptyMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )
    expect(emptyMarkup).toContain("at least one Publish relay")
    expect(emptyMarkup).toContain(
      "Select a Private inbox if you want to receive private messages."
    )
    expect(emptyMarkup).not.toContain(
      "Publish relay and select a Private inbox"
    )
    expect(emptyMarkup).not.toContain("at least two relays")

    const oneRelayMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://only.example")],
          validation: {
            valid: true,
            errors: [],
            warnings: [
              "One Publish relay is valid, but adding another improves redundancy.",
            ],
          },
        })}
      />
    )
    expect(oneRelayMarkup).toContain(
      "One Publish relay is valid, but adding another improves redundancy."
    )
  })

  it("identifies unencrypted relay transport without blocking its controls", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("ws://relay.lan", {
              readEnabled: false,
            }),
          ],
        })}
      />
    )

    expect(markup).toContain("Unencrypted connection")
    expect(markup).toContain("Transport encryption is absent.")
    expect(markup).toContain(
      "Use this relay only when you control it or explicitly trust the relay and network path."
    )
    const readControl = markup.match(
      /<button[^>]*aria-label="Enable Read for ws:\/\/relay\.lan"[^>]*>/
    )?.[0]
    expect(readControl).toBeDefined()
    expect(readControl).not.toContain(' disabled=""')

    const reviewTextIndex = markup.indexOf("Review and publish")
    const reviewTagStart = markup.lastIndexOf("<button", reviewTextIndex)
    const reviewTagEnd = markup.indexOf(">", reviewTagStart)
    const reviewControl = markup.slice(reviewTagStart, reviewTagEnd + 1)
    expect(reviewTextIndex).toBeGreaterThan(-1)
    expect(reviewTagStart).toBeGreaterThan(-1)
    expect(reviewControl).not.toContain(' disabled=""')

    const encryptedMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://relay.example")],
        })}
      />
    )
    expect(encryptedMarkup).not.toContain("Unencrypted connection")
  })

  it("identifies recovery-only inboxes and makes whole-relay cutoff explicit", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://previous-inbox.example", {
              readEnabled: false,
              publishEnabled: false,
              privateInboxEnabled: false,
              readState: null,
              publishState: null,
              privateInboxState: null,
              recoveryReadOnly: true,
            }),
          ],
        })}
      />
    )

    expect(markup).toContain("Recovery read-only")
    expect(markup).toContain("7-day recovery window")
    expect(markup).toContain(
      'aria-label="Remove wss://previous-inbox.example from my whole setup"'
    )
    expect(markup).toContain("ends recovery for this relay immediately")
  })

  it("blocks a reviewed change that removes the last usable private inbox", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://last-inbox.example", {
              privateInboxEnabled: false,
            }),
          ],
          validation: {
            valid: false,
            errors: [
              "Select a replacement before removing the last usable Private inbox.",
            ],
            warnings: [
              "One Publish relay is valid, but adding another improves redundancy.",
            ],
          },
        })}
      />
    )

    expect(markup).toContain(
      "Select a replacement before removing the last usable Private inbox."
    )
    const publishButton = markup.match(
      /<button[^>]*disabled=""[^>]*>.*?Review and publish.*?<\/button>/
    )?.[0]
    expect(publishButton).toBeDefined()
  })

  it("previews whole removal by omitting the target recovery row", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const preview = panelSource.match(
      /function removalInstructionForReview\([\s\S]*?\n\}/
    )?.[0]
    expect(preview).toContain("hasUnpublishedChanges")
    expect(preview).toContain("preparationError")
    expect(panelSource).toContain(
      'controller.prepareChange({ type: "remove_relay", relayUrl })'
    )
    expect(panelSource).toContain("!preparedChange")
  })

  it("names the exact zero, one, or two signer requests for whole removal", () => {
    const redundancyWarning =
      "One Publish relay is valid, but adding another improves redundancy."
    const localOnly = getRelayRemovalReviewCopy({
      signerRequestCount: 0,
      changedObjects: ["Local whole-relay removal policy"],
      warnings: [redundancyWarning],
    })
    expect(localOnly.signerRequestCount).toBe(0)
    expect(localOnly.signerMessage).toContain("zero signer requests")
    expect(localOnly.changedObjects).toEqual([
      "Local whole-relay removal policy",
    ])
    expect(localOnly.warnings).toEqual([redundancyWarning])

    const relayListOnly = getRelayRemovalReviewCopy({
      signerRequestCount: 1,
      changedObjects: [
        "Read and Publish relay preferences",
        "Local whole-relay removal policy",
      ],
      warnings: [redundancyWarning],
    })
    expect(relayListOnly.signerRequestCount).toBe(1)
    expect(relayListOnly.signerMessage).toContain("exactly 1 signer request")
    expect(relayListOnly.changedObjects).toEqual([
      "Read and Publish relay preferences",
      "Local whole-relay removal policy",
    ])
    expect(relayListOnly.warnings).toEqual([redundancyWarning])

    const bothKinds = getRelayRemovalReviewCopy({
      signerRequestCount: 2,
      changedObjects: [
        "Read and Publish relay preferences",
        "Private inbox relay preferences",
        "Local whole-relay removal policy",
      ],
      warnings: [redundancyWarning],
    })
    expect(bothKinds.signerRequestCount).toBe(2)
    expect(bothKinds.signerMessage).toContain("exactly 2 signer requests")
    expect(bothKinds.changedObjects).toEqual([
      "Read and Publish relay preferences",
      "Private inbox relay preferences",
      "Local whole-relay removal policy",
    ])
    expect(bothKinds.warnings).toEqual([redundancyWarning])
  })

  it("keeps prepared warnings visible in both final review dialogs", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()

    expect(panelSource).toContain(
      "<PreparedReviewWarnings warnings={review.warnings} />"
    )
    expect(panelSource).toContain(
      "<PreparedReviewWarnings warnings={summary.warnings} />"
    )
  })

  it("offers signer-free redistribution for the exact retained inbox event", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({ exactInboxRedistributionAvailable: true })}
      />
    )

    expect(markup).toContain("Finish private inbox distribution")
    expect(markup).toContain("Retry exact declaration")
    expect(markup).toContain(
      "This does not create a new event or ask your signer."
    )
  })

  it("resets unpublished edits to the current Network projection", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const discardReview = panelSource.match(
      /function discardReview\(\): void \{[\s\S]*?\n {2}\}/
    )?.[0]

    expect(discardReview).toContain("setRows(controller.view.rows)")
    expect(panelSource).not.toContain("function discardReviewRows(")
  })

  it("shows exact readback evidence without an update-journal summary", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://relay.example")],
          pendingExactDeliveries: [
            {
              kind: 10050,
              label: "Private inbox",
              eventId: "f".repeat(64),
              confirmationState: "readback_pending",
              eligibleTargetCount: 3,
              exactReadbackCount: 1,
              unresolvedCount: 2,
              excludedTargetCount: 1,
              retryAvailable: true,
            },
          ],
        })}
      />
    )

    expect(markup).toContain("1 exact readback")
    expect(markup).toContain("2 unresolved")
    expect(markup).toContain("3 eligible targets")
    expect(markup).toContain("1 excluded")
    expect(markup).toContain("Retry exact signed update")
    expect(markup).not.toContain("accepted")
    expect(markup).not.toContain("timed out")
  })

  it("shows visible disclosure affordances for published preferences and relay details", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://relay.example")],
        })}
      />
    )

    expect(markup).toContain("Published preferences")
    expect(markup).toContain("Relay details")
    expect(markup.match(/lucide-chevron-down/g)).toHaveLength(2)
    expect(markup).toContain("group-open/relay-details:rotate-180")
    expect(markup).toContain("group-open/published-preferences:rotate-180")
  })

  it("never labels an all-excluded exact plan as confirmed", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          pendingExactDeliveries: [
            {
              kind: 10050,
              label: "Private inbox",
              eventId: "e".repeat(64),
              confirmationState: "policy_blocked",
              eligibleTargetCount: 0,
              exactReadbackCount: 0,
              unresolvedCount: 0,
              excludedTargetCount: 2,
              retryAvailable: false,
            },
          ],
        })}
      />
    )

    expect(markup).toContain("Targets excluded")
    expect(markup).not.toContain("Exact event confirmed")
  })

  it("offers move controls only across equivalent adjacent rows", () => {
    const equivalentMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://first.example", { signedPosition: 0 }),
            relayRow("wss://second.example", { signedPosition: 1 }),
          ],
        })}
      />
    )
    expect(equivalentMarkup).toContain(
      'aria-label="Move wss://first.example later"'
    )
    expect(equivalentMarkup).toContain(
      'aria-label="Move wss://second.example earlier"'
    )
    expect(equivalentMarkup).toContain("does not ask your signer")

    const nonEquivalentMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://responded.example", {
              signedPosition: 0,
              reachability: "responded",
            }),
            relayRow("wss://unchecked.example", {
              signedPosition: 1,
              reachability: "not_checked",
            }),
          ],
        })}
      />
    )
    expect(nonEquivalentMarkup).not.toContain('aria-label="Move ')
  })

  it("serializes local reorder writes and restores deterministic focus", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()

    expect(panelSource).toContain("if (reorderInFlightRef.current) return")
    expect(panelSource).toContain("reorderInFlightRef.current = true")
    expect(panelSource).toContain("reorderInFlightRef.current = false")
    expect(panelSource).toContain("controllerPreferredOrder")
    expect(panelSource).toContain("orderAccountNetworkRelayRows(")
    expect(panelSource).toContain("relayOrderGroupRefs.current.get(url)")
    expect(panelSource).toContain(
      'querySelector<HTMLButtonElement>("button:not(:disabled)")'
    )
    expect(panelSource).toContain(
      "removalFallbackFocusRef?.current?.focus({ preventScroll: true })"
    )
    expect(panelSource).toContain("!publishButton.disabled")
    expect(panelSource).not.toContain("setRows(presentationRows)")
    expect(panelSource).toContain(
      "addRelayInputRef.current?.focus({ preventScroll: true })"
    )
    expect(panelSource).toContain("ref={review.addRelayInputRef}")
  })

  it("rolls a rejected reorder back to the latest durable order", async () => {
    const first = relayRow("wss://first.example", { signedPosition: 0 })
    const second = relayRow("wss://second.example", { signedPosition: 1 })
    const third = relayRow("wss://third.example", { signedPosition: 2 })
    let rows = [first, second, third]
    let latestPreferredOrder = rows.map((row) => row.url)
    let rejectPersist: (reason: Error) => void = () => undefined
    const persistence = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject
    })

    const result = persistRelayOrderPreference({
      nextRows: [second, first, third],
      persist: async () => await persistence,
      latestPreferredOrder: () => latestPreferredOrder,
      updateRows: (updater) => {
        rows = updater(rows)
      },
    })

    expect(rows.map((row) => row.url)).toEqual([
      second.url,
      first.url,
      third.url,
    ])
    latestPreferredOrder = [third.url, first.url, second.url]
    rejectPersist(new Error("Could not save the relay order. Try again."))

    expect(await result).toBe("Could not save the relay order. Try again.")
    expect(rows.map((row) => row.url)).toEqual(latestPreferredOrder)
  })

  it("keeps the relay editor reset key insensitive to local reordering", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const revisionHelper = panelSource.match(
      /function getRelaySettingsEditorRevision\([\s\S]*?\n\}/
    )?.[0]

    expect(revisionHelper).toBeDefined()
    expect(revisionHelper).toContain(
      ".sort((left, right) => left[0].localeCompare(right[0]))"
    )
    expect(revisionHelper).toContain("Boolean(row.recoveryReadOnly)")
    expect(panelSource).toContain("key={editorRevision}")
  })
})
