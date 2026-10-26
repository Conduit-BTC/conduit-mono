import { useEffect, useRef, useState } from "react"
import type {
  useOrdinarySettings,
  PrivateSettingsDocument,
  PublicSettingsDocument,
  SettingsChange,
  SavedShippingAddress,
} from "@conduit/core"
import { Button } from "./Button"
import { Input } from "./Input"
import { Label } from "./Label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./Select"
import { Textarea } from "./Textarea"

type Controller = ReturnType<typeof useOrdinarySettings>
const fieldClass = "space-y-2"
const labels: Record<string, string> = {
  true: "On",
  false: "Off",
  "day-market": "Light",
  "night-market": "Dark",
  system: "Use device theme",
  bitcoin: "Bitcoin",
  sats: "Satoshis",
  automatic: "Choose at checkout",
  nwc: "Nostr Wallet Connect",
  webln: "Browser wallet",
  manual: "Invoice",
  newest: "Newest first",
  priority: "Needs attention",
  recent: "Recently updated",
  recipientName: "Recipient name",
  addressLine1: "Street address",
  addressLine2: "Apartment or unit",
  city: "City",
  stateOrRegion: "State or region",
  postalCode: "Postal code",
  country: "Country code",
  email: "Email",
  phone: "Phone",
  label: "Address label",
}
function readField(
  document: PrivateSettingsDocument | PublicSettingsDocument,
  path: string
): unknown {
  let value: unknown = document.settings
  for (const key of path.split("."))
    value =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined
  return value
}
function DraftReview({
  changes,
  current,
  onAccept,
  onCancel,
}: {
  changes: SettingsChange[]
  current: PrivateSettingsDocument | PublicSettingsDocument
  onAccept: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
      <h3 className="font-semibold">Review your changes</h3>
      <p>
        Compare the latest observed settings with your draft. Keeping your draft
        replaces these values.
      </p>
      {changes.map((change) => (
        <div key={change.path}>
          <p className="font-medium">
            {change.path
              .split(".")
              .map((x) => labels[x] ?? x.replace(/([A-Z])/g, " $1"))
              .join(" · ")}
          </p>
          <p className="break-words text-sm">
            Current:{" "}
            {JSON.stringify(readField(current, change.path)) ?? "Not set"}
          </p>
          <p className="break-words text-sm">
            Your draft: {JSON.stringify(change.value) ?? "Not set"}
          </p>
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" onClick={onAccept}>
          Keep my reviewed changes
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Back to editing
        </Button>
      </div>
    </div>
  )
}
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (value: string) => void
}) {
  return (
    <div className={fieldClass}>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option] ?? option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className={fieldClass}>
      <Label>{label}</Label>
      <Input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
function problemMessage(problem?: string): string | null {
  if (!problem) return null
  if (problem === "unsupported")
    return "These settings use a newer format. Use a compatible client before saving."
  if (problem === "conflict")
    return "Settings changed elsewhere. Your draft is retained; review the current values before saving again."
  if (problem === "storage")
    return "This browser could not retain settings. Allow browser storage and save again."
  if (problem === "signer")
    return "Your signer could not open settings. Reconnect it or approve your next save to continue."
  if (problem === "invalid")
    return "Some settings are invalid. Check your entered addresses, language codes and opening hours. Your draft is retained."
  if (problem === "clock")
    return "Check this device’s date and time before saving again."
  return "Settings could not be saved. Your draft remains here; check your connection and signer, then try again."
}
const blankAddress: SavedShippingAddress = {
  recipientName: "",
  addressLine1: "",
  city: "",
  postalCode: "",
  country: "US",
}
export function OrdinarySettingsPanel({
  settings,
  merchant = false,
}: {
  settings: Controller
  merchant?: boolean
}) {
  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">Preferences</h1>
      <p className="text-[var(--text-secondary)]">
        Your private preferences follow your account across Shop and Sell after
        signer approval.
      </p>
      {!settings.owner ? (
        <p>Connect your signer to edit account preferences.</p>
      ) : (
        <>
          <PrivatePreferences
            key={`private:${settings.owner}`}
            settings={settings}
          />
          {merchant && (
            <PublicPreferences
              key={`public:${settings.owner}`}
              settings={settings}
            />
          )}
        </>
      )}
    </main>
  )
}
function PrivatePreferences({ settings }: { settings: Controller }) {
  const [baseline, setBaseline] = useState<PrivateSettingsDocument>(
    settings.privateDocument
  )
  const [changes, setChanges] = useState<SettingsChange[]>([])
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const reviewedPendingEventId = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!changes.length) setBaseline(settings.privateDocument)
  }, [settings.privateDocument, changes.length])
  function change(path: string, value: unknown) {
    setChanges((old) => [
      ...old.filter((c) => c.path !== path),
      { path, value },
    ])
    setStatus(null)
  }
  function value(path: string, fallback = ""): string {
    const edited = changes.find((c) => c.path === path)
    if (edited) return String(edited.value ?? fallback)
    let result: unknown = baseline.settings
    for (const key of path.split("."))
      result =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)[key]
          : undefined
    return String(result ?? fallback)
  }
  const shipping = (changes.find((c) => c.path === "shipping")?.value ??
    baseline.settings.shipping ?? {
      savedAddresses: {},
      defaultAddressId: null,
    }) as NonNullable<PrivateSettingsDocument["settings"]["shipping"]>
  const [address, setAddress] = useState<SavedShippingAddress | null>(null)
  async function save() {
    setBusy(true)
    try {
      const result = await settings.savePrivate({
        baseline,
        changes,
        reviewedPendingEventId: reviewedPendingEventId.current,
      })
      if (!mounted.current) return
      setChanges([])
      reviewedPendingEventId.current = undefined
      setBaseline(result.document)
      setStatus(
        result.delivery === "observed"
          ? "Saved and found on relays."
          : "Saved on this device. Delivery will continue automatically."
      )
    } catch (error) {
      if ((error as { code?: string }).code === "conflict")
        await settings.privateQuery.refetch()
      if (mounted.current)
        setStatus(
          problemMessage((error as { code?: string }).code ?? "invalid")
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section
      aria-label="Private preferences"
      className="space-y-5 border-t border-[var(--border)] pt-5"
    >
      <h2 className="text-xl font-semibold">Private preferences</h2>
      <p>
        Only your connected signer and active client can open these settings.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice
          label="Display currency"
          value={value("display.currency", "BTC")}
          options={["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "BTC"]}
          onChange={(v) => change("display.currency", v)}
        />
        <Choice
          label="Bitcoin unit"
          value={value("display.bitcoinUnit", "bitcoin")}
          options={["bitcoin", "sats"]}
          onChange={(v) => change("display.bitcoinUnit", v)}
        />
        <TextField
          label="Language code (for example, en)"
          value={value("display.language")}
          onChange={(v) => change("display.language", v || undefined)}
        />
        <TextField
          label="Regional format (for example, en-US)"
          value={value("display.locale")}
          onChange={(v) => change("display.locale", v || undefined)}
        />
        <Choice
          label="Appearance"
          value={value("appearance.theme", "system")}
          options={["system", "day-market", "night-market"]}
          onChange={(v) => change("appearance.theme", v)}
        />
        <Choice
          label="Preferred payment method"
          value={value("payments.preferredMethod", "automatic")}
          options={["automatic", "nwc", "webln", "manual"]}
          onChange={(v) => change("payments.preferredMethod", v)}
        />
        <Choice
          label="Weight unit"
          value={value("working.weightUnit", "g")}
          options={["g", "kg", "lb", "oz"]}
          onChange={(v) => change("working.weightUnit", v)}
        />
        <Choice
          label="Order sort"
          value={value("working.orderSort", "newest")}
          options={["newest", "priority", "recent"]}
          onChange={(v) => change("working.orderSort", v)}
        />
        <Choice
          label="Order notifications"
          value={value("notifications.orders", "true")}
          options={["true", "false"]}
          onChange={(v) => change("notifications.orders", v === "true")}
        />
        <Choice
          label="Message notifications"
          value={value("notifications.messages", "true")}
          options={["true", "false"]}
          onChange={(v) => change("notifications.messages", v === "true")}
        />
      </div>
      <p className="text-sm text-[var(--text-muted)]">
        Price display never changes a listing, order, invoice, or payment.
        Notification preferences are retained for clients that support
        notifications.
      </p>
      <SavedAddressesEditor
        shipping={shipping}
        address={address}
        setAddress={setAddress}
        onChange={(value) => change("shipping", value)}
      />
      {settings.privateQuery.data?.pendingDraft && (
        <Button
          variant="outline"
          onClick={() => {
            const draft = settings.privateQuery.data!.pendingDraft!
            setBaseline(draft.baseline)
            setChanges(draft.changes)
            setReview(true)
          }}
        >
          Review saved conflicting draft
        </Button>
      )}
      {review && (
        <DraftReview
          changes={changes}
          current={settings.privateDocument}
          onCancel={() => setReview(false)}
          onAccept={() => {
            setBaseline(settings.privateDocument)
            if (
              settings.privateQuery.data?.pendingDraft?.changes.every((saved) =>
                changes.some((change) => change.path === saved.path)
              )
            )
              reviewedPendingEventId.current =
                settings.privateQuery.data?.pendingEventId
            setReview(false)
            setStatus("Reviewed. Save to apply your draft to these settings.")
          }}
        />
      )}
      {(status || settings.privateQuery.data?.problem) && (
        <p role="status">
          {status ?? problemMessage(settings.privateQuery.data?.problem)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={
            !settings.ready || busy || review || !changes.length || !!address
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save private preferences"}
        </Button>
        {changes.length > 0 && (
          <Button
            variant="outline"
            onClick={() => {
              void settings.privateQuery.refetch()
              setReview(true)
            }}
          >
            Review current settings
          </Button>
        )}
      </div>
      <p className="text-sm text-[var(--text-muted)]">
        Unsaved edits stay in this session. Concurrent changes on another
        offline device can still replace a complete snapshot.
      </p>
    </section>
  )
}
function PublicPreferences({ settings }: { settings: Controller }) {
  const [baseline, setBaseline] = useState<PublicSettingsDocument>(
    settings.publicDocument
  )
  const [changes, setChanges] = useState<SettingsChange[]>([])
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const reviewedPendingEventId = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!changes.length) setBaseline(settings.publicDocument)
  }, [settings.publicDocument, changes.length])
  function change(path: string, value: unknown) {
    setChanges((old) => [
      ...old.filter((c) => c.path !== path),
      { path, value },
    ])
  }
  async function save() {
    setBusy(true)
    try {
      const result = await settings.savePublic({
        baseline,
        changes,
        reviewedPendingEventId: reviewedPendingEventId.current,
      })
      if (mounted.current) {
        setChanges([])
        reviewedPendingEventId.current = undefined
        setBaseline(result.document)
        setStatus(
          result.delivery === "observed"
            ? "Public settings saved and found on relays."
            : "Public settings saved locally; delivery continues automatically."
        )
      }
    } catch (error) {
      if ((error as { code?: string }).code === "conflict")
        await settings.publicQuery.refetch()
      if (mounted.current)
        setStatus(
          problemMessage((error as { code?: string }).code ?? "invalid")
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section
      aria-label="Public storefront settings"
      className="space-y-4 border-t border-[var(--border)] pt-5"
    >
      <h2 className="text-xl font-semibold">Public storefront settings</h2>
      <p>
        Anyone can read these values. Add only information you want to publish.
      </p>
      <PublicSettingsFields
        baseline={baseline}
        changes={changes}
        change={change}
      />
      {settings.publicQuery.data?.pendingDraft && (
        <Button
          variant="outline"
          onClick={() => {
            const draft = settings.publicQuery.data!.pendingDraft!
            setBaseline(draft.baseline)
            setChanges(draft.changes)
            setReview(true)
          }}
        >
          Review saved conflicting draft
        </Button>
      )}
      {review && (
        <DraftReview
          changes={changes}
          current={settings.publicDocument}
          onCancel={() => setReview(false)}
          onAccept={() => {
            setBaseline(settings.publicDocument)
            if (
              settings.publicQuery.data?.pendingDraft?.changes.every((saved) =>
                changes.some((change) => change.path === saved.path)
              )
            )
              reviewedPendingEventId.current =
                settings.publicQuery.data?.pendingEventId
            setReview(false)
            setStatus("Reviewed. Save to apply your draft to these settings.")
          }}
        />
      )}
      {(status || settings.publicQuery.data?.problem) && (
        <p role="status">
          {status ?? problemMessage(settings.publicQuery.data?.problem)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!settings.ready || busy || review || !changes.length}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Publish public settings"}
        </Button>
        {changes.length > 0 && (
          <Button
            variant="outline"
            onClick={() => {
              void settings.publicQuery.refetch()
              setReview(true)
            }}
          >
            Review current settings
          </Button>
        )}
      </div>
    </section>
  )
}

function SavedAddressesEditor({
  shipping,
  address,
  setAddress,
  onChange,
}: {
  shipping: NonNullable<PrivateSettingsDocument["settings"]["shipping"]>
  address: SavedShippingAddress | null
  setAddress: (value: SavedShippingAddress | null) => void
  onChange: (
    value: NonNullable<PrivateSettingsDocument["settings"]["shipping"]>
  ) => void
}) {
  const editingId = useRef<string | null>(null)
  return (
    <>
      <h3 className="font-semibold">Saved shipping addresses</h3>
      {Object.entries(shipping.savedAddresses).map(([id, item]) => (
        <div
          key={id}
          className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3"
        >
          <p>
            {item.label || item.recipientName}
            {shipping.defaultAddressId === id ? " · Default" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                editingId.current = id
                setAddress(item)
              }}
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onChange({ ...shipping, defaultAddressId: id })}
            >
              Use as default
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onChange({
                  ...shipping,
                  savedAddresses: Object.fromEntries(
                    Object.entries(shipping.savedAddresses).filter(
                      ([key]) => key !== id
                    )
                  ),
                  defaultAddressId:
                    shipping.defaultAddressId === id
                      ? null
                      : shipping.defaultAddressId,
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      {address ? (
        <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] p-4">
          {(
            [
              "label",
              "recipientName",
              "addressLine1",
              "addressLine2",
              "city",
              "stateOrRegion",
              "postalCode",
              "country",
              "email",
              "phone",
            ] as const
          ).map((key) => (
            <TextField
              key={key}
              label={labels[key] ?? key}
              value={String(address[key] ?? "")}
              onChange={(v) => setAddress({ ...address, [key]: v })}
            />
          ))}
          <Button
            type="button"
            onClick={() => {
              const id = editingId.current ?? crypto.randomUUID()
              onChange({
                ...shipping,
                savedAddresses: { ...shipping.savedAddresses, [id]: address },
                defaultAddressId: shipping.defaultAddressId ?? id,
              })
              setAddress(null)
              editingId.current = null
            }}
          >
            Keep address in draft
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setAddress(null)}
          >
            Cancel address edit
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            editingId.current = null
            setAddress({ ...blankAddress })
          }}
        >
          Add address
        </Button>
      )}
    </>
  )
}

function PublicSettingsFields({
  baseline,
  changes,
  change,
}: {
  baseline: PublicSettingsDocument
  changes: SettingsChange[]
  change: (path: string, value: unknown) => void
}) {
  const get = (path: string, original: unknown) => {
    const edited = changes.find((c) => c.path === path)
    return edited ? edited.value : original
  }
  const location = get(
    "merchant.generalLocation",
    baseline.settings.merchant?.generalLocation
  ) as { location: string; geohash?: string } | null | undefined
  const hours = get(
    "merchant.businessHours",
    baseline.settings.merchant?.businessHours
  ) as NonNullable<
    PublicSettingsDocument["settings"]["merchant"]
  >["businessHours"]
  function changeHours(day: string, value: string) {
    const ranges = value.trim()
      ? value.split(",").map((part) => {
          const [start, end] = part.trim().split("-")
          return { start: start?.trim() ?? "", end: end?.trim() ?? "" }
        })
      : []
    change("merchant.businessHours", {
      ...hours,
      timezone:
        hours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekly: { ...hours?.weekly, [day]: ranges },
    })
  }
  return (
    <>
      <TextField
        label="General merchant location"
        value={location?.location ?? ""}
        onChange={(v) =>
          change(
            "merchant.generalLocation",
            v ? { ...location, location: v } : null
          )
        }
      />
      <TextField
        label="Coarse geohash (four characters)"
        value={location?.geohash ?? ""}
        onChange={(v) =>
          change("merchant.generalLocation", {
            ...location,
            location: location?.location ?? "",
            geohash: v || undefined,
          })
        }
      />
      <Choice
        label="Storefront theme"
        value={String(
          get(
            "storefront.theme",
            baseline.settings.storefront?.theme ?? "day-market"
          )
        )}
        options={["day-market", "night-market"]}
        onChange={(v) => change("storefront.theme", v)}
      />
      <Choice
        label="Storefront layout"
        value={String(
          get(
            "storefront.layout",
            baseline.settings.storefront?.layout ?? "grid"
          )
        )}
        options={["grid", "list"]}
        onChange={(v) => change("storefront.layout", v)}
      />
      <fieldset className="space-y-3">
        <legend className="font-semibold">Business hours</legend>
        <p className="text-sm">
          Use 09:00-17:00, or leave a day empty for closed. Separate multiple
          opening periods with commas.
        </p>
        <TextField
          label="Business timezone"
          value={
            hours?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
          }
          onChange={(v) =>
            change("merchant.businessHours", {
              ...hours,
              timezone: v,
              weekly: hours?.weekly ?? {},
            })
          }
        />
        {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => (
          <TextField
            key={day}
            label={`${day} hours`}
            value={(
              (hours?.weekly[day] ?? []) as Array<{
                start: string
                end: string
              }>
            )
              .map((range) => `${range.start}-${range.end}`)
              .join(", ")}
            onChange={(v) => changeHours(day, v)}
          />
        ))}
      </fieldset>
      <TextField
        label="Service languages (comma separated)"
        value={(
          get(
            "merchant.serviceLanguages",
            baseline.settings.merchant?.serviceLanguages ?? []
          ) as string[]
        ).join(", ")}
        onChange={(v) =>
          change(
            "merchant.serviceLanguages",
            v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          )
        }
      />
      <div className={fieldClass}>
        <Label>Public notice</Label>
        <Textarea
          aria-label="Public notice"
          value={String(
            get("merchant.notice", baseline.settings.merchant?.notice ?? "")
          )}
          onChange={(e) => change("merchant.notice", e.target.value || null)}
        />
      </div>
    </>
  )
}
