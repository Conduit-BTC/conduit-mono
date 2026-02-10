interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string
  readonly VITE_DEFAULT_RELAYS?: string
  readonly VITE_LIGHTNING_NETWORK?: string
  readonly VITE_BLOSSOM_SERVER_URL?: string
  readonly [key: string]: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
