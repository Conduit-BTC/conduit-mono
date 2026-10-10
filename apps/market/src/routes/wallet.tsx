import { WalletCards } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import {
  useAuth,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  type ShopperDisplayCurrency,
} from "@conduit/core"
import { useWallets } from "@conduit/core/hooks/useWallets"
import {
  Wallets,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Label,
} from "@conduit/ui"
import { useShopperPricing } from "../hooks/useShopperPricing"
import { ProfileLightningAddressEditor } from "../components/ProfileLightningAddressEditor"
export const Route = createFileRoute("/wallet")({ component: WalletsPage })
function WalletsPage() {
  const auth = useAuth()
  const wallets = useWallets()
  return (
    <Wallets
      auth={auth}
      wallets={wallets}
      renderAddressEditor={(suggestion, onDismiss) => (
        <ProfileLightningAddressEditor
          key={`${auth.accountPubkey}:${auth.authGeneration}`}
          suggestion={suggestion}
          onDismiss={onDismiss}
        />
      )}
      footer={<PriceDisplaySettings />}
    />
  )
}
function PriceDisplaySettings() {
  const shopperPricing = useShopperPricing()
  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-elevated)] p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <WalletCards className="h-4 w-4 text-[var(--text-muted)]" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--link-text)]">
          Price display
        </h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
        This changes labels only; listings, invoices, and payments keep their
        original values.
      </p>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 sm:items-end">
        <div className="grid gap-2">
          <Label htmlFor="display-currency">Preferred currency</Label>
          <Select
            value={shopperPricing.preference.currency}
            onValueChange={(value) =>
              shopperPricing.setCurrency(value as ShopperDisplayCurrency)
            }
          >
            <SelectTrigger
              id="display-currency"
              className="h-11 rounded-[var(--radius-md)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_SHOPPER_DISPLAY_CURRENCIES.map((currency) => (
                <SelectItem key={currency} value={currency}>
                  {currency === "BITCOIN"
                    ? "Bitcoin (BTC base units)"
                    : currency}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-11 items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-4">
          <Label
            htmlFor="sats-standard"
            className="cursor-pointer text-sm font-medium"
          >
            Sats the standard
          </Label>
          <Switch
            id="sats-standard"
            checked={shopperPricing.preference.bitcoinUnit === "sats"}
            onCheckedChange={shopperPricing.setSatsStandard}
          />
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-[var(--text-muted)]">
        ₿10,000 equals 10,000 sats. This preference changes labels only; it
        never changes a listing, order, invoice, or payment. Wallet balances use
        sats in both apps. Display preferences currently apply on this device.
      </p>
    </section>
  )
}
