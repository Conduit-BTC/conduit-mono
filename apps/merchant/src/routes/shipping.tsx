import { createFileRoute, Link } from "@tanstack/react-router"
import { MerchantShippingPolicyEditor } from "../components/MerchantShippingPolicyEditor"
export const Route = createFileRoute("/shipping")({ component: ShippingPage })
function ShippingPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Shipping</h1>
      <p>
        Shipping policies own destinations, rates and calculation terms. General
        merchant location is in <Link to="/preferences">Preferences</Link>.
      </p>
      <MerchantShippingPolicyEditor />
    </main>
  )
}
