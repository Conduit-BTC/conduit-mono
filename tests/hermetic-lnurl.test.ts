import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  createHermeticLnurlFixture,
  type HermeticLnurlIssuedInvoice,
} from "../e2e/helpers/hermetic-lnurl"
import {
  assertCheckoutSparkLnurlInvoiceOrigin,
  resolveCheckoutSparkLnurlInvoice,
} from "../packages/core/src/protocol/checkout-spark-lnurl-invoice"
import {
  fetchLnurlPayMetadata,
  decodeLightningInvoiceMetadata,
  isValidLightningInvoice,
  validateZapInvoiceDescriptionBinding,
} from "../packages/core/src/protocol/lightning"

const NOW = 1_800_000_000
const MERCHANT = "merchant@wallet.conduit.market"
const CALLBACK =
  "https://wallet.conduit.market/__hermetic_lnurl/callback/merchant"

test("real LNURL resolution accepts an offline signed regtest invoice and retains local origin", async () => {
  const issued: HermeticLnurlIssuedInvoice[] = []
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: MERCHANT }],
    nowSeconds: () => NOW,
    onInvoiceIssued: (invoice) => {
      issued.push(invoice)
    },
  })
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => {
      const response = await fixture.respond({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method ?? "GET",
      })
      if (!response) throw new Error("Unconfigured offline request")
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      })
    }
  )
  try {
    const metadata = await fetchLnurlPayMetadata(MERCHANT)
    expect(metadata.allowsNostr).toBe(false)
    expect(metadata.nostrPubkey).toBeUndefined()
    expect(fixture.snapshot()).toEqual({
      metadataRequests: 1,
      invoicesIssued: 0,
    })
    const invoice = await resolveCheckoutSparkLnurlInvoice({
      lud16: MERCHANT,
      amountSats: 700,
      network: "regtest",
      nowSeconds: NOW,
      shouldContinue: () => true,
    })
    expect(issued).toHaveLength(1)
    expect(issued[0]!.paymentRequest === invoice.paymentRequest).toBe(true)
    expect(
      createHash("sha256")
        .update(Buffer.from(issued[0]!.preimage, "hex"))
        .digest("hex") === invoice.paymentHash
    ).toBe(true)
    // This pure BOLT11 hash checker accepts exact description bytes; no zap is made.
    expect(
      validateZapInvoiceDescriptionBinding({
        invoice: invoice.paymentRequest,
        zapRequestJson: metadata.metadata,
      }).ok
    ).toBe(true)
    expect(
      assertCheckoutSparkLnurlInvoiceOrigin(invoice.origin, {
        lud16: MERCHANT,
        network: "regtest",
        amountSats: 700,
        paymentRequest: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        expiresAt: invoice.expiresAt,
      })
    ).toBe(NOW * 1_000)
    expect(invoice.expiresAt).toBe(NOW + 900)
    expect(fixture.snapshot()).toEqual({
      metadataRequests: 2,
      invoicesIssued: 1,
    })
  } finally {
    transport.mockRestore()
  }
})

test("invoice registration failure is content-free and does not release an invoice", async () => {
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: MERCHANT }],
    nowSeconds: () => NOW,
    onInvoiceIssued: () => {
      throw new Error("Runner registration unavailable")
    },
  })
  await expect(
    fixture.respond({
      url: "https://wallet.conduit.market/__hermetic_lnurl/callback/merchant?amount=700000",
      method: "GET",
    })
  ).rejects.toThrow("Offline LNURL invoice registration failed")
  expect(fixture.snapshot()).toEqual({ metadataRequests: 0, invoicesIssued: 0 })
})

test("the callback response waits until runner-side native registration is ready", async () => {
  let registrationStarted = false
  let releaseRegistration!: () => void
  const registration = new Promise<void>((resolve) => {
    releaseRegistration = resolve
  })
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: MERCHANT }],
    nowSeconds: () => NOW,
    onInvoiceIssued: async () => {
      registrationStarted = true
      await registration
    },
  })
  const pending = fixture.respond({
    url: `${CALLBACK}?amount=2000`,
    method: "GET",
  })
  expect(registrationStarted).toBe(true)
  expect(fixture.snapshot().invoicesIssued).toBe(0)
  releaseRegistration()
  expect((await pending)?.status).toBe(200)
  expect(fixture.snapshot().invoicesIssued).toBe(1)
})

test("fee fitting can issue multiple exact invoices without completing a payment", async () => {
  let now = NOW
  const issued: HermeticLnurlIssuedInvoice[] = []
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: MERCHANT }],
    nowSeconds: () => now,
    feeSats: 2,
    onInvoiceIssued: async (invoice) => {
      issued.push(invoice)
    },
  })
  for (const amountSats of [700, 699]) {
    const response = await fixture.respond({
      url: `${CALLBACK}?amount=${amountSats * 1_000}`,
      method: "GET",
    })
    const invoice = JSON.parse(response!.body).pr as string
    expect(isValidLightningInvoice(invoice)).toBe(true)
    const metadata = decodeLightningInvoiceMetadata(invoice)
    expect(metadata.sats).toBe(amountSats)
    expect(metadata.createdAt).toBe(now)
    expect(metadata.expiresAt).toBe(now + 900)
    now += 60
  }
  expect(
    issued.map(({ amountSats, feeSats }) => ({ amountSats, feeSats }))
  ).toEqual([
    { amountSats: 700, feeSats: 2 },
    { amountSats: 699, feeSats: 2 },
  ])
  expect(issued[0]!.preimage !== issued[1]!.preimage).toBe(true)
  expect(fixture.snapshot()).toEqual({ metadataRequests: 0, invoicesIssued: 2 })
})

test("only exact GET endpoints and whole-sat amounts inside the configured range issue invoices", async () => {
  const fixture = createHermeticLnurlFixture({
    recipients: [{ lud16: MERCHANT, minSendable: 2_000, maxSendable: 5_000 }],
    nowSeconds: () => NOW,
  })
  for (const request of [
    { url: `${CALLBACK}?amount=1000`, method: "GET" },
    { url: `${CALLBACK}?amount=6000`, method: "GET" },
    { url: `${CALLBACK}?amount=2500`, method: "GET" },
    { url: `${CALLBACK}?amount=2000`, method: "POST" },
    { url: `${CALLBACK}?amount=2000&nostr=unused`, method: "GET" },
    { url: `${CALLBACK}?amount=2000&lnurl=unused`, method: "GET" },
    { url: `${CALLBACK}?amount=2000&amount=2000`, method: "GET" },
    {
      url: "https://wallet.conduit.market/.well-known/lnurlp/unconfigured",
      method: "GET",
    },
    { url: "https://wallet.conduit.market/unconfigured", method: "GET" },
  ])
    expect(await fixture.respond(request)).toBeNull()
  expect(fixture.snapshot()).toEqual({ metadataRequests: 0, invoicesIssued: 0 })
  for (const amount of [2_000, 5_000]) {
    expect(
      (
        await fixture.respond({
          url: `${CALLBACK}?amount=${amount}`,
          method: "GET",
        })
      )?.status
    ).toBe(200)
  }
  expect(fixture.snapshot()).toEqual({ metadataRequests: 0, invoicesIssued: 2 })
})

test("configuration snapshots exact recipients and rejects unusable ranges or clocks", async () => {
  const recipients = [
    { lud16: MERCHANT, minSendable: 1_000, maxSendable: 5_000 },
  ]
  let now = NOW
  const fixture = createHermeticLnurlFixture({
    recipients,
    nowSeconds: () => now,
  })
  recipients[0]!.lud16 = "different@wallet.conduit.market"
  recipients[0]!.maxSendable = 1_000
  expect(
    (await fixture.respond({ url: `${CALLBACK}?amount=5000`, method: "GET" }))
      ?.status
  ).toBe(200)
  expect(
    await fixture.respond({
      url: "https://wallet.conduit.market/.well-known/lnurlp/different",
      method: "GET",
    })
  ).toBeNull()
  for (const value of [-1, Number.NaN, 0x7ffffffff]) {
    now = value
    await expect(
      fixture.respond({ url: `${CALLBACK}?amount=2000`, method: "GET" })
    ).rejects.toThrow("Invalid offline LNURL fixture")
  }
  expect(fixture.snapshot().invoicesIssued).toBe(1)
  for (const input of [
    { recipients: [] },
    { recipients: [{ lud16: MERCHANT }, { lud16: MERCHANT }] },
    {
      recipients: [{ lud16: MERCHANT, minSendable: 2_001, maxSendable: 2_999 }],
    },
    { recipients: [{ lud16: MERCHANT }], expirySeconds: 0 },
    { recipients: [{ lud16: MERCHANT }], expirySeconds: 3_601 },
  ])
    expect(() =>
      createHermeticLnurlFixture({ ...input, nowSeconds: () => NOW })
    ).toThrow("Invalid offline LNURL fixture")
})
