/**
 * Fences foreground verification across repeated background/offline boundaries.
 *
 * The controller intentionally knows nothing about signing or React. It only
 * decides whether a completed identity proof belongs to the latest lifecycle
 * epoch and whether another explicit verification pass is still required.
 */
export class RemoteSignerResumeController {
  private epoch = 0
  private verificationRequired = false
  private inFlightEpoch: number | null = null

  markBoundary(hasPendingRequest = false): boolean {
    this.epoch += 1
    this.verificationRequired = true
    return !hasPendingRequest
  }

  beginVerification(): number | null {
    if (!this.verificationRequired || this.inFlightEpoch !== null) return null
    this.verificationRequired = false
    this.inFlightEpoch = this.epoch
    return this.inFlightEpoch
  }

  completeVerification(attemptEpoch: number): boolean {
    if (this.inFlightEpoch !== attemptEpoch) return false
    this.inFlightEpoch = null
    return attemptEpoch === this.epoch && this.verificationRequired === false
  }

  requireAnotherVerification(): void {
    this.epoch += 1
    this.verificationRequired = true
  }

  get requiresVerification(): boolean {
    return this.verificationRequired
  }

  reset(): void {
    this.epoch += 1
    this.verificationRequired = false
    this.inFlightEpoch = null
  }
}
