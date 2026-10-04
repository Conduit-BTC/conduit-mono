import { useRef, useState } from "react"
import { useProductImageUpload } from "@conduit/core"
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import { getOrganizerEventTimezoneOptions } from "../lib/event-market-form"

export function EventTimezoneField({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Time zone</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose time zone" />
        </SelectTrigger>
        <SelectContent>
          {getOrganizerEventTimezoneOptions(value).map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function EventBannerField({
  id,
  value,
  title,
  scopeId,
  disabled = false,
  onChange,
  onBusyChange,
}: {
  id: string
  value: string
  title: string
  scopeId: string
  disabled?: boolean
  onChange: (url: string) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const upload = useProductImageUpload()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState("")
  const [phase, setPhase] = useState("")
  async function uploadBanner(file: File) {
    const target = upload.target
    if (target.kind !== "configured" && target.kind !== "fallback") return
    setError("")
    onBusyChange?.(true)
    try {
      const url = await upload.uploadFile({
        scopeId,
        itemId: `${scopeId}:banner`,
        file,
        target,
        onPhase: setPhase,
      })
      onChange(url)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Banner upload failed. Retry this file or add its public URL."
      )
    } finally {
      setPhase("")
      onBusyChange?.(false)
      if (input.current) input.current.value = ""
    }
  }
  const canUpload =
    upload.target.kind === "configured" || upload.target.kind === "fallback"
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Event banner (optional)</Label>
      <Input
        id={id}
        type="url"
        value={value}
        disabled={disabled || upload.isBusy}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://…"
      />
      <p className="text-xs text-[var(--text-muted)]">
        Choose a wide 3:1 image, such as 1800 by 600 px. Keep essential text and
        logos away from the outer edges. The full banner is shown without
        cropping.
      </p>
      {canUpload ? (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            {upload.target.kind === "fallback"
              ? "Upload one banner to the public fallback, or configure your media server in Network settings."
              : "Upload the banner to your configured media server."}
          </p>
          <Input
            ref={input}
            aria-label="Choose event banner file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={disabled || upload.isBusy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void uploadBanner(file)
            }}
          />
        </>
      ) : (
        <Button asChild variant="outline" size="sm">
          <a href="/network">Set up banner uploads</a>
        </Button>
      )}
      {phase ? <p role="status">Banner: {phase.replaceAll("_", " ")}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-[var(--destructive)]">
          {error}
        </p>
      ) : null}
      {value ? (
        <img
          src={value}
          alt={`${title || "Event"} banner preview`}
          className="aspect-[3/1] w-full rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] object-contain"
        />
      ) : null}
    </div>
  )
}
