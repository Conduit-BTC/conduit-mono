import { createContext, useContext, type ReactNode } from "react"
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
