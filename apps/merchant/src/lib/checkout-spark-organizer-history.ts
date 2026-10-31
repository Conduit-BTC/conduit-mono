import {
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  type CheckoutSparkNativeTreasuryHistoryDiagnostic,
} from "@conduit/core"
import {
  assertCheckoutSparkOrganizerRecoveryAuthority,
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
  withCheckoutSparkOrganizerRecovery,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import type { CheckoutSparkOrganizerRoutingInput } from "./checkout-spark-organizer-routing"
import { inspectMerchantCheckoutSparkNativeHistory } from "./checkout-spark-native-history-reader"

/** Selected, already-reserved recovery only. No import, acceptance, publication,
 * wallet initialization or payment-state write is part of this inspection.
 */
export async function inspectCheckoutSparkOrganizerNativeHistory(
  input: Omit<CheckoutSparkOrganizerRoutingInput, "onCommerceProof">,
  dependencies: {
    repository?: DexieCheckoutSparkSettledRepository
    inspect?: typeof inspectMerchantCheckoutSparkNativeHistory
    /** Tests may shorten the whole check, never extend its production bound. */
    timeoutMs?: number
  } = {}
): Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic> {
  input = { ...input }
  const timeoutMs =
    typeof dependencies.timeoutMs === "number" &&
    Number.isFinite(dependencies.timeoutMs) &&
    dependencies.timeoutMs > 0
      ? Math.min(35_000, dependencies.timeoutMs)
      : 35_000
  const deadline = performance.now() + timeoutMs
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const inspect =
    async (): Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic> => {
      try {
        const purchase = assertCheckoutSparkOrganizerRecoveryAuthority(
          input.authority
        )
        const revision = input.signer.revision
        const method = input.signer.authMethod
        const assertSession = () => {
          const current = assertCheckoutSparkOrganizerRecoveryAuthority(
            input.authority
          )
          if (
            expired ||
            performance.now() >= deadline ||
            !input.shouldContinue() ||
            !revision ||
            !method ||
            input.signer.revision !== revision ||
            input.signer.authMethod !== method ||
            input.signer.pubkey !== input.authenticatedPubkey ||
            current.plan.eventMarket?.organizerPubkey !==
              input.authenticatedPubkey ||
            current.handoffId !== purchase.handoffId ||
            !input.signer.capabilities.nip44
          )
            throw new Error("Organizer inspection session changed.")
        }
        assertSession()
        if ((await input.signer.getPublicKey()) !== input.authenticatedPubkey)
          return "unavailable"
        assertSession()
        return await withCheckoutSparkOrganizerRecovery(
          input.authority,
          async (context) => {
            const assertCurrent = () => {
              context.assertCurrent()
              assertSession()
            }
            const checkCurrent = async () => {
              assertCurrent()
              await assertCheckoutSparkOrganizerRecoveryWriterCurrent(
                input.authority
              )
              assertCurrent()
            }
            assertCurrent()
            const repository =
              dependencies.repository ??
              new DexieCheckoutSparkSettledRepository(input.db)
            const { plan } = context.initial
            const saved = await repository.load(
              plan.checkoutId,
              plan.planDigest
            )
            await checkCurrent()
            // Inspection does not import an older snapshot or revive a retired record.
            if (saved.status !== "active") return "unavailable"
            assertCheckoutSparkSettledRecoveryProgression(
              context.state,
              saved.state
            )
            const expected = JSON.stringify(saved.state)
            const finalization = saved.state.treasuryFinalization
            const intent = finalization?.intent
            if (
              plan.eventMarket?.mode !== "organizer_handoff" ||
              !plan.nativeTreasury ||
              !intent ||
              intent.invoiceId !== plan.nativeTreasury.invoiceId ||
              intent.invoiceRequest !== plan.nativeTreasury.invoiceRequest ||
              context.initial.wallet.network !== plan.network
            )
              return "unavailable"
            const result = await (
              dependencies.inspect ?? inspectMerchantCheckoutSparkNativeHistory
            )({
              mnemonic: context.initial.wallet.mnemonic,
              accountNumber: context.initial.wallet.accountNumber,
              fundingIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
              request: {
                network: plan.network,
                nativeTreasury: plan.nativeTreasury,
                amountSats: intent.amountSats,
                authorizedDebitSats: intent.authorizedDebitSats,
                providerTransferId: finalization.providerTransferId,
              },
              assertCurrent,
              checkCurrent,
            })
            const after = await repository.load(
              plan.checkoutId,
              plan.planDigest
            )
            await checkCurrent()
            if (
              after.status !== "active" ||
              JSON.stringify(after.state) !== expected
            )
              return "unavailable"
            return result
          }
        )
      } catch {
        // Provider/session failures may contain private material. Return no details.
        return "unavailable"
      }
    }
  try {
    return await Promise.race([
      inspect(),
      new Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve("unavailable")
        }, timeoutMs)
      }),
    ])
  } finally {
    expired = true
    clearTimeout(timer)
  }
}
