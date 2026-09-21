import { Plus } from "lucide-react"
import { Button, Input, Label } from "@conduit/ui"
import type {
  MerchantProductSupplierAllocationFormRecipient,
  MerchantProductSupplierAllocationFormValidation,
} from "../lib/productForm"

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
}

function formatAllocationWeightShare(
  weight: number,
  totalWeight: number
): string {
  if (totalWeight <= 0) return ""
  const percent = (weight / totalWeight) * 100
  return `${percent.toFixed(percent >= 10 ? 1 : 2).replace(/\.0$/, "")}%`
}

export function ProductSupplierAllocationEditor({
  value,
  validation,
  onChange,
}: ProductSupplierAllocationEditorProps) {
  const totalWeight =
    validation.allocation?.recipients.reduce(
      (sum, recipient) => sum + recipient.weight,
      0
    ) ?? 0
  const supplierRecipients =
    validation.allocation?.recipients.filter(
      (recipient) => recipient.role === "supplier"
    ) ?? []
  const merchantWeight =
    validation.allocation?.recipients.find(
      (recipient) => recipient.role === "merchant"
    )?.weight ?? 0

  return (
    <fieldset className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <legend className="px-1 text-sm font-semibold text-[var(--text-primary)]">
        Revenue split
      </legend>
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) =>
            onChange({ ...value, enabled: event.target.checked })
          }
          className="mt-1 h-4 w-4 rounded border-[var(--border)] accent-secondary-500"
        />
        <span className="grid gap-1">
          <span className="font-medium text-[var(--text-primary)]">
            Publish signed supplier allocation terms
          </span>
          <span className="text-xs leading-5 text-[var(--text-muted)]">
            Adds standard weighted NIP-57 zap recipients to this exact product
            revision. Market shows these as declared terms, not as proof that a
            payment occurred.
          </span>
        </span>
      </label>

      {value.enabled ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div className="grid gap-1.5">
              <Label htmlFor="product-merchant-allocation-weight">
                Merchant weight
              </Label>
              <Input
                id="product-merchant-allocation-weight"
                inputMode="numeric"
                value={value.merchantWeight}
                onChange={(event) =>
                  onChange({ ...value, merchantWeight: event.target.value })
                }
                aria-describedby="product-allocation-help"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="product-merchant-allocation-relay">
                Merchant profile relay
              </Label>
              <Input
                id="product-merchant-allocation-relay"
                value={value.merchantRelayHint}
                placeholder="wss://relay.example"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  onChange({
                    ...value,
                    merchantRelayHint: event.target.value,
                  })
                }
                aria-describedby="product-allocation-relay-help"
              />
            </div>
          </div>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-[var(--text-primary)]">
                Suppliers
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange({
                    ...value,
                    suppliers: [
                      ...value.suppliers,
                      { identity: "", relayHint: "", weight: "1" },
                    ],
                  })
                }
              >
                <Plus className="h-4 w-4" />
                Add supplier
              </Button>
            </div>

            {value.suppliers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-xs text-[var(--text-muted)]">
                Add each supplier identity and its relative share weight.
              </div>
            ) : (
              <div className="grid gap-3">
                {value.suppliers.map((supplier, index) => {
                  const allocationRecipient = supplierRecipients[index]
                  return (
                    <div
                      key={index}
                      className="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_auto] sm:items-end"
                    >
                      <div className="grid gap-1.5">
                        <Label htmlFor={`product-supplier-identity-${index}`}>
                          Supplier identity
                        </Label>
                        <Input
                          id={`product-supplier-identity-${index}`}
                          value={supplier.identity}
                          placeholder="npub1… or nprofile1…"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              ...value,
                              suppliers: value.suppliers.map(
                                (recipient, recipientIndex) =>
                                  recipientIndex === index
                                    ? {
                                        ...recipient,
                                        identity: event.target.value,
                                      }
                                    : recipient
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`product-supplier-relay-${index}`}>
                          Profile relay
                        </Label>
                        <Input
                          id={`product-supplier-relay-${index}`}
                          value={supplier.relayHint}
                          placeholder="wss://relay.example"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(event) =>
                            onChange({
                              ...value,
                              suppliers: value.suppliers.map(
                                (recipient, recipientIndex) =>
                                  recipientIndex === index
                                    ? {
                                        ...recipient,
                                        relayHint: event.target.value,
                                      }
                                    : recipient
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`product-supplier-weight-${index}`}>
                          Weight
                        </Label>
                        <Input
                          id={`product-supplier-weight-${index}`}
                          inputMode="numeric"
                          value={supplier.weight}
                          onChange={(event) =>
                            onChange({
                              ...value,
                              suppliers: value.suppliers.map(
                                (recipient, recipientIndex) =>
                                  recipientIndex === index
                                    ? {
                                        ...recipient,
                                        weight: event.target.value,
                                      }
                                    : recipient
                              ),
                            })
                          }
                        />
                        {allocationRecipient ? (
                          <span className="text-xs text-[var(--text-muted)]">
                            {formatAllocationWeightShare(
                              allocationRecipient.weight,
                              totalWeight
                            )}
                          </span>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          onChange({
                            ...value,
                            suppliers: value.suppliers.filter(
                              (_, recipientIndex) => recipientIndex !== index
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div
            id="product-allocation-help"
            className="text-xs leading-5 text-[var(--text-muted)]"
          >
            Weights are relative. Any whole-satoshi rounding residue belongs to
            the merchant. Changing these terms publishes a new signed product
            revision; existing orders keep their original terms.
          </div>
          <div
            id="product-allocation-relay-help"
            className="text-xs leading-5 text-[var(--text-muted)]"
          >
            Each profile relay must be a public wss:// relay where that
            recipient&apos;s kind-0 profile can be found. An nprofile identity
            may supply its own relay hint.
          </div>

          {validation.allocation ? (
            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
              Merchant share:{" "}
              {formatAllocationWeightShare(merchantWeight, totalWeight)}
            </div>
          ) : validation.error ? (
            <p role="alert" className="text-xs text-error">
              {validation.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  )
}
