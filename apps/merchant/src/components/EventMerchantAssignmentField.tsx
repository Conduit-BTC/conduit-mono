import { Field, Input } from "@conduit/ui"

export function EventMerchantAssignmentField({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <Field
      id={id}
      label="Public assignment"
      description="Required before approval. Tell buyers which booth or pickup desk to use."
    >
      {(control) => (
        <Input
          {...control}
          value={value}
          required
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Booth 12 or pickup desk"
        />
      )}
    </Field>
  )
}
