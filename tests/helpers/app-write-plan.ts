import { config, __setRelayPublishTestOverrides } from "@conduit/core"
import { relayTargetsFromUrls } from "../../packages/core/src/protocol/relay-authority"

/** Register synthetic App routes and retain their grants in an injected plan. */
export function setAppWritePlanFixture(
  overrides: Parameters<typeof __setRelayPublishTestOverrides>[0]
): void {
  const plan = overrides.planPublishRelays
  __setRelayPublishTestOverrides({
    ...overrides,
    ...(plan
      ? {
          planPublishRelays: async (input) => {
            const result = await plan(input)
            const urls = [
              ...result.primaryRelayUrls,
              ...result.broadcastRelayUrls,
            ]
            config.commerceRelayUrls = [
              ...new Set([...config.commerceRelayUrls, ...urls]),
            ]
            return {
              ...result,
              primaryRelayTargets:
                result.primaryRelayTargets ??
                relayTargetsFromUrls(result.primaryRelayUrls, {
                  kind: "app",
                  operation: "write",
                  bucket: "commerce_write",
                }),
              broadcastRelayTargets:
                result.broadcastRelayTargets ??
                relayTargetsFromUrls(result.broadcastRelayUrls, {
                  kind: "app",
                  operation: "write",
                  bucket: "commerce_write",
                }),
            }
          },
        }
      : {}),
  })
}
