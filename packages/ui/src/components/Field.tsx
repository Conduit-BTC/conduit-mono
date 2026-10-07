import { useId, type ReactNode } from "react"
import { Label } from "./Label"

export interface FieldControlProps {
  id: string
  "aria-describedby"?: string
  "aria-invalid"?: true
}

/** Presentation only: validation and values stay with the consuming form. */
export function Field({
  label,
  description,
  error,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  children: (props: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy = [description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {description ? (
        <p
          id={descriptionId}
          className="mt-1 text-pretty text-sm text-[var(--text-secondary)]"
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="mt-1 text-pretty text-sm font-medium text-[var(--error-text)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
