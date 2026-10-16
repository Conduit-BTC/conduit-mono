// Provider admission requires a protected, reviewed operator environment.
// Candidate source never receives provider credentials or executes mutations.
const result = {
  check: "address-proxy-admission",
  verdict: "inconclusive",
  reason: "protected_operator_proof_required",
}

if (import.meta.main) {
  console.log(JSON.stringify(result))
  process.exitCode = 1
}
