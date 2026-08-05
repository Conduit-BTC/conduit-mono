import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react"
import {
  buildMerchantSetupStepResultTelemetryProperties,
  recordBrowserTelemetryEvent,
  type MerchantSetupTelemetryStep,
} from "@conduit/core"
import { useMerchantReadiness } from "./useMerchantReadiness"
import type { MerchantSetupReadiness } from "../lib/readiness"

const MerchantReadinessContext = createContext<MerchantSetupReadiness | null>(
  null
)

export function MerchantReadinessProvider({
  children,
}: {
  children: ReactNode
}) {
  const readiness = useMerchantReadiness()
  const emittedResultSignaturesRef = useRef(new Set<string>())

  useEffect(() => {
    const stepResults: Array<{
      complete: boolean
      pending: boolean
      step: MerchantSetupTelemetryStep
    }> = [
      {
        complete: readiness.profileComplete,
        pending: readiness.profileCheckPending,
        step: "profile",
      },
      {
        complete: readiness.paymentsComplete,
        pending: readiness.paymentsCheckPending,
        step: "payments",
      },
      {
        complete: readiness.shippingComplete,
        pending: readiness.shippingCheckPending,
        step: "shipping",
      },
      {
        complete: readiness.networkComplete,
        pending: false,
        step: "network",
      },
    ]

    for (const result of stepResults) {
      if (result.pending) continue
      const status = result.complete ? "success" : "blocked"
      const signature = `${result.step}:${status}`
      if (emittedResultSignaturesRef.current.has(signature)) continue

      emittedResultSignaturesRef.current.add(signature)
      recordBrowserTelemetryEvent({
        app: "merchant",
        eventName: "merchant_setup_step_result",
        properties: buildMerchantSetupStepResultTelemetryProperties({
          status,
          step: result.step,
        }),
      })
    }
  }, [readiness])

  return (
    <MerchantReadinessContext.Provider value={readiness}>
      {children}
    </MerchantReadinessContext.Provider>
  )
}

export function useMerchantReadinessState(): MerchantSetupReadiness {
  const readiness = useContext(MerchantReadinessContext)

  if (!readiness) {
    throw new Error(
      "useMerchantReadinessState must be used inside MerchantReadinessProvider"
    )
  }

  return readiness
}
