import type { Page, TestInfo } from "@playwright/test"

export function classifySmokeBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (
    /navigation.*interrupted|interrupted by another navigation/i.test(message)
  )
    return "navigation_interrupted"
  if (/ERR_CONNECTION_REFUSED|connection refused/i.test(message))
    return "connection_refused"
  if (/ERR_CONNECTION_RESET|connection reset/i.test(message))
    return "connection_reset"
  if (/ERR_NAME_NOT_RESOLVED|could not resolve|name resolution/i.test(message))
    return "name_resolution"
  if (/Target.*closed|page.*closed|browser.*closed/i.test(message))
    return "target_closed"
  if (error instanceof Error && error.name === "TimeoutError") return "timeout"
  return "unknown"
}

// Observe the original gesture and dialog lifetime without changing either.
// No labels, message contents, identifiers, or coordinates leave the page.
export async function observeMessagesDialogTrigger(page: Page) {
  return page.evaluateHandle(() => {
    let pointerDownOnTrigger = false
    let pointerUpOnTrigger = false
    let clickOnTrigger = false
    let dialogMounted = false
    let dialogRemoved = false
    const triggers = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) =>
          ["Open messages", "Close messages"].includes(
            button.getAttribute("aria-label") ??
              button.textContent?.trim() ??
              ""
          )
      )
    const isTrigger = (event: Event) =>
      event.target instanceof Node &&
      triggers().some((button) => button.contains(event.target as Node))
    const onDown = (event: Event) => {
      if (isTrigger(event)) pointerDownOnTrigger = true
    }
    const onUp = (event: Event) => {
      if (isTrigger(event)) pointerUpOnTrigger = true
    }
    const onClick = (event: Event) => {
      if (isTrigger(event)) clickOnTrigger = true
    }
    const observeDialog = () => {
      const present = !!document.querySelector('[role="dialog"]')
      if (dialogMounted && !present) dialogRemoved = true
      if (present) dialogMounted = true
    }
    const observer = new MutationObserver(observeDialog)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    observeDialog()
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("pointerup", onUp, true)
    document.addEventListener("click", onClick, true)
    const visible = (element: HTMLElement) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible"
    return {
      read() {
        observeDialog()
        const buttons = triggers()
        const trigger = buttons[0]
        const rect = trigger?.getBoundingClientRect()
        const hit = rect
          ? document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2
            )
          : null
        const dialogs = [
          ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
        ]
        return {
          observationAvailable: true,
          triggerCount: buttons.length,
          triggerVisible: !!trigger && visible(trigger),
          triggerEnabled: !!trigger && !trigger.disabled,
          triggerHitTarget: !!trigger && !!hit && trigger.contains(hit),
          documentVisible: document.visibilityState === "visible",
          documentFocused: document.hasFocus(),
          fontsLoaded: document.fonts.status === "loaded",
          pointerDownOnTrigger,
          pointerUpOnTrigger,
          clickOnTrigger,
          dialogCount: dialogs.length,
          visibleDialogCount: dialogs.filter(visible).length,
          dialogMounted,
          dialogRemoved,
        }
      },
      dispose() {
        observer.disconnect()
        document.removeEventListener("pointerdown", onDown, true)
        document.removeEventListener("pointerup", onUp, true)
        document.removeEventListener("click", onClick, true)
      },
    }
  })
}

export const commerceJourneyPhases = [
  "seed_profiles",
  "start_wallets",
  "create_contexts",
  "install_signers",
  "buyer_inbox",
  "merchant_inbox",
  "wallet_route",
  "foreign_wallet",
  "foreign_open_dialog",
  "foreign_connection_form",
  "foreign_connection_submit",
  "foreign_connected",
  "foreign_registry_order",
  "foreign_registry_refresh",
  "foreign_manage",
  "foreign_select_default",
  "foreign_default_committed",
  "receiving_wallet",
  "receiving_open_dialog",
  "receiving_connection_form",
  "receiving_connection_submit",
  "receiving_connected",
  "receiving_manage",
  "receiving_select_default",
  "receiving_default_committed",
  "publish_product",
  "verify_product",
  "store_discovery",
  "filtered_store",
  "store_catalog",
  "store_presence",
  "legacy_redirect",
  "store_ready",
  "empty_search",
  "product_search",
  "cart_add",
  "checkout",
  "send_order",
  "merchant_delivery",
  "merchant_order",
  "accept_order",
  "buyer_status",
  "generate_invoice",
  "invoice_delivery",
  "pay_invoice",
  "payment_proof",
  "merchant_settlement",
  "merchant_paid",
  "buyer_paid",
  "reload",
  "exactly_once",
  "complete",
] as const
export type CommerceJourneyPhase = (typeof commerceJourneyPhases)[number]

export const populatedAuditPhases = [
  "setup",
  "start_wallet",
  "seed_profiles",
  "install_signer",
  "profile_navigate",
  "profile_ready",
  "profile_edit",
  "payments_navigate",
  "wallet_configure",
  "wallet_reload",
  "wallet_ready",
  "wallet_contrast",
  "network_navigate",
  "network_ready",
  "catalog_navigate",
  "catalog_ready",
  "editor_open",
  "editor_ready",
  "storefront_navigate",
  "storefront_ready",
  "product_navigate",
  "product_ready",
  "legal_navigate",
  "legal_contrast",
  "complete",
] as const
export type PopulatedAuditPhase = (typeof populatedAuditPhases)[number]

type Rule = "number" | "boolean" | readonly string[]

// The evaluator receives DialogContent; the signed-action status is a direct
// child of its form. Other live regions retain earlier announcements.
export function classifyProductSubmitValidation(dialog: Element): string {
  const status = dialog.querySelector(':scope > form > div[aria-live="polite"]')
  const message = status?.textContent?.trim() ?? ""
  if (message === "Publish this product to add it to your store.")
    return "ready"
  if (message === "Add a product title.") return "title"
  if (
    /^(Image URL|Add a URL for image|Use each image URL|Use \d+ images)/.test(
      message
    )
  )
    return "images"
  if (
    /^(Add at least \d+ distinct tags|Use \d+ tags|Keep each tag to)/.test(
      message
    )
  )
    return "tags"
  if (
    /^(Add the shipping weight|Check the shipping weight|Shipping weight|Shipping dimensions)/.test(
      message
    )
  )
    return "measurements"
  if (message === "Publish your shipping table on the Shipping page first.")
    return "shipping_table"
  if (/^Price\b/.test(message)) return "price"
  if (/^Stock\b/.test(message)) return "stock"
  return "unknown"
}
export type SmokeFailureBoundary =
  "app-readiness" | "user-action" | "relay-provider" | "assertion"

export type SmokeFailureContext = {
  boundary: SmokeFailureBoundary
  expected: string
  observed: "pending" | "met" | "unmet" | "unavailable"
}

// A source file may report only its own static conditions. The boundary comes
// from this table, never from a worker-authored string.
const failureConditions: Record<
  string,
  Readonly<Record<string, SmokeFailureBoundary>>
> = {
  "e2e/commerce.playwright.ts": {
    commerce_store_navigation_completed: "app-readiness",
    commerce_buyer_paid_visible: "app-readiness",
    commerce_buyer_reloaded_paid_visible: "app-readiness",
    commerce_buyer_status_dialog_opened: "user-action",
    commerce_buyer_status_accepted_visible: "assertion",
  },
  "e2e/merchant-order-inbox.playwright.ts": {
    merchant_open_messages_click_completed: "user-action",
    merchant_messages_dialog_ready: "app-readiness",
    buyer_account_ready: "app-readiness",
    buyer_open_messages_click_completed: "user-action",
    buyer_dialog_ready: "app-readiness",
    buyer_input_filled: "user-action",
    buyer_send_clicked: "user-action",
    buyer_delivery_status_visible: "app-readiness",
    buyer_reply_saved: "assertion",
    buyer_reply_relay_observed: "relay-provider",
  },
  "e2e/merchant-product-image-preview.playwright.ts": {
    fallback_tag_input_filled: "user-action",
    fallback_tag_enter_completed: "user-action",
    fallback_tag_committed: "app-readiness",
    fallback_publish_enabled: "app-readiness",
    fallback_publish_click_completed: "user-action",
    fallback_dialog_closed: "app-readiness",
  },
  "e2e/shared-ui-composition.playwright.ts": {
    wallet_import_control_ready: "app-readiness",
    wallet_import_click_completed: "user-action",
    wallet_import_dialog_ready: "app-readiness",
  },
  "e2e/merchant-shipping-tables.playwright.ts": {
    product_publish_enabled: "app-readiness",
    product_publish_click_completed: "user-action",
    product_publish_dialog_closed: "app-readiness",
  },
  "e2e/wallet-sign-in.playwright.ts": {
    migration_route_ready: "app-readiness",
    migration_wallet_opened: "app-readiness",
  },
  "e2e/wallet-cross-app.playwright.ts": {
    wallet_refusal_sync_completed: "app-readiness",
    wallet_refusal_background_read_held: "assertion",
    wallet_refusal_foreground_import_completed: "user-action",
    wallet_refusal_import_ready: "app-readiness",
    wallet_refusal_background_released: "user-action",
    wallet_refusal_ready_preserved: "assertion",
  },
  "e2e/mobile-safari-baseline.playwright.ts": {
    mobile_wallet_setup_trigger_click_completed: "user-action",
    mobile_wallet_setup_item_ready: "app-readiness",
    mobile_wallet_setup_item_click_completed: "user-action",
    mobile_wallet_setup_dialog_ready: "app-readiness",
  },
}

export function parseSmokeFailureContext(
  file: string,
  value: unknown
): SmokeFailureContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const fields = value as Record<string, unknown>
  if (
    Object.keys(fields).length !== 2 ||
    typeof fields.expected !== "string" ||
    typeof fields.observed !== "string" ||
    !["pending", "met", "unmet", "unavailable"].includes(fields.observed)
  )
    return undefined
  const allowed = Object.hasOwn(failureConditions, file)
    ? failureConditions[file]
    : undefined
  const boundary =
    allowed && Object.hasOwn(allowed, fields.expected)
      ? allowed[fields.expected]
      : undefined
  return boundary
    ? {
        boundary,
        expected: fields.expected,
        observed: fields.observed as SmokeFailureContext["observed"],
      }
    : undefined
}

export function safeRetainedSmokeFailureContext(
  file: string,
  value: unknown
): SmokeFailureContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).length !== 3) return undefined
  const safe = parseSmokeFailureContext(file, {
    expected: fields.expected,
    observed: fields.observed,
  })
  return safe?.boundary === fields.boundary ? safe : undefined
}

export function smokeFailureContextFromAnnotations(
  file: string,
  annotations: readonly { type: string; description?: string }[]
): SmokeFailureContext | undefined {
  const matches = annotations.filter(
    (annotation) => annotation.type === "smoke:failure-context"
  )
  if (
    matches.length !== 1 ||
    !matches[0]?.description ||
    matches[0].description.length > 256
  )
    return undefined
  try {
    return parseSmokeFailureContext(file, JSON.parse(matches[0].description))
  } catch {
    return undefined
  }
}

export function recordSmokeFailureContext(
  info: TestInfo,
  expected: string,
  observed: SmokeFailureContext["observed"] = "pending"
): void {
  const file = info.file.replaceAll("\\", "/")
  const relative = file.slice(file.lastIndexOf("/e2e/") + 1)
  if (!parseSmokeFailureContext(relative, { expected, observed }))
    throw new Error("Unapproved smoke failure context")
  const type = "smoke:failure-context"
  const description = JSON.stringify({ expected, observed })
  const existing = info.annotations.find(
    (annotation) => annotation.type === type
  )
  if (existing) existing.description = description
  else info.annotations.push({ type, description })
}

const schemas: Record<string, { file: string; fields: Record<string, Rule> }> =
  {
    "wallet-import-menu": {
      file: "e2e/shared-ui-composition.playwright.ts",
      fields: {
        phase: ["before_trigger", "trigger_clicked", "import_clicked"],
        observationAvailable: "boolean",
        triggerVisible: "boolean",
        triggerEnabled: "boolean",
        importVisible: "boolean",
        importEnabled: "boolean",
        dialogVisible: "boolean",
        loadingVisible: "boolean",
        initializationErrorVisible: "boolean",
        sparkUnavailableVisible: "boolean",
        signerPromptVisible: "boolean",
      },
    },
    "wallet-background-refusal": {
      file: "e2e/wallet-cross-app.playwright.ts",
      fields: {
        phase: [
          "sync_click",
          "sync_settled",
          "background_read_held",
          "foreground_import",
          "foreground_import_settled",
          "background_released",
          "complete",
        ],
        syncObserved: "boolean",
        syncOutcome: ["pending", "resolved", "rejected"],
        foregroundImportSettled: "boolean",
        observationAvailable: "boolean",
        lockObservationAvailable: "boolean",
        heldReadInsideAccountSetupLock: "boolean",
        readinessObservationAvailable: "boolean",
        nativeSessionOpen: "boolean",
        targetRuntimeReady: "boolean",
        targetRuntimeConnecting: "boolean",
        targetRuntimeLocked: "boolean",
        targetRuntimeUnavailable: "boolean",
        targetRuntimeError: "boolean",
        walletCount: "number",
        otherReadyWalletCount: "number",
        otherConnectingWalletCount: "number",
        otherLockedWalletCount: "number",
        otherErrorWalletCount: "number",
        openingButtonCount: "number",
        otherNativeOpenWalletCount: "number",
        readyTextCount: "number",
        readyStateCount: "number",
        openButtonCount: "number",
      },
    },
    "mobile-wallet-menu": {
      file: "e2e/mobile-safari-baseline.playwright.ts",
      fields: {
        attempt: ["first", "after_reload"],
        phase: [
          "before_trigger",
          "menu_mounted",
          "trigger_clicked",
          "menu_removed",
          "item_clicked",
        ],
        observationAvailable: "boolean",
        triggerPresent: "boolean",
        triggerEnabled: "boolean",
        walletLoading: "boolean",
        menuMounted: "boolean",
        menuPresent: "boolean",
        menuOpen: "boolean",
        menuRemoved: "boolean",
        itemPresent: "boolean",
        itemVisible: "boolean",
        itemEnabled: "boolean",
        dialogPresent: "boolean",
        pointerDownOnTrigger: "boolean",
        triggerMovementDuringGesture: ["stable", "moved", "unavailable"],
      },
    },
    "wallet-balances": {
      file: "e2e/wallet-balances.playwright.ts",
      fields: {
        routeFetchCategory: [
          "closed",
          "aborted",
          "timeout",
          "network",
          "other",
        ],
        routeFetchPageClosed: "boolean",
        routeFetchNavigationRequest: "boolean",
        routeFetchNavigations: "number",
        routeFetchStarts: "number",
        routeFetchCompletes: "number",
        routeFetchStartNavigations: "number",
        routeFetchStartNavigationRequests: "number",
        routeFetchFailureNavigationRequests: "number",
        routeFetchNewNavigationRequested: "boolean",
      },
    },
    "wallet-foreground-open": {
      file: "e2e/wallet-cross-app.playwright.ts",
      fields: {
        visibleWalletCount: "number",
        nativeOpenCount: "number",
        nativeErrorCount: "number",
        nativeLockedCount: "number",
        runtimeLockedCount: "number",
        runtimeConnectingCount: "number",
        runtimeReadyCount: "number",
        runtimeErrorCount: "number",
        runtimeMissingCount: "number",
        sparkAvailability: ["ready", "unavailable"],
        openButtonCount: "number",
        openingButtonCount: "number",
        readyCount: "number",
        recoveryNotice: ["absent", "checking", "pending", "blocked"],
        signerDecryptCalls: "number",
        signerDecryptDenials: "number",
        observationAvailable: "boolean",
      },
    },
    "wallet-retry": {
      file: "e2e/wallet-registry-removal.playwright.ts",
      fields: {
        phase: ["open_details", "click_retry", "await_sync", "dismiss_details"],
        observationAvailable: "boolean",
        retryPresent: "boolean",
        retryVisible: "boolean",
        retryEnabled: "boolean",
        recoveryDialogPresent: "boolean",
        managePresent: "boolean",
        syncCheckingVisible: "boolean",
        recoveryBlockedVisible: "boolean",
        walletCardCount: "number",
      },
    },
    "merchant-image-reload": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        authReady: "boolean",
        addImagePresent: "boolean",
        addImageEnabled: "boolean",
        fallbackDisclosureVisible: "boolean",
        uploadPendingVisible: "boolean",
        claimState: [
          "absent",
          "retry_same_hash",
          "consumed",
          "malformed",
          "unavailable",
        ],
      },
    },
    "merchant-image-dialog-open": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        pointerDownObserved: "boolean",
        pointerDownOnTrigger: "boolean",
        pointerUpObserved: "boolean",
        pointerUpOnTrigger: "boolean",
        clickObserved: "boolean",
        clickOnTrigger: "boolean",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
        dialogPresent: "boolean",
        triggerConnected: "boolean",
        triggerEnabledAtDown: "boolean",
        triggerEnabledAtClick: "boolean",
        triggerEnabledAfter: "boolean",
        triggerMovementDuringGesture: ["stable", "moved", "unavailable"],
        triggerCountBefore: ["none", "one", "multiple"],
        triggerCountAfter: ["none", "one", "multiple"],
        fontsAtDown: ["loading", "loaded", "unknown"],
        fontsAtClick: ["loading", "loaded", "unknown"],
        resumeDraftPresentBefore: "boolean",
        draftKeyStateBefore: ["absent", "one", "multiple", "unavailable"],
        resumeDraftPresent: "boolean",
        draftKeyState: ["absent", "one", "multiple", "unavailable"],
      },
    },
    "manual-checkout-stop": {
      file: "e2e/manual-checkout-invoice.playwright.ts",
      fields: {
        phase: ["after_refresh", "after_reload"],
        relayAccepted: "boolean",
        relayDelivered: "boolean",
        observationAvailable: "boolean",
        wrapperState: [
          "missing",
          "queued",
          "waiting_for_signer",
          "opening",
          "permission_declined",
          "opened",
          "unsupported",
          "malformed",
          "invalid_envelope",
          "retryable_failure",
          "provider_unavailable",
          "machine",
          "unrelated",
          "deleted",
          "expired",
        ],
        projectionStored: "boolean",
        signerPresent: "boolean",
        paymentViewVisible: "boolean",
        warningVisible: "boolean",
      },
    },
    "wallet-migration": {
      file: "e2e/wallet-sign-in.playwright.ts",
      fields: {
        passwordPresent: "boolean",
        showEnabled: "boolean",
        scenario: ["none", "sdk-open", "post-open"],
        phase: [
          "seed",
          "open_dialog",
          "password",
          "migrate",
          "failed_open",
          "retry",
          "credential",
          "lock_reopen",
          "previous_password",
          "fresh_signin",
          "route_fetch_failed",
          "second_wallet",
          "legacy_recovery",
          "legacy_menu",
          "legacy_dialog",
          "legacy_password",
          "legacy_reveal",
          "legacy_close",
          "legacy_focus",
          "signer_recovery",
          "complete",
        ],
        elapsedSeconds: "number",
        routeFetchCategory: [
          "closed",
          "aborted",
          "timeout",
          "network",
          "other",
        ],
        routeFetchPageClosed: "boolean",
        routeFetchNavigationRequest: "boolean",
        routeFetchNavigations: "number",
        routeFetchStarts: "number",
        routeFetchCompletes: "number",
      },
    },
    "commerce-inbox-reconnect": {
      file: "e2e/commerce-inbox.playwright.ts",
      fields: {
        observationAvailable: "boolean",
        controlCount: "number",
        controlVisible: "boolean",
        dialogCount: "number",
        composerVisible: "boolean",
        bodyMatchCount: "number",
        visibleBodyMatchCount: "number",
        loadingHistoryVisible: "boolean",
        emptyHistoryVisible: "boolean",
        unavailableHistoryVisible: "boolean",
        buyerDirectCountReachedThreeBeforeReconnect: "boolean",
        sessionCurrent: "boolean",
        providerReady: "boolean",
        localObservationAvailable: "boolean",
        localCoverage: ["complete", "partial", "unavailable"],
        localDirectCount: "number",
        localReplyRetained: "boolean",
        localPending: "boolean",
        localStorageFailed: "boolean",
      },
    },
    "commerce-inbox-self-copy": {
      file: "e2e/commerce-inbox.playwright.ts",
      fields: {
        phase: [
          "setup_complete",
          "reconnect_complete",
          "loop_enter",
          "before_send",
          "send_completed",
          "status_visible",
          "text_persisted",
          "before_attachment",
          "attachment_completed",
          "attachment_status_visible",
          "file_persisted",
          "complete",
        ],
        principal: ["none", "buyer", "seller"],
        elapsedSeconds: "number",
        nearCaseDeadline: "boolean",
        caseDeadlinePassed: "boolean",
        clickStarted: "boolean",
        clickResolved: "boolean",
        observationAvailable: "boolean",
        observationWhen: ["send_pending"],
        sendVisible: "boolean",
        sendEnabled: "boolean",
        draftPresent: "boolean",
        sessionCurrent: "boolean",
        providerReady: "boolean",
        localPending: "boolean",
        localStorageFailed: "boolean",
        textPersisted: "boolean",
      },
    },
    "router-retirement": {
      file: "e2e/commerce-router-recovery.playwright.ts",
      fields: {
        phase: [
          "nonzero_observed",
          "zero_applied",
          "fresh_check_started",
          "retirement_observed",
          "failure",
        ],
        scoped: "boolean",
        zeroFixtureApplied: "boolean",
        observationAvailable: "boolean",
        persistedState: ["absent", "active", "retired"],
        availableZero: ["confirmed", "not_confirmed", "unobserved"],
        ownedZero: ["confirmed", "not_confirmed", "unobserved"],
        pendingEmpty: ["confirmed", "not_confirmed", "unobserved"],
        progressPresent: "boolean",
        cleanupComplete: "boolean",
      },
    },
    "commerce-buyer-status": {
      file: "e2e/commerce.playwright.ts",
      fields: {
        phase: ["before_open", "after_click", "assertion_end", "failure"],
        observationAvailable: "boolean",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
        pointerDownOnTrigger: "boolean",
        pointerUpOnTrigger: "boolean",
        pointerUpObserved: "boolean",
        pointerCancelObserved: "boolean",
        pointerType: ["mouse", "touch", "pen", "unavailable"],
        triggerDetachedDuringGesture: "boolean",
        triggerReplacedDuringGesture: "boolean",
        documentVisible: "boolean",
        documentFocused: "boolean",
        fontsLoaded: "boolean",
        clickOnTrigger: "boolean",
        triggerMovementDuringGesture: ["stable", "moved", "unavailable"],
        dialogCount: "number",
        acceptedCount: "number",
        visibleAcceptedCount: "number",
        sessionCurrent: "boolean",
        providerReady: "boolean",
        localObservationAvailable: "boolean",
        localPending: "boolean",
        localStorageFailed: "boolean",
        localOrderCount: "number",
        localAcceptedCount: "number",
        localCoverage: ["complete", "partial", "unavailable"],
      },
    },
    "commerce-journey": {
      file: "e2e/commerce.playwright.ts",
      fields: {
        buyerObservationAvailable: "boolean",
        buyerLifecyclePaid: "boolean",
        buyerProofSent: "boolean",
        buyerPaidMessages: "number",
        buyerMessageDialogVisible: "boolean",
        buyerReadAfterReload: "boolean",
        phase: commerceJourneyPhases,
        elapsedSeconds: "number",
        phaseSeconds: "number",
        slowestPhase: commerceJourneyPhases,
        slowestSeconds: "number",
        cleanupStarted: "boolean",
        cleanupComplete: "boolean",
        makeInvoice: "number",
        payInvoice: "number",
        lookupInvoice: "number",
        foreignMakeInvoice: "number",
        foreignReceiveCapable: "boolean",
        foreignAlreadyReceiving: "boolean",
        foreignRegistryRefreshObserved: "boolean",
        foreignMenuVisibleBeforeClick: "boolean",
        foreignMenuEnabledBeforeClick: "boolean",
        foreignMenuHitTargetBeforeClick: "boolean",
        navigationObservationAvailable: "boolean",
        navigationResponseObserved: "boolean",
        navigationResponseStatus: "number",
        navigationRequestFailed: "boolean",
        navigationCommitted: "boolean",
        navigationPageClosed: "boolean",
        navigationFailure: [
          "navigation_interrupted",
          "connection_refused",
          "connection_reset",
          "name_resolution",
          "target_closed",
          "timeout",
          "unknown",
        ],
      },
    },
    "price-interaction": {
      file: "e2e/shared-ui-visual-contract.playwright.ts",
      fields: {
        pointerDown: "boolean",
        pointerUp: "boolean",
        click: "boolean",
        connected: "boolean",
        enabled: "boolean",
        quantity: "number",
      },
    },
    "fallback-upload": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        phase: [
          "setup",
          "open_draft",
          "seed_identity",
          "navigate",
          "catalog",
          "open_dialog",
          "dialog_visible",
          "wrap_signer",
          "invalid_file",
          "valid_file",
          "restore_draft",
          "discard_draft",
          "fresh_file",
          "tag_entry",
          "publish",
          "listing_edit",
          "complete",
        ],
        observationAvailable: "boolean",
        dialogCount: "number",
        inboxPrompt: "boolean",
        invalidControls: "number",
        submitEnabled: "boolean",
        submitState: ["publish", "uploading", "saving", "reconnect", "other"],
        tagCount: "number",
        tagOrdinal: "number",
        tagDraftPresent: "boolean",
        tagFocused: "boolean",
        digitalSelected: "boolean",
        insufficientTagsNotice: "boolean",
      },
    },
    "populated-audit": {
      file: "e2e/shared-ui-populated-audit.playwright.ts",
      fields: {
        phase: populatedAuditPhases,
        elapsedSeconds: "number",
        pageCrashed: "boolean",
      },
    },
    "surface-audit": {
      file: "e2e/shared-ui-surface-audit.playwright.ts",
      fields: {
        phase: [
          "setup",
          "navigate",
          "render",
          "fonts",
          "measure",
          "capture",
          "complete",
        ],
        routeIndex: "number",
        pageCrashed: "boolean",
        networkProcessCrashed: "boolean",
        failedDocuments: "number",
        pendingDocuments: "number",
        pendingImages: "number",
        pendingFonts: "number",
        pendingScripts: "number",
        navigationError: [
          "none",
          "aborted",
          "interrupted",
          "timeout",
          "closed",
          "crashed",
          "internal",
          "other",
        ],
      },
    },
    "cart-stale-action": {
      file: "e2e/market-cart-concurrency.playwright.ts",
      fields: {
        phase: [
          "seed",
          "navigate",
          "ready",
          "remove",
          "stale_decrease",
          "stale_increase",
          "resume",
          "release",
          "reload",
          "complete",
        ],
        tabIndex: "number",
      },
    },
    "order-reply": {
      file: "e2e/merchant-order-inbox.playwright.ts",
      fields: {
        phase: [
          "setup",
          "merchant_navigate",
          "merchant_catalog",
          "merchant_open_dialog",
          "merchant_dialog",
          "merchant_form",
          "publish_product",
          "buyer_checkout",
          "send_order",
          "merchant_order",
          "merchant_reply",
          "merchant_restore",
          "buyer_delivery",
          "buyer_reply",
          "buyer_dialog",
          "buyer_input_filled",
          "buyer_send_clicked",
          "buyer_restore",
          "merchant_delivery",
          "complete",
        ],
        orderMessages: "number",
        distinctSenders: "number",
        distinctRecipients: "number",
        decryptFailures: "number",
        pending: "boolean",
        storageUnavailable: "boolean",
        queued: "number",
        opened: "number",
        dialogVisible: "boolean",
        inputPresent: "boolean",
        inputVisible: "boolean",
        inputEnabled: "boolean",
        sendPresent: "boolean",
        focusWithinDialog: "boolean",
        observationAvailable: "boolean",
        triggerCount: "number",
        triggerVisible: "boolean",
        triggerEnabled: "boolean",
        triggerHitTarget: "boolean",
        documentVisible: "boolean",
        documentFocused: "boolean",
        fontsLoaded: "boolean",
        pointerDownOnTrigger: "boolean",
        pointerUpOnTrigger: "boolean",
        clickOnTrigger: "boolean",
        dialogCount: "number",
        visibleDialogCount: "number",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
      },
    },
    "fallback-recovery": {
      file: "e2e/merchant-product-image-preview.playwright.ts",
      fields: {
        phase: [
          "setup",
          "open_draft",
          "upload",
          "fulfillment_selected",
          "tag_entry",
          "publish_ready",
          "guard_publish",
          "guard_rejected",
          "restore_draft",
          "recovery_publish",
          "inbox_setup",
          "listing_edit",
          "complete",
        ],
        fulfillmentFocusedAtSelection: "boolean",
        tagInputFocused: "boolean",
        committedTagCount: "number",
        publishEnabled: "boolean",
      },
    },
    "footer-follow": {
      file: "e2e/mobile-safari-baseline.playwright.ts",
      fields: {
        phase: ["initial", "hidden", "returned"],
        footerTop: "number",
        cartBottom: "number",
        scrollY: "number",
        viewportHeight: "number",
        footerHidden: "boolean",
        scrollEvents: "number",
        lastScrollY: "number",
        lastDelta: "number",
        mainHeight: "number",
        maxScrollY: "number",
        mobileQueryMatches: "boolean",
      },
    },
    "footer-layout": {
      file: "e2e/mobile-safari-baseline.playwright.ts",
      fields: {
        phase: ["initial", "returned"],
        layout: ["missing", "clipped", "intersecting", "disjoint"],
        triggerX: "number",
        triggerY: "number",
        triggerWidth: "number",
        triggerHeight: "number",
        footerX: "number",
        footerY: "number",
        footerWidth: "number",
        footerHeight: "number",
        viewportWidth: "number",
        viewportHeight: "number",
        scrollY: "number",
        measuredFooterHeight: "number",
        footerHidden: "boolean",
        widgetMarginBottom: "number",
        widgetTransformY: "number",
        footerTransformY: "number",
        widgetHiddenShift: "number",
        widgetBottomOffset: "number",
        atomicTriggerY: "number",
        atomicTriggerBottom: "number",
        atomicFooterLinkTop: "number",
        atomicFooterHeight: "number",
        atomicLayout: ["missing", "intersecting", "disjoint"],
        triggerMarginBottom: "number",
        triggerTransformY: "number",
      },
    },
    "product-dialog-open": {
      file: "e2e/commerce.playwright.ts",
      fields: {
        pointerDownOnTrigger: "boolean",
        pointerUpOnTrigger: "boolean",
        clickOnTrigger: "boolean",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
        dialogPresent: "boolean",
        triggerEnabled: "boolean",
        fontsAtClick: ["loading", "loaded", "unknown"],
        triggerX: "number",
        triggerY: "number",
        triggerStartY: "number",
        triggerDownY: "number",
        triggerUpY: "number",
        triggerWidth: "number",
        triggerHeight: "number",
      },
    },
    "variation-dialog-open": {
      file: "e2e/merchant-variation-shipping.playwright.ts",
      fields: {
        pointerDownOnTrigger: "boolean",
        pointerUpOnTrigger: "boolean",
        clickOnTrigger: "boolean",
        dialogMounted: "boolean",
        dialogRemoved: "boolean",
        dialogPresent: "boolean",
        triggerEnabled: "boolean",
        fontsAtClick: ["loading", "loaded", "unknown"],
        triggerX: "number",
        triggerY: "number",
        triggerWidth: "number",
        triggerHeight: "number",
      },
    },
    "product-submit": {
      file: "e2e/merchant-shipping-tables.playwright.ts",
      fields: {
        phase: ["first_product", "second_product"],
        present: "boolean",
        enabled: "boolean",
        signerAvailable: "boolean",
        invalidControls: "number",
        invalidTitle: "boolean",
        invalidPrice: "boolean",
        invalidStock: "boolean",
        invalidShippingWeight: "boolean",
        invalidTags: "boolean",
        invalidImages: "boolean",
        invalidOther: "boolean",
        imageRowCount: "number",
        blankImageRows: "number",
        invalidImageRows: "number",
        primaryImageMatchesExpected: "boolean",
        expectedImagePresent: "boolean",
        action: [
          "publish",
          "waiting_signer",
          "uploading",
          "reconnect",
          "other",
        ],
        validation: [
          "ready",
          "title",
          "price",
          "stock",
          "images",
          "tags",
          "measurements",
          "shipping_table",
          "other",
          "unknown",
        ],
      },
    },
  }

/** Only fixed fields and bounded scalar observations may leave a smoke worker. */
export function safeSmokeDiagnostics(
  file: string,
  annotations: readonly { type: string; description?: string }[] = []
): Array<Record<string, string | number | boolean>> {
  const diagnostics: Array<Record<string, string | number | boolean>> = []
  for (const [kind, schema] of Object.entries(schemas)) {
    if (
      schema.file !== file &&
      !(
        kind === "wallet-retry" && file === "e2e/wallet-cross-app.playwright.ts"
      )
    )
      continue
    const raw = annotations.find(
      (item) => item.type === `smoke:${kind}`
    )?.description
    if (!raw || raw.length > 2048) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const safe: Record<string, string | number | boolean> = { kind }
    for (const [key, rule] of Object.entries(schema.fields)) {
      const value = (parsed as Record<string, unknown>)[key]
      if (
        rule === "number" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= 32768
      )
        safe[key] = Math.round(value * 10) / 10
      else if (rule === "boolean" && typeof value === "boolean")
        safe[key] = value
      else if (
        Array.isArray(rule) &&
        typeof value === "string" &&
        rule.includes(value)
      )
        safe[key] = value
    }
    if (Object.keys(safe).length > 1) diagnostics.push(safe)
  }
  return diagnostics
}

/** Recheck transient report data before including it in public CI text. */
export function safeRetainedSmokeDiagnostics(
  file: string,
  value: unknown
): Array<Record<string, string | number | boolean>> {
  if (!Array.isArray(value) || value.length > 4) return []
  const seen = new Set<string>()
  const safe: Array<Record<string, string | number | boolean>> = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const kind = (item as Record<string, unknown>).kind
    if (typeof kind !== "string" || seen.has(kind)) continue
    seen.add(kind)
    const retained = safeSmokeDiagnostics(file, [
      { type: `smoke:${kind}`, description: JSON.stringify(item) },
    ])
    for (const diagnostic of retained) {
      safe.push(
        Object.fromEntries(
          Object.entries(diagnostic).filter(([key]) => !key.endsWith("Seconds"))
        )
      )
    }
  }
  return safe
}

export function recordSmokeDiagnostic(
  info: TestInfo,
  kind:
    | "wallet-import-menu"
    | "wallet-foreground-open"
    | "wallet-retry"
    | "wallet-background-refusal"
    | "mobile-wallet-menu"
    | "wallet-balances"
    | "merchant-image-reload"
    | "merchant-image-dialog-open"
    | "manual-checkout-stop"
    | "commerce-inbox-reconnect"
    | "commerce-inbox-self-copy"
    | "router-retirement"
    | "commerce-journey"
    | "commerce-buyer-status"
    | "wallet-migration"
    | "price-interaction"
    | "fallback-upload"
    | "surface-audit"
    | "populated-audit"
    | "cart-stale-action"
    | "footer-follow"
    | "footer-layout"
    | "product-submit"
    | "product-dialog-open"
    | "variation-dialog-open"
    | "order-reply"
    | "fallback-recovery",
  values: Record<string, unknown>
): void {
  const type = `smoke:${kind}`
  const description = JSON.stringify(values)
  const annotation = info.annotations.find((item) => item.type === type)
  if (annotation) annotation.description = description
  else info.annotations.push({ type, description })
}
