import { useId } from "react"
import { Plus } from "lucide-react"
import { Button, Checkbox, Input, Label } from "@conduit/ui"
import type {
  ProductSupplierReadiness,
  ProductSupplierRecipientReadiness,
} from "@conduit/core"
import type {
  MerchantProductSupplierAllocationFormRecipient,
  MerchantProductSupplierAllocationFormValidation,
} from "../lib/productForm"
import {
  addSupplierPercentage,
  getMerchantPercentage,
  getSupplierPercentage,
  removeSupplierPercentage,
  setSupplierPercentage,
} from "../lib/productSupplierPercentages"

export interface ProductSupplierAllocationEditorValue {
  enabled: boolean
  merchantWeight: string
  merchantRelayHint: string
  suppliers: MerchantProductSupplierAllocationFormRecipient[]
}

export interface ProductSupplierAllocationEditorProps {
  value: ProductSupplierAllocationEditorValue
  validation: MerchantProductSupplierAllocationFormValidation
  onChange: (value: ProductSupplierAllocationEditorValue) => void
  readiness?: ProductSupplierReadiness
  checking?: boolean
  onRetryReadiness?: () => void
}

/** Only an explicit authoring reset discards saved discovery hints. */
export function startNewSupplierAllocation(
  value: ProductSupplierAllocationEditorValue
): ProductSupplierAllocationEditorValue {
  return {
    ...value,
    merchantWeight: "1",
    merchantRelayHint: "",
    suppliers: [],
  }
}

function readinessMessage(
  result: ProductSupplierRecipientReadiness | undefined,
  checking: boolean
): string {
  if (checking) return "Checking payment and messaging setup…"
  if (!result)
    return "Enter a valid identity to check payment and messaging setup."
  if (result.state === "ready")
    return `${result.displayName ? `${result.displayName} · ` : ""}Payment and messaging setup checked.`
  if (result.reason === "payment_address_missing")
    return "Ask this recipient to add a Lightning address to their profile."
  if (result.reason === "inbox_unavailable")
    return "Their private inbox could not be verified. Ask them to check Network settings, then retry."
  if (result.reason === "payment_endpoint_unavailable")
    return "Their payment service could not be reached or has no usable payment range. Retry or ask them to check their Lightning address."
  if (result.reason === "profile_invalid")
    return "Their signed payment profile could not be verified. Check the identity or ask them to update their profile."
  return "Their current payment profile could not be reached. Retry or check the identity."
}

export function ProductSupplierAllocationEditor({
  value,
  validation,
  onChange,
  readiness,
  checking = false,
  onRetryReadiness,
}: ProductSupplierAllocationEditorProps) {
  const id = useId()
  const helpId = `${id}-allocation-help`
  const publicTermsId = `${id}-allocation-public-terms`
  const enableLabelId = `${id}-allocation-enable-label`
  const errorId = `${id}-allocation-error`
  const supplierResults =
    readiness?.recipients.filter(
      (recipient) => recipient.role === "supplier"
    ) ?? []
  const merchantResult = readiness?.recipients.find(
    (recipient) => recipient.role === "merchant"
  )
  const merchantPercentage = getMerchantPercentage(value)
  const blockedSavedHints =
    !validation.canPublish &&
    Boolean(validation.error) &&
    (Boolean(value.merchantRelayHint.trim()) ||
      value.suppliers.some((supplier) => Boolean(supplier.relayHint.trim())))

  return (
    <fieldset
      aria-describedby={validation.error ? errorId : undefined}
      className="grid min-w-0 grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <legend className="px-1 text-sm font-semibold text-[var(--text-primary)]">
        Revenue split
      </legend>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
          aria-labelledby={enableLabelId}
          aria-describedby={publicTermsId}
          className="mt-1"
        />
        <span className="grid min-w-0 gap-1">
          <span
            id={enableLabelId}
            className="font-medium text-[var(--text-primary)]"
          >
            Share revenue with suppliers
          </span>
          <span
            id={publicTermsId}
            className="text-xs leading-5 text-[var(--text-muted)]"
          >
            Supplier identities and shares are published as public terms on this
            product revision. These terms declare shares, not payment or
            settlement. They are hidden from the normal buyer view, but are
            publicly readable.
          </span>
        </span>
      </label>
      {value.enabled ? (
        <div className="grid min-w-0 grid-cols-1 gap-4">
          {!merchantPercentage || blockedSavedHints ? (
            <div className="grid justify-items-start gap-2">
              <p className="text-xs text-error">
                The saved split needs repair before publishing.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange(startNewSupplierAllocation(value))}
              >
                Start a new split
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              Suppliers
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!merchantPercentage}
              onClick={() => onChange(addSupplierPercentage(value))}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add supplier
            </Button>
          </div>
          {value.suppliers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--text-muted)]">
              Add a supplier's npub and percentage of the item amount.
            </p>
          ) : (
            value.suppliers.map((supplier, index) => {
              const statusId = `${id}-supplier-status-${index}`
              const inputErrorId = `${id}-supplier-error-${index}`
              return (
                <div
                  key={index}
                  className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
                >
                  <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
                    <div className="grid min-w-0 gap-1.5">
                      <Label htmlFor={`${id}-supplier-identity-${index}`}>
                        Supplier {index + 1} npub
                      </Label>
                      <Input
                        id={`${id}-supplier-identity-${index}`}
                        value={supplier.identity}
                        placeholder="npub1…"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-describedby={statusId}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            suppliers: value.suppliers.map((row, rowIndex) =>
                              rowIndex === index
                                ? { ...row, identity: event.target.value }
                                : row
                            ),
                          })
                        }
                      />
                    </div>
                    <div className="grid min-w-0 gap-1.5">
                      <Label htmlFor={`${id}-supplier-percentage-${index}`}>
                        Supplier {index + 1} share (%)
                      </Label>
                      <Input
                        id={`${id}-supplier-percentage-${index}`}
                        inputMode="decimal"
                        maxLength={8}
                        value={
                          supplier.percentageInput ??
                          getSupplierPercentage(value, index)
                        }
                        aria-invalid={!!supplier.percentageError}
                        aria-describedby={
                          supplier.percentageError
                            ? `${helpId} ${inputErrorId}`
                            : helpId
                        }
                        onChange={(event) =>
                          onChange(
                            setSupplierPercentage(
                              value,
                              index,
                              event.target.value
                            )
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Remove supplier ${index + 1}`}
                      onClick={() =>
                        onChange(removeSupplierPercentage(value, index))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  <p
                    id={statusId}
                    role="status"
                    className="text-xs leading-5 text-[var(--text-secondary)]"
                  >
                    {readinessMessage(supplierResults[index], checking)}
                  </p>
                  {supplier.percentageError ? (
                    <p id={inputErrorId} className="text-xs text-error">
                      {supplier.percentageError}
                    </p>
                  ) : null}
                </div>
              )
            })
          )}
          {merchantPercentage ? (
            <div className="grid gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-sm">
              <span>Your share: {merchantPercentage}%</span>
              <span className="text-xs text-[var(--text-secondary)]">
                You keep the remainder after supplier shares.
              </span>
              {merchantResult ? (
                <span
                  role="status"
                  className="text-xs text-[var(--text-secondary)]"
                >
                  {readinessMessage(merchantResult, checking)}
                </span>
              ) : null}
            </div>
          ) : null}
          {onRetryReadiness && readiness?.state !== "ready" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checking}
              onClick={onRetryReadiness}
            >
              {checking ? "Checking setup…" : "Check setup again"}
            </Button>
          ) : null}
          <p id={helpId} className="text-xs leading-5 text-[var(--text-muted)]">
            Shares apply to the item amount. Each recipient pays their own
            payout fees. Any whole-satoshi rounding remainder belongs to you.
            Saved shares are preserved exactly until edited; displayed
            percentages are rounded to two decimal places. Changes apply to
            future orders; existing orders keep their original terms. Setup
            checks do not prove receipt of money.
          </p>
        </div>
      ) : null}
      {validation.error ? (
        <p id={errorId} role="alert" className="text-xs text-error">
          {validation.error}
        </p>
      ) : null}
    </fieldset>
  )
}
