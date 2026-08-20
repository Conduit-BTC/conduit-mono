import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { getWalletCapabilityPills } from "../apps/market/src/lib/wallet-capabilities"
import {
  getWalletNetworkLabel,
  getWalletProviderDescription,
} from "../apps/market/src/lib/wallet-provider-label"

describe("Market wallet route contracts", () => {
  it("lets the shared NWC parser validate wallet connection strings", async () => {
    const content = await readFile(
      "apps/market/src/hooks/useWallets.ts",
      "utf8"
    )

    expect(content).toContain("parseNwcUri(uri)")
    expect(content).not.toContain('startsWith("nostr+walletconnect://")')
  })

  it("observes committed wallet mutations and reloads prepared state", async () => {
    const hook = await readFile("apps/market/src/hooks/useWallets.ts", "utf8")
    const route = await readFile("apps/market/src/routes/wallet.tsx", "utf8")
    const database = await readFile("packages/core/src/db/index.ts", "utf8")
    const finalizations =
      hook.match(/await refreshAfterCommittedWalletMutation\(\)/g) ?? []
    const sparkRegistrations =
      hook.match(/await registerSparkWallet\(\{/g) ?? []

    expect(finalizations.length).toBeGreaterThanOrEqual(6)
    expect(sparkRegistrations).toHaveLength(1)
    expect(hook).toContain("const setupSparkWallet = useCallback(")
    expect(database).toContain(
      "liveQuery(() => db.wallets.toArray()).subscribe"
    )
    expect(hook).toContain("subscribeToWalletDescriptorChanges")
    expect(hook).toContain("setWalletSubscriptionEpoch")
    expect(hook).toContain("notifyWalletChangeFallback()")
    expect(hook).not.toContain("notifyWalletsChanged")
    expect(hook).not.toMatch(/passkey|VITE_BREEZ_API_KEY|breez-spark-sdk/i)
    expect(hook).toMatch(
      /await store\.transaction\(async \(\) => \{[\s\S]{0,300}await registry\.remove/
    )
    expect(hook).toContain("getWalletDefaultReplacement(remaining")
    expect(route).toContain("{wallets.initializationError}")
    expect(route).not.toContain("Wallet data on this device was left unchanged")
  })

  it("serializes Spark unlock and removal and cleans removed manager state on reload", async () => {
    const hook = await readFile("apps/market/src/hooks/useWallets.ts", "utf8")

    expect(hook.match(/await openRegisteredSparkWallet\(\{/g)).toHaveLength(1)
    expect(hook).toContain("await sparkManager.closeWalletsExcept(")
    expect(hook.match(/afterOpen: \(\) =>/g)).toHaveLength(1)
    expect(hook).not.toContain("onValidated")
    expect(hook).toMatch(
      /requestedWallet\.providerId === "spark"[\s\S]{0,180}runSparkWalletRemoval/
    )
    expect(hook).toMatch(
      /await cleanupSparkWalletState\(\{[\s\S]{0,500}await store\.transaction/
    )
  })

  it("renders plural Portable and Connected wallet groups", async () => {
    const content = await readFile("apps/market/src/routes/wallet.tsx", "utf8")
    const recoveryBundleDetails = await readFile(
      "apps/market/src/components/SparkRecoveryBundleDetails.tsx",
      "utf8"
    )

    expect(content).toContain('title="Portable"')
    expect(content).toContain('title="Connected"')
    expect(content).toContain("Add portable wallet")
    expect(content).toContain("Add a Spark wallet")
    expect(content).toContain("Spark is the first Portable Wallet provider.")
    expect(content).toContain("Create Spark wallet")
    expect(content).toContain("Restore Spark wallet")
    expect(content).toContain("Save your Spark recovery details")
    expect(content).toContain("Spark is currently supported.")
    expect(content).toContain("Spark wallet setup mode")
    expect(content).toContain("Wallet nickname (optional)")
    expect(content).toContain("On this device")
    expect(content).toContain("Advanced recovery settings")
    expect(content).toContain("MAX_SPARK_ACCOUNT_NUMBER")
    expect(content).toContain("Change only if the source")
    expect(content).toContain("wallet specifies a different account number.")
    expect(content).toContain(
      "Use this nickname to identify the wallet in Conduit."
    )
    expect(content).toContain("Encrypts the recovery phrase in this browser.")
    expect(content).toContain("is not needed to")
    expect(content).toContain("BIP39 phrase, Spark account number, and network")
    expect(content).not.toContain("compatible Spark application")
    expect(content).not.toContain("The phrase is the cross-application backup")
    expect(content).not.toContain("Restore from phrase")
    expect(content).toContain("Connect wallet")
    expect(content).toContain("wallets.portableWallets")
    expect(content).toContain("wallets.connectedWallets")
    expect(content).toContain("wallets.setDefaultPaymentWallet")
    expect(content).toContain("wallets.refreshBalance")
    expect(content).toContain("getWalletCapabilityPills")
    expect(content).toContain("Remove from this device")
    expect(content).toContain("does not delete the Portable Wallet")
    expect(content).toMatch(
      /I have the recovery details required to restore this Portable\s+Wallet/
    )
    expect(content).not.toContain("does not delete the Spark wallet")
    expect(content).toContain("getWalletProviderDescription")
    expect(content).toContain("getWalletNetworkLabel")
    expect(content).toContain(
      "Uses real bitcoin and supports Lightning and Spark payments."
    )
    expect(content).toContain("This wallet is separate from Bitcoin Mainnet.")
    expect(recoveryBundleDetails).toContain("Copy recovery details")
    expect(content).toContain("useShopperPricing")
    expect(content).toContain("formatBitcoinBaseUnits")
    expect(content).toContain("sats === 0")
    expect(content).toContain("Sats the standard")
    expect(content).toContain("SUPPORTED_SHOPPER_DISPLAY_CURRENCIES")
    expect(content).not.toMatch(/passkey|Breez/i)
  })

  it("labels future providers without changing Portable/Connected language", () => {
    expect(
      getWalletProviderDescription({
        kind: "portable",
        providerId: "spark",
        network: "mainnet",
      })
    ).toBe("Spark wallet · Mainnet")
    expect(
      getWalletProviderDescription({
        kind: "portable",
        providerId: "wavelength",
        network: "mainnet",
      })
    ).toBe("Wavelength Portable Wallet")
    expect(
      getWalletProviderDescription({
        kind: "connected",
        providerId: "nwc",
        network: "mainnet",
      })
    ).toBe("Connected via NWC")
  })

  it("uses clear Bitcoin network labels", () => {
    expect(getWalletNetworkLabel("mainnet")).toBe("Bitcoin Mainnet")
    expect(getWalletNetworkLabel("regtest")).toBe("Regtest")
  })

  it("renders advertised Alby NWC permissions as supported capability pills", () => {
    const capabilities = getWalletCapabilityPills({
      methods: [
        "get_balance",
        "get_budget",
        "get_info",
        "list_transactions",
        "lookup_invoice",
        "make_invoice",
        "pay_invoice",
        "sign_message",
      ],
      notifications: ["payment_received", "payment_sent"],
    })

    expect(capabilities).toEqual([
      {
        id: "method:get_balance",
        label: "Read balance",
        variant: "success",
      },
      {
        id: "method:get_budget",
        label: "Read budget",
        variant: "success",
      },
      {
        id: "method:get_info",
        label: "Read node info",
        variant: "success",
      },
      {
        id: "method:list_transactions",
        label: "Read transaction history",
        variant: "success",
      },
      {
        id: "method:lookup_invoice",
        label: "Lookup invoices",
        variant: "success",
      },
      {
        id: "method:make_invoice",
        label: "Create invoices",
        variant: "success",
      },
      {
        id: "method:pay_invoice",
        label: "Send payments",
        variant: "success",
      },
      {
        id: "method:sign_message",
        label: "Sign messages",
        variant: "success",
      },
      {
        id: "notification:wallet",
        label: "Wallet notifications",
        variant: "success",
      },
    ])
  })

  it("does not put wallet balance in the global Market header by default", async () => {
    const content = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )

    expect(content).not.toContain("Connected wallet balance")
    expect(content).not.toContain("balanceMsats")
    expect(content).not.toContain("refreshBalance: true")
    expect(content).toContain('label="Wallets"')
  })

  it("keeps header destinations named and current without crowding narrow screens", async () => {
    const content = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )

    expect(content).toContain('aria-current={active ? "page" : undefined}')
    expect(content).toContain("aria-label={ariaLabel ?? label}")
    expect(content).toContain("Cart, ${cart.totals.count}")
    expect(content.match(/min-\[400px\]:(?:inline|inline-flex)/g)).toHaveLength(
      2
    )
  })

  it("lets checkout explicitly select any eligible payment target", async () => {
    const content = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )
    const targetContent = await readFile(
      "apps/market/src/components/PaymentTargetSelectContent.tsx",
      "utf8"
    )

    expect(content).toContain("const wallets = useWallets()")
    expect(content).toContain('candidate.capabilities.includes("pay_invoice")')
    expect(content).toContain('id="checkout-wallet"')
    expect(content).toContain("setPaymentTargetSelection")
    expect(content).toContain("resolveWalletPaymentInstance")
    expect(content).toContain("selectedWalletTarget?.walletId")
    expect(content).toContain("selectedWalletTarget?.providerId")
    expect(content).toContain("paymentTargetOptions")
    expect(content).toContain("<PaymentTargetSelectContent")
    expect(content).toContain("<PaymentTargetSelectValue")
    expect(content).toContain("showDefaultBadge")
    expect(targetContent).toContain("export function PaymentTargetSelectValue")
    expect(targetContent).toContain("PAYMENT_TARGET_SELECT_TRIGGER_CLASS_NAME")
    expect(targetContent).toContain("[&>span]:basis-0")
    expect(targetContent).toContain('className="w-0 min-w-0 flex-1 truncate"')
    expect(targetContent).toContain("Browser wallet (WebLN)")
    expect(targetContent).toContain("Show invoice for manual payment")
    expect(targetContent).toContain("getWalletProviderDescription")
    expect(targetContent).toContain("Previously selected wallet (unavailable)")
    expect(targetContent).toContain("textValue=")
    expect(content).toContain("paymentTarget: storedPaymentTarget")
    expect(content).toContain("sparkFeeApproval.requestApproval")
    expect(content).toContain("Wallet balance")
    expect(content).toContain("getKnownWalletPaymentConstraint")
    expect(content).toContain("Automatic wallet payment will be skipped")
    expect(content).toContain("Hold to send order and show invoice")
    expect(content).toContain("HoldToReleaseButton")
    expect(content).toContain("if (canAttemptLightningPayment)")
    expect(content).toContain('selectedPaymentTarget.type === "wallet"')
    expect(content).toContain('selectedPaymentTarget.type === "webln"')

    const feeApproval = await readFile(
      "apps/market/src/components/SparkFeeApprovalDialog.tsx",
      "utf8"
    )
    expect(feeApproval).toContain("focusReturnRef")
    expect(feeApproval).toContain("focusTarget?.isConnected")
    expect(feeApproval).toContain("Review maximum Lightning fee")
    expect(feeApproval).toContain("Maximum total")
    expect(feeApproval).toContain("No bitcoin will be sent until")
    expect(feeApproval).toContain(
      "The final fee may be lower than this approved maximum."
    )
  })

  it("does not resolve saved-wallet checkout choices before storage is ready", async () => {
    const content = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )

    expect(content).toContain("wallets.loading")
    expect(content).toContain("Loading saved wallets")
    expect(content).toContain("{wallets.initializationError}")
    expect(content).toContain("wallets.retryInitialization()")
    expect(content).toMatch(
      /const canAttemptLightningPayment =\s+!wallets\.loading/
    )
    expect(content).toMatch(
      /const allowsManualLightningFallback =\s+!wallets\.loading/
    )
  })

  it("keeps a removed checkout wallet unavailable until explicit reselection", async () => {
    const content = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )
    const targetContent = await readFile(
      "apps/market/src/components/PaymentTargetSelectContent.tsx",
      "utf8"
    )

    expect(content).toMatch(
      /selectedWalletTarget !== null && selectedWallet === null/
    )
    expect(content).not.toContain("isCheckoutWalletTargetStale")
    expect(content).toContain("selectedPaymentTargetIsStale")
    expect(targetContent).toContain("Previously selected wallet (unavailable)")
    expect(content).toMatch(
      /Choose another payment target before zap out\.\s+You can still send the order first\./
    )
    expect(content).toMatch(
      /role="alert"[\s\S]{0,240}text-\[var\(--text-secondary\)\]/
    )
    expect(content).not.toContain("setPaymentTargetSelection(null)")
  })

  it("keeps local Spark removal available when provider actions are unavailable", async () => {
    const hook = await readFile("apps/market/src/hooks/useWallets.ts", "utf8")
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(hook).toContain("runSparkWalletRemoval")
    expect(hook).toContain('mode === "local-only"')
    expect(hook).toContain("assertLocalSparkWalletRemovalSafe")
    expect(hook).toContain("isSparkWalletManagerInitialized")
    expect(wallet).toMatch(
      /disabled=\{pending\}\s+onClick=\{\(event\) => onRemove\(wallet, event\.currentTarget\)\}/
    )
    expect(wallet).toContain(
      "This removes the wallet registration and encrypted recovery copy from this browser."
    )
  })

  it("keeps multi-wallet controls accessible on narrow screens and failure states", async () => {
    const checkout = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )
    const targetContent = await readFile(
      "apps/market/src/components/PaymentTargetSelectContent.tsx",
      "utf8"
    )
    const recoveryBundleDetails = await readFile(
      "apps/market/src/components/SparkRecoveryBundleDetails.tsx",
      "utf8"
    )
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(targetContent).toContain(
      "w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]"
    )
    expect(targetContent).toContain("[&_[data-radix-select-viewport]]:min-w-0")
    expect(targetContent).toContain("[overflow-wrap:anywhere]")
    expect(checkout).toContain(
      'className="mt-3 text-xs leading-5 text-[var(--text-secondary)]"'
    )
    expect(wallet).toContain('<TabsTrigger value="create" disabled={pending}>')
    expect(wallet).toContain('<TabsTrigger value="restore" disabled={pending}>')
    expect(wallet).toMatch(/<TabsContent value="create"/)
    expect(wallet).toMatch(/<TabsContent value="restore"/)
    expect(wallet).toContain('aria-label="Spark wallet setup mode"')
    expect(wallet).not.toContain('aria-pressed={mode === "create"}')
    expect(wallet).not.toContain('aria-pressed={mode === "restore"}')
    expect(wallet.match(/<form/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(wallet).toContain('type="submit"')
    expect(wallet).toContain("recoveryHeadingRef.current?.focus()")
    expect(wallet).toContain("restoreDialogFocus")
    expect(wallet).toContain("dialogTriggerRef.current = event.currentTarget")
    expect(wallet).toContain('runtime.status === "ready" ? "Refresh" : "Retry"')
    expect(wallet).toContain("Payment request copied.")
    expect(wallet).toContain("Copy was blocked. Copy the request manually.")
    expect(recoveryBundleDetails).toContain(
      "Your clipboard may be readable by other apps or synced between"
    )
    expect(
      recoveryBundleDetails.match(/function SparkRecoveryBundleDetails\(/g)
    ).toHaveLength(1)
    expect(wallet.match(/<SparkRecoveryBundleDetails /g)).toHaveLength(2)
    expect(wallet).toMatch(
      /Copying\s+a recovery phrase puts it on your system clipboard/
    )
    expect(wallet).toMatch(
      /await wallets\.createSpark\(walletLabel, password\)\s+setPassword\(""\)/
    )
    expect(wallet).toContain("error ? (")
  })

  it("invalidates stale receive requests when their inputs change", async () => {
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(wallet).toContain("const clearRequest = (announceInvalidation")
    expect(wallet).toMatch(
      /onChange=\{\(event\) => \{\s+setAmount\(event\.target\.value\)\s+clearRequest\(true\)/
    )
    expect(wallet).toContain('aria-describedby="receive-amount-help"')
    expect(wallet).toContain('id="receive-amount-help"')
    expect(wallet).toContain(
      "Amount applies to Lightning invoices. Spark addresses are"
    )
    expect(wallet).toContain(
      "Payment request cleared. Create a new request for the updated amount."
    )
    expect(wallet).toMatch(
      /announceInvalidation && request[\s\S]{0,180}setRequestAnnouncement/
    )
    expect(wallet).toContain('aria-live="polite"')
    expect(wallet).toMatch(
      /const createSparkAddress = async \(\) => \{[\s\S]{0,180}setAmount\(""\)[\s\S]{0,80}clearRequest\(\)/
    )
  })

  it("bounds history loading without trapping the wallet dialog", async () => {
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(wallet).toContain("SPARK_HISTORY_LOAD_TIMEOUT_MS")
    expect(wallet).toContain("Payment history took too long to load")
    expect(wallet).toContain("Retry history")
    expect(wallet).toMatch(
      /function WalletHistoryDialog[\s\S]{0,3200}if \(!open\) close\(\)/
    )
    expect(wallet).toMatch(
      /function WalletHistoryDialog[\s\S]{0,5200}<Button variant="ghost" onClick=\{close\}>/
    )
  })

  it("makes reviewed Lightning sends the default while retaining advanced Spark transfers", async () => {
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(wallet).toContain('useState<"lightning" | "spark">("lightning")')
    expect(wallet).toContain(
      '<TabsTrigger value="lightning" disabled={pending}>'
    )
    expect(wallet).toContain('<TabsTrigger value="spark" disabled={pending}>')
    expect(wallet).toContain("Lightning invoice")
    expect(wallet).toContain("Direct Spark address")
    expect(wallet).toContain("aria-pressed={useMax}")
    expect(wallet).toContain(
      "Max reserves the approved maximum Lightning fee and sends"
    )
    expect(wallet).toContain(
      "If the final fee is lower, some sats will remain."
    )
    expect(wallet).toContain('? { type: "max" }')
    expect(wallet).toContain("Review payment")
    expect(wallet).toContain("Maximum total")
    expect(wallet).toContain("Estimated remaining after maximum fee")
    expect(wallet).toContain("Sub-sat Lightning invoices are not supported.")
    expect(wallet).toContain("successStatusRef")
    expect(wallet).toContain("resultAlertRef")
    expect(wallet).toContain("aria-busy={pending}")
    expect(wallet).toContain('"Preparing…"')
    expect(wallet).toContain('"Sending…"')
    expect(wallet).toContain("reviewedPaymentRequest")
    expect(wallet).toContain('form="spark-send-draft-form"')
    expect(wallet).toContain('form="spark-send-confirm-form"')
    expect(wallet).toMatch(
      /const updatePaymentRequest = \(value: string\) => \{[\s\S]{0,240}setUseMax\(false\)[\s\S]{0,80}setAmount\(""\)/
    )
    expect(wallet).toContain("wallets.prepareSparkSend(wallet.id")
    expect(wallet).toContain("wallets.confirmSparkSend(wallet.id, quote.id)")
  })

  it("keeps ambiguous Spark sends locked until explicit acknowledgement", async () => {
    const wallet = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(wallet).toContain("hasUnresolvedSparkSend")
    expect(wallet).toContain("acknowledgeUnresolvedSparkSend")
    expect(wallet).toContain("Close and check history")
    expect(wallet).toContain("No matching payment; allow retry")
    expect(wallet).toContain(
      "If a matching payment appears in history, do not retry"
    )
    expect(wallet).toContain("showCloseButton={!pending}")
    expect(wallet).toMatch(
      /wallet && quote && outcome !== "ambiguous"[\s\S]{0,100}discardSparkSendQuote/
    )
    expect(wallet).toContain('outcome === "ambiguous"')
    expect(wallet).toMatch(
      /const prepare = async \(\) => \{[\s\S]{0,1200}hasUnresolvedSparkSend\(wallet\.id\)[\s\S]{0,160}setOutcome\("ambiguous"\)/
    )
    expect(wallet).toMatch(
      /outcome === "ambiguous"\s+\? "rounded-xl border[^"]*text-\[var\(--text-secondary\)\] outline-none"/
    )
  })

  it("preserves the checkout wallet for order payment recovery", async () => {
    const checkout = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )
    const content = await readFile("apps/market/src/routes/orders.tsx", "utf8")
    const targetContent = await readFile(
      "apps/market/src/components/PaymentTargetSelectContent.tsx",
      "utf8"
    )

    expect(checkout.match(/paymentTarget: storedPaymentTarget/g)).toHaveLength(
      2
    )
    expect(content).toContain("const wallets = useWallets()")
    expect(content).toContain("row.lifecycle?.paymentTarget")
    expect(content).toContain("resolveWalletPaymentInstance")
    expect(content).toContain("replaceOrderPaymentTarget")
    expect(content).toContain("retryWalletTargetIsStale")
    expect(content).toContain("getNwcPaymentReadiness")
    expect(content).toContain("nwcReadiness?.ready === true")
    expect(checkout).toContain("<PaymentTargetSelectContent")
    expect(content).toContain("<PaymentTargetSelectContent")
    expect(checkout).toContain("<PaymentTargetSelectValue")
    expect(content).toContain("<PaymentTargetSelectValue")
    expect(content).toContain('placeholder="Choose a payment target"')
    expect(content).not.toContain("showDefaultBadge")
    expect(targetContent).toContain("Previously selected wallet (unavailable)")
    expect(content).toContain("Loading saved wallets")
    expect(content).toContain("{wallets.initializationError}")
    expect(content).toContain("wallets.retryInitialization()")
    expect(content).toContain("persistedRetryTargetType")
    expect(content).toContain("persistedRetryWalletId")
    expect(content).toContain("persistedRetryProviderId")
    expect(content).not.toContain("persistedRetryTargetRef.current")
    expect(content).not.toMatch(
      /eligibleWallets\.find\(\(candidate\) =>\s*candidate\.defaultIntents\.includes/
    )
  })
})
