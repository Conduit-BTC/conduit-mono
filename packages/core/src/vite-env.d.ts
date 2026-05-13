interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string
  readonly VITE_DEFAULT_RELAYS?: string
  readonly VITE_PUBLIC_RELAY_URLS?: string
  readonly VITE_COMMERCE_RELAY_URLS?: string
  readonly VITE_LIGHTNING_NETWORK?: string
  readonly VITE_BLOSSOM_SERVER_URL?: string
  readonly VITE_NIP89_RELAY_HINT?: string
  readonly VITE_NIP89_MARKET_PUBKEY?: string
  readonly VITE_NIP89_MERCHANT_PUBKEY?: string
  readonly VITE_NIP89_MARKET_D_TAG?: string
  readonly VITE_NIP89_MERCHANT_D_TAG?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_BUILD_COMMIT?: string
  readonly VITE_BUILD_BRANCH?: string
  readonly VITE_BUILD_TIME?: string
  readonly VITE_SOURCE_URL?: string
  readonly VITE_RELEASE_CHANNEL?: string
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
