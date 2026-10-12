export type ProxyProofVerdict =
  "bypass_rejected" | "bypass_possible" | "inconclusive"
export type ProbeOperation = "register" | "rename" | "transfer" | "unregister"
export interface ProxyProof {
  verdict: ProxyProofVerdict
  completed: ProbeOperation[]
  failedOperation?: ProbeOperation
  cleanupSucceeded: boolean
}

/** Real upstream responses determine the verdict. A denied valid control is
 * inconclusive, never evidence that missing admissions were enforced. */
export async function proveProxyAdmission(input: {
  checkGateway?(): Promise<"rejected" | "bypass" | "unqualified">
  request(
    operation: ProbeOperation,
    admission: "valid" | "missing" | "wrong"
  ): Promise<Response>
  cleanup(): Promise<boolean>
}): Promise<ProxyProof> {
  const proof: ProxyProof = {
    verdict: "inconclusive",
    completed: [],
    cleanupSucceeded: false,
  }
  try {
    if (input.checkGateway) {
      const gateway = await input.checkGateway()
      if (gateway !== "rejected") {
        if (gateway === "bypass") {
          proof.verdict = "bypass_possible"
          proof.failedOperation = "register"
        }
        return proof
      }
    }
    for (const operation of [
      "register",
      "rename",
      "transfer",
      "unregister",
    ] as const) {
      proof.failedOperation = operation
      for (const admission of ["missing", "wrong"] as const) {
        const response = await input.request(operation, admission)
        if (response.ok) {
          proof.verdict = "bypass_possible"
          return proof
        }
        if (response.status !== 403) return proof
      }
      // The same mutation must actually work with the proxy admission. This
      // rules out invalid signatures, nonexistent wallets and disabled routes.
      if (!(await input.request(operation, "valid")).ok) return proof
      proof.completed.push(operation)
    }
    delete proof.failedOperation
    proof.verdict = "bypass_rejected"
    return proof
  } catch {
    return proof
  } finally {
    try {
      proof.cleanupSucceeded = await input.cleanup()
    } catch {
      proof.cleanupSucceeded = false
    }
  }
}
