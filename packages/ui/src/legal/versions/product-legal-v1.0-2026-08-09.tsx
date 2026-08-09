/*
 * Copyright (c) 2026 Conduit Hodlings Inc. All rights reserved.
 *
 * The legal prose in this versioned file is excluded from the repository's
 * MIT License. See the Legal Content and Trademarks Exception in /LICENSE.
 */

import {
  PRODUCT_PRIVACY_PATH,
  PRODUCT_TERMS_PATH,
} from "../../components/ProductLegalVersion"

export function ProductPrivacyScopeNoticeVersion() {
  return (
    <>
      <strong>Scope:</strong> This Product Privacy Policy applies only to the
      official Conduit Shop application at shop.conduit.market, the official
      Conduit Sell application at sell.conduit.market, and Conduit-operated
      supporting infrastructure used to provide those Product Apps. It does not
      describe Conduit’s marketing, educational, investor, Updates,
      administration, or Website analytics at conduit.market. See the Conduit
      Website Privacy Policy and Website Terms of Service for those surfaces. We
      use separate notices because the Website and Product Apps serve different
      purposes and use materially different analytics and data flows.
    </>
  )
}

export function ProductTermsScopeNoticeVersion() {
  return (
    <>
      <strong>Scope:</strong> These Product Terms apply only to the official
      Conduit Shop application at shop.conduit.market and the official Conduit
      Sell application at sell.conduit.market, together the “Product Apps.” They
      do not govern the informational Website at conduit.market, which is
      subject to the Website Terms of Service and Website Privacy Policy. If
      both sets of terms could appear relevant, these Product Terms control use
      of the Product Apps.
    </>
  )
}

export function ProductPrivacyPolicyVersion() {
  return (
    <>
      <section aria-labelledby="privacy-1">
        <h2 id="privacy-1">1. Who We Are And Where This Policy Applies</h2>
        <p>
          Conduit Hodlings Inc, doing business as Conduit (“Conduit,” “we,”
          “us,” or “our”), provides the official Conduit Shop and Conduit Sell
          Product Apps only at <strong>shop.conduit.market</strong> and{" "}
          <strong>sell.conduit.market</strong>. This policy also covers
          Conduit-operated supporting infrastructure used to provide those
          official Product Apps.
        </p>
        <p>
          This policy does not apply to a fork, copy, modified build, or
          deployment of the open-source software outside the two official hosts.
          Those deployments are outside this policy, and their operators must
          provide their own privacy notices. Conduit designs the official
          Product Apps to minimize unnecessary data collection. We do not
          custody user funds or durable Nostr account private keys, and we do
          not sell personal information.
        </p>
      </section>

      <section aria-labelledby="privacy-2">
        <h2 id="privacy-2">2. Public Nostr Information</h2>
        <p>
          Nostr is a decentralized event protocol. Information intentionally
          published as public Nostr events may be visible worldwide. This may
          include public keys; merchant and buyer profile fields; product
          listings, prices, images, and tags; shipping options; relay
          declarations and preferences; public social activity; payment
          addresses; timestamps; and other information a user chooses to make
          public.
        </p>
        <p>
          Independently operated relays, clients, indexers, archives, search
          services, counterparties, and other network participants may copy,
          index, cache, retain, republish, omit, or delete public events.
          Conduit may retrieve, display, cache, or limit the display of public
          events in the Product Apps, but Conduit cannot promise central or
          complete deletion from Nostr or from systems outside our control.
        </p>
      </section>

      <section aria-labelledby="privacy-3">
        <h2 id="privacy-3">3. Information Stored In The Browser</h2>
        <p>
          The Product Apps use browser storage so decentralized commerce can
          work without a traditional hosted account database. Depending on the
          Product App, the features used, and whether a user is signed in,
          browser-local information may include:
        </p>
        <ul>
          <li>the connected public key and selected signer method;</li>
          <li>
            relay settings and cached NIP-65 kind-10002 and private-inbox
            kind-10050 information;
          </li>
          <li>
            carts, display and shopping preferences, product and profile caches,
            and BTC or fiat price caches;
          </li>
          <li>checkout shipping and contact drafts;</li>
          <li>
            decrypted ordinary messages and decrypted order conversations;
          </li>
          <li>
            order lifecycle records and invoice or payment-status information;
          </li>
          <li>records of payment attempts and their outcomes;</li>
          <li>
            buyer or merchant Nostr Wallet Connect (“NWC”) connection URIs and
            secrets when a user configures a wallet connection; and
          </li>
          <li>
            encrypted browser-local NIP-46 client connection keys and related
            remote-signer session information.
          </li>
        </ul>
        <p>
          Browser-local information is controlled by the browser and device and
          is not sent to Conduit merely because the Product App stores or
          displays it. Particular features may transmit the relevant information
          to a counterparty, signer, wallet, relay, or other chosen service as
          described in this policy.
        </p>
        <p>
          <strong>
            Signed-in message, order, wallet, and preference information may
            remain in the browser until the user removes it, clears site data,
            or the Product App replaces or prunes a cache. Disconnecting a
            signer does not necessarily clear all locally stored order or
            message history.
          </strong>
        </p>
        <p>
          Guest checkout may generate a temporary, per-order browser signing
          key. Current guest signing material, checkout shipping and contact
          draft, and matching local order-recovery data expire after 24 hours
          and are pruned. A browser that prevents or interrupts cleanup may
          require the user to clear site data manually.
        </p>
      </section>

      <section aria-labelledby="privacy-4">
        <h2 id="privacy-4">4. Encrypted Messaging And Local Decryption</h2>
        <p>
          The Product Apps use NIP-17/NIP-59 gift wrapping and NIP-44 encryption
          for ordinary direct messages and order-linked messages. The Product
          Apps unwrap and decrypt these messages locally in the user’s browser
          or through the user’s signer and may cache decrypted copies locally.
          Conduit-operated servers do not ordinarily receive plaintext
          buyer–merchant message contents, and Product Apps do not send those
          plaintext contents to analytics providers.
        </p>
        <p>
          Message contents may include checkout contact and shipping details,
          order items and totals, notes, invoices, payment evidence, status and
          shipping updates, tracking information, and buyer–merchant
          communications. The sender and recipient receive plaintext. Browser
          software, signer software, counterparties, wallets, and other services
          a user chooses may also receive or process plaintext as needed for
          their functions and are governed by their own practices.
        </p>
        <p>
          Information voluntarily submitted to Conduit for support is not a
          private buyer–merchant message. Conduit receives the support
          information a user chooses to provide and uses it to investigate and
          respond to the request. Users should not include signer secrets,
          wallet secrets, invoices, private keys, or unnecessary order or
          contact details in support submissions.
        </p>
      </section>

      <section aria-labelledby="privacy-5">
        <h2 id="privacy-5">5. Relay Delivery And Network Metadata</h2>
        <p>
          Encrypted messages are published to Nostr relays; they are not sent
          directly from one user’s device to another in a peer-to-peer
          connection. A relay or network provider may observe the recipient
          public key in the gift wrap’s outer <code>p</code> tag, the encrypted
          gift wrap and its event size, timing and traffic volume, the selected
          relay, connection behavior, and the direct-connection IP address.
          Where NIP-42 relay authentication is used, a relay may also observe
          the authentication public key and request filters.
        </p>
        <p>
          A usable recipient kind-10050 private-inbox declaration controls
          private-message delivery in the official production Product Apps. If a
          usable declaration cannot be established, including when discovery is
          unavailable, private delivery may fail. This strict production
          behavior applies to ordinary kind-14 direct messages and kind-16
          commerce order messages. Ordinary kind-14 direct messages do not
          receive a compatibility delivery fallback.
        </p>
        <p>
          <strong>relay.conduit.market</strong> is Conduit-operated and hosted
          on Fly.io. Conduit and Fly.io may process WebSocket connection and
          operational metadata needed to operate, secure, diagnose, and protect
          that relay. The relay uses persistent storage. As of this policy's
          last-updated date, Conduit had not verified a fixed gift-wrap
          retention period. This policy does not promise automatic deletion, no
          logging, or complete metadata privacy. Other relays are independently
          operated and may have different storage, access, authentication, and
          logging practices.
        </p>
        <p>
          Encryption protects message content when correctly implemented, but it
          does not eliminate routing or network metadata. Relay acceptance does
          not prove that a recipient retrieved, read, or acted on a message.
        </p>
      </section>

      <section aria-labelledby="privacy-6">
        <h2 id="privacy-6">6. Product Telemetry</h2>
        <p>
          Product telemetry is separate from analytics used on the informational
          Conduit Website. When telemetry is configured and enabled for an
          official Product App deployment, it uses explicitly instrumented
          operational events; sanitized route classes; coarse status, count,
          amount, time, and latency buckets; pageview and pageleave timing; and
          bounded Web Vitals. Browser telemetry uses one shared static service
          identifier and temporary session and pageview identifiers. It is not
          intended to identify a person or a durable Product App account.
        </p>
        <p>
          A public storefront route may contain the merchant’s intentionally
          public npub. A telemetry provider can infer an anonymous visit to a
          sanitized route class such as checkout, orders, messages, products,
          payments, or a public storefront. Product telemetry is not used for
          behavioral advertising.
        </p>
        <p>
          Product telemetry does not create or read analytics cookies and does
          not use localStorage analytics persistence, persistent account or
          visitor identifiers, person profiles, automatic interaction capture,
          heatmaps, console capture, or session replay. It removes or prohibits
          query strings, referrers, campaign parameters, active-user public
          keys, product and order identifiers, message and order contents,
          contact and shipping addresses, invoices, payment hashes and
          preimages, signer secrets, NWC strings, browser fingerprints, and raw
          dynamic paths.
        </p>
        <p>
          Product telemetry’s own configuration does not create analytics
          cookies. A legacy parent-domain cookie created by a different
          conduit.market surface may still be presented by a browser to a
          Product App host until that cookie is removed or expires; browser
          Product telemetry does not use it, and the proxy described below is
          designed not to forward it to PostHog.
        </p>
        <p>
          Browser telemetry on the official Product App hosts is limited to
          PostHog and passes through a Conduit-operated Cloudflare proxy.
          Conduit and Cloudflare necessarily process ordinary connection
          metadata, including source IP at the Cloudflare edge. The proxy is
          designed not to forward browser cookies, browser user-agent,
          <code>CF-Connecting-IP</code>, or <code>X-Forwarded-For</code> headers
          to PostHog. It also restricts origins and ingestion paths, limits
          request size, and does not cache telemetry request bodies.
        </p>
        <p>
          The Product Apps' repository deployment record for this version
          documents a PostHog Cloud plan-managed event retention window of 84
          months. PostHog controls that plan field. Rotating temporary session
          and pageview identifiers does not shorten the provider’s
          event-retention window.
        </p>
        <p>
          Conduit-operated checkout authorization infrastructure may separately
          emit a content-free aggregate outcome event directly to PostHog using
          a static service identifier. It does not include authorization request
          contents, merchant or buyer identifiers, product addresses, amounts,
          invoices, connection secrets, or rate-limit keys.
        </p>
      </section>

      <section aria-labelledby="privacy-7">
        <h2 id="privacy-7">7. Anonymous Public-Zap Checkout Authorization</h2>
        <p>
          When anonymous public-zap checkout authorization is available and
          used, a Conduit-operated endpoint receives the merchant public key,
          public product address coordinates, requested quantities, and ordinary
          connection metadata. It uses source IP information for rate limiting
          and may retrieve the referenced public merchant profile, listing,
          deletion, and pricing information needed to validate the request.
        </p>
        <p>
          This authorization boundary does not receive the buyer’s name, street
          address, phone number, email address, order note, private message,
          invoice preimage, or NWC secret. Conduit therefore receives limited
          order-related public coordinates and quantities for this feature, but
          not the buyer’s private checkout details through this endpoint.
        </p>
      </section>

      <section aria-labelledby="privacy-8">
        <h2 id="privacy-8">8. How Conduit Uses Information</h2>
        <p>Conduit uses information it controls to:</p>
        <ul>
          <li>provide, secure, maintain, and improve the Product Apps;</li>
          <li>
            let the client create, encrypt, publish, retrieve, decrypt, display,
            and locally store public events and private commerce messages;
          </li>
          <li>display public profiles, listings, and shipping options;</li>
          <li>
            validate narrow checkout authorization requests and prevent abuse;
          </li>
          <li>maintain local caches and user-selected preferences;</li>
          <li>provide support and respond to user requests;</li>
          <li>diagnose aggregate reliability and performance problems;</li>
          <li>protect users, infrastructure, and the Product Apps; and</li>
          <li>comply with applicable law and enforce the Product Terms.</li>
        </ul>
      </section>

      <section aria-labelledby="privacy-9">
        <h2 id="privacy-9">9. Independent Services And Other Recipients</h2>
        <p>
          Using the Product Apps may involve independently operated services,
          including Nostr relays; NIP-07 browser signers; NIP-46 remote signers
          and their relays; NWC relays and wallet services; Lightning wallets,
          LNURL providers, and payment infrastructure; BTC and fiat price-data
          providers; PostHog; hosting and content-delivery providers such as
          Cloudflare and Fly.io; merchant-selected image, fulfillment, support,
          or accounting services; and other services selected by a user or
          counterparty.
        </p>
        <p>
          Those services may receive public information, encrypted events,
          plaintext provided to them for their function, payment requests,
          wallet commands, requested URLs, and ordinary connection metadata in
          accordance with their own technology and policies. Conduit does not
          control independent providers merely because a Product App can
          interoperate with them.
        </p>
      </section>

      <section aria-labelledby="privacy-10">
        <h2 id="privacy-10">10. Retention, Deletion, And User Controls</h2>
        <p>
          Users can disconnect a signer or wallet, remove a locally configured
          wallet connection where the Product App provides that control, and
          clear Product App site data through browser settings. Clearing site
          data may remove local carts, preferences, drafts, keys, wallet
          connections, caches, and order or message history from that browser
          and may make locally tracked guest orders unrecoverable.
        </p>
        <p>
          Conduit cannot centrally access or delete information retained by a
          buyer, merchant, counterparty, browser, signer, wallet, public relay,
          independent client, payment provider, or another provider outside
          Conduit’s control. Public events and Lightning payment records may
          remain available even after they no longer appear in a Product App.
          Encrypted events or decrypted copies may remain with senders,
          recipients, relays, signers, and local devices.
        </p>
        <p>
          We respond to lawful and verifiable privacy requests for information
          Conduit controls, subject to legal, security, and operational limits.
        </p>
      </section>

      <section aria-labelledby="privacy-11">
        <h2 id="privacy-11">11. Security</h2>
        <p>
          Conduit uses reasonable administrative, technical, and organizational
          safeguards appropriate to the Product Apps. No internet-based system,
          public relay network, browser extension, wallet connection, local
          storage mechanism, encryption implementation, or third-party service
          can be guaranteed completely secure. Users are responsible for
          protecting their devices, browsers, signers, durable account keys,
          guest recovery material, wallets, NWC connection strings, passwords,
          and other credentials.
        </p>
      </section>

      <section aria-labelledby="privacy-12">
        <h2 id="privacy-12">12. Children</h2>
        <p>
          The Product Apps are not intended for children under 18 or anyone who
          is not old enough to enter a binding agreement in their jurisdiction.
          Conduit does not knowingly collect personal information from children
          through the Product Apps.
        </p>
      </section>

      <section aria-labelledby="privacy-13">
        <h2 id="privacy-13">13. Privacy Rights And Choices</h2>
        <p>
          Depending on where a user lives, the user may have rights to request
          access to, correction of, deletion of, or portability of personal
          information Conduit controls, or to limit certain processing. Conduit
          may need to verify the requester’s identity before responding. These
          rights do not give Conduit technical control over information stored
          only on a device or held by an independent merchant, relay, wallet,
          signer, or other provider.
        </p>
      </section>

      <section aria-labelledby="privacy-14">
        <h2 id="privacy-14">14. Changes To This Policy</h2>
        <p>
          Conduit may update this Product Privacy Policy. Each released version
          receives a stable version identifier and effective date. Community
          proposals, source-code pull requests, and unreleased wording do not
          change the effective policy. Material changes may be announced in the
          Product Apps or by another appropriate notice.
        </p>
      </section>

      <section aria-labelledby="privacy-15">
        <h2 id="privacy-15">15. Contact</h2>
        <p>To ask a privacy question or submit a request, contact:</p>
        <p>
          Conduit Hodlings Inc
          <br />
          3400 Cottage Way, Suite G2, PMB 23234
          <br />
          Sacramento, CA 95825
          <br />
          Email:{" "}
          <a href="mailto:contact@conduitbtc.com">contact@conduitbtc.com</a>
        </p>
        <p>
          The companion{" "}
          <a href={PRODUCT_TERMS_PATH}>Product Terms of Service</a> govern use
          of the official Product Apps.
        </p>
      </section>
    </>
  )
}

export function ProductTermsOfServiceVersion() {
  return (
    <>
      <section aria-labelledby="terms-1">
        <h2 id="terms-1">1. Scope And Agreement</h2>
        <p>
          These Product Terms of Service (“Terms”) are a legal agreement between
          you and Conduit Hodlings Inc, doing business as Conduit (“Conduit,”
          “we,” “us,” or “our”). They govern only your access to and use of the
          official Conduit Shop at <strong>shop.conduit.market</strong> and the
          official Conduit Sell application at{" "}
          <strong>sell.conduit.market</strong>, together the “Product Apps.” By
          accessing or using a Product App, you agree to these Terms and the{" "}
          <a href={PRODUCT_PRIVACY_PATH}>Product Privacy Policy</a>.
        </p>
        <p>
          If you use a Product App for a company or another entity, you
          represent that you have authority to bind that entity, and “you”
          includes the entity.
        </p>
        <p>
          These Terms do not apply to a fork, copy, modified build, preview,
          staging environment, or other deployment outside the two named
          official hosts. The operator of any such deployment must provide its
          own terms. The software’s origin in Conduit’s repository does not by
          itself create an agreement between Conduit Hodlings Inc and that
          deployment’s users or authorize its operator to represent the
          deployment as an official Conduit Product App.
        </p>
      </section>

      <section aria-labelledby="terms-2">
        <h2 id="terms-2">2. Eligibility And Legal Compliance</h2>
        <p>
          You must be at least 18 years old, or the age of legal majority in
          your jurisdiction, and able to enter a binding agreement to use the
          Product Apps. You are responsible for complying with all laws,
          regulations, sanctions, trade restrictions, tax obligations, and
          licensing or registration requirements that apply to you, your use,
          your listings, and your transactions.
        </p>
        <p>
          You may not use the Product Apps if you are located in, ordinarily
          resident in, organized under the laws of, or acting for a person or
          entity in a jurisdiction where that use is prohibited by applicable
          law. You may not use a VPN, proxy, or other tool to evade legal,
          sanctions, or access restrictions.
        </p>
      </section>

      <section aria-labelledby="terms-3">
        <h2 id="terms-3">3. Description Of Shop And Sell</h2>
        <p>
          Conduit Shop is a buyer-facing software interface for discovering
          public merchant listings, preparing and sending order requests,
          managing browser-local order records, making supported Lightning
          payments, and communicating with merchants through Nostr-based
          protocols.
        </p>
        <p>
          Conduit Sell is a merchant-facing software interface for publishing
          profiles, listings, shipping options, and relay declarations;
          receiving and managing order conversations; creating and sending
          invoices and updates; configuring wallet connections; and managing
          merchant workflows.
        </p>
      </section>

      <section aria-labelledby="terms-4">
        <h2 id="terms-4">4. Signers, Keys, Sessions, And Local Storage</h2>
        <p>
          Conduit does not generate or custody a user’s durable Nostr account
          private key. Users ordinarily sign through an external NIP-07 or
          NIP-46 signer. Guest checkout may generate a temporary, order-scoped
          browser key, and NIP-46 connections may use a browser-local client
          connection key; neither is a Conduit-custodied user account key.
        </p>
        <p>
          You are responsible for your signer, public and private keys, guest
          recovery material, signer approvals, browser, device, local site data,
          remote-signer configuration, and wallet credentials. Conduit cannot
          recover a durable account private key or guarantee recovery of a guest
          order after its local recovery data expires or is cleared.
        </p>
        <p>
          The Product Apps may retain signed-in messages, order history, wallet
          connections, and preferences in browser storage after a signer is
          disconnected. You are responsible for clearing local data when using a
          shared, lost, transferred, or untrusted device.
        </p>
      </section>

      <section aria-labelledby="terms-5">
        <h2 id="terms-5">5. Conduit’s Role</h2>
        <p>
          <strong>
            The Product Apps are software interfaces and protocol-coordination
            tools. Conduit is not the merchant of record for independent
            merchants, a buyer or seller in user transactions, an escrow
            provider, custodian, wallet provider, payment processor, shipping
            carrier, tax adviser, or legal adviser.
          </strong>
        </p>
        <p>
          Conduit does not take title to products, set independent merchants’
          terms, possess items, guarantee user identity, or control transaction
          performance between a buyer and merchant. Any transaction is between
          those parties unless Conduit expressly enters a separate written
          agreement stating otherwise.
        </p>
      </section>

      <section aria-labelledby="terms-6">
        <h2 id="terms-6">6. Merchant Responsibilities</h2>
        <p>
          Merchants are solely responsible for their identity and authority to
          sell; listings, descriptions, images, prices, availability, product
          claims, and accuracy; applicable licenses, taxes, disclosures, and
          records; shipping terms, fulfillment, returns, refunds, warranties,
          and customer support; protection and lawful use of buyer information;
          and compliance with laws that apply to the merchant, buyer, product,
          and destination.
        </p>
        <p>
          Merchants must independently verify an order, invoice amount, payment
          status, settlement, delivery address, and any payment proof before
          fulfilling or refunding. Product App status displays and messages are
          workflow aids and do not replace verification through the merchant’s
          wallet, payment provider, carrier, or records.
        </p>
      </section>

      <section aria-labelledby="terms-7">
        <h2 id="terms-7">7. Buyer Responsibilities</h2>
        <p>
          Buyers are responsible for evaluating the merchant, listing, product,
          relay and freshness context, price, taxes, shipping and return terms,
          refund policy, payment destination, invoice, and other transaction
          information before submitting an order request or payment.
        </p>
        <p>
          Buyers must provide accurate information needed for fulfillment, use
          the Product Apps only for lawful transactions, protect their signer
          and wallet, and communicate promptly with the merchant about disputes
          or changes. Conduit does not guarantee that a merchant will accept,
          fulfill, ship, support, cancel, or refund an order.
        </p>
      </section>

      <section aria-labelledby="terms-8">
        <h2 id="terms-8">8. Orders Are Requests Until Accepted</h2>
        <p>
          Submitting an order through Conduit Shop sends an encrypted commerce
          order request to the merchant and may create a browser-local order
          record. An order request is not merchant acceptance. The merchant may
          accept, reject, request changes, issue an invoice, or fail to respond.
          A contract for sale, if any, is formed between buyer and merchant
          under the merchant’s terms and applicable law, not by Conduit merely
          displaying or transmitting the request.
        </p>
        <p>
          Relay acknowledgement, local persistence, a displayed status, or a
          payment-attempt record does not by itself prove merchant receipt,
          acceptance, payment settlement, fulfillment, or delivery.
        </p>
      </section>

      <section aria-labelledby="terms-9">
        <h2 id="terms-9">9. Wallets, Lightning, Payments, And Refunds</h2>
        <p>
          Payments are made directly between buyers and merchants through
          merchant-selected wallets, Lightning invoices, NWC connections, LNURL
          providers, WebLN-compatible tools, or other supported payment rails.
          Conduit does not custody funds, hold balances, process chargebacks,
          operate escrow, or guarantee settlement.
        </p>
        <p>
          Lightning payments may be irreversible once sent or settled. You are
          responsible for verifying the invoice amount, payment destination,
          network, merchant identity, wallet permissions, NWC budget or policy,
          and all transaction details before authorizing payment. Wallets,
          relays, and payment providers may charge fees, fail, delay, return an
          ambiguous result, or behave differently from Product App status.
        </p>
        <p>
          Refunds, returns, cancellations, chargebacks, payment disputes, and
          fulfillment remedies are controlled by the buyer, merchant, applicable
          law, and their chosen payment services—not by Conduit—unless Conduit
          expressly agrees otherwise in a separate writing.
        </p>
      </section>

      <section aria-labelledby="terms-10">
        <h2 id="terms-10">10. Public Nostr Events And Independent Relays</h2>
        <p>
          Profiles, listings, shipping options, relay declarations, and other
          public events may be published to independently operated Nostr relays.
          Relays may accept, reject, copy, index, retain, delete, duplicate,
          delay, omit, or fail to deliver events. Public events may remain
          available through relays, clients, or archives even when they no
          longer appear in a Product App.
        </p>
        <p>
          Conduit does not control all relays or guarantee global discovery,
          freshness, availability, deletion, interoperability, or delivery. A
          bounded relay lookup is not proof that an event does or does not exist
          everywhere on Nostr.
        </p>
      </section>

      <section aria-labelledby="terms-11">
        <h2 id="terms-11">11. Encrypted Messaging And Residual Metadata</h2>
        <p>
          The Product Apps use NIP-17/NIP-59 gift wrapping and NIP-44 encryption
          for ordinary direct and order-linked messages. Product Apps decrypt
          messages locally in the browser or through the user’s signer. Message
          content is available to the sender and recipient and may also be
          processed by their browsers, signers, wallets, counterparties, or
          chosen services.
        </p>
        <p>
          Encryption does not eliminate routing and network metadata. Relays and
          network providers may observe outer recipient tags, encrypted event
          size, timing, traffic volume, selected relays, connection behavior, IP
          addresses, and authentication or request information. Messages may be
          delayed, rejected, duplicated, retained, deleted, or never retrieved.
          Conduit does not guarantee confidentiality against a compromised
          device, signer, key, counterparty, browser, or implementation.
        </p>
      </section>

      <section aria-labelledby="terms-12">
        <h2 id="terms-12">12. Prohibited Conduct And Listings</h2>
        <p>You may not use a Product App to:</p>
        <ul>
          <li>violate applicable law or another person’s rights;</li>
          <li>
            list, sell, purchase, promote, or facilitate illegal, infringing,
            deceptive, unsafe, stolen, sanctioned, or restricted goods or
            services;
          </li>
          <li>
            commit fraud, money laundering, sanctions evasion, market
            manipulation, or deceptive conduct;
          </li>
          <li>
            exploit, endanger, harass, threaten, stalk, spam, phish,
            impersonate, or abuse another person;
          </li>
          <li>
            distribute malware or interfere with a Product App, relay, signer,
            wallet, or other system;
          </li>
          <li>
            circumvent access controls, rate limits, safety controls, or legal
            restrictions;
          </li>
          <li>
            scrape, probe, or burden Conduit-operated infrastructure in a way
            that disrupts service or compromises security or privacy; or
          </li>
          <li>
            misrepresent affiliation with Conduit or misuse Conduit names,
            logos, or trademarks.
          </li>
        </ul>
        <p>
          Conduit may restrict content or access on Conduit-operated interfaces
          and infrastructure, but cannot guarantee removal from independent
          relays or clients.
        </p>
      </section>

      <section aria-labelledby="terms-13">
        <h2 id="terms-13">
          13. Open-Source Software, Legal Text, Trademarks, And Intellectual
          Property
        </h2>
        <p>
          Source code and redistributable bundled assets published for the
          Product Apps are available under the MIT License unless a file or the
          repository license states otherwise. Open-source software is provided
          under its applicable license and on an “as is” basis, without
          warranties.
        </p>
        <p>
          The Product Privacy Policy and Product Terms text are legal documents,
          not reusable software, and are excluded from the MIT License as stated
          in the repository’s Legal Content and Trademarks Exception. A fork or
          independent deployment must provide legal terms and notices for its
          own operator and behavior.
        </p>
        <p>
          Conduit names, logos, marks, product names, and branded app identities
          are not granted under the MIT License. You may not use them in a way
          that implies sponsorship, endorsement, affiliation, or official
          operation by Conduit without prior written consent.
        </p>
        <p>
          We respect intellectual property rights. A rights holder may send a
          takedown notice with the work claimed to be infringed, enough
          information to locate the material, contact information, and a
          good-faith accuracy statement. Conduit may restrict material in its
          interfaces, but decentralized copies may remain elsewhere.
        </p>
      </section>

      <section aria-labelledby="terms-14">
        <h2 id="terms-14">14. Service Changes, Restrictions, Or Suspension</h2>
        <p>
          Conduit may modify, suspend, discontinue, restrict, or limit any
          Product App or feature at any time, including to comply with law,
          protect users or infrastructure, respond to provider or protocol
          changes, or address security and abuse. Decentralized data may remain
          available outside Conduit even after Conduit changes or discontinues
          an interface.
        </p>
        <p>
          Conduit may update these Terms. Each released version receives a
          stable version identifier and effective date. Community proposals,
          pull requests, and unreleased wording do not become effective Terms
          merely by being submitted or merged. Continued use after an effective
          update constitutes acceptance to the extent permitted by law.
        </p>
      </section>

      <section aria-labelledby="terms-15">
        <h2 id="terms-15">15. Disclaimers</h2>
        <p>
          TO THE FULLEST EXTENT PERMITTED BY LAW, THE PRODUCT APPS, SOFTWARE,
          CONTENT, RELAYS, INTEGRATIONS, AND RELATED INFRASTRUCTURE ARE PROVIDED
          “AS IS” AND “AS AVAILABLE.” CONDUIT DISCLAIMS ALL WARRANTIES, EXPRESS
          OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AVAILABILITY, ACCURACY,
          SECURITY, AND RELIABILITY.
        </p>
        <p>
          Conduit does not warrant that a Product App will be uninterrupted,
          error-free, secure, compatible with every relay, signer, wallet, or
          client, or free of harmful components. You assume the risks of using
          Nostr, Lightning, public and private relays, third-party wallets,
          external signers, merchant-provided information, local browser
          storage, and decentralized infrastructure.
        </p>
      </section>

      <section aria-labelledby="terms-16">
        <h2 id="terms-16">16. Limitation Of Liability</h2>
        <p>
          TO THE FULLEST EXTENT PERMITTED BY LAW, CONDUIT WILL NOT BE LIABLE FOR
          INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
          DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST DATA, LOSS OF
          GOODWILL, TRANSACTION LOSSES, WALLET LOSSES, PAYMENT ERRORS, MERCHANT
          CONDUCT, BUYER CONDUCT, RELAY FAILURES, PROTOCOL CHANGES, OR
          THIRD-PARTY SERVICE FAILURES.
        </p>
        <p>
          TO THE FULLEST EXTENT PERMITTED BY LAW, CONDUIT’S TOTAL CUMULATIVE
          LIABILITY FOR ALL CLAIMS RELATING TO THE PRODUCT APPS WILL NOT EXCEED
          THE GREATER OF ONE HUNDRED U.S. DOLLARS OR THE AMOUNT YOU PAID
          DIRECTLY TO CONDUIT FOR THE PRODUCT APP GIVING RISE TO THE CLAIM IN
          THE THREE MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY.
        </p>
      </section>

      <section aria-labelledby="terms-17">
        <h2 id="terms-17">17. Indemnification</h2>
        <p>
          You agree to indemnify and hold harmless Conduit, its affiliates,
          officers, directors, employees, contractors, and agents from and
          against claims, losses, liabilities, damages, costs, and expenses,
          including reasonable attorneys’ fees, arising from your use of a
          Product App, your listings or transactions, your violation of these
          Terms or law, or your infringement of another person’s rights.
        </p>
      </section>

      <section aria-labelledby="terms-18">
        <h2 id="terms-18">
          18. Disputes, Governing Law, Severability, And Contact
        </h2>
        <p>
          Please read this paragraph carefully. Except for claims eligible for
          small claims court and claims for injunctive or equitable relief
          relating to intellectual property, security, or unauthorized use of a
          Product App, you and Conduit agree to resolve disputes through binding
          individual arbitration rather than in court. Arbitration will be
          administered by the American Arbitration Association under its
          applicable rules unless the parties agree to another provider.
          Arbitration will occur only on an individual basis. You and Conduit
          waive participation in a class, collective, consolidated, private
          attorney general, or representative action to the fullest extent
          permitted by law. If a court or arbitrator finds that waiver
          unenforceable for a claim, the arbitration agreement will not apply to
          that claim to the extent required by law.
        </p>
        <p>
          These Terms are governed by Delaware law, without regard to conflict
          of law principles. For claims not subject to arbitration, you agree to
          the exclusive jurisdiction and venue of the state and federal courts
          located in Delaware, except where applicable law requires otherwise.
        </p>
        <p>
          If a provision is unenforceable, the remaining provisions remain in
          effect. These Terms, the Product Privacy Policy, and any additional
          terms Conduit expressly provides for a feature are the entire
          agreement between you and Conduit regarding the official Product Apps.
        </p>
        <p>
          Questions, legal notices, takedown requests, and other notices may be
          sent to:
        </p>
        <p>
          Conduit Hodlings Inc
          <br />
          3400 Cottage Way, Suite G2, PMB 23234
          <br />
          Sacramento, CA 95825
          <br />
          Email:{" "}
          <a href="mailto:contact@conduitbtc.com">contact@conduitbtc.com</a>
        </p>
      </section>
    </>
  )
}
