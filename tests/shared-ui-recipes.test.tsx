import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Field } from "../packages/ui/src/components/Field"
import { Input } from "../packages/ui/src/components/Input"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../packages/ui/src/components/Table"

describe("shared UI recipes", () => {
  it("associates each input with its own visible label, help and validation error", () => {
    const html = renderToStaticMarkup(
      <>
        <Field label="Name" description="Visible help" error="Name is required">
          {(props) => <Input {...props} required />}
        </Field>
        <Field label="Reference">{(props) => <Input {...props} />}</Field>
      </>
    )
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([input]) => input)
    const ids = inputs.map((input) => input.match(/\bid="([^"]+)"/)?.[1])
    expect(ids[0]).toBeDefined()
    expect(ids[1]).toBeDefined()
    expect(ids[0]).not.toBe(ids[1])
    for (const id of ids) expect(html).toContain(`for="${id}"`)
    expect(inputs[0]).toContain('aria-invalid="true"')
    const describedBy = inputs[0]
      .match(/aria-describedby="([^"]+)"/)?.[1]
      .split(" ")
    expect(describedBy).toHaveLength(2)
    for (const id of describedBy ?? []) expect(html).toContain(`id="${id}"`)
    expect(html).toContain("Visible help")
    expect(html).toContain("Name is required")
    expect(inputs[1]).not.toContain("aria-describedby")
    expect(inputs[1]).not.toContain("aria-invalid")
  })

  it("keeps column and row headers and a keyboard reachable named scroll region", () => {
    const html = renderToStaticMarkup(
      <Table scrollLabel="Order status" density="compact">
        <TableCaption>Recent orders</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-selected="true">
            <TableHead scope="row">1042</TableHead>
            <TableCell>Awaiting payment</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )
    expect(html).toContain(
      'role="region" aria-label="Order status" tabindex="0"'
    )
    expect(html).toMatch(/<caption[^>]*>Recent orders<\/caption>/)
    expect(html.match(/scope="col"/g)).toHaveLength(2)
    expect(html).toContain('scope="row"')
    expect(html).toContain('data-selected="true"')
    expect(html).toContain("Awaiting payment")
    expect(html).not.toContain('role="grid"')
  })
})
