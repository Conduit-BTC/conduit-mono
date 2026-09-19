import {
  recordBrowserTelemetryEvent,
  type ConduitTelemetryApp,
} from "../telemetry"
import {
  buildNip17CompatibilityResultTelemetryProperties,
  type Nip17CompatibilityResultTelemetryInput,
} from "../telemetry-event-properties"
import type { AccountNetworkMutationResult } from "./account-network-mutation"
import { EVENT_KINDS } from "./kinds"

/** Observe an existing Network operation without owning signing or delivery. */
export async function observeAccountNetworkInboxRepair(input: {
  app?: ConduitTelemetryApp
  includesInbox: boolean
  shouldContinue: () => boolean
  operation: () => Promise<AccountNetworkMutationResult>
  record?: (outcome: Nip17CompatibilityResultTelemetryInput) => void
}): Promise<AccountNetworkMutationResult> {
  const record = (outcome: Nip17CompatibilityResultTelemetryInput) => {
    if (!input.includesInbox || !input.shouldContinue()) return
    try {
      input.record?.(outcome)
      if (input.app) {
        recordBrowserTelemetryEvent({
          app: input.app,
          eventName: "nip17_compatibility_result",
          properties: buildNip17CompatibilityResultTelemetryProperties(outcome),
        })
      }
    } catch {
      // Optional diagnostics cannot change the operation's result.
    }
  }
  let result: AccountNetworkMutationResult
  try {
    result = await input.operation()
  } catch (error) {
    record({
      action: "declaration_repair",
      declarationClass: "unknown",
      deliveryRoute: "not_applicable",
      ackOutcome: "not_applicable",
      repairOutcome: "failed",
      blockReason: "not_applicable",
    })
    throw error
  }
  const inbox = result.checkpoints.find(
    (checkpoint) => checkpoint.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS
  )
  // A no-op or a signed withdrawal is not a repaired usable inbox.
  if (
    result.status !== "no_change" &&
    inbox?.signedEvent.tags.some((tag) => tag[0] === "relay")
  ) {
    record({
      action: "declaration_repair",
      declarationClass: inbox.pending ? "distribution_pending" : "declared",
      deliveryRoute: "not_applicable",
      ackOutcome: "not_applicable",
      repairOutcome: inbox.pending ? "confirmation_pending" : "discoverable",
      blockReason: "not_applicable",
    })
  }
  return result
}
