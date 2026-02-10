import { useSyncExternalStore } from "react"
import { subscribeNdkState, getNdkState, type NdkState } from "../protocol/ndk"

export function useNdkState(): NdkState {
  return useSyncExternalStore(subscribeNdkState, getNdkState, getNdkState)
}
