import { z } from "zod"
export const receivingWalletBindingSchema = z.strictObject({
  walletId: z.string().min(1).max(128),
  providerId: z.enum(["spark", "nwc"]),
  network: z.enum(["mainnet", "testnet", "signet", "regtest"]),
  requestId: z.string().min(1).max(256).optional(),
})
export type ReceivingWalletBinding = z.infer<
  typeof receivingWalletBindingSchema
>
