import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("critical signer recovery flows", () => {
  it("preserves account-owned drafts through same-account recovery", async () => {
    const [products, network, checkout, presets, preferences, orders] =
      await Promise.all([
        source("apps/merchant/src/routes/products.tsx"),
        source("packages/ui/src/components/RelaySettingsPanel.tsx"),
        source("apps/market/src/routes/checkout.tsx"),
        source("apps/market/src/hooks/useShopperPresets.tsx"),
        source("apps/market/src/routes/preferences.tsx"),
        source("apps/market/src/routes/orders.tsx"),
      ])

    const productOwnerEffect = products.slice(
      products.indexOf(
        "useLayoutEffect(() => {",
        products.indexOf("const hasProductChanges")
      ),
      products.indexOf(
        "useEffect(() => {",
        products.indexOf("const hasProductChanges")
      )
    )
    expect(
      productOwnerEffect.indexOf("previousOwner === accountPubkey")
    ).toBeLessThan(productOwnerEffect.indexOf("setForm("))
    expect(productOwnerEffect).toContain("setProductDeliveryNotice(null)")
    expect(productOwnerEffect).toContain("setProductDeliveryRetry(null)")
    expect(products).toContain(
      "if (!isCurrentProductOwner(variables.merchantPubkey))"
    )

    expect(network).toContain('key={accountPubkey ?? "no-account"}')
    expect(network).not.toContain("key={signerReviewKey}")
    expect(network).toContain('key={`media:${accountPubkey ?? "no-account"}`}')

    const checkoutOwnerEffectStart = checkout.indexOf(
      "const previousOwner = checkoutWorkOwnerRef.current"
    )
    const checkoutOwnerEffect = checkout.slice(
      checkoutOwnerEffectStart,
      checkout.indexOf(
        "const preset = getIdentityBoundShippingPreset(",
        checkoutOwnerEffectStart
      )
    )
    expect(checkout).toContain("const draftOwnerIdentity = accountPubkey")
    expect(
      checkoutOwnerEffect.indexOf("previousOwner === draftOwnerIdentity")
    ).toBeLessThan(checkoutOwnerEffect.indexOf('setStep("shipping")'))
    expect(checkoutOwnerEffect).toContain(
      "setShipping(DEFAULT_CHECKOUT_SHIPPING)"
    )

    const presetOwnerEffect = presets.slice(
      presets.indexOf("if (!identityPubkey) {"),
      presets.indexOf("if (!identityPubkey || signerReady) return")
    )
    const sameOwnerReturn = presetOwnerEffect.indexOf(
      "if (stateOwnerPubkeyRef.current === identityPubkey)"
    )
    expect(presets).toContain("const identityPubkey = accountPubkey")
    expect(sameOwnerReturn).toBeGreaterThan(-1)
    expect(presetOwnerEffect.indexOf("return", sameOwnerReturn)).toBeLessThan(
      presetOwnerEffect.indexOf("setDecryptedPreset(null)", sameOwnerReturn)
    )

    const readinessEffect = preferences.slice(
      preferences.indexOf("if (presets.signerReady) return"),
      preferences.indexOf(
        "const reconnectSigner",
        preferences.indexOf("if (presets.signerReady) return")
      )
    )
    expect(readinessEffect).toContain("setClearOpen(false)")
    expect(readinessEffect).not.toContain("setDraft(")
    expect(readinessEffect).not.toContain("clearPlaintextDraft")
    expect(preferences).toContain(
      'key={presets.identityPubkey ?? "no-account"}'
    )

    const orderRecoveryEffect = orders.slice(
      orders.indexOf("if (!actionsReady && sparkFeeApproval.quote)"),
      orders.indexOf(
        "persistedRetryTargetType",
        orders.indexOf("if (!actionsReady && sparkFeeApproval.quote)")
      )
    )
    expect(orderRecoveryEffect).not.toContain("setPaymentAddressUpdate(null)")
    expect(orderRecoveryEffect).not.toContain("setPrivateFallbackOpen(false)")
    expect(orderRecoveryEffect).not.toContain("setReplyText(")
    expect(orderRecoveryEffect).not.toContain("setRetryTarget(")
  })

  it("invalidates prepared signer work without replaying it after reconnect", async () => {
    const [products, network, checkout, presets, orders] = await Promise.all([
      source("apps/merchant/src/routes/products.tsx"),
      source("packages/ui/src/components/RelaySettingsPanel.tsx"),
      source("apps/market/src/routes/checkout.tsx"),
      source("apps/market/src/hooks/useShopperPresets.tsx"),
      source("apps/market/src/routes/orders.tsx"),
    ])

    expect(products).toContain(
      "setPendingProductPublish(null)\n  }, [authGeneration, signerReady])"
    )
    const networkReviewInvalidation = network.slice(
      network.indexOf(
        "useLayoutEffect(() => {",
        network.indexOf("const [removalPreparationError")
      ),
      network.indexOf("const baselineRoles")
    )
    expect(networkReviewInvalidation).toContain(
      "setPreparedPublishChange(null)"
    )
    expect(networkReviewInvalidation).toContain(
      "setPreparedRemovalChange(null)"
    )
    expect(networkReviewInvalidation).toContain("}, [signerReviewKey])")
    expect(checkout).toContain(
      "autoZapAuthorizationGenerationRef.current !== authGeneration"
    )
    expect(checkout).toContain(
      "if (!signerConnected && sparkFeeApproval.quote) {\n      sparkFeeApproval.decline()"
    )
    expect(presets).toContain(
      "signerAuthorityRef.current.authGeneration !==\n            expectedAuthority.authGeneration"
    )

    const ordersReconnect = orders.slice(
      orders.indexOf("const reconnectSigner = useCallback"),
      orders.indexOf(
        "useEffect(() => {",
        orders.indexOf("const reconnectSigner = useCallback")
      )
    )
    expect(ordersReconnect).toContain('connect({ mode: "restore" })')
    expect(ordersReconnect).not.toContain("retryPayment")
    expect(ordersReconnect).not.toContain("runOrderPayment")
    expect(ordersReconnect).not.toContain("replyMutation")
    expect(orders).toContain(
      'mode: signerConnected ? "observe_and_deliver" : "observe_only"'
    )
  })

  it("rebuilds Orders payment authority only after explicit confirmation", async () => {
    const orders = await source("apps/market/src/routes/orders.tsx")
    expect(orders).toContain("useState<OrderPaymentAddressUpdate | null>(null)")
    expect(orders).not.toContain("useState<OrderPaymentContext | null>(null)")

    const retry = orders.slice(
      orders.indexOf("async function retryPayment"),
      orders.indexOf("async function runRetryPayment")
    )
    expect(retry).toContain("setPaymentAddressUpdate(check.update)")
    expect(retry.indexOf("setPaymentAddressUpdate(check.update)")).toBeLessThan(
      retry.indexOf("return")
    )

    const confirm = orders.slice(
      orders.indexOf("async function confirmPaymentAddressUpdate"),
      orders.indexOf("async function continuePrivateFallback")
    )
    expect(confirm.indexOf("await verifyRetryFreshness()")).toBeLessThan(
      confirm.indexOf("const ctx = buildServiceCtx()")
    )
    expect(confirm).not.toContain("persistTargetAndBuildServiceCtx")
    expect(confirm.indexOf("const ctx = buildServiceCtx()")).toBeLessThan(
      confirm.indexOf("await runRetryPayment(ctx, pending)")
    )
    expect(confirm.indexOf("await runRetryPayment(ctx, pending)")).toBeLessThan(
      confirm.indexOf("setPaymentAddressUpdate")
    )
  })

  it("clears private in-memory work when account A is replaced by B", async () => {
    const [products, network, checkout, presets, orders] = await Promise.all([
      source("apps/merchant/src/routes/products.tsx"),
      source("packages/ui/src/components/RelaySettingsPanel.tsx"),
      source("apps/market/src/routes/checkout.tsx"),
      source("apps/market/src/hooks/useShopperPresets.tsx"),
      source("apps/market/src/routes/orders.tsx"),
    ])

    expect(products).toContain("previousOwner === accountPubkey")
    expect(products).toContain("setActiveProductDraftTarget(null)")
    expect(network).toContain('key={accountPubkey ?? "no-account"}')
    expect(checkout).toContain("previousOwner === draftOwnerIdentity")
    expect(checkout).toContain('setNote("")')
    expect(presets).toContain("stateOwnerPubkeyRef.current = identityPubkey")
    expect(presets).toContain("setDecryptedPreset(null)")
    expect(orders).toContain(
      "key={`${activeBuyerPubkey}:${selectedRow.orderId}`}"
    )
  })
})
