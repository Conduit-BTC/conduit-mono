import { createRoot } from "react-dom/client"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src"

// Mounted into real app layouts by the browser regression, never an app route.
// Keep the form unpositioned: Radix's native form control must inherit the
// scroll owner's containing block, rather than an accidentally helpful wrapper.
function ScrollContainmentHarness() {
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <div style={{ height: 1600 }} aria-hidden="true" />
      <Select name="containment-choice" defaultValue="first">
        <SelectTrigger aria-label="Containment choice">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="first">First choice</SelectItem>
          <SelectItem value="second">Second choice</SelectItem>
        </SelectContent>
      </Select>
      <Input aria-label="Last form field" />
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button">Open containment dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Containment dialog</DialogTitle>
          <DialogDescription>
            Check portal visibility and focus.
          </DialogDescription>
          <Input aria-label="Dialog field" />
        </DialogContent>
      </Dialog>
    </form>
  )
}

export function mountScrollContainmentHarness(container: HTMLElement) {
  const root = createRoot(container)
  root.render(<ScrollContainmentHarness />)
}
