import type { CheckoutSparkSettledReconciliation } from "./checkout-spark-settled-router"

const MAX_PENDING_CANCELLATIONS = 128

interface CancellationAuthority {
  readonly scope: object
  readonly state: string
  readonly revision: number
  readonly key: string
  consumed: boolean
}

/** Internal process-local ledger. Each payment rail owns a separate instance. */
export function createCheckoutSparkPreProviderCancellationRegistry<
  Capability extends object,
>() {
  const authorities = new WeakMap<Capability, CancellationAuthority>()
  const byScope = new WeakMap<object, Map<string, Capability>>()
  const revoke = (capability: Capability | undefined) => {
    if (!capability) return
    const authority = authorities.get(capability)
    if (authority) authority.consumed = true
  }
  return {
    remember(
      scope: object,
      state: CheckoutSparkSettledReconciliation,
      revision: number,
      key: string
    ): void {
      const capability = Object.freeze({}) as Capability
      authorities.set(capability, {
        scope,
        state: JSON.stringify(state),
        revision,
        key,
        consumed: false,
      })
      let entries = byScope.get(scope)
      if (!entries) {
        entries = new Map()
        byScope.set(scope, entries)
      }
      revoke(entries.get(key))
      entries.delete(key)
      entries.set(key, capability)
      if (entries.size > MAX_PENDING_CANCELLATIONS) {
        const oldest = entries.keys().next().value!
        revoke(entries.get(oldest))
        entries.delete(oldest)
      }
    },
    load(
      scope: object | undefined,
      state: CheckoutSparkSettledReconciliation,
      revision: number,
      key: string
    ): Capability | undefined {
      const capability = scope && byScope.get(scope)?.get(key)
      if (!capability) return undefined
      const authority = authorities.get(capability)
      const valid =
        authority &&
        !authority.consumed &&
        authority.scope === scope &&
        authority.revision === revision &&
        authority.state === JSON.stringify(state)
      // An older presentation snapshot cannot revoke a newer live capability.
      // A positively newer durable revision makes this exact entry obsolete.
      if (!authority || authority.consumed || revision > authority.revision) {
        revoke(capability)
        byScope.get(scope!)?.delete(key)
      }
      return valid ? capability : undefined
    },
    authority(capability: Capability): CancellationAuthority | undefined {
      return authorities.get(capability)
    },
    forget(scope: object, key: string): void {
      revoke(byScope.get(scope)?.get(key))
      byScope.get(scope)?.delete(key)
    },
    consume(capability: Capability): void {
      const authority = authorities.get(capability)
      if (authority) {
        authority.consumed = true
        if (byScope.get(authority.scope)?.get(authority.key) === capability)
          byScope.get(authority.scope)?.delete(authority.key)
      }
    },
  }
}
