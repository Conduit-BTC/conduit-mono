import { startMerchantCheckoutSparkReconciliation } from "../../packages/core/src/protocol/checkout-spark-merchant-reconciliation-worker"
import type { MerchantCheckoutSparkRecoveryCandidate } from "../../packages/core/src/protocol/commerce"
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools"
import {
  createCheckoutSparkSettledShopperRunner,
  type CheckoutSparkSettledShopperRunInput,
} from "../../apps/market/src/lib/checkout-spark-settled-shopper-runner"
import { harness } from "./fixture"
const run = harness()
run.throwOnSend = true
const result = document.querySelector("#result")!
document.querySelector("#run")!.addEventListener("click", async () => {
  await run.step()
  run.throwOnSend = false
  const next = await run.step()
  result.textContent = JSON.stringify({
    reason: next.reason,
    sends: run.sends.length,
    status: run.state.legs[0]!.status,
  })
})

const accountButton = document.createElement("button")
accountButton.textContent = "Test account-change fence"
document.body.append(accountButton)
accountButton.addEventListener("click", async () => {
  let account = "synthetic-buyer"
  let reads = 0
  const runner = createCheckoutSparkSettledShopperRunner({
    repository: {
      load: async () => {
        reads++
        account = "synthetic-other"
        return { status: "absent" }
      },
    } as never,
  })
  const input = {
    checkoutId: "synthetic-checkout",
    planDigest: "synthetic-plan",
    buyerPubkey: account,
    currentBuyerPubkey: () => account,
    shouldContinue: () => true,
    fundingMode: "inspect",
    fundingPayment: {
      buyerPubkey: account,
      paymentTarget: { type: "manual" },
      shouldContinue: () => true,
    },
    authorization: {
      planDigest: "synthetic-plan",
      walletId: "synthetic-wallet",
      grossFundingSats: 1,
    },
  } as CheckoutSparkSettledShopperRunInput
  const outcome = await runner.run(input)
  result.textContent = JSON.stringify({ ...outcome, reads })
})

const controls = document.createElement("div")
controls.innerHTML =
  '<button id="start">Start guarded read</button><button id="pause">Pause guarded read</button><button id="release">Release guarded read</button><button id="duplicate">Start duplicate run</button><button id="cancel">Cancel activation</button>'
document.body.append(controls)
let release = () => {}
let active = true
let reads = 0
let runner: ReturnType<typeof createCheckoutSparkSettledShopperRunner>
let input: CheckoutSparkSettledShopperRunInput
const write = (value: unknown) => {
  result.textContent = JSON.stringify(value)
}
document.querySelector("#start")!.addEventListener("click", () => {
  runner = createCheckoutSparkSettledShopperRunner({
    repository: {
      load: async () => {
        reads++
        await new Promise<void>((resolve) => {
          release = resolve
          result.textContent = "read pending"
        })
        return { status: "absent" }
      },
    } as never,
  })
  input = {
    checkoutId: "guarded-checkout",
    planDigest: "guarded-plan",
    buyerPubkey: "synthetic-buyer",
    currentBuyerPubkey: () => "synthetic-buyer",
    shouldContinue: () => active,
    fundingMode: "inspect",
    fundingPayment: {
      buyerPubkey: "synthetic-buyer",
      paymentTarget: { type: "manual" },
      shouldContinue: () => active,
    },
    authorization: {
      planDigest: "guarded-plan",
      walletId: "synthetic-wallet",
      grossFundingSats: 1,
    },
  } as CheckoutSparkSettledShopperRunInput
  void runner.run(input).then((value) => write({ ...value, reads }))
})
document.querySelector("#pause")!.addEventListener("click", () => {
  void runner.pause()
})
document.querySelector("#release")!.addEventListener("click", () => release())
document.querySelector("#cancel")!.addEventListener("click", () => {
  active = false
})
document.querySelector("#duplicate")!.addEventListener("click", () => {
  void runner.run(input).then((value) => write({ ...value, reads }))
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void runner?.pause()
})

// This identity exists only in the isolated local test app, never in app routes.
const syntheticKey = new Uint8Array(32).fill(7)
const signer = {
  getPublicKey: async () => getPublicKey(syntheticKey),
  signEvent: async (event: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(event, syntheticKey),
}
Object.defineProperty(window, "nostr", { configurable: true, value: signer })
const sign = document.createElement("button")
sign.textContent = "Verify synthetic extension signer"
document.body.append(sign)
sign.addEventListener("click", async () => {
  const event = await signer.signEvent({
    kind: 1,
    created_at: 1_800_000_000,
    tags: [],
    content: "Synthetic browser test",
  })
  write({
    valid: verifyEvent(event),
    identityMatches: event.pubkey === (await signer.getPublicKey()),
  })
})

const workerButton = document.createElement("button")
workerButton.textContent = "Inspect serial worker ownership"
document.body.append(workerButton)
workerButton.addEventListener("click", async () => {
  const started: string[] = []
  let releaseWork = () => {}
  let entered = () => {}
  const entry = new Promise<void>((resolve) => {
    entered = resolve
  })
  const worker = startMerchantCheckoutSparkReconciliation({
    active: true,
    now: () => 1_800_000_000_000,
    onUpdate: () => {},
    reconcile: async (candidate, assertActive) => {
      started.push(candidate.checkoutId)
      entered()
      await new Promise<void>((resolve) => {
        releaseWork = resolve
      })
      assertActive()
      return "pending"
    },
  })
  const candidates = ["first", "second"].map(
    (id) =>
      ({
        schemaVersion: 2,
        checkoutId: id,
        orderId: id,
        wrapId: id,
        planDigest: id,
        takeoverAt: 1,
        preparedAt: 1,
      }) as MerchantCheckoutSparkRecoveryCandidate
  )
  worker.replaceCandidates(candidates)
  await entry
  worker.setActive(false)
  releaseWork()
  await worker.stopAndDrain()
  write({
    selectedCard: "second",
    actualWorker: started[0],
    starts: started.length,
  })
})
