import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type {
  CommerceQueryMeta,
  ProfileBatchResult,
} from "../src/protocol/commerce"
import type { SelectedProfileContext } from "../src/protocol/profile-cache"
import { useProfile, type UseProfileResult } from "../src/hooks/useProfile"

const PUBKEY = "a".repeat(64)
function selectedContext(lud16: string | undefined): SelectedProfileContext {
  return {
    profile: { pubkey: PUBKEY, name: "Merchant", lud16 },
    frontier: {
      eventId: "selected",
      eventCreatedAt: 20,
      rawContent: JSON.stringify({ name: "Merchant", lud16 }),
      validity: "valid",
    },
    freshness: "observed",
    persistence: "durable",
    readComplete: true,
  }
}

describe("selected profile context hook", () => {
  for (const failedRefetch of [false, true]) {
    it(`exposes selected authority through the profile hook${failedRefetch ? " after a failed refetch" : ""}`, () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      })
      const queryKey = [
        "profiles",
        "",
        [PUBKEY],
        "visible",
        "",
        undefined,
        undefined,
        undefined,
        "",
      ]
      const context = selectedContext(undefined)
      const current: ProfileBatchResult = {
        data: { [PUBKEY]: context.profile },
        profileContexts: { [PUBKEY]: context },
        meta: { source: "public", stale: false } as CommerceQueryMeta,
      }
      queryClient.setQueryData(queryKey, current)
      if (failedRefetch) {
        queryClient
          .getQueryCache()
          .find({ queryKey })!
          .setState({
            status: "error",
            error: new Error("Synthetic failed refetch"),
          })
      }
      let observed: UseProfileResult | undefined
      function Reader() {
        observed = useProfile(PUBKEY, { enabled: false })
        return null
      }
      renderToStaticMarkup(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(Reader),
        })
      )
      expect(observed?.profileContext?.frontier).toEqual(context.frontier)
      expect(observed?.profileContext?.profile.lud16).toBeUndefined()
      expect(observed?.profileContext?.freshness).toBe(
        failedRefetch ? "retained" : "observed"
      )
      expect(observed?.profileContext?.readComplete).toBe(!failedRefetch)
      expect(observed?.profileContexts[PUBKEY]).toBe(observed?.profileContext)
      expect(current.profileContexts[PUBKEY].freshness).toBe("observed")
      queryClient.clear()
    })
  }
})
