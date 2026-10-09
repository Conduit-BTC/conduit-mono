import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  applyInboxDeclarationDistributionStage,
  applyInboxDeclarationDistributionOutcomes,
  createInMemoryInboxDeclarationEvidenceRepository,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import { hydrateAccountNetworkPreferences } from "@conduit/core/protocol/network-preferences"
import { buildAccountNetworkSettingsView } from "@conduit/core/protocol/network-settings-view"
import { createInMemoryAccountNetworkLocalStateRepository } from "@conduit/core/protocol/account-network-local-state"
import { createInMemoryOwnerRelayListEvidenceRepository } from "@conduit/core/protocol/owner-relay-list-evidence"
import { admitFixture } from "./helpers/public-event"
import type {
  AccountNetworkRelayRowView,
  AccountNetworkSettingsController,
} from "@conduit/core"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  RelaySettingsPanel,
} from "@conduit/ui"
import {
  getRelayRemovalReviewCopy,
  persistRelayOrderPreference,
} from "../packages/ui/src/components/RelaySettingsPanel"
import {
  hasUnpublishedRelayRoleChanges,
  reconcileRelaySettingsDraftRows,
} from "../packages/ui/src/components/relay-settings-draft"

const EMPTY_FRONTIER = {
  state: "not_observed",
  currentUsable: false,
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
    relayList?: AccountNetworkSettingsController["view"]["relayList"]
    inbox?: AccountNetworkSettingsController["view"]["inbox"]
    status?: AccountNetworkSettingsController["status"]
    operationPhase?: AccountNetworkSettingsController["operation"]["phase"]
    relayInformationRefreshing?: boolean
    appRelays?: AccountNetworkSettingsController["view"]["appRelays"]
    personalRelaysEnabled?: boolean
    setupRecommendation?: AccountNetworkSettingsController["view"]["setupRecommendation"]
  } = {}
): AccountNetworkSettingsController {
  return {
    view: {
      rows: input.rows ?? [],
      ...(input.appRelays ? { appRelays: input.appRelays } : {}),
      ...(input.personalRelaysEnabled === undefined
        ? {}
        : { personalRelaysEnabled: input.personalRelaysEnabled }),
      ...(input.setupRecommendation
        ? { setupRecommendation: input.setupRecommendation }
        : {}),
      relayList: input.relayList ?? EMPTY_FRONTIER,
      inbox: input.inbox ?? EMPTY_FRONTIER,
      pendingExactDeliveries: input.pendingExactDeliveries ?? [],
    },
    status: input.status ?? "ready",
    error: null,
    revision: "test-revision",
    operation: {
      kind: null,
      phase: input.operationPhase ?? "idle",
      message: null,
    },
    relayInformationRefreshing: input.relayInformationRefreshing ?? false,
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
    setAppRelaysEnabled: async () => undefined,
    setPersonalRelaysEnabled: async () => undefined,
    dismissSetupRecommendation: async () => undefined,
    refresh: async () => undefined,
    clearOperation: () => undefined,
  }
}

describe("RelaySettingsPanel account Network review", () => {
  it("keeps roles and review available with five confirmations and two unresolved targets", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [relayRow("wss://relay.example")],
          pendingExactDeliveries: [
            {
              kind: 10002,
              label: "Read and Publish",
              eventId: "f".repeat(64),
              confirmationState: "readback_pending",
              eligibleTargetCount: 7,
              exactReadbackCount: 5,
              unresolvedCount: 2,
              excludedTargetCount: 0,
              authRequiredCount: 2,
              retryAvailable: true,
            },
          ],
        })}
      />
    )
    for (const role of ["Read", "Publish", "Private inbox"]) {
      const button = markup.match(
        new RegExp(
          `<button[^>]*aria-label="Disable ${role} for wss://relay.example"[^>]*>`
        )
      )?.[0]
      expect(button).toBeDefined()
      expect(button).not.toContain('disabled=""')
    }
    const index = markup.indexOf("Review and publish")
    expect(
      markup.slice(markup.lastIndexOf("<button", index), index)
    ).not.toContain('disabled=""')
    expect(markup).toContain("You can keep editing")
    expect(markup).toContain("Readback authorization required")
    expect(markup).toContain("2 readback targets require authorization")
    expect(markup).toContain("7 distribution targets")
    expect(markup).not.toContain("7 eligible targets")
  })

  it("labels pending signed rows by the current operation phase", () => {
    const pendingRow = relayRow("wss://pending.example", {
      readState: "pending",
      publishState: "pending",
      privateInboxState: null,
      privateInboxEnabled: false,
    })
    const waitingMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller({ rows: [pendingRow] })} />
    )
    expect(waitingMarkup).toContain("Awaiting confirmation")
    expect(waitingMarkup).not.toContain(">Publishing<")

    const publishingMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [pendingRow],
          operationPhase: "publishing",
        })}
      />
    )
    expect(publishingMarkup).toContain(">Publishing<")
    expect(publishingMarkup).not.toContain("Awaiting confirmation")
    expect(publishingMarkup).not.toContain("Recovery read-only")
  })

  it("keeps explicit review available while background discovery is degraded", () => {
    for (const status of ["reconciling", "error"] as const) {
      const markup = renderToStaticMarkup(
        <RelaySettingsPanel controller={controller({ status })} />
      )
      const reviewTextIndex = markup.indexOf("Review and publish")
      const reviewTagStart = markup.lastIndexOf("<button", reviewTextIndex)
      const reviewTagEnd = markup.indexOf(">", reviewTagStart)
      expect(markup.slice(reviewTagStart, reviewTagEnd + 1)).not.toContain(
        'disabled=""'
      )
    }
  })

  it("uses a shared accessible collapsible primitive", () => {
    const closedMarkup = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger>App Relays</CollapsibleTrigger>
        <CollapsibleContent>Managed relays</CollapsibleContent>
      </Collapsible>
    )
    const openMarkup = renderToStaticMarkup(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>App Relays</CollapsibleTrigger>
        <CollapsibleContent>Managed relays</CollapsibleContent>
      </Collapsible>
    )

    expect(closedMarkup).toContain('type="button"')
    expect(closedMarkup).toContain('aria-expanded="false"')
    expect(closedMarkup).toContain("aria-controls=")
    expect(closedMarkup).toContain('hidden=""')
    expect(openMarkup).toContain('aria-expanded="true"')
    expect(openMarkup).not.toContain('hidden=""')
  })

  it("keeps initial empty reconciliation pending before offering settled recovery", () => {
    const notCheckedFrontier = {
      ...EMPTY_FRONTIER,
      coverage: "not_checked" as const,
    }
    const unavailableFrontier = {
      ...EMPTY_FRONTIER,
      coverage: "unavailable" as const,
    }
    const pendingControllers = [
      controller({
        status: "reconciling",
        relayList: notCheckedFrontier,
        inbox: notCheckedFrontier,
      }),
      controller({ status: "reconciling" }),
      controller({
        relayList: notCheckedFrontier,
        inbox: notCheckedFrontier,
      }),
      controller({
        relayList: unavailableFrontier,
        inbox: unavailableFrontier,
        relayInformationRefreshing: true,
      }),
    ]

    for (const pendingController of pendingControllers) {
      const markup = renderToStaticMarkup(
        <RelaySettingsPanel controller={pendingController} />
      )
      expect(markup).toContain("Checking relay preferences…")
      expect(markup).not.toContain(
        "Relay preferences couldn&#x27;t be confirmed."
      )
      expect(markup).not.toContain("Retry</button>")
    }

    const settledMarkup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          relayList: unavailableFrontier,
          inbox: unavailableFrontier,
        })}
      />
    )
    expect(settledMarkup).toContain(
      "Relay preferences couldn&#x27;t be confirmed."
    )
    expect(settledMarkup).toContain("Retry</button>")
    const retryButton = settledMarkup.match(
      /<button[^>]*>[\s\S]*?Retry<\/button>/
    )?.[0]
    expect(retryButton).toBeDefined()
    expect(retryButton).not.toContain('disabled=""')
  })

  it("accepts a one-relay setup and describes the actual minimum", () => {
    const emptyMarkup = renderToStaticMarkup(
      <RelaySettingsPanel controller={controller()} />
    )
    expect(emptyMarkup).toContain(
      "No relay preferences were found on the relays checked."
    )
    expect(emptyMarkup).toContain("one Publish relay")
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
    expect(markup).toContain(
      "The previous inbox is retained while confirmation is pending."
    )
    expect(markup).toContain(
      "seven-day recovery window starts after confirmation"
    )
    expect(markup).toContain(
      'aria-label="Remove wss://previous-inbox.example from my whole setup"'
    )
    expect(markup).toContain("ends recovery for this relay immediately")
  })

  it("renders the persisted millisecond recovery clock through restored evidence and projection", async () => {
    const observedAt = 1_800_000_000_000
    const previous = "wss://grace-inbox.example"
    const signedEvent = await admitFixture(
      finalizeEvent(
        {
          kind: 10050,
          created_at: observedAt / 1_000,
          tags: [["relay", "wss://current-inbox.example"]],
          content: "",
        },
        generateSecretKey()
      )
    )
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: signedEvent.pubkey,
      signedEvent,
      previousRelayUrls: [previous],
      publishRelayUrls: ["wss://nos.lol"],
      confirmationRelayUrls: ["wss://nos.lol"],
      relayOutcomes: [
        {
          relayUrl: "wss://nos.lol",
          publishStatus: "acked",
          publishAttemptCount: 1,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
      ],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: observedAt - 1_000,
    })
    const renderRecord = async (record: typeof staged) => {
      const reconciliation = await hydrateAccountNetworkPreferences(
        signedEvent.pubkey,
        {
          inboxDeclaration: {
            evidenceRepository:
              createInMemoryInboxDeclarationEvidenceRepository(
                [record],
                () => observedAt
              ),
            now: () => observedAt,
          },
          ownerRelayList: {
            evidenceRepository:
              createInMemoryOwnerRelayListEvidenceRepository(),
            now: () => observedAt,
          },
          localStateRepository:
            createInMemoryAccountNetworkLocalStateRepository(),
        }
      )
      const view = buildAccountNetworkSettingsView({
        reconciliation,
        localState: null,
      })
      return {
        view,
        markup: renderToStaticMarkup(
          <RelaySettingsPanel controller={{ ...controller(), view }} />
        ),
      }
    }
    const pending = await renderRecord(staged)
    expect(
      pending.view.rows.find((row) => row.url === previous)?.recoveryPhase
    ).toBe("awaiting_confirmation")
    expect(
      pending.view.rows.find((row) => row.url === previous)?.recoveryExpiresAt
    ).toBeUndefined()
    const currentInbox = pending.view.rows.find(
      (row) => row.url === "wss://current-inbox.example"
    )
    expect(currentInbox?.privateInboxEnabled).toBe(true)
    expect(currentInbox?.recoveryReadOnly).not.toBe(true)
    expect(pending.view.inbox.currentUsable).toBe(true)
    expect(pending.markup).toContain(
      "seven-day recovery window starts after confirmation"
    )
    const confirmed = applyInboxDeclarationDistributionOutcomes(staged, {
      readback: [{ relayUrl: "wss://nos.lol", status: "observed" }],
      observedAt,
    })
    const { view, markup: graceMarkup } = await renderRecord(confirmed)
    const expiresAt = observedAt + INBOX_DECLARATION_CUTOVER_GRACE_MS
    expect(
      view.rows.find((row) => row.url === previous)?.recoveryExpiresAt
    ).toBe(expiresAt)
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(expiresAt))
    expect(graceMarkup).toContain(
      "Conduit reads this previous inbox during the seven-day recovery"
    )
    expect(graceMarkup).toContain(`through ${expectedDate}`)
    expect(graceMarkup).not.toContain("confirmation pending")
  })

  it("presents retained read evidence without implying an active recovery window", () => {
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [
            relayRow("wss://retained.example", {
              readEnabled: false,
              publishEnabled: false,
              privateInboxEnabled: false,
              readState: null,
              publishState: null,
              privateInboxState: null,
              retainedReadOnly: true,
            }),
          ],
        })}
      />
    )
    expect(markup).toContain("Saved read evidence")
    expect(markup).toContain("No recovery window is active.")
    expect(markup).not.toContain("Recovery read-only")
    expect(markup).not.toContain("seven-day recovery window")
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
    expect(markup).toContain("3 distribution targets")
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

  it("presents app and personal relay groups with safe relay identity imagery", () => {
    const personal = relayRow("wss://personal.example", {
      capability: {
        configuredUses: [],
        observedCommerce: false,
        nip11: "available",
        searchAdvertised: false,
        authEvidence: "untested",
        relayName: "Personal Relay",
        relayIconUrl: "https://nostr.build/personal-relay.png",
      },
    })
    const app = relayRow("wss://conduit-congee.fly.dev", {
      capability: {
        configuredUses: ["app_publishing"],
        observedCommerce: false,
        nip11: "unavailable",
        searchAdvertised: false,
        authEvidence: "untested",
        relayName: "Conduit Marketplace Relay",
        relayIconUrl: "https://nostr.build/stale-conduit-relay.png",
        relayIconFallbackUrl: "/images/logo/logo-icon.svg",
      },
    })
    const appRows = [
      app,
      ...[
        ["wss://relay.ditto.pub", "Ditto Relay"],
        ["wss://relay.primal.net", "Primal Public Relay"],
        ["wss://nos.lol", "nos.lol"],
        ["wss://relay.plebeian.market", "Plebeian Market Relay"],
      ].map(([url, relayName]) =>
        relayRow(url, {
          capability: {
            configuredUses: [],
            observedCommerce: false,
            nip11: "not_checked",
            searchAdvertised: false,
            authEvidence: "untested",
            relayName,
          },
        })
      ),
    ]
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [personal],
          appRelays: {
            enabled: true,
            rows: appRows,
            warning: "Your personal setup is missing important routes.",
          },
          personalRelaysEnabled: false,
          setupRecommendation: {
            title: "Match Conduit defaults",
            description: "Prepare recommended roles for review.",
            rows: [app],
          },
        })}
      />
    )

    expect(markup).toContain("App Relays")
    expect(markup).toContain("Your Relays")
    expect(markup).toContain(
      "5 managed routes for reliable commerce, discovery, and messaging."
    )
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('hidden=""')
    expect(markup).toContain("Match Conduit defaults")
    expect(markup.match(/\(Secondary relay\)/g)).toHaveLength(1)
    expect(markup).not.toContain("relay.dreamith.to")
    expect(markup).not.toContain("relay.conduit.market")
    expect(markup).not.toContain("relay.damus.io")
    expect(markup).toContain(
      'class="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]"'
    )
    expect(markup).toContain('src="/images/logo/logo-icon.svg"')
    expect(markup).toContain('src="https://nostr.build/personal-relay.png"')
    expect(markup).toContain('loading="lazy"')
    expect(markup).toContain('referrerPolicy="no-referrer"')
    expect(markup).toContain('aria-label="Disable App Relays"')
    expect(markup).toContain('aria-label="Enable Your Relays"')
    expect(markup).toContain('aria-label="Dismiss relay setup recommendation"')
    expect(markup.indexOf("Personal Relay")).toBeLessThan(
      markup.indexOf("wss://personal.example")
    )
  })

  it("keeps a kind-10050-only relay visible and editable while personal routing is off", () => {
    const nip65 = relayRow("wss://nip65-only.example", {
      privateInboxEnabled: false,
      privateInboxState: null,
    })
    const inboxOnly = relayRow("wss://inbox-only.example", {
      readEnabled: false,
      publishEnabled: false,
      privateInboxEnabled: true,
      readState: null,
      publishState: null,
      privateInboxState: "published",
      signedPosition: 1,
    })
    const markup = renderToStaticMarkup(
      <RelaySettingsPanel
        controller={controller({
          rows: [nip65, inboxOnly],
          appRelays: { enabled: true, rows: [] },
          personalRelaysEnabled: false,
        })}
      />
    )

    expect(markup).toContain("wss://nip65-only.example")
    expect(markup).toContain("wss://inbox-only.example")
    expect(markup).toContain('aria-label="Enable Your Relays"')
    const readButton = markup.match(
      /<button[^>]*aria-label="Enable Read for wss:\/\/inbox-only\.example"[^>]*>/
    )?.[0]
    const inboxButton = markup.match(
      /<button[^>]*aria-label="Disable Private inbox for wss:\/\/inbox-only\.example"[^>]*>/
    )?.[0]
    expect(readButton).toBeDefined()
    expect(readButton).not.toContain('disabled=""')
    expect(inboxButton).toBeDefined()
    expect(inboxButton).not.toContain('disabled=""')
  })

  it("adopts a signed relay added by a new controller revision", () => {
    const existing = relayRow("wss://existing.example")
    const added = relayRow("wss://added.example", {
      signedPosition: 1,
      reachability: "issue",
    })

    const reconciled = reconcileRelaySettingsDraftRows({
      previousControllerRows: [existing],
      localRows: [existing],
      nextControllerRows: [existing, added],
    })

    expect(reconciled.map((row) => row.url)).toContain(added.url)
    expect(reconciled.find((row) => row.url === added.url)).toEqual(added)
  })

  it("adopts a signed relay removed by a new controller revision", () => {
    const retained = relayRow("wss://retained.example")
    const removed = relayRow("wss://removed.example", { signedPosition: 1 })

    const reconciled = reconcileRelaySettingsDraftRows({
      previousControllerRows: [retained, removed],
      localRows: [retained, removed],
      nextControllerRows: [retained],
    })

    expect(reconciled.map((row) => row.url)).toEqual([retained.url])
  })

  it("preserves explicit role edits while adopting fresh controller metadata", () => {
    const previous = relayRow("wss://edited.example", {
      capability: {
        configuredUses: [],
        observedCommerce: false,
        nip11: "available",
        searchAdvertised: false,
        authEvidence: "untested",
        relayName: "Stale relay name",
      },
    })
    const local = { ...previous, publishEnabled: false }
    const current = relayRow(previous.url, {
      privateInboxEnabled: false,
      privateInboxState: null,
      signedPosition: 4,
      reachability: "issue",
      capability: {
        configuredUses: [],
        observedCommerce: false,
        nip11: "available",
        searchAdvertised: true,
        authEvidence: "advertised",
        relayName: "Fresh relay name",
        observedAt: 42,
      },
    })

    const [reconciled] = reconcileRelaySettingsDraftRows({
      previousControllerRows: [previous],
      localRows: [local],
      nextControllerRows: [current],
    })

    expect(reconciled?.publishEnabled).toBe(false)
    expect(reconciled?.privateInboxEnabled).toBe(false)
    expect(reconciled?.signedPosition).toBe(4)
    expect(reconciled?.reachability).toBe("issue")
    expect(reconciled?.capability.relayName).toBe("Fresh relay name")
    expect(reconciled?.capability.observedAt).toBe(42)
    expect(hasUnpublishedRelayRoleChanges([current], [reconciled!])).toBe(true)
  })

  it("keeps the full edited row when background discovery omits its relay", () => {
    const previous = relayRow("wss://removed.example")
    const local = { ...previous, readEnabled: false }

    const reconciled = reconcileRelaySettingsDraftRows({
      previousControllerRows: [previous],
      localRows: [local],
      nextControllerRows: [],
    })

    expect(reconciled).toEqual([
      expect.objectContaining({
        url: previous.url,
        readEnabled: false,
        publishEnabled: true,
        privateInboxEnabled: true,
        candidate: true,
      }),
    ])
    expect(hasUnpublishedRelayRoleChanges([], reconciled)).toBe(true)
  })

  it("preserves a local relay candidate across controller revisions", () => {
    const existing = relayRow("wss://existing.example")
    const candidate = relayRow("wss://candidate.example", {
      readEnabled: false,
      publishEnabled: true,
      privateInboxEnabled: false,
      readState: null,
      publishState: null,
      privateInboxState: null,
      signedPosition: null,
      candidate: true,
    })

    const reconciled = reconcileRelaySettingsDraftRows({
      previousControllerRows: [existing],
      localRows: [existing, candidate],
      nextControllerRows: [existing],
    })

    expect(reconciled.find((row) => row.url === candidate.url)).toEqual(
      candidate
    )
  })

  it("does not create a hidden publish delta for a controller-only refresh", () => {
    const retained = relayRow("wss://retained.example")
    const removed = relayRow("wss://removed.example", { signedPosition: 1 })
    const refreshed = relayRow(retained.url, {
      reachability: "issue",
      capability: {
        configuredUses: [],
        observedCommerce: false,
        nip11: "unavailable",
        searchAdvertised: false,
        authEvidence: "untested",
        observedAt: 84,
      },
    })
    const added = relayRow("wss://added.example", { signedPosition: 1 })

    const reconciled = reconcileRelaySettingsDraftRows({
      previousControllerRows: [retained, removed],
      localRows: [retained, removed],
      nextControllerRows: [refreshed, added],
    })

    expect(new Set(reconciled.map((row) => row.url))).toEqual(
      new Set([refreshed.url, added.url])
    )
    expect(hasUnpublishedRelayRoleChanges([refreshed, added], reconciled)).toBe(
      false
    )
  })

  it("requires a warning review before disabling app relays", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()

    expect(panelSource).toContain("if (!enabled && disableWarning)")
    expect(panelSource).toContain("Turn off App Relays?")
    expect(panelSource).toContain("{disableWarning}")
    expect(panelSource).toContain("controller.setAppRelaysEnabled(enabled)")
    expect(panelSource).toContain(
      "review.applySetupRecommendation(recommendation.rows)"
    )
    expect(panelSource).toContain("controller.dismissSetupRecommendation()")
    expect(panelSource).toContain("<Collapsible defaultOpen={false}>")
    expect(panelSource).toContain("appRelays.rows.length")
    expect(panelSource).toContain("group-data-[state=open]:rotate-90")
    expect(panelSource).not.toContain(
      "gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
    )
    expect(panelSource).toContain(
      'controller.prepareChange({ type: "set_roles", rows: desiredRoles })'
    )
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

  it("preserves relay drafts by account while invalidating prepared signer work", async () => {
    const panelSource = await Bun.file(
      "packages/ui/src/components/RelaySettingsPanel.tsx"
    ).text()
    const invalidationStart = panelSource.indexOf(
      "useLayoutEffect(() => {",
      panelSource.indexOf("const [removalPreparationError")
    )
    const invalidationEnd =
      panelSource.indexOf("}, [signerReviewKey])", invalidationStart) +
      "}, [signerReviewKey])".length
    const invalidationEffect = panelSource.slice(
      invalidationStart,
      invalidationEnd
    )

    expect(panelSource).toContain('key={accountPubkey ?? "no-account"}')
    expect(panelSource).toContain(
      'key={`media:${accountPubkey ?? "no-account"}`}'
    )
    expect(panelSource).toContain("signerReviewKey={signerReviewKey}")
    expect(panelSource).not.toContain("getRelaySettingsEditorRevision")
    expect(invalidationEffect).toContain("setPublishDialogOpen(false)")
    expect(invalidationEffect).toContain("setPreparedPublishChange(null)")
    expect(invalidationEffect).toContain("setPreparedRemovalChange(null)")
    expect(invalidationEffect).toContain("}, [signerReviewKey])")
    expect(invalidationEffect).not.toContain("setRows(")

    const [marketRoute, merchantRoute, controllerSource] = await Promise.all([
      Bun.file("apps/market/src/routes/network.tsx").text(),
      Bun.file("apps/merchant/src/routes/network.tsx").text(),
      Bun.file("packages/core/src/hooks/useAccountNetworkSettings.ts").text(),
    ])
    for (const route of [marketRoute, merchantRoute]) {
      expect(route).toContain(
        'signerReviewKey={`${accountPubkey ?? "none"}:${authGeneration}:${signerReadiness}`}'
      )
    }
    expect(controllerSource).toContain('current.signerReadiness === "ready"')
  })
})
