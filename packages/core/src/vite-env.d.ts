interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string
  readonly VITE_DEFAULT_RELAYS?: string
  readonly VITE_LIGHTNING_NETWORK?: string
  readonly VITE_BLOSSOM_SERVER_URL?: string
  readonly VITE_NIP89_RELAY_HINT?: string
  readonly VITE_NIP89_MARKET_PUBKEY?: string
  readonly VITE_NIP89_MERCHANT_PUBKEY?: string
  readonly VITE_NIP89_MARKET_D_TAG?: string
  readonly VITE_NIP89_MERCHANT_D_TAG?: string
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
